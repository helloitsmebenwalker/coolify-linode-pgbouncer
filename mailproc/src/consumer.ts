import type { FastifyBaseLogger } from 'fastify';

import { config } from './config.js';
import { withTransaction } from './db.js';
import { InvalidEventError, parseMailStoredEvent } from './events.js';
import { processEvent } from './pipeline.js';
import { archive, read, type QueueMessage } from './queue.js';
import { ObjectMismatchError } from './storage.js';

/**
 * The consume loop.
 *
 * Failure handling splits into two kinds, and telling them apart is most of
 * what this file does:
 *
 *   Transient — S3 blipped, the database went away, the object is not visible
 *   yet. Do nothing: the visibility timeout expires and the message comes back
 *   on its own. Explicitly *not* acknowledged, explicitly not deleted.
 *
 *   Poison — the payload is malformed, or names a bucket we are not allowed to
 *   read. Retrying cannot change the outcome, and a message that can never
 *   succeed will otherwise be redelivered until the end of time. Dead-letter it
 *   immediately.
 *
 * `read_ct` catches everything in between: a transient failure that turns out
 * to be permanent stops after QUEUE_MAX_ATTEMPTS deliveries.
 */

/**
 * Park a message in mail_processing_failures and take it off the queue, in one
 * transaction — the payload is preserved for inspection and replay, so nothing
 * is actually thrown away.
 */
async function deadLetter(
  message: QueueMessage<unknown>,
  error: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const payload = message.message as { message?: { resourceId?: string } } | null;
  const resourceId = payload?.message?.resourceId ?? null;

  await withTransaction(async (client) => {
    await client.query(
      `insert into mail_processing_failures (resource_id, msg_id, read_ct, error, payload)
       values ($1, $2, $3, $4, $5::jsonb)`,
      [resourceId, message.msgId, message.readCt, error.slice(0, 4_000), JSON.stringify(message.message)],
    );
    await archive(message.msgId, client);
  });

  log.error({ msgId: message.msgId, resourceId, readCt: message.readCt, error }, 'dead-lettered');
}

async function handleMessage(
  message: QueueMessage<unknown>,
  log: FastifyBaseLogger,
): Promise<void> {
  // read_ct is incremented by the claim, so it counts this delivery too.
  if (message.readCt > config.queue.maxAttempts) {
    await deadLetter(
      message,
      `exceeded ${config.queue.maxAttempts} delivery attempts`,
      log,
    );
    return;
  }

  let event;
  try {
    event = parseMailStoredEvent(message.message);
  } catch (err) {
    // Malformed now, malformed forever.
    await deadLetter(message, err instanceof Error ? err.message : String(err), log);
    return;
  }

  try {
    const result = await processEvent(event, message.msgId);
    log.info(
      {
        msgId: message.msgId,
        resourceId: result.resourceId,
        attachments: result.attachments,
        bytes: result.bytes,
      },
      'email processed',
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);

    // A bucket we are not allowed to read, or bytes that do not match the
    // checksum the producer published, will not fix themselves.
    if (err instanceof InvalidEventError || err instanceof ObjectMismatchError) {
      await deadLetter(message, reason, log);
      return;
    }

    // Anything else: leave it. The lease expires and it comes back.
    log.warn(
      { err, msgId: message.msgId, readCt: message.readCt, resourceId: event.message.resourceId },
      'processing failed, message will be redelivered',
    );
  }
}

/** Run `limit` handlers at a time over the batch. */
async function mapWithConcurrency(
  messages: QueueMessage<unknown>[],
  limit: number,
  log: FastifyBaseLogger,
): Promise<void> {
  const queue = [...messages];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      await handleMessage(next, log);
    }
  });
  await Promise.all(runners);
}

/** One poll. Returns how many messages were claimed. */
export async function runOnce(log: FastifyBaseLogger): Promise<number> {
  const messages = await read<unknown>(
    config.queue.name,
    config.queue.batch,
    config.queue.visibilitySeconds,
  );
  if (messages.length === 0) return 0;

  await mapWithConcurrency(messages, config.worker.concurrency, log);
  return messages.length;
}

export function startConsumer(log: FastifyBaseLogger): () => Promise<void> {
  let running = true;
  let idle: NodeJS.Timeout | null = null;

  const loop = (async () => {
    while (running) {
      try {
        const claimed = await runOnce(log);
        // A full batch means there is probably more waiting.
        if (claimed === config.queue.batch) continue;
      } catch (err) {
        log.error({ err }, 'consumer loop error');
      }
      await new Promise<void>((resolve) => {
        idle = setTimeout(resolve, config.queue.pollMs);
      });
    }
  })();

  return async () => {
    running = false;
    if (idle) clearTimeout(idle);
    // Let the in-flight batch finish; its leases are held either way.
    await loop;
  };
}
