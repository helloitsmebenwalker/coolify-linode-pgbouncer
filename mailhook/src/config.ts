/**
 * All environment reading happens here so a misconfigured deploy fails at boot
 * with a useful message rather than at 3am on the first notification.
 *
 * The Graph and S3 blocks are validated lazily: the webhook endpoint itself
 * only needs the database and the client state, so a partially-configured
 * instance can still accept and durably record notifications while you sort
 * out credentials.
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
  port: number('PORT', 3001),
  host: optional('HOST', '0.0.0.0'),
  logLevel: optional('LOG_LEVEL', 'info'),
  env: optional('NODE_ENV', 'development'),

  webhook: {
    /**
     * Graph does not sign notifications, so this shared secret is the only
     * thing distinguishing a real notification from anyone who guesses the URL.
     * It is a hint, not an authorisation: the payload is never trusted for
     * content — we re-fetch the message from Graph with our own credentials.
     */
    clientState: required('WEBHOOK_CLIENT_STATE'),
    /** Public base URL Graph will call, e.g. https://mailhook.example.com */
    publicUrl: optional('WEBHOOK_PUBLIC_URL', '').replace(/\/$/, ''),
    notifyPath: optional('WEBHOOK_NOTIFY_PATH', '/webhooks/m365/mail'),
    lifecyclePath: optional('WEBHOOK_LIFECYCLE_PATH', '/webhooks/m365/lifecycle'),
  },

  graph: {
    tenantId: process.env.GRAPH_TENANT_ID ?? '',
    clientId: process.env.GRAPH_CLIENT_ID ?? '',
    clientSecret: process.env.GRAPH_CLIENT_SECRET ?? '',
    /** Mailbox to watch: object id or UPN, e.g. invoices@contoso.com */
    mailbox: process.env.GRAPH_MAILBOX ?? '',
    mailFolder: optional('GRAPH_MAIL_FOLDER', 'Inbox'),
    baseUrl: optional('GRAPH_BASE_URL', 'https://graph.microsoft.com/v1.0'),
    loginUrl: optional('GRAPH_LOGIN_URL', 'https://login.microsoftonline.com'),
    timeoutMs: number('GRAPH_TIMEOUT_MS', 30_000),
  },

  storage: {
    bucket: process.env.S3_BUCKET ?? '',
    region: optional('S3_REGION', 'us-ord-1'),
    /** Linode Object Storage: https://<region>.linodeobjects.com */
    endpoint: process.env.S3_ENDPOINT ?? '',
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    forcePathStyle: bool('S3_FORCE_PATH_STYLE', false),
    keyPrefix: optional('S3_KEY_PREFIX', 'raw').replace(/^\/|\/$/g, ''),
  },

  queue: {
    name: optional('QUEUE_NAME', 'mail_events'),
  },

  worker: {
    enabled: bool('WORKER_ENABLED', true),
    pollMs: number('WORKER_POLL_MS', 1_000),
    batch: number('WORKER_BATCH', 10),
    /** How long a claimed intake row stays invisible to other workers. */
    lockSeconds: number('WORKER_LOCK_SECONDS', 300),
    maxAttempts: number('WORKER_MAX_ATTEMPTS', 8),
    /** Exponential backoff base, doubled per attempt and capped at an hour. */
    backoffSeconds: number('WORKER_BACKOFF_SECONDS', 15),
  },

  /**
   * Graph explicitly does not guarantee delivery of change notifications, and
   * a `missed` lifecycle event tells you only that something was lost, not
   * what. The catch-up sweep lists the folder since the last message we saw
   * and re-inserts anything the webhook never delivered.
   */
  catchUp: {
    enabled: bool('CATCHUP_ENABLED', true),
    intervalMs: number('CATCHUP_INTERVAL_MS', 600_000),
    /** How far back to look on a cold start with no cursor. */
    coldStartHours: number('CATCHUP_COLD_START_HOURS', 24),
    pageSize: number('CATCHUP_PAGE_SIZE', 50),
  },

  /**
   * Local testing without a tenant: POST a .eml to /dev/ingest and it runs the
   * same store-then-publish path a real notification would. Never enable in
   * production — it is an unauthenticated write into the archive.
   */
  devIngest: bool('DEV_INGEST', false),

  subscriptions: {
    /** Graph caps message subscriptions at 4230 minutes (just under 3 days). */
    lifetimeMinutes: number('SUBSCRIPTION_LIFETIME_MINUTES', 4_230),
    autoRenew: bool('SUBSCRIPTION_AUTORENEW', true),
    /** Renew once the remaining lifetime drops below this. */
    renewBeforeMinutes: number('SUBSCRIPTION_RENEW_BEFORE_MINUTES', 720),
    checkIntervalMs: number('SUBSCRIPTION_CHECK_INTERVAL_MS', 900_000),
  },
} as const;

export function assertGraphConfigured(): void {
  const missing = (
    [
      ['GRAPH_TENANT_ID', config.graph.tenantId],
      ['GRAPH_CLIENT_ID', config.graph.clientId],
      ['GRAPH_CLIENT_SECRET', config.graph.clientSecret],
      ['GRAPH_MAILBOX', config.graph.mailbox],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length) throw new Error(`Graph is not configured: ${missing.join(', ')} unset`);
}

export function assertStorageConfigured(): void {
  const missing = (
    [
      ['S3_BUCKET', config.storage.bucket],
      ['S3_ENDPOINT', config.storage.endpoint],
      ['S3_ACCESS_KEY_ID', config.storage.accessKeyId],
      ['S3_SECRET_ACCESS_KEY', config.storage.secretAccessKey],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length) throw new Error(`Object storage is not configured: ${missing.join(', ')} unset`);
}

export function isFullyConfigured(): boolean {
  try {
    assertGraphConfigured();
    assertStorageConfigured();
    return true;
  } catch {
    return false;
  }
}
