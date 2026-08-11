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
| A Microsoft 365 tenant with Exchange Online, and admin rights in it | You need to **grant admin consent** (Global Administrator or Privileged Role Administrator) or, for the scoped route in step 1, the **Organization Management** role group in Exchange. If you hold neither, you need someone who does — this is the step most likely to block you for a day. |
| The mailbox you want to watch | A user or shared mailbox in that tenant, **with an Exchange Online licence assigned**. An unlicensed user has no mailbox, and Graph answers `MailboxNotEnabledForRESTAPI` however correct everything else is. |
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
3. **Certificates & secrets → New client secret**. Copy the **Value** now — it
   is shown once (the "Secret ID" column is not the secret). Note the expiry: a
   secret can last at most 24 months, and when it expires the pipeline stops
   with 401s. Put the date in a calendar.

Then grant it access to mail — via **one** of the two routes below. They are
additive, which is the trap: doing both leaves the mailbox scoping with no
effect at all.

### Route A — throwaway test tenant

Grant `Mail.Read` tenant-wide and move on:

**API permissions → Add a permission → Microsoft Graph → Application
permissions** → `Mail.Read` → **Grant admin consent**, and confirm the status
column turns green. Delegated permissions are the wrong kind here; there is no
signed-in user.

In a trial tenant with a mailbox or two this is the whole story. In a tenant
with real mail in it, "every mailbox" is not a scope you want a container to
hold.

### Route B — any tenant you care about

Do **not** consent `Mail.Read` in Entra. Grant it in Exchange instead, scoped to
specific mailboxes, using [RBAC for
Applications](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac).
This replaces the older `New-ApplicationAccessPolicy`, which Microsoft now
documents as legacy.

You need the **Enterprise applications** IDs, not the App registrations ones —
Entra admin center → **Enterprise applications** → your app → the **Object ID**
there is the service principal id. Then, in Exchange Online PowerShell:

```powershell
Connect-ExchangeOnline    # you need the Organization Management role group

# A pointer in Exchange to the Entra service principal
New-ServicePrincipal -AppId <application-client-id> `
  -ObjectId <enterprise-app-object-id> -DisplayName "mailhook"

# The set of mailboxes it may read. MemberOfGroup takes the group's
# distinguished name — get it from (Get-Group mailhook-allowed).DistinguishedName
New-ManagementScope -Name "mailhook-scope" `
  -RecipientRestrictionFilter "MemberOfGroup -eq '<group-distinguished-name>'"

New-ManagementRoleAssignment -App <enterprise-app-object-id> `
  -Role "Application Mail.Read" -CustomResourceScope "mailhook-scope"

# InScope must be True for the mailbox you watch, False for any other
Test-ServicePrincipalAuthorization -Identity "mailhook" `
  -Resource invoices@contoso.com | Format-Table
```

Two things that will waste your time otherwise:

- **If `Mail.Read` is also consented in Entra, the scope does nothing.** The two
  authorities are additive — an unscoped Entra grant unioned with a scoped
  Exchange grant is an unscoped grant. Remove the Entra consent.
- **Permission changes are cached for 30 minutes to 2 hours.**
  `Test-ServicePrincipalAuthorization` bypasses the cache, so trust it over what
  the API is currently doing. Only direct group membership counts; nested groups
  are out of scope.

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
| `ErrorAccessDenied` fetching a message | Scoping does not cover this mailbox, or the change is still cached (30 min–2 h). `Test-ServicePrincipalAuthorization` from step 1 bypasses the cache and tells you which. |
| `MailboxNotEnabledForRESTAPI` | The user has no Exchange Online licence, so there is no mailbox to read. |
| `Insufficient privileges to complete the operation` | Admin consent was never granted, or the permission was added as delegated rather than application. |
| 401 on every Graph call | Client secret expired or was copied from the "Secret ID" column instead of "Value". |
| `configured: false` in `/healthz` | One of the `GRAPH_*` or `S3_*` variables is empty. The startup log names which. |
| Webhook returns 403 | `clientState` mismatch: the subscription was created with a different secret than the service now has. Delete and recreate the subscription. |
| Notifications arrive, nothing lands in the bucket | The webhook and the worker are independent. `intake.pending` climbing with `done` flat means the worker is failing — `mail_intake.last_error` has the reason. |
| `SELF_SIGNED_CERT_IN_CHAIN` at boot | `sslmode` reached `pg` — see the note in the [root README](../README.md#notes). |
| Bucket writes fail with `SignatureDoesNotMatch` | `S3_ENDPOINT` region does not match the bucket's region, or the key is scoped to a different bucket. |
