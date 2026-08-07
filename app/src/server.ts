import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

import { pool, waitForDatabase } from './db.js';
import { migrate } from './migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? process.env.APP_PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const GREETING = process.env.GREETING ?? 'Hello from Coolify on Linode';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
  // Coolify puts Traefik in front of the container.
  trustProxy: true,
});

// The compiled server lives in dist/, so public/ is one level up.
await app.register(fastifyStatic, {
  root: join(__dirname, '..', 'public'),
  prefix: '/',
  index: false,
});

app.get('/', async (_request, reply) => {
  return reply.sendFile('index.html');
});

/**
 * Liveness + readiness. Coolify's healthcheck and the compose healthcheck both
 * hit this, so it must stay cheap and must fail when the DB is unreachable.
 */
app.get('/healthz', async (_request, reply) => {
  try {
    await pool.query('select 1');
    return { status: 'ok', uptime: process.uptime() };
  } catch (err) {
    app.log.error({ err }, 'healthcheck failed');
    return reply.code(503).send({ status: 'degraded', error: 'database unreachable' });
  }
});

app.get('/api/info', async () => {
  return {
    greeting: GREETING,
    environment: process.env.NODE_ENV ?? 'development',
    // Coolify injects these; they're handy for confirming which build is live.
    commit: process.env.SOURCE_COMMIT ?? 'unknown',
    hostname: process.env.HOSTNAME ?? 'unknown',
    node: process.version,
  };
});

app.post('/api/visits', async (request) => {
  const userAgent = request.headers['user-agent'] ?? null;
  const { rows } = await pool.query<{ id: string; created_at: Date }>(
    'insert into visits (path, user_agent) values ($1, $2) returning id, created_at',
    ['/', userAgent],
  );
  return rows[0];
});

app.get('/api/visits', async () => {
  const [{ rows: recent }, { rows: counted }] = await Promise.all([
    pool.query('select id, path, created_at from visits order by created_at desc limit 10'),
    pool.query<{ count: string }>('select count(*)::text as count from visits'),
  ]);
  return { total: Number(counted[0].count), recent };
});

async function start() {
  await waitForDatabase();

  if (process.env.RUN_MIGRATIONS !== 'false') {
    await migrate();
  }

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`listening on http://${HOST}:${PORT}`);
}

async function shutdown(signal: string) {
  app.log.info(`received ${signal}, shutting down`);
  await app.close();
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
