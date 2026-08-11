import { config } from './config.js';
import { pool, waitForDatabase } from './db.js';
import { archive, metrics, read } from './queue.js';
import type { MailStoredEvent } from './worker.js';

/**
 * Reference consumer for the mail.stored queue.
 *
 * This is what a downstream service does: claim a batch, do the work, archive.
 * Two things it demonstrates that matter in real consumers:
 *
 *   * The visibility timeout is the safety net. If this process dies between
 *     read and archive, the message becomes visible again and someone else
 *     picks it up. Nothing is lost, so nothing needs a distributed transaction.
 *
 *   * Delivery is at-least-once, so handling must be idempotent. Every event
 *     carries message.resourceId and object.sha256 — dedupe on the former,
 *     verify with the latter.
 *
 * Run with: npm run consume -- --follow
 */

const follow = process.argv.includes('--follow');
const batch = Number(process.argv.find((arg) => arg.startsWith('--batch='))?.split('=')[1] ?? 10);
const visibilitySeconds = 60;

async function handle(event: MailStoredEvent): Promise<void> {
  console.log(
    [
      `${event.message.receivedAt ?? 'unknown time'}`,
      `from=${event.message.from ?? '?'}`,
      `subject=${JSON.stringify(event.message.subject ?? '')}`,
      `-> s3://${event.object.bucket}/${event.object.key}`,
      `(${event.object.sizeBytes} bytes)`,
    ].join(' '),
  );
}

async function drain(): Promise<number> {
  const messages = await read<MailStoredEvent>(config.queue.name, batch, visibilitySeconds);

  for (const message of messages) {
    try {
      await handle(message.message);
      await archive(message.msgId);
    } catch (err) {
      // Leave it alone: the visibility timeout expires and it comes back.
      console.error(`failed to handle msg ${message.msgId} (read ${message.readCt}x):`, err);
    }
  }

  return messages.length;
}

async function main(): Promise<void> {
  await waitForDatabase();
  console.log(`consuming queue "${config.queue.name}"`, follow ? '(following)' : '');

  do {
    const handled = await drain();
    if (handled === 0) {
      if (!follow) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  } while (follow);

  console.log(await metrics(config.queue.name));
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
