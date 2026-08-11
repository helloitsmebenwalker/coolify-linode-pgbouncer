import { pool, waitForDatabase } from './db.js';

/**
 * Schema for the mail pipeline.
 *
 * Three concerns, deliberately separate tables:
 *
 *   mail_intake     every notification Graph hands us, recorded before we ack.
 *                   This is the durability boundary — once a row is here the
 *                   notification cannot be lost, and Graph's retry budget
 *                   stops mattering.
 *   mail_objects    what we actually wrote to the bucket. One row per message,
 *                   so a replayed notification re-uses the same object key.
 *   mq_messages     the queue itself (see queue.ts). Consumers read from here.
 *
 * The queue is plain SQL rather than the pgmq extension: Akamai's managed
 * Postgres is Aiven-backed and does not offer pgmq, and the semantics we need
 * (claim-with-visibility-timeout) are a single UPDATE ... SKIP LOCKED away.
 */
const statements = [
  // --- intake -------------------------------------------------------------
  `create table if not exists mail_intake (
     id              bigserial primary key,
     subscription_id text        not null,
     tenant_id       text,
     change_type     text        not null,
     resource        text        not null,
     resource_id     text        not null,
     mailbox         text,
     state           text        not null default 'pending',
     attempts        integer     not null default 0,
     next_attempt_at timestamptz not null default now(),
     locked_until    timestamptz,
     last_error      text,
     source          text        not null default 'webhook',
     received_at     timestamptz not null default now(),
     updated_at      timestamptz not null default now(),
     constraint mail_intake_state_check
       check (state in ('pending', 'working', 'done', 'failed', 'gone'))
   )`,

  // Dedupe key. Graph retries a notification it thinks we failed to ack, and
  // the catch-up sweep re-inserts anything it finds; both land on this.
  `create unique index if not exists mail_intake_dedupe_idx
     on mail_intake (resource_id, change_type)`,

  // Drives the worker's claim query. Partial: done/failed rows are the bulk of
  // the table over time and never need scanning.
  `create index if not exists mail_intake_claim_idx
     on mail_intake (next_attempt_at, id)
     where state = 'pending'`,

  `create index if not exists mail_intake_stuck_idx
     on mail_intake (locked_until)
     where state = 'working'`,

  // --- stored objects -----------------------------------------------------
  `create table if not exists mail_objects (
     resource_id         text primary key,
     mailbox             text        not null,
     internet_message_id text,
     subject             text,
     from_address        text,
     received_at         timestamptz,
     has_attachments     boolean,
     bucket              text        not null,
     object_key          text        not null,
     size_bytes          bigint      not null,
     sha256              text        not null,
     etag                text,
     stored_at           timestamptz not null default now()
   )`,

  `create index if not exists mail_objects_received_idx
     on mail_objects (received_at desc)`,

  `create index if not exists mail_objects_internet_id_idx
     on mail_objects (internet_message_id)`,

  // --- queue --------------------------------------------------------------
  `create table if not exists mq_messages (
     msg_id      bigserial primary key,
     queue       text        not null,
     message     jsonb       not null,
     read_ct     integer     not null default 0,
     enqueued_at timestamptz not null default now(),
     vt          timestamptz not null default now()
   )`,

  // The read path is "oldest visible message on this queue", so the index has
  // to lead with queue and vt or every read degenerates into a heap scan.
  `create index if not exists mq_messages_read_idx
     on mq_messages (queue, vt, msg_id)`,

  `create table if not exists mq_archive (
     msg_id      bigint primary key,
     queue       text        not null,
     message     jsonb       not null,
     read_ct     integer     not null,
     enqueued_at timestamptz not null,
     archived_at timestamptz not null default now()
   )`,

  `create index if not exists mq_archive_queue_idx
     on mq_archive (queue, archived_at desc)`,

  // --- subscriptions + cursors -------------------------------------------
  `create table if not exists graph_subscriptions (
     subscription_id  text primary key,
     resource         text        not null,
     mailbox          text        not null,
     change_type      text        not null,
     notification_url text        not null,
     expires_at       timestamptz not null,
     created_at       timestamptz not null default now(),
     renewed_at       timestamptz,
     state            text        not null default 'active',
     constraint graph_subscriptions_state_check
       check (state in ('active', 'removed'))
   )`,

  `create table if not exists mailhook_state (
     key        text primary key,
     value      text        not null,
     updated_at timestamptz not null default now()
   )`,
];

export async function migrate(): Promise<void> {
  await waitForDatabase();
  for (const statement of statements) {
    await pool.query(statement);
  }
  console.log(`mailhook migrations applied (${statements.length} statements)`);
}

if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
