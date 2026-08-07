#!/usr/bin/env node
/**
 * Does PgBouncer actually help? Run the same workload against the direct
 * Postgres endpoint and against the Aiven PgBouncer pool, and compare.
 *
 *   DIRECT_URL="postgres://...:5432/defaultdb?sslmode=require" \
 *   POOLED_URL="postgres://...:PORT/defaultdb?sslmode=require" \
 *   node bench.mjs --concurrency 100 --duration 15 --scenario churn
 *
 * Scenarios
 *   churn      Every operation opens a fresh connection, runs one query and
 *              closes it. This is the case PgBouncer exists for: serverless
 *              functions, PHP-style request lifecycles, or any app that does
 *              not pool client-side. Direct connections pay a full TCP + TLS +
 *              auth handshake each time and burn a backend slot; the pooler
 *              answers from an already-established backend.
 *
 *   saturate   Hold `concurrency` connections open simultaneously. Past the
 *              cluster's max_connections the direct endpoint starts refusing
 *              with "too many clients already", while PgBouncer parks the
 *              excess clients in its queue and multiplexes them onto pool_size
 *              backends. This is the scenario that shows PgBouncer preventing
 *              an outage rather than just shaving latency.
 *
 *   txn        Client-side pooled connections running small transactions.
 *              The narrowest margin — if your app already pools well, this is
 *              where PgBouncer adds a network hop for little gain. Worth
 *              measuring so you know the cost.
 */
import { parseArgs } from 'node:util';

import { makeClient, makePool, summarize, printTable, errorBreakdown } from './lib.mjs';

const { values } = parseArgs({
  options: {
    concurrency: { type: 'string', default: '50' },
    duration: { type: 'string', default: '10' },
    scenario: { type: 'string', default: 'churn' },
    only: { type: 'string' },
  },
});

const CONCURRENCY = Number(values.concurrency);
const DURATION_MS = Number(values.duration) * 1000;
const SCENARIO = values.scenario;

const TARGETS = [
  { label: 'direct', url: process.env.DIRECT_URL },
  { label: 'pgbouncer', url: process.env.POOLED_URL },
].filter((t) => t.url && (!values.only || values.only === t.label));

if (TARGETS.length === 0) {
  console.error('Set DIRECT_URL and/or POOLED_URL. See `make bench` in the Makefile.');
  process.exit(1);
}

const QUERY = 'select id, path, created_at from visits order by created_at desc limit 5';

/** One fresh connection per operation. */
async function runChurn(url, deadline, latencies, errors) {
  while (Date.now() < deadline) {
    const started = performance.now();
    const client = makeClient(url);
    try {
      await client.connect();
      await client.query(QUERY);
      latencies.push(performance.now() - started);
    } catch (err) {
      errors.push(err);
    } finally {
      await client.end().catch(() => {});
    }
  }
}

/** Hold a connection open for the whole run, querying in a loop. */
async function runSaturate(url, deadline, latencies, errors) {
  const client = makeClient(url);
  try {
    await client.connect();
  } catch (err) {
    errors.push(err);
    return;
  }
  try {
    while (Date.now() < deadline) {
      const started = performance.now();
      try {
        await client.query(QUERY);
        latencies.push(performance.now() - started);
      } catch (err) {
        errors.push(err);
        break;
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/** Client-side pool + a real transaction per operation. */
async function runTxn(pool, deadline, latencies, errors) {
  while (Date.now() < deadline) {
    const started = performance.now();
    try {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query("insert into visits (path, user_agent) values ('/bench', 'bench')");
        await client.query(QUERY);
        await client.query('commit');
        latencies.push(performance.now() - started);
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      errors.push(err);
    }
  }
}

async function ensureSchema(url) {
  const client = makeClient(url);
  await client.connect();
  await client.query(`create table if not exists visits (
      id bigserial primary key,
      path text not null,
      user_agent text,
      created_at timestamptz not null default now())`);
  const { rows } = await client.query('select count(*)::int as n from visits');
  if (rows[0].n < 200) {
    await client.query(
      `insert into visits (path, user_agent)
       select '/seed', 'seed' from generate_series(1, 500)`,
    );
  }
  await client.end();
}

async function runTarget({ label, url }) {
  const latencies = [];
  const errors = [];
  const deadline = Date.now() + DURATION_MS;

  process.stdout.write(`  running ${label} (${SCENARIO}, c=${CONCURRENCY})... `);
  const wallStart = performance.now();

  if (SCENARIO === 'txn') {
    const pool = makePool(url, CONCURRENCY);
    await Promise.all(
      Array.from({ length: CONCURRENCY }, () => runTxn(pool, deadline, latencies, errors)),
    );
    await pool.end();
  } else {
    const worker = SCENARIO === 'saturate' ? runSaturate : runChurn;
    await Promise.all(
      Array.from({ length: CONCURRENCY }, () => worker(url, deadline, latencies, errors)),
    );
  }

  const wallMs = performance.now() - wallStart;
  console.log('done');

  const result = summarize(label, latencies, errors, wallMs);
  result._errors = errors;
  return result;
}

console.log(`\nscenario=${SCENARIO} concurrency=${CONCURRENCY} duration=${DURATION_MS / 1000}s\n`);

await ensureSchema(TARGETS[0].url);

const results = [];
for (const target of TARGETS) {
  results.push(await runTarget(target));
}

console.log();
printTable(results);

for (const r of results) {
  if (r._errors.length) {
    console.log(`\n${r.label} errors (${r._errors.length}):`);
    for (const [message, count] of errorBreakdown(r._errors)) {
      console.log(`  ${String(count).padStart(6)}x  ${message}`);
    }
  }
}

const direct = results.find((r) => r.label === 'direct');
const pooled = results.find((r) => r.label === 'pgbouncer');

if (direct && pooled && direct.ops && pooled.ops) {
  const ratio = (a, b) => (a >= b ? `${(a / b).toFixed(2)}x higher` : `${(b / a).toFixed(2)}x lower`);

  console.log('\npgbouncer vs direct');
  console.log(`  throughput:  ${ratio(pooled.rps, direct.rps)} (${pooled.rps.toFixed(0)} vs ${direct.rps.toFixed(0)} rps)`);
  console.log(`  p95 latency: ${ratio(pooled.p95, direct.p95)} (${pooled.p95.toFixed(1)} vs ${direct.p95.toFixed(1)} ms)`);
  console.log(`  errors:      ${pooled.errors} vs ${direct.errors}`);

  // Refused connections make the direct numbers look better than they are: the
  // clients it turned away stopped competing for the backends it did serve.
  const refused = direct._errors.filter((e) => /too many clients|connection.*refus/i.test(e.message)).length;
  if (refused > 0) {
    console.log(
      `\n  NOTE: direct refused ${refused} client(s) with "too many clients already".` +
        `\n  Its latency figures cover only the clients it accepted, so they flatter it —` +
        `\n  the refused clients are an outage, not a fast response. PgBouncer absorbed` +
        `\n  the same load by queueing clients onto a smaller set of backends.`,
    );
  } else if (pooled.p95 > direct.p95 && pooled.errors === 0 && direct.errors === 0) {
    console.log(
      `\n  NOTE: nothing was refused at this concurrency, so the pooler is pure overhead` +
        `\n  here — one extra network hop. Raise --concurrency until direct starts erroring` +
        `\n  to find the point where pooling starts paying for itself.`,
    );
  }
}

process.exit(0);
