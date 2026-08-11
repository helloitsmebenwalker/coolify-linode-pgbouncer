import pg from 'pg';

const { Pool } = pg;

const rawConnectionString = process.env.DATABASE_URL;

if (!rawConnectionString) {
  throw new Error('DATABASE_URL is not set');
}

const url = new URL(rawConnectionString);
const sslmode = url.searchParams.get('sslmode') ?? 'disable';

/**
 * `sslmode` has to come OUT of the connection string before `pg` sees it — see
 * app/src/db.ts for the full explanation. Short version: pg-connection-string
 * builds its own `ssl` object from `sslmode` and it lands last, silently
 * discarding the CA passed below.
 */
url.searchParams.delete('sslmode');
const connectionString = url.toString();

function sslConfig(): false | { ca?: string; rejectUnauthorized: boolean } {
  if (sslmode === 'disable') return false;

  const ca = process.env.DATABASE_CA_CERT;
  if (ca) return { ca, rejectUnauthorized: true };

  return { rejectUnauthorized: sslmode === 'verify-ca' || sslmode === 'verify-full' };
}

/**
 * Everything this service does is a single-statement claim or a two-statement
 * transaction, so it is safe to point DATABASE_URL at the PgBouncer pool in
 * transaction mode. What it must NOT do is rely on session state — hence the
 * queue polls with SKIP LOCKED instead of using LISTEN/NOTIFY, which
 * transaction pooling breaks.
 */
export const pool = new Pool({
  connectionString,
  ssl: sslConfig(),
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export async function waitForDatabase(attempts = 30, delayMs = 2_000): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await pool.query('select 1');
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      console.log(`database not ready (attempt ${attempt}/${attempts}), retrying...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** Run `fn` inside a transaction on a single checked-out connection. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
