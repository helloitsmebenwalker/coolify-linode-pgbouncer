import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

/**
 * Akamai's managed Postgres requires TLS, while the local compose database
 * speaks plaintext. `pg` does not act on the `sslmode` parameter consistently,
 * so decide here rather than leaving it to the driver.
 *
 * Set DATABASE_CA_CERT (from `terraform -chdir=infra/database output -raw
 * ca_cert`) to actually verify the server. Without it `require` means encrypted
 * but unverified — same as libpq, and still open to an active MITM.
 */
function sslConfig(): false | { ca?: string; rejectUnauthorized: boolean } {
  const sslmode = new URL(connectionString!).searchParams.get('sslmode') ?? 'disable';
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
