import { createHash, timingSafeEqual } from 'node:crypto';

import Fastify, { type FastifyBaseLogger, type FastifyRequest } from 'fastify';

import { config, isFullyConfigured } from './config.js';
import { pool, waitForDatabase } from './db.js';
import { migrate } from './migrate.js';
import { recordNotification, stats as intakeStats } from './intake.js';
import { metrics as queueMetrics } from './queue.js';
import { checkBucket } from './storage.js';
import { markRemoved, renew, startRenewer } from './subscriptions.js';
import { catchUp, startWorker, storeAndPublish } from './worker.js';

const app = Fastify({
  logger: { level: config.logLevel },
  // Coolify puts Traefik in front of the container.
  trustProxy: true,
  // Graph batches up to 1000 notifications; the default 1MB limit is plenty,
  // but be explicit about it rather than discovering it under load.
  bodyLimit: 2 * 1024 * 1024,
});

/**
 * Graph's validation handshake POSTs with an empty body, and it does not always
 * send a JSON content type. Fastify rejects both by default (empty body with
 * `application/json` is FST_ERR_CTP_EMPTY_JSON_BODY, and an unregistered type
 * is a 415), which fails the handshake and makes the subscription impossible
 * to create. Both parsers below exist to avoid that.
 */
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
  const raw = typeof body === 'string' ? body.trim() : '';
  if (!raw) return done(null, {});
  try {
    done(null, JSON.parse(raw));
  } catch (err) {
    done(err as Error, undefined);
  }
});

app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_request, body, done) => {
  done(null, body);
});

if (config.devIngest) {
  app.addContentTypeParser(
    ['message/rfc822', 'application/octet-stream'],
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    },
  );
}

// --- notification payloads ------------------------------------------------

interface ChangeNotification {
  subscriptionId?: string;
  subscriptionExpirationDateTime?: string;
  changeType?: string;
  resource?: string;
  resourceData?: { id?: string };
  clientState?: string;
  tenantId?: string;
}

interface LifecycleNotification {
  subscriptionId?: string;
  lifecycleEvent?: 'reauthorizationRequired' | 'subscriptionRemoved' | 'missed';
  clientState?: string;
  resource?: string;
}

/**
 * Graph does not sign change notifications, so clientState is the whole of the
 * authentication story for this endpoint. Compare it in constant time: a naive
 * `===` on a secret compared thousands of times a day is a byte-at-a-time
 * oracle, and the URL is public by construction.
 */
function clientStateValid(candidate: string | undefined): boolean {
  if (!candidate) return false;
  const expected = Buffer.from(config.webhook.clientState);
  const actual = Buffer.from(candidate);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * Graph validates a notification URL by POSTing `?validationToken=...` and
 * requiring the raw token back as text/plain within 10 seconds. Handle it
 * before anything else — there is no clientState on a validation request.
 */
function handleValidation(request: FastifyRequest): string | null {
  const token = (request.query as Record<string, string | undefined>)?.validationToken;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

// --- routes ---------------------------------------------------------------

/**
 * Kept cheap: the container healthcheck and Coolify both poll it, and a
 * healthcheck that talks to Graph or S3 turns a third-party blip into a
 * redeploy. `?deep=1` opts into the bucket round-trip for manual checks.
 */
app.get('/healthz', async (request, reply) => {
  try {
    await pool.query('select 1');
  } catch (err) {
    request.log.error({ err }, 'healthcheck failed');
    return reply.code(503).send({ status: 'degraded', error: 'database unreachable' });
  }

  if ((request.query as { deep?: string }).deep) {
    try {
      await checkBucket();
    } catch (err) {
      request.log.error({ err }, 'bucket check failed');
      return reply.code(503).send({ status: 'degraded', error: 'bucket unreachable' });
    }
  }

  return {
    status: 'ok',
    uptime: process.uptime(),
    configured: isFullyConfigured(),
    worker: config.worker.enabled,
  };
});

/**
 * The mail notification endpoint.
 *
 * The only work done here is one INSERT per notification. Graph gives about
 * three seconds before it treats the delivery as failed, and it retries a
 * bounded number of times before dropping notifications entirely — so fetching
 * the message or writing to the bucket on this path would trade a durable
 * pipeline for a lossy one.
 */
app.post(config.webhook.notifyPath, async (request, reply) => {
  const validationToken = handleValidation(request);
  if (validationToken) {
    request.log.info('graph subscription validation handshake');
    return reply.code(200).type('text/plain').send(validationToken);
  }

  const body = request.body as { value?: ChangeNotification[] } | undefined;
  const notifications = body?.value ?? [];

  let accepted = 0;
  let rejected = 0;
  let duplicates = 0;

  for (const notification of notifications) {
    if (!clientStateValid(notification.clientState)) {
      rejected++;
      continue;
    }

    const resourceId = notification.resourceData?.id ?? notification.resource?.split('/').pop();
    if (!notification.resource || !resourceId) {
      request.log.warn({ notification }, 'notification without a usable resource');
      rejected++;
      continue;
    }

    const inserted = await recordNotification({
      subscriptionId: notification.subscriptionId ?? 'unknown',
      tenantId: notification.tenantId ?? null,
      changeType: notification.changeType ?? 'created',
      resource: notification.resource,
      resourceId,
      source: 'webhook',
    });

    if (inserted) accepted++;
    else duplicates++;
  }

  if (rejected > 0) {
    request.log.warn({ rejected, accepted }, 'rejected notifications with a bad clientState');
  }

  // Everything valid was rejected: this is not our subscription talking.
  if (accepted === 0 && duplicates === 0 && rejected > 0) {
    return reply.code(403).send({ error: 'invalid clientState' });
  }

  request.log.info({ accepted, duplicates }, 'notifications recorded');
  return reply.code(202).send();
});

/**
 * Lifecycle events. These are the ones that decide whether the pipeline is
 * still alive in a week: `reauthorizationRequired` must be answered with a
 * renewal, and `missed` means Graph knows it dropped notifications and is
 * telling you to go and look.
 */
app.post(config.webhook.lifecyclePath, async (request, reply) => {
  const validationToken = handleValidation(request);
  if (validationToken) {
    return reply.code(200).type('text/plain').send(validationToken);
  }

  const body = request.body as { value?: LifecycleNotification[] } | undefined;
  const events = (body?.value ?? []).filter((event) => clientStateValid(event.clientState));

  // Ack first, act after: renewals and catch-up sweeps both call Graph, and
  // neither fits inside the response budget. Handling is idempotent, so a
  // lifecycle event Graph redelivers costs nothing.
  void handleLifecycleEvents(events, request.log);
  return reply.code(202).send();
});

async function handleLifecycleEvents(
  events: LifecycleNotification[],
  log: FastifyBaseLogger,
): Promise<void> {
  for (const event of events) {
    const subscriptionId = event.subscriptionId;
    try {
      switch (event.lifecycleEvent) {
        case 'reauthorizationRequired':
          if (subscriptionId) {
            await renew(subscriptionId);
            log.info({ subscriptionId }, 'reauthorized subscription');
          }
          break;

        case 'subscriptionRemoved':
          if (subscriptionId) await markRemoved(subscriptionId);
          log.error(
            { subscriptionId },
            'graph removed the subscription — recreate it with `npm run sub -- create`',
          );
          break;

        case 'missed':
          log.warn({ subscriptionId }, 'graph reported missed notifications, sweeping');
          await catchUp(log);
          break;

        default:
          log.warn({ event }, 'unknown lifecycle event');
      }
    } catch (err) {
      log.error({ err, subscriptionId }, 'lifecycle handling failed');
    }
  }
}

app.get('/api/stats', async () => {
  const [intake, queue] = await Promise.all([intakeStats(), queueMetrics(config.queue.name)]);
  return { intake, queue };
});

app.get('/api/messages', async (request) => {
  const limit = Math.min(Number((request.query as { limit?: string }).limit ?? 20) || 20, 200);
  const { rows } = await pool.query(
    `select resource_id, mailbox, subject, from_address, received_at,
            bucket, object_key, size_bytes, stored_at
       from mail_objects
      order by stored_at desc
      limit $1`,
    [limit],
  );
  return { messages: rows };
});

/**
 * Dev-only: push a raw .eml straight through the store-and-publish path.
 *
 *   curl -sS --data-binary @fixture.eml -H 'content-type: message/rfc822' \
 *     http://localhost:3001/dev/ingest
 *
 * It exercises the real bucket write and the real enqueue, so a local run with
 * MinIO proves the whole downstream half without a Microsoft 365 tenant.
 */
if (config.devIngest) {
  app.post('/dev/ingest', async (request, reply) => {
    const mime = request.body as Buffer;
    if (!Buffer.isBuffer(mime) || mime.byteLength === 0) {
      return reply.code(400).send({ error: 'expected a raw message body' });
    }

    const header = (name: string): string | undefined => {
      const match = new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(
        mime.subarray(0, 8_192).toString('utf8'),
      );
      return match?.[1]?.trim();
    };

    const internetMessageId = header('Message-ID');
    const date = header('Date');
    const resourceId = `dev-${createHash('sha256').update(mime).digest('hex').slice(0, 32)}`;

    const event = await storeAndPublish({
      mailbox: config.graph.mailbox || 'dev@localhost',
      resourceId,
      mime,
      metadata: {
        id: resourceId,
        internetMessageId,
        subject: header('Subject'),
        from: { emailAddress: { address: header('From') } },
        receivedDateTime: (date ? new Date(date) : new Date()).toISOString(),
        hasAttachments: /^content-type:\s*multipart\//im.test(mime.subarray(0, 8_192).toString()),
      },
      source: {
        intakeId: '0',
        subscriptionId: 'dev',
        changeType: 'created',
        resource: `dev/${resourceId}`,
      },
    });

    return reply.code(201).send({ key: event.object.key, sha256: event.object.sha256 });
  });
}

/** Ops escape hatch: push a failed intake row back into the worker's path. */
app.post('/api/intake/:id/replay', async (request, reply) => {
  const { id } = request.params as { id: string };
  const { rowCount } = await pool.query(
    `update mail_intake
        set state = 'pending', next_attempt_at = now(), attempts = 0, locked_until = null
      where id = $1 and state in ('failed', 'gone')`,
    [id],
  );
  if (!rowCount) return reply.code(404).send({ error: 'no replayable intake row with that id' });
  return { replayed: id };
});

// --- lifecycle ------------------------------------------------------------

let stopWorker: (() => Promise<void>) | null = null;
let stopRenewer: (() => void) | null = null;

async function start(): Promise<void> {
  await waitForDatabase();

  if (process.env.RUN_MIGRATIONS !== 'false') {
    await migrate();
  }

  if (config.worker.enabled) {
    stopWorker = startWorker(app.log);
    app.log.info('worker started');

    if (config.subscriptions.autoRenew && config.webhook.publicUrl) {
      stopRenewer = startRenewer(app.log);
      app.log.info('subscription renewer started');
    }
  }

  if (!isFullyConfigured()) {
    app.log.warn(
      'graph or object storage is not fully configured — notifications will be recorded but not processed',
    );
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`mailhook listening on http://${config.host}:${config.port}`);
}

async function shutdown(signal: string): Promise<void> {
  app.log.info(`received ${signal}, shutting down`);
  // Stop accepting first, then let the in-flight batch finish: a message
  // interrupted between the bucket write and the commit is safe (it replays),
  // but there is no reason to cause one.
  await app.close();
  stopRenewer?.();
  await stopWorker?.();
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
