import type { FastifyBaseLogger } from 'fastify';
import type { PoolClient } from 'pg';

import { config } from './config.js';
import { withTransaction } from './db.js';
import {
  claimBatch,
  getState,
  markDone,
  markGone,
  markRetry,
  reapExpiredLeases,
  recordNotification,
  setState,
  type IntakeRow,
} from './intake.js';
import {
  GraphError,
  fetchMessageMetadata,
  fetchMessageMime,
  listMessagesSince,
  type GraphMessage,
} from './graph.js';
import { send } from './queue.js';
import { objectKeyFor, objectUrl, putMessage } from './storage.js';

/**
 * The worker: intake row -> Graph -> bucket -> queue.
 *
 * The ordering is the point of the whole design. The queue event is the
 * promise "this email is in the bucket at this key", so it is only ever
 * written after the PUT has been acknowledged, and it is written in the same
 * transaction that marks the intake row done. There is no window where a
 * consumer can see an event for an object that is not there.
 *
 * The reverse window does exist — object written, process dies before commit —
 * and it resolves by replay: the lease expires, the row goes back to pending,
 * and the re-run rewrites the identical object under the identical key before
 * enqueuing. At-least-once end to end, never at-most-once.
 */

export const MAIL_STORED = 'mail.stored';

export interface MailStoredEvent {
  type: typeof MAIL_STORED;
  version: 1;
  occurredAt: string;
  mailbox: string;
  message: {
    resourceId: string;
    internetMessageId: string | null;
    subject: string | null;
    from: string | null;
    to: string[];
    receivedAt: string | null;
    hasAttachments: boolean;
    conversationId: string | null;
  };
  object: {
    bucket: string;
    key: string;
    region: string;
    endpoint: string;
    url: string;
    sizeBytes: number;
    sha256: string;
    contentType: 'message/rfc822';
  };
  source: {
    intakeId: string;
    subscriptionId: string;
    changeType: string;
    resource: string;
  };
}

function mailboxOf(row: IntakeRow): string {
  // Notifications carry `Users/{id}/Messages/{id}`; that object id is the
  // authoritative mailbox even when we subscribed by UPN.
  const match = /users\/([^/]+)/i.exec(row.resource);
  return row.mailbox ?? match?.[1] ?? config.graph.mailbox;
}

/**
 * Write the message to the bucket, then record it and publish the event in one
 * transaction. `onCommit` runs inside that transaction, which is how the intake
 * row's completion and the queue event become a single atomic fact.
 */
export async function storeAndPublish(input: {
  mailbox: string;
  resourceId: string;
  mime: Buffer;
  metadata: GraphMessage;
  source: MailStoredEvent['source'];
  onCommit?: (client: PoolClient) => Promise<void>;
}): Promise<MailStoredEvent> {
  const { mailbox, resourceId, mime, metadata } = input;

  const receivedAt = metadata.receivedDateTime ? new Date(metadata.receivedDateTime) : undefined;
  const key = objectKeyFor({ mailbox, resourceId, receivedAt });

  const stored = await putMessage({
    key,
    body: mime,
    internetMessageId: metadata.internetMessageId,
    resourceId,
    mailbox,
  });

  const event: MailStoredEvent = {
    type: MAIL_STORED,
    version: 1,
    occurredAt: new Date().toISOString(),
    mailbox,
    message: {
      resourceId,
      internetMessageId: metadata.internetMessageId ?? null,
      subject: metadata.subject ?? null,
      from: metadata.from?.emailAddress?.address ?? null,
      to: (metadata.toRecipients ?? [])
        .map((recipient) => recipient.emailAddress?.address)
        .filter((address): address is string => Boolean(address)),
      receivedAt: metadata.receivedDateTime ?? null,
      hasAttachments: metadata.hasAttachments ?? false,
      conversationId: metadata.conversationId ?? null,
    },
    object: {
      bucket: stored.bucket,
      key: stored.key,
      region: config.storage.region,
      endpoint: config.storage.endpoint,
      url: objectUrl(stored.key),
      sizeBytes: stored.size,
      sha256: stored.sha256,
      contentType: 'message/rfc822',
    },
    source: input.source,
  };

  await withTransaction(async (client) => {
    await client.query(
      `insert into mail_objects
         (resource_id, mailbox, internet_message_id, subject, from_address, received_at,
          has_attachments, bucket, object_key, size_bytes, sha256, etag)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (resource_id) do update set
         bucket = excluded.bucket,
         object_key = excluded.object_key,
         size_bytes = excluded.size_bytes,
         sha256 = excluded.sha256,
         etag = excluded.etag,
         stored_at = now()`,
      [
        resourceId,
        mailbox,
        event.message.internetMessageId,
        event.message.subject,
        event.message.from,
        event.message.receivedAt,
        event.message.hasAttachments,
        stored.bucket,
        stored.key,
        stored.size,
        stored.sha256,
        stored.etag ?? null,
      ],
    );

    // Only ever after the PUT above returned: the event is a promise that the
    // object is there.
    await send(config.queue.name, event, { client });
    await input.onCommit?.(client);
  });

  return event;
}

async function processIntake(row: IntakeRow, log: FastifyBaseLogger): Promise<void> {
  const mailbox = mailboxOf(row);

  const metadata = await fetchMessageMetadata(row.resource);
  const mime = await fetchMessageMime(row.resource);

  const event = await storeAndPublish({
    mailbox,
    resourceId: row.resource_id,
    mime,
    metadata,
    source: {
      intakeId: row.id,
      subscriptionId: row.subscription_id,
      changeType: row.change_type,
      resource: row.resource,
    },
    onCommit: (client) => markDone(row.id, client),
  });

  log.info(
    {
      intakeId: row.id,
      key: event.object.key,
      bytes: event.object.sizeBytes,
      mailbox,
    },
    'email archived and queued',
  );
}

async function runBatch(log: FastifyBaseLogger): Promise<number> {
  const rows = await claimBatch(config.worker.batch, config.worker.lockSeconds);
  if (rows.length === 0) return 0;

  // Sequential on purpose: Graph throttles per-app, and a burst of parallel
  // $value fetches is the quickest route to a 429 that slows everything down.
  for (const row of rows) {
    try {
      await processIntake(row, log);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (err instanceof GraphError && err.isGone) {
        await markGone(row.id, message);
        log.warn({ intakeId: row.id, resource: row.resource }, 'message no longer in mailbox');
        continue;
      }

      const outcome = await markRetry(row.id, row.attempts, message, {
        maxAttempts: config.worker.maxAttempts,
        backoffSeconds: config.worker.backoffSeconds,
      });
      log[outcome === 'failed' ? 'error' : 'warn'](
        { err, intakeId: row.id, attempts: row.attempts, outcome },
        'intake processing failed',
      );
    }
  }

  return rows.length;
}

const CATCHUP_CURSOR = 'catchup:last_received_at';

/**
 * Graph's change notifications are best-effort — the docs say so outright, and
 * a `missed` lifecycle event tells you something was lost without telling you
 * what. This sweep asks the folder directly for anything received since the
 * last message we saw and feeds it through the same intake path, where the
 * dedupe index absorbs everything the webhook already delivered.
 */
export async function catchUp(log: FastifyBaseLogger): Promise<number> {
  const cursor = await getState(CATCHUP_CURSOR);
  const since = cursor
    ? new Date(cursor)
    : new Date(Date.now() - config.catchUp.coldStartHours * 3_600_000);

  const messages = await listMessagesSince(since, config.catchUp.pageSize);
  if (messages.length === 0) return 0;

  const mailbox = encodeURIComponent(config.graph.mailbox);
  let inserted = 0;
  let latest = since;

  for (const message of messages) {
    if (!message.id) continue;

    const added = await recordNotification({
      subscriptionId: 'catchup',
      changeType: 'created',
      resource: `users/${mailbox}/messages/${message.id}`,
      resourceId: message.id,
      mailbox: config.graph.mailbox,
      source: 'catchup',
    });
    if (added) inserted++;

    const receivedAt = message.receivedDateTime ? new Date(message.receivedDateTime) : null;
    if (receivedAt && receivedAt > latest) latest = receivedAt;
  }

  // Only advance once the rows are committed, so a crash re-reads the window
  // rather than skipping it.
  if (latest > since) await setState(CATCHUP_CURSOR, latest.toISOString());

  if (inserted > 0) {
    log.warn({ inserted, scanned: messages.length }, 'catch-up found messages the webhook missed');
  }
  return inserted;
}

/** Start the polling loops. Returns a stop function for graceful shutdown. */
export function startWorker(log: FastifyBaseLogger): () => Promise<void> {
  let running = true;
  let idle: NodeJS.Timeout | null = null;

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      idle = setTimeout(resolve, ms);
    });

  const loop = (async () => {
    while (running) {
      try {
        const reaped = await reapExpiredLeases();
        if (reaped > 0) log.warn({ reaped }, 'returned expired leases to the queue');

        const processed = await runBatch(log);
        // A full batch probably means more is waiting; go straight round again.
        if (processed === config.worker.batch) continue;
      } catch (err) {
        log.error({ err }, 'worker loop error');
      }
      await wait(config.worker.pollMs);
    }
  })();

  const timers: NodeJS.Timeout[] = [];

  if (config.catchUp.enabled) {
    timers.push(
      setInterval(() => {
        catchUp(log).catch((err) => log.error({ err }, 'catch-up sweep failed'));
      }, config.catchUp.intervalMs),
    );
  }

  return async () => {
    running = false;
    if (idle) clearTimeout(idle);
    for (const timer of timers) clearInterval(timer);
    await loop;
  };
}
