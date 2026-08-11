import Fastify from 'fastify';

import { config } from './config.js';
import { startConsumer } from './consumer.js';
import { pool, waitForDatabase } from './db.js';
import { migrate } from './migrate.js';
import { metrics as queueMetrics } from './queue.js';

/**
 * The HTTP surface exists for operations, not for traffic: a healthcheck
 * Coolify can poll, and enough visibility to answer "is it keeping up" and
 * "what failed" without opening psql.
 */
const app = Fastify({
  logger: { level: config.logLevel },
  trustProxy: true,
});

app.get('/healthz', async (request, reply) => {
  try {
    await pool.query('select 1');
  } catch (err) {
    request.log.error({ err }, 'healthcheck failed');
    return reply.code(503).send({ status: 'degraded', error: 'database unreachable' });
  }

  return { status: 'ok', uptime: process.uptime(), consumer: config.worker.enabled };
});

app.get('/api/stats', async () => {
  const [queue, documents, failures] = await Promise.all([
    queueMetrics(config.queue.name),
    pool.query<{ count: string; last: Date | null }>(
      `select count(*)::text as count, max(processed_at) as last from mail_documents`,
    ),
    pool.query<{ count: string }>(
      `select count(*)::text as count from mail_processing_failures where replayed_at is null`,
    ),
  ]);

  return {
    queue,
    documents: { total: Number(documents.rows[0].count), lastProcessedAt: documents.rows[0].last },
    deadLettered: Number(failures.rows[0].count),
  };
});

app.get('/api/documents', async (request) => {
  const query = request.query as { limit?: string; q?: string };
  const limit = Math.min(Number(query.limit ?? 20) || 20, 200);

  // Full-text when asked, most-recent-first otherwise.
  if (query.q) {
    const { rows } = await pool.query(
      `select resource_id, mailbox, subject, from_address, received_at, attachment_count,
              ts_rank(to_tsvector('english', coalesce(subject, '') || ' ' || coalesce(text_body, '')),
                      plainto_tsquery('english', $1)) as rank
         from mail_documents
        where to_tsvector('english', coalesce(subject, '') || ' ' || coalesce(text_body, ''))
              @@ plainto_tsquery('english', $1)
        order by rank desc
        limit $2`,
      [query.q, limit],
    );
    return { documents: rows };
  }

  const { rows } = await pool.query(
    `select resource_id, mailbox, subject, from_address, received_at,
            attachment_count, size_bytes, processed_at
       from mail_documents
      order by processed_at desc
      limit $1`,
    [limit],
  );
  return { documents: rows };
});

app.get('/api/documents/:resourceId', async (request, reply) => {
  const { resourceId } = request.params as { resourceId: string };

  const [document, attachments] = await Promise.all([
    pool.query(`select * from mail_documents where resource_id = $1`, [resourceId]),
    pool.query(
      `select position, filename, content_type, size_bytes, sha256, is_inline, object_key
         from mail_attachments where resource_id = $1 order by position`,
      [resourceId],
    ),
  ]);

  if (document.rowCount === 0) return reply.code(404).send({ error: 'not found' });
  return { document: document.rows[0], attachments: attachments.rows };
});

app.get('/api/failures', async (request) => {
  const limit = Math.min(Number((request.query as { limit?: string }).limit ?? 20) || 20, 200);
  const { rows } = await pool.query(
    `select id, resource_id, msg_id, read_ct, error, failed_at
       from mail_processing_failures
      where replayed_at is null
      order by failed_at desc
      limit $1`,
    [limit],
  );
  return { failures: rows };
});

/**
 * Put a dead letter back on the queue. The payload was preserved on the way
 * out, so this is a genuine replay rather than a reconstruction.
 */
app.post('/api/failures/:id/replay', async (request, reply) => {
  const { id } = request.params as { id: string };

  const replayed = await pool.query(
    `with failure as (
       select id, payload from mail_processing_failures
        where id = $1 and replayed_at is null
     ), requeued as (
       insert into mq_messages (queue, message)
       select $2, payload from failure
       returning msg_id
     )
     update mail_processing_failures
        set replayed_at = now()
      where id = (select id from failure)
      returning id`,
    [id, config.queue.name],
  );

  if (replayed.rowCount === 0) {
    return reply.code(404).send({ error: 'no un-replayed failure with that id' });
  }
  return { replayed: id };
});

let stopConsumer: (() => Promise<void>) | null = null;

async function start(): Promise<void> {
  await waitForDatabase();

  if (process.env.RUN_MIGRATIONS !== 'false') {
    await migrate();
  }

  if (config.worker.enabled) {
    stopConsumer = startConsumer(app.log);
    app.log.info(
      { queue: config.queue.name, concurrency: config.worker.concurrency },
      'consumer started',
    );
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`mailproc listening on http://${config.host}:${config.port}`);
}

async function shutdown(signal: string): Promise<void> {
  app.log.info(`received ${signal}, shutting down`);
  await app.close();
  await stopConsumer?.();
  await pool.end();
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
