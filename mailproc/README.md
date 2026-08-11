# mailproc

Consumes `mail.stored` events from the Postgres queue, pulls the raw message
back out of the bucket, parses it, and writes the extracted data to Postgres —
with one clearly-marked function where your own logic goes.

```
mq_messages ──claim (SKIP LOCKED, 5 min lease)──▶ mailproc
                                                   │
                    s3://bucket/raw/…/….eml ──GET──┤  verify sha256
                                                   │  parse MIME
                                                   ▼
                                           BEGIN
                                             mail_documents      (upsert)
                                             mail_attachments    (upsert)
                                             onEmailStored(...)  ← your code
                                             archive the message (ack)
                                           COMMIT
```

## The bit you are going to edit

[`src/handlers.ts`](src/handlers.ts) — `onEmailStored`. Everything else is
plumbing to get you there with a parsed email, its attachments, and an open
transaction.

```ts
export async function onEmailStored(ctx, client) {
  // ctx.document   the row that was just written (typed, flat)
  // ctx.parsed     mailparser output: bodies, addresses, decoded attachments
  // ctx.attachments  what was recorded, incl. bucket keys if extraction is on
  // ctx.mime       the raw bytes, if the parser dropped something you need
  // client         the transaction that commits the document and the ack
}
```

Two rules follow from where it runs:

- **Database writes through `client` are effectively exactly-once.** They commit
  atomically with the document rows and the queue acknowledgement. Throw, and
  all of it rolls back and the message is redelivered.
- **Everything else is at-least-once.** An HTTP call, an email, a payment — none
  of that rolls back. Key those on `document.resourceId`, which is stable across
  every redelivery of the same message.

Keep it fast: the transaction is open and the lease is ticking. Long work should
go on its own queue, enqueued from inside the handler — there's a worked example
in the comments.

## What lands in Postgres

`mail_documents`, one row per email keyed by `resource_id`:

| | |
| --- | --- |
| addresses | `from_address`, `from_name`, `to_addresses[]`, `cc_addresses[]` |
| content | `subject`, `text_body`, `html_body`, `headers` (jsonb, full `headerLines`) |
| timing | `sent_at` (from the message), `received_at` (from Graph), `processed_at` |
| provenance | `bucket`, `object_key`, `sha256`, `size_bytes` |

`mail_attachments`, one row per part: filename, content type, size, sha256,
inline flag, and an object key when extraction is on.

There's a GIN index over `subject || text_body`, so search is already there:

```bash
make mailproc-docs Q="invoice overdue"
```

Postgres is already in the stack and already holds the text. Reaching for a
search cluster before this stops being enough would be premature.

## Failure handling

The interesting part of any consumer. Three outcomes, deliberately different:

| | What happens | Why |
| --- | --- | --- |
| **Transient** — S3 blipped, database went away | Nothing. The message is not acked; its lease expires and it comes back. | The queue already is the retry mechanism. Adding another one inside the process just duplicates it badly. |
| **Poison** — malformed payload, checksum mismatch, bucket not allow-listed | Dead-lettered immediately to `mail_processing_failures`, with the payload. | It will be exactly as broken in five minutes, and retrying it forever buries the queue behind a message that can never succeed. |
| **Persistent** — fails past `QUEUE_MAX_ATTEMPTS` deliveries | Dead-lettered. `read_ct` counts deliveries, so this catches transient-looking failures that are actually permanent. | |

Dead letters keep the original payload, so replay is a real replay:

```bash
make mailproc-failures                                   # what failed and why
curl -X POST $URL/api/failures/<id>/replay               # put it back on the queue
```

## Reprocessing

Everything is keyed on `resource_id` with upserts, so reprocessing is safe by
construction. To re-run new logic over mail you already have, re-enqueue from
mailhook's record of what it stored:

```sql
insert into mq_messages (queue, message)
select 'mail_events', jsonb_build_object(
  'type', 'mail.stored', 'version', 1,
  'occurredAt', now(), 'mailbox', mailbox,
  'message', jsonb_build_object(
    'resourceId', resource_id, 'internetMessageId', internet_message_id,
    'subject', subject, 'from', from_address, 'to', '[]'::jsonb,
    'receivedAt', received_at, 'hasAttachments', has_attachments,
    'conversationId', null),
  'object', jsonb_build_object(
    'bucket', bucket, 'key', object_key, 'region', '', 'endpoint', '', 'url', '',
    'sizeBytes', size_bytes, 'sha256', sha256, 'contentType', 'message/rfc822'),
  'source', jsonb_build_object(
    'intakeId', '0', 'subscriptionId', 'replay', 'changeType', 'created', 'resource', ''))
from mail_objects
where received_at >= now() - interval '7 days';
```

This is why the bucket holds the original MIME rather than mailhook's
interpretation of it: the parse is repeatable, and a bug in extraction costs a
re-run rather than the data.

## Local run

```bash
make mailproc-up
make mailhook-ingest EML=message.eml    # push an email in at the top
make mailproc-stats                     # watch it come out the bottom
make mailproc-docs
```

## Deploying

The service is already in `docker-compose.coolify.yml`. It needs no domain —
nothing calls it from outside, so it stays off the proxy — and the same
`DATABASE_URL` and `S3_*` values as mailhook, except that its key only needs
read access unless you turn on attachment extraction.

Scale it by adding replicas. Every claim is `FOR UPDATE SKIP LOCKED`, so N
consumers divide the queue instead of duplicating it.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3002` | healthcheck and ops endpoints only |
| `DATABASE_URL` | — | required; the PgBouncer pool URL is fine |
| `DATABASE_CA_CERT` | — | without it, `sslmode=require` is encrypted but unverified |
| `QUEUE_NAME` | `mail_events` | must match mailhook |
| `QUEUE_BATCH` / `QUEUE_POLL_MS` | `10` / `1000` | |
| `QUEUE_VISIBILITY_SECONDS` | `300` | must exceed the slowest download+parse |
| `QUEUE_MAX_ATTEMPTS` | `5` | deliveries before dead-lettering |
| `WORKER_CONCURRENCY` | `4` | messages handled in parallel |
| `WORKER_ENABLED` | `true` | `false` runs the HTTP surface only |
| `S3_ENDPOINT` / `S3_REGION` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | — | read access is enough |
| `S3_ALLOWED_BUCKETS` | — | **set this.** Comma-separated allow-list; empty means "trust whatever bucket the event names" |
| `S3_FORCE_PATH_STYLE` | `false` | `true` for MinIO |
| `VERIFY_CHECKSUM` | `true` | compare the download against the event's sha256 |
| `STORE_HTML_BODY` | `true` | |
| `MAX_BODY_CHARS` | `1000000` | truncation before the body hits Postgres |
| `EXTRACT_ATTACHMENTS` | `false` | write each attachment back as its own object |
| `MAX_ATTACHMENT_BYTES` | `26214400` | skip extraction above this |
| `ATTACHMENT_PREFIX` | `attachments` | |

`S3_ALLOWED_BUCKETS` is worth a sentence. The bucket to read comes from the
event, and a queue event is a claim, not a capability — anything that can insert
into `mq_messages` could otherwise point this service's credentials at a bucket
of its choosing. The allow-list is what makes that claim checkable.
