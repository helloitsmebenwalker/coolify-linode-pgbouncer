import { config, assertGraphConfigured } from './config.js';

/**
 * Microsoft Graph client, app-only (client credentials).
 *
 * Deliberately dependency-free: the client-credentials flow is one form POST,
 * and pulling in MSAL to do it would be the largest dependency in the service.
 *
 * Permissions needed on the app registration (application, admin-consented):
 *   Mail.Read       — read the message and its MIME body
 * Scope it down with an application access policy so the app can only read the
 * mailboxes you intend, otherwise Mail.Read means *every* mailbox in the tenant:
 *   New-ApplicationAccessPolicy -AppId <client-id> -PolicyScopeGroupId <group> \
 *     -AccessRight RestrictAccess
 */

export interface GraphMessage {
  id: string;
  internetMessageId?: string;
  subject?: string;
  receivedDateTime?: string;
  hasAttachments?: boolean;
  conversationId?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
}

export interface GraphSubscription {
  id: string;
  resource: string;
  changeType: string;
  notificationUrl: string;
  lifecycleNotificationUrl?: string;
  expirationDateTime: string;
  clientState?: string;
}

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }

  /** 404/410 mean the message is gone — a retry will never succeed. */
  get isGone(): boolean {
    return this.status === 404 || this.status === 410;
  }

  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  assertGraphConfigured();

  // 60s of slack so a token never expires mid-request.
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  const url = `${config.graph.loginUrl}/${config.graph.tenantId}/oauth2/v2.0/token`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.graph.clientId,
      client_secret: config.graph.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    }),
    signal: AbortSignal.timeout(config.graph.timeoutMs),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new GraphError(`token request failed (${response.status})`, response.status, text);
  }

  const payload = JSON.parse(text) as { access_token: string; expires_in: number };
  cachedToken = {
    value: payload.access_token,
    expiresAt: Date.now() + payload.expires_in * 1_000,
  };
  return cachedToken.value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One Graph call, with throttling handled.
 *
 * Graph answers 429 with a Retry-After that it genuinely means; ignoring it is
 * the fastest way to get an app registration throttled harder. 5xx gets the
 * same treatment with exponential backoff.
 */
async function request(
  path: string,
  init: RequestInit & { attempts?: number } = {},
): Promise<Response> {
  const { attempts = 4, ...rest } = init;
  const url = path.startsWith('http') ? path : `${config.graph.baseUrl}/${path.replace(/^\//, '')}`;

  let lastError: GraphError | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const token = await accessToken();
    const response = await fetch(url, {
      ...rest,
      headers: {
        authorization: `Bearer ${token}`,
        ...(rest.headers ?? {}),
      },
      signal: AbortSignal.timeout(config.graph.timeoutMs),
    });

    if (response.ok) return response;

    const body = await response.text();

    // A 401 on a token we believed was valid: drop it and try once more.
    if (response.status === 401 && attempt < attempts) {
      cachedToken = null;
      continue;
    }

    lastError = new GraphError(
      `graph ${rest.method ?? 'GET'} ${url} failed (${response.status})`,
      response.status,
      body.slice(0, 2_000),
    );

    if (!lastError.isRetryable || attempt === attempts) throw lastError;

    const retryAfter = Number(response.headers.get('retry-after'));
    const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1_000
      : Math.min(30_000, 500 * 2 ** attempt);
    await sleep(delayMs);
  }

  throw lastError ?? new GraphError(`graph request to ${url} failed`, 0, '');
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await request(path, {
    ...init,
    headers: { accept: 'application/json', ...(init.headers ?? {}) },
  });
  return (await response.json()) as T;
}

// --- messages -------------------------------------------------------------

const MESSAGE_FIELDS =
  'id,internetMessageId,subject,receivedDateTime,hasAttachments,conversationId,from,toRecipients';

/**
 * `resource` arrives on the notification looking like
 * `Users/{id}/Messages/{id}` and is usable as a Graph path verbatim, which is
 * more robust than reassembling it from parts we guessed at.
 */
export function fetchMessageMetadata(resource: string): Promise<GraphMessage> {
  return requestJson<GraphMessage>(`${resource}?$select=${MESSAGE_FIELDS}`);
}

/**
 * The full RFC 5322 message, headers and attachments included. This is the
 * thing worth archiving — the JSON representation is lossy.
 */
export async function fetchMessageMime(resource: string): Promise<Buffer> {
  const response = await request(`${resource}/$value`, { headers: { accept: 'message/rfc822' } });
  return Buffer.from(await response.arrayBuffer());
}

/** Folder path for the watched mailbox, used by subscriptions and catch-up. */
export function mailFolderResource(): string {
  const mailbox = encodeURIComponent(config.graph.mailbox);
  const folder = config.graph.mailFolder;
  return `users/${mailbox}/mailFolders('${encodeURIComponent(folder)}')/messages`;
}

/** Messages received strictly after `since`, oldest first. */
export async function listMessagesSince(
  since: Date,
  top = 50,
): Promise<Pick<GraphMessage, 'id' | 'receivedDateTime'>[]> {
  const params = new URLSearchParams({
    $filter: `receivedDateTime gt ${since.toISOString()}`,
    $orderby: 'receivedDateTime asc',
    $top: String(top),
    $select: 'id,receivedDateTime',
  });

  const payload = await requestJson<{ value: GraphMessage[] }>(
    `${mailFolderResource()}?${params.toString()}`,
  );
  return payload.value ?? [];
}

// --- subscriptions --------------------------------------------------------

export function subscriptionExpiry(minutes = config.subscriptions.lifetimeMinutes): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

export function createSubscription(input: {
  resource: string;
  notificationUrl: string;
  lifecycleNotificationUrl?: string;
  clientState: string;
  changeType?: string;
  expirationDateTime?: string;
}): Promise<GraphSubscription> {
  return requestJson<GraphSubscription>('subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      changeType: input.changeType ?? 'created',
      notificationUrl: input.notificationUrl,
      lifecycleNotificationUrl: input.lifecycleNotificationUrl,
      resource: input.resource,
      clientState: input.clientState,
      expirationDateTime: input.expirationDateTime ?? subscriptionExpiry(),
    }),
  });
}

export function renewSubscription(
  subscriptionId: string,
  expirationDateTime = subscriptionExpiry(),
): Promise<GraphSubscription> {
  return requestJson<GraphSubscription>(`subscriptions/${subscriptionId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expirationDateTime }),
  });
}

export async function deleteSubscription(subscriptionId: string): Promise<void> {
  await request(`subscriptions/${subscriptionId}`, { method: 'DELETE' });
}

export async function listSubscriptions(): Promise<GraphSubscription[]> {
  const payload = await requestJson<{ value: GraphSubscription[] }>('subscriptions');
  return payload.value ?? [];
}
