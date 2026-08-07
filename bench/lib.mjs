import pg from 'pg';

/**
 * Akamai/Aiven managed Postgres requires TLS. `pg` does not act on the
 * sslmode query parameter on its own, so translate it here. Pass the cluster
 * CA via PGSSLROOTCERT to get real verification instead of require-only.
 */
export function sslConfigFor(url) {
  const sslmode = new URL(url).searchParams.get('sslmode') ?? 'require';
  if (sslmode === 'disable') return false;

  const ca = process.env.PGSSLROOTCERT_PEM;
  if (ca) return { ca, rejectUnauthorized: true };

  // `require` in libpq means encrypt but don't verify. Match that.
  return { rejectUnauthorized: sslmode === 'verify-full' || sslmode === 'verify-ca' };
}

export function makeClient(url) {
  return new pg.Client({ connectionString: url, ssl: sslConfigFor(url) });
}

export function makePool(url, max) {
  return new pg.Pool({ connectionString: url, ssl: sslConfigFor(url), max });
}

export function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function summarize(label, latencies, errors, wallMs) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    label,
    ops: latencies.length,
    errors: errors.length,
    rps: latencies.length / (wallMs / 1000),
    mean: sorted.length ? sum / sorted.length : 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? 0,
  };
}

const fmt = (n, d = 1) => n.toFixed(d).padStart(8);

export function printTable(rows) {
  const head = ['scenario', 'ops', 'err', 'rps', 'mean', 'p50', 'p95', 'p99', 'max'];
  const widths = [28, 7, 6, 9, 9, 9, 9, 9, 9];
  console.log(head.map((h, i) => h.padStart(widths[i])).join(''));
  console.log(widths.map((w) => '─'.repeat(w)).join(''));
  for (const r of rows) {
    console.log(
      r.label.padStart(28) +
        String(r.ops).padStart(7) +
        String(r.errors).padStart(6) +
        fmt(r.rps, 1).padStart(9) +
        fmt(r.mean).padStart(9) +
        fmt(r.p50).padStart(9) +
        fmt(r.p95).padStart(9) +
        fmt(r.p99).padStart(9) +
        fmt(r.max).padStart(9),
    );
  }
  console.log('\n(latencies in ms)');
}

export function errorBreakdown(errors) {
  const counts = new Map();
  for (const e of errors) {
    // Some driver-level failures (socket closed mid-query, pool teardown)
    // arrive with an empty message; fall back to whatever else identifies them.
    const key =
      (e?.message || '').trim().slice(0, 70) ||
      e?.code ||
      e?.severity ||
      e?.constructor?.name ||
      String(e);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
