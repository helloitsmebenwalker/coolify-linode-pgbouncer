# mailhook

Microsoft 365 delivers a message to a watched mailbox → this service archives
the raw MIME to Linode Object Storage → a Postgres-managed queue receives an
event saying where it landed.

```
Microsoft Graph                mailhook                     Postgres
─────────────────              ────────                     ────────
change notification  ──POST──▶ verify clientState
                               INSERT mail_intake ────────▶ mail_intake
                     ◀──202──  (~5ms, nothing else)

                               worker loop
                               claim intake (SKIP LOCKED) ◀─ mail_intake
                     ◀──GET──  message metadata + $value
                               PUT ───▶ Object Storage
                                        s3://bucket/raw/…/…eml
                               BEGIN ───────────────────────▶ mail_objects
                                                              mq_messages ← the event
                                                              mail_intake  → done
                               COMMIT
```

Consumers poll `mq_messages`. The event is only ever written after the object
is in the bucket, so an event never points at something that is not there.

## Why it is shaped like this

**The webhook does one INSERT and nothing else.** Graph expects a response in
about three seconds, retries a bounded number of times, and then drops
notifications on the floor. Fetching the message and uploading it on the
request path would put a Graph timeout and an S3 hiccup directly in the way of
durability. Recording the notification first makes the retry budget irrelevant:
once the row is committed, the work will happen eventually.

**The queue is plain SQL, not `pgmq`.** The managed cluster here is Aiven-backed
and does not offer the extension. `mq_messages` reimplements the part that
matters — claim with a visibility timeout — in one `UPDATE … FOR UPDATE SKIP
LOCKED`, and keeps a pgmq-shaped API (`send` / `read` / `archive` /
`deleteMessage`) so moving to the real thing later is a swap of `queue.ts`.

**Nothing uses `LISTEN`/`NOTIFY`.** `DATABASE_URL` is expected to point at the
PgBouncer pool in transaction mode, which multiplexes backends between clients:
a `LISTEN` registered on one checkout is simply gone by the next query. Polling
with `SKIP LOCKED` is the pattern that survives pooling, and it is what both the
worker and the reference consumer do. (This is the same trade-off the benchmark
in `bench/` measures — see the repo README.)

**Delivery is at-least-once, deliberately.** The failure window that remains is
"object written, process dies before commit". It resolves by replay: the lease
expires, the intake row returns to `pending`, and the retry rewrites byte-identical
content to the same key before enqueuing. Consumers must dedupe — every event
carries `message.resourceId` for exactly that.

## Setup

**[DEPLOY.md](DEPLOY.md) is the ordered runbook** — prerequisites, the Entra
registration, DNS, the Coolify environment, and a troubleshooting table. What
follows is the same ground in summary.

### 1. Entra ID app registration

Create an app registration in the tenant that owns the mailbox and give it the
**application** permission `Mail.Read`, then grant admin consent. Note the
tenant id, client id, and a client secret.

`Mail.Read` as an application permission means *every* mailbox in the tenant.
Scope it down, or the compromise of this container is the compromise of all
corporate mail. Use [RBAC for
Applications](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)
in Exchange Online — `New-ApplicationAccessPolicy` is the legacy mechanism —
and **remove the tenant-wide Entra consent when you do**, because the two grants
are additive:

```powershell
New-ServicePrincipal -AppId <client-id> -ObjectId <enterprise-app-object-id> -DisplayName "mailhook"
New-ManagementScope -Name "mailhook-scope" -RecipientRestrictionFilter "MemberOfGroup -eq '<group-dn>'"
New-ManagementRoleAssignment -App <enterprise-app-object-id> -Role "Application Mail.Read" `
  -CustomResourceScope "mailhook-scope"
```

[DEPLOY.md](DEPLOY.md#1-register-the-application-in-microsoft-entra) has the
full version, including how to verify it.

### 2. Bucket

```bash
cd infra/storage
cp terraform.tfvars.example terraform.tfvars   # pick a globally-unique bucket name
cd ../..
make tf-init storage-apply
make storage-env          # the S3_* block for Coolify
```

The access key Terraform creates is scoped to this one bucket. Linode returns
the secret once, at creation — Terraform state is the only copy afterwards.

### 3. Deploy

The service is part of `docker-compose.coolify.yml`. In Coolify, assign the
`mailhook` service its own domain: that URL is what Graph calls, and Graph
requires public HTTPS with a valid certificate, which is what Traefik provides.

Set in Coolify's env editor:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | the PgBouncer pool URL (`make pool-show`) |
| `DATABASE_CA_CERT` | `terraform -chdir=infra/database output -raw ca_cert` |
| `WEBHOOK_PUBLIC_URL` | `https://<the domain you assigned>` |
| `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` | from step 1 |
| `GRAPH_MAILBOX` | `invoices@contoso.com` |
| `S3_*` | from `make storage-env` |

`WEBHOOK_CLIENT_STATE` comes from Coolify's `SERVICE_PASSWORD_CLIENTSTATE`
magic variable — generated once and reused, so the service and the subscription
always agree.

### 4. Subscribe

Only after the service is deployed and reachable — Graph validates the
notification URL synchronously by calling it:

```bash
make sub-create     # or: docker compose exec mailhook node dist/subscriptions.js create
```

A `400` with "subscription validation request failed" means Graph could not
reach the URL or did not get its token back. Check `WEBHOOK_PUBLIC_URL` first;
it is almost always that.

Subscriptions on mail expire after at most 4230 minutes (just under three
days), and an expired one fails silently — mail simply stops arriving. The
service renews its own subscriptions in the background
(`SUBSCRIPTION_AUTORENEW`, on by default) and also answers Graph's
`reauthorizationRequired` lifecycle event.

## Local development

No Microsoft tenant needed. The dev stack swaps Linode Object Storage for MinIO
and enables `/dev/ingest`, which runs a raw `.eml` through the same
store-then-publish path a real notification would:

```bash
make mailhook-up
make mailhook-ingest EML=message.eml
make mailhook-stats
make mailhook-consume
```

`DEV_INGEST` must never be on in production — it is an unauthenticated write
into the archive.

## The event

```jsonc
{
  "type": "mail.stored",
  "version": 1,
  "occurredAt": "2026-08-11T07:58:08.011Z",
  "mailbox": "invoices@contoso.com",
  "message": {
    "resourceId": "AAMkAG...",          // dedupe on this
    "internetMessageId": "<4471@example.com>",
    "subject": "Invoice 4471",
    "from": "accounts@example.com",
    "to": ["invoices@contoso.com"],
    "receivedAt": "2026-08-11T08:00:00Z",
    "hasAttachments": true,
    "conversationId": "AAQkAG..."
  },
  "object": {
    "bucket": "mailhook-archive",
    "key": "raw/invoices_contoso.com/2026/08/11/24a7043a….eml",
    "region": "us-ord-1",
    "endpoint": "https://us-ord-1.linodeobjects.com",
    "url": "https://mailhook-archive.us-ord-1.linodeobjects.com/raw/…",
    "sizeBytes": 48219,
    "sha256": "d19a819d…",
    "contentType": "message/rfc822"
  },
  "source": { "intakeId": "42", "subscriptionId": "…", "changeType": "created", "resource": "Users/…/Messages/…" }
}
```

Consuming it is `read` → work → `archive`; `src/consumer.ts` is a complete
worked example. The visibility timeout is the safety net: a consumer that dies
mid-work leaves the message to reappear rather than losing it, which is why no
part of this needs a distributed transaction.

## Operations

```bash
make mailhook-stats        # intake states + queue depth
curl $URL/api/messages     # what has been archived recently
curl -X POST $URL/api/intake/42/replay   # push a failed row back through
```

`mail_intake` doubles as the dead-letter queue. Rows that exhaust
`WORKER_MAX_ATTEMPTS` land in state `failed` with `last_error` set; `gone` means
the message was deleted from the mailbox before we fetched it, which no amount
of retrying fixes.

**Catch-up sweep.** Graph does not guarantee notification delivery, and its
`missed` lifecycle event tells you something was lost without telling you what.
Every `CATCHUP_INTERVAL_MS` (default 10 minutes) the worker lists the folder for
anything received since the last message it saw and feeds it through intake,
where the dedupe index absorbs what the webhook already delivered. A log line at
`warn` with `"catch-up found messages the webhook missed"` means the webhook
path dropped something — worth investigating rather than ignoring, since the
sweep only papers over it.

## Security notes

- Graph does not sign change notifications. `clientState` is the entire
  authentication story for the webhook, and the URL is public by construction,
  so it is compared in constant time and the payload is never trusted for
  content — the message is always re-fetched from Graph with our own
  credentials.
- The bucket is private with CORS off. Nothing in the pipeline generates a
  public URL; the `object.url` in the event is an address, not access.
- The bucket holds complete emails — bodies, headers and attachments. It is
  almost certainly the most sensitive store in this stack. `expire_after_days`
  in `infra/storage` exists so retention is a decision rather than an accident.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3001` | |
| `DATABASE_URL` | — | required; the PgBouncer pool URL is fine |
| `DATABASE_CA_CERT` | — | without it, `sslmode=require` is encrypted but unverified |
| `WEBHOOK_CLIENT_STATE` | — | required; `openssl rand -hex 32` |
| `WEBHOOK_PUBLIC_URL` | — | needed to create/renew subscriptions |
| `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` | — | app-only auth |
| `GRAPH_MAILBOX` | — | UPN or object id |
| `GRAPH_MAIL_FOLDER` | `Inbox` | |
| `S3_BUCKET` / `S3_REGION` / `S3_ENDPOINT` | — | from `make storage-env` |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | — | scoped to the one bucket |
| `S3_FORCE_PATH_STYLE` | `false` | `true` for MinIO |
| `S3_KEY_PREFIX` | `raw` | |
| `QUEUE_NAME` | `mail_events` | |
| `WORKER_ENABLED` | `true` | set `false` to run a webhook-only replica |
| `WORKER_BATCH` / `WORKER_POLL_MS` | `10` / `1000` | |
| `WORKER_MAX_ATTEMPTS` / `WORKER_BACKOFF_SECONDS` | `8` / `15` | doubling, capped at 1h |
| `WORKER_LOCK_SECONDS` | `300` | lease length on a claimed intake row |
| `CATCHUP_ENABLED` / `CATCHUP_INTERVAL_MS` | `true` / `600000` | |
| `SUBSCRIPTION_AUTORENEW` | `true` | |
| `DEV_INGEST` | `false` | local only |

Scaling out is safe: every claim is `SKIP LOCKED`, so N replicas divide the work
instead of duplicating it. Run extra replicas with `WORKER_ENABLED=false` if you
only need more webhook capacity.
