# Deploying mailhook

Getting Microsoft 365 mail flowing into the bucket and onto the queue, in order.

This assumes the Coolify host and the managed database already exist — steps 1–9
of the [root DEPLOY.md](../DEPLOY.md). If they don't, do those first; everything
below builds on them.

There are three separate systems to configure and they fail in different ways:
Microsoft (identity and subscription), Linode (bucket and key), Coolify
(deploy and environment). Do them in this order — each step needs the one
before it.

## 0. What you need before you start

| | Why |
| --- | --- |
| A Microsoft 365 tenant, and rights to **grant admin consent** in it | Application permissions do not work without consent, and consent is an admin action. If you are not a Global Administrator or Privileged Role Administrator, you need someone who is — this is the step most likely to block you for a day. |
| The mailbox you want to watch | A normal user mailbox or a shared mailbox, in that tenant. |
| A domain you control, with DNS pointing at the Coolify host | **Not optional.** Graph will only call a public HTTPS URL with a publicly-trusted certificate. Coolify's default `sslip.io` URL is plain HTTP, so a subscription against it cannot be created. |
| A running Coolify deploy of this repo | From the root DEPLOY.md. |
| The managed Postgres URL | `make pool-show`. |
| `LINODE_TOKEN` exported in your shell | For the bucket Terraform. |

## 1. Register the application in Microsoft Entra

In the [Microsoft Entra admin center](https://entra.microsoft.com) →
**Identity → Applications → App registrations → New registration**:

1. Name it (`mailhook`), single tenant, no redirect URI — this is a daemon app
   with no user sign-in.
2. From **Overview**, copy the **Application (client) ID** and the
   **Directory (tenant) ID**.
3. **API permissions → Add a permission → Microsoft Graph → Application
   permissions** → `Mail.Read`. Add it, then **Grant admin consent** and confirm
   the status column turns green. Delegated permissions are the wrong kind here;
   there is no signed-in user.
4. **Certificates & secrets → New client secret**. Copy the **Value** now — it
   is shown once. Note the expiry: a secret can last at most 24 months, and when
   it expires the pipeline stops with 401s. Put the date in a calendar.

### Restrict which mailboxes it can read

`Mail.Read` as an application permission grants read access to **every mailbox
in the tenant**. Scope it before the secret goes anywhere near a container. In
Exchange Online PowerShell:

```powershell
# A mail-enabled security group containing only the mailboxes mailhook may read
New-ApplicationAccessPolicy -AppId <client-id> `
  -PolicyScopeGroupId mailhook-allowed@contoso.com `
  -AccessRight RestrictAccess -Description "mailhook"

# Verify — this must say Granted for the mailbox you watch, Denied for others
Test-ApplicationAccessPolicy -Identity invoices@contoso.com -AppId <client-id>
```

Policy changes take a few minutes to propagate. If step 6 fails with
`ErrorAccessDenied` right after you set this, wait and retry before assuming the
permission is wrong.

## 2. Create the bucket

```bash
cd infra/storage
cp terraform.tfvars.example terraform.tfvars    # bucket_label must be globally unique
$EDITOR terraform.tfvars                        # region: match the Coolify host
cd ../..

make tf-init
make storage-apply
make storage-env      # prints the S3_* block for step 4 — keep this terminal open
```

`make storage-env` emits five lines ready to paste. The secret key is returned by
Linode once, at creation; after that Terraform state is the only copy, so do not
delete `infra/storage/terraform.tfstate`.

## 3. Point DNS at the host

Add an A record for the mailhook domain — `mailhook.yourdomain.com` — to the
Coolify host's IP:

```bash
terraform -chdir=infra/coolify output -raw ipv4
```

Wait for it to resolve before deploying. Coolify requests the certificate during
deploy and ACME validates over port 80 against real DNS; a domain that does not
resolve yet gets you a resource with no certificate and a subscription you
cannot create.

## 4. Deploy the service

`mailhook` is already part of `docker-compose.coolify.yml`, so this is the
existing Coolify resource, not a new one.

1. Open the resource → the `mailhook` service → set its domain to
   `https://mailhook.yourdomain.com`.
2. **Environment Variables** → add:

| Variable | Value |
| --- | --- |
| `WEBHOOK_PUBLIC_URL` | `https://mailhook.yourdomain.com` — no trailing slash, and it must match the domain above exactly |
| `GRAPH_TENANT_ID` | Directory (tenant) ID from step 1 |
| `GRAPH_CLIENT_ID` | Application (client) ID from step 1 |
| `GRAPH_CLIENT_SECRET` | the secret **Value** from step 1 |
| `GRAPH_MAILBOX` | `invoices@contoso.com` |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | the five lines from `make storage-env` |
| `DATABASE_URL` | already set for `app`; both services share it |
| `DATABASE_CA_CERT` | `terraform -chdir=infra/database output -raw ca_cert` — without it TLS is encrypted but unverified |

   Mark the secret ones as build-time-excluded/locked in Coolify's editor so they
   are not echoed into build logs.

3. Leave `WEBHOOK_CLIENT_STATE` alone. It comes from Coolify's
   `SERVICE_PASSWORD_CLIENTSTATE` magic variable, generated once on first deploy
   and reused. Both the service and the subscribe command read the same value, so
   the two sides cannot drift.
4. **Deploy.** Migrations run at boot and create the intake, object, queue and
   subscription tables.

## 5. Prove it is reachable before you subscribe

```bash
curl -sS https://mailhook.yourdomain.com/healthz
# {"status":"ok","uptime":12.3,"configured":true,"worker":true}
```

`"configured": true` means Graph and the bucket both have complete settings — it
does **not** mean the credentials work. Check that separately:

```bash
curl -sS 'https://mailhook.yourdomain.com/healthz?deep=1'   # does a real HEAD on the bucket
```

A 503 with `bucket unreachable` here is an access-key problem, and it is much
easier to diagnose now than as a failed message in an hour. Both must pass
before the next step.

## 6. Create the subscription

Graph validates the notification URL synchronously — it POSTs a token to your
service and expects it echoed back within 10 seconds — so this only works once
the service is deployed and public.

From the Coolify host (**Terminal** in the UI, or `make ssh`):

```bash
MAILHOOK=$(docker ps --filter name=mailhook --format '{{.Names}}' | head -1)
docker exec -it "$MAILHOOK" node dist/subscriptions.js create
```

Locally, with the dev stack up, `make sub-create` does the same thing.

Success prints the subscription JSON and its expiry. Then:

```bash
docker exec -it <mailhook-container> node dist/subscriptions.js list
```

## 7. Send a test email

Send something to the watched mailbox, then:

```bash
curl -sS https://mailhook.yourdomain.com/api/stats
# intake.done goes to 1, queue.length to 1

curl -sS https://mailhook.yourdomain.com/api/messages
# subject, sender, and the object key it was written to
```

Coolify's **Logs** tab shows the whole path in two lines — `notifications
recorded` from the webhook, then `email archived and queued` from the worker.

Nothing consumes the queue yet, so `queue.length` stays at 1. That is the
handoff point: your downstream service reads from there. `mailhook/src/consumer.ts`
is a complete worked example of the read → work → archive loop, and
[README.md](README.md#the-event) documents the event shape.

## 8. What to watch after it is live

| Signal | Meaning |
| --- | --- |
| `intake.failed > 0` | Messages that exhausted their retries. `mail_intake.last_error` says why; `POST /api/intake/<id>/replay` puts one back through. |
| `queue.length` climbing | Nothing is consuming, or the consumer is broken. |
| `queue.maxReadCt` climbing | A consumer keeps claiming a message and never archiving it — it is failing mid-handle. |
| log: `catch-up found messages the webhook missed` | The webhook path dropped something. The sweep recovered it, but the cause is worth finding. |
| log: `graph removed the subscription` | Recreate it with step 6. Renewal cannot revive a removed subscription. |
| `intake.oldestPendingSeconds` growing | The worker is stuck or throttled by Graph. |

The two silent killers are the **client secret expiring** (up to 24 months) and
**the subscription lapsing** while `SUBSCRIPTION_AUTORENEW` is off. Both stop
mail with no user-visible symptom, so put a calendar reminder on the first and
leave auto-renew on for the second.

## 9. Teardown, in this order

```bash
# while the service is still running
docker exec -it <mailhook-container> node dist/subscriptions.js list
docker exec -it <mailhook-container> node dist/subscriptions.js delete <id>

make storage-destroy    # fails unless the bucket is empty — empty it deliberately
```

Unsubscribe first: a subscription pointing at a dead URL keeps failing until
Graph expires it. And Terraform will not delete a bucket with objects in it,
which is a guardrail, not an obstacle — that bucket holds the only copy of the
archived mail.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `subscription validation request failed` on create | Graph could not reach the URL or did not get the token back. Check `WEBHOOK_PUBLIC_URL` matches the assigned domain exactly, that it is HTTPS with a valid certificate (not the `sslip.io` fallback), and that `curl https://…/healthz` works from outside your network. |
| `ErrorAccessDenied` fetching a message | Application access policy has not propagated, or does not include this mailbox. `Test-ApplicationAccessPolicy` from step 1. |
| `Insufficient privileges to complete the operation` | Admin consent was never granted, or the permission was added as delegated rather than application. |
| 401 on every Graph call | Client secret expired or was copied from the "Secret ID" column instead of "Value". |
| `configured: false` in `/healthz` | One of the `GRAPH_*` or `S3_*` variables is empty. The startup log names which. |
| Webhook returns 403 | `clientState` mismatch: the subscription was created with a different secret than the service now has. Delete and recreate the subscription. |
| Notifications arrive, nothing lands in the bucket | The webhook and the worker are independent. `intake.pending` climbing with `done` flat means the worker is failing — `mail_intake.last_error` has the reason. |
| `SELF_SIGNED_CERT_IN_CHAIN` at boot | `sslmode` reached `pg` — see the note in the [root README](../README.md#notes). |
| Bucket writes fail with `SignatureDoesNotMatch` | `S3_ENDPOINT` region does not match the bucket's region, or the key is scoped to a different bucket. |
