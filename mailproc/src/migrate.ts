import { pool, waitForDatabase } from './db.js';

/**
 * Schema owned by this service.
 *
 * It does not touch mailhook's tables — `mq_messages`, `mail_intake` and
 * `mail_objects` belong to the producer, and this service only reads the queue.
 * Two services sharing one database is fine; two services migrating the same
 * table is not.
 *
 * `mail_documents` is keyed by the same `resource_id` the event carries, which
 * is what makes reprocessing idempotent: replaying the whole queue rewrites
 * rows rather than duplicating them.
 */
const statements = [
  `create table if not exists mail_documents (
     resource_id         text primary key,
     mailbox             text        not null,
     internet_message_id text,
     subject             text,
     from_address        text,
     from_name           text,
     to_addresses        text[]      not null default '{}',
     cc_addresses        text[]      not null default '{}',
     sent_at             timestamptz,
     received_at         timestamptz,
     text_body           text,
     html_body           text,
     headers             jsonb,
     attachment_count    integer     not null default 0,
     size_bytes          bigint      not null,
     sha256              text        not null,
     bucket              text        not null,
     object_key          text        not null,
     processed_at        timestamptz not null default now()
   )`,

  `create index if not exists mail_documents_received_idx
     on mail_documents (received_at desc)`,

  `create index if not exists mail_documents_from_idx
     on mail_documents (from_address)`,

  // Full-text over subject and body. Postgres is already here and already
  // holds the extracted text; reaching for a search cluster before this stops
  // being enough would be premature.
  `create index if not exists mail_documents_fts_idx
     on mail_documents
     using gin (to_tsvector('english', coalesce(subject, '') || ' ' || coalesce(text_body, '')))`,

  `create table if not exists mail_attachments (
     id           bigserial primary key,
     resource_id  text        not null references mail_documents (resource_id) on delete cascade,
     position     integer     not null,
     filename     text,
     content_type text,
     size_bytes   bigint      not null,
     sha256       text        not null,
     content_id   text,
     is_inline    boolean     not null default false,
     bucket       text,
     object_key   text,
     created_at   timestamptz not null default now(),
     unique (resource_id, position)
   )`,

  `create index if not exists mail_attachments_sha_idx
     on mail_attachments (sha256)`,

  /**
   * Dead letters. A message that fails past QUEUE_MAX_ATTEMPTS lands here with
   * the payload intact, so it is inspectable and replayable rather than lost in
   * a log line.
   */
  `create table if not exists mail_processing_failures (
     id          bigserial primary key,
     resource_id text,
     msg_id      bigint,
     read_ct     integer     not null default 0,
     error       text        not null,
     payload     jsonb,
     failed_at   timestamptz not null default now(),
     replayed_at timestamptz
   )`,

  `create index if not exists mail_processing_failures_open_idx
     on mail_processing_failures (failed_at desc)
     where replayed_at is null`,
];

export async function migrate(): Promise<void> {
  await waitForDatabase();
  for (const statement of statements) {
    await pool.query(statement);
  }
  console.log(`mailproc migrations applied (${statements.length} statements)`);
}

if (process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
