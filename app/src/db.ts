import pg from 'pg';

const { Pool } = pg;

const rawConnectionString = process.env.DATABASE_URL;

if (!rawConnectionString) {
  throw new Error('DATABASE_URL is not set');
}

const url = new URL(rawConnectionString);
const sslmode = url.searchParams.get('sslmode') ?? 'disable';

/**
 * `sslmode` has to come OUT of the connection string before `pg` sees it.
 * ConnectionParameters does `Object.assign({}, config, parse(connectionString))`,
 * and pg-connection-string builds its own `ssl` object whenever `sslmode` is
 * present — so the parsed value lands last and silently overwrites the `ssl`
 * passed below, CA and all. The symptom is SELF_SIGNED_CERT_IN_CHAIN against a
 * server whose certificate verifies fine with the same CA outside of `pg`.
 */
url.searchParams.delete('sslmode');
const connectionString = url.toString();

/**
 * Akamai's managed Postgres requires TLS, while the local compose database
 * speaks plaintext. Decide here rather than leaving it to the driver.
 *
 * Set DATABASE_CA_CERT (from `terraform -chdir=infra/database output -raw
 * ca_cert`) to actually verify the server. Without it `require` means encrypted
 * but unverified — same as libpq, and still open to an active MITM.
 */
function sslConfig(): false | { ca?: string; rejectUnauthorized: boolean } {
  if (sslmode === 'disable') return false;

  const ca = process.env.DATABASE_CA_CERT;
  if (ca) return { ca, rejectUnauthorized: true };

  return { rejectUnauthorized: sslmode === 'verify-ca' || sslmode === 'verify-full' };
}

export const pool = new Pool({
  connectionString,
  ssl: sslConfig(),
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

/**
 * Postgres inside a compose stack is usually still booting when the app first
 * starts, so retry a handful of times before giving up.
 */
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
