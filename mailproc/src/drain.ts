import { pino } from 'pino';

import { config } from './config.js';
import { runOnce } from './consumer.js';
import { pool, waitForDatabase } from './db.js';
import { metrics } from './queue.js';

/**
 * Process whatever is on the queue right now, then exit.
 *
 * Useful in three places: proving a local run end to end, draining a backlog
 * after a fix without waiting on the poll interval, and running the consumer as
 * a scheduled job instead of a long-lived service.
 */
const log = pino({ level: config.logLevel });

async function main(): Promise<void> {
  await waitForDatabase();

  let total = 0;
  for (;;) {
    const claimed = await runOnce(log);
    if (claimed === 0) break;
    total += claimed;
  }

  log.info({ processed: total, ...(await metrics(config.queue.name)) }, 'drain complete');
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
