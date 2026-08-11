/**
 * Configuration for the consumer side of the pipeline.
 *
 * Note what is NOT here: nothing about Microsoft Graph. This service never
 * talks to Microsoft. It learns everything it needs from the queue event and
 * the bucket, which is the point of putting an object store between the two
 * halves — the producer can change how mail arrives without this service
 * caring, and this one can be redeployed, replayed or rewritten without any
 * risk to mail capture.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got ${raw}`);
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

export const config = {
  port: number('PORT', 3002),
  host: optional('HOST', '0.0.0.0'),
  logLevel: optional('LOG_LEVEL', 'info'),
  env: optional('NODE_ENV', 'development'),

  queue: {
    name: optional('QUEUE_NAME', 'mail_events'),
    /** Messages claimed per poll. */
    batch: number('QUEUE_BATCH', 10),
    pollMs: number('QUEUE_POLL_MS', 1_000),
    /**
     * How long a claimed message stays invisible. Must comfortably exceed the
     * time to download and parse the largest message you expect: if it expires
     * mid-work, a second consumer starts the same job while the first is still
     * running. Idempotent handling makes that harmless, not free.
     */
    visibilitySeconds: number('QUEUE_VISIBILITY_SECONDS', 300),
    /**
     * After this many deliveries a message is dead-lettered instead of retried
     * forever. `read_ct` counts deliveries, so this is attempts, not failures.
     */
    maxAttempts: number('QUEUE_MAX_ATTEMPTS', 5),
  },

  worker: {
    enabled: bool('WORKER_ENABLED', true),
    /** Messages handled in parallel. Downloads are IO-bound; nothing throttles us. */
    concurrency: number('WORKER_CONCURRENCY', 4),
  },

  storage: {
    region: optional('S3_REGION', 'us-ord-1'),
    endpoint: process.env.S3_ENDPOINT ?? '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    forcePathStyle: bool('S3_FORCE_PATH_STYLE', false),
    /**
     * Buckets this consumer will read from. The event names its own bucket, and
     * a queue event is not a capability — anything that can write to the queue
     * could otherwise point this service at an arbitrary bucket. Empty means
     * "trust the event", which is fine only when nothing else can write there.
     */
    allowedBuckets: (process.env.S3_ALLOWED_BUCKETS ?? '')
      .split(',')
      .map((bucket) => bucket.trim())
      .filter(Boolean),
    /** Where extracted attachments go, when extraction is on. */
    attachmentPrefix: optional('ATTACHMENT_PREFIX', 'attachments').replace(/^\/|\/$/g, ''),
  },

  processing: {
    /** Keep the HTML body as well as the plain-text one. */
    storeHtml: bool('STORE_HTML_BODY', true),
    /** Truncate bodies at this many characters before they hit Postgres. */
    maxBodyChars: number('MAX_BODY_CHARS', 1_000_000),
    /**
     * Write each attachment back to the bucket as its own object. Off by
     * default: the bytes are already durable inside the .eml, so this is a
     * convenience for downstream consumers, not a safety measure.
     */
    extractAttachments: bool('EXTRACT_ATTACHMENTS', false),
    /** Skip extraction above this size. */
    maxAttachmentBytes: number('MAX_ATTACHMENT_BYTES', 25 * 1024 * 1024),
    /**
     * Verify the downloaded object against the sha256 in the event. Cheap, and
     * it turns a truncated download into a retry instead of a corrupt row.
     */
    verifyChecksum: bool('VERIFY_CHECKSUM', true),
  },
} as const;

export function assertStorageConfigured(): void {
  const missing = (
    [
      ['S3_ENDPOINT', config.storage.endpoint],
      ['S3_ACCESS_KEY_ID', config.storage.accessKeyId],
      ['S3_SECRET_ACCESS_KEY', config.storage.secretAccessKey],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length) throw new Error(`Object storage is not configured: ${missing.join(', ')} unset`);
}

export { required };
