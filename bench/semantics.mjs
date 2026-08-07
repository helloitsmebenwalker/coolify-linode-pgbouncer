#!/usr/bin/env node
/**
 * Transaction-mode pooling is not transparent. Before pointing a production app
 * at the PgBouncer URL, run this: it exercises the session-scoped guarantees
 * that transaction pooling breaks, and reports which ones your app can no
 * longer rely on.
 *
 *   DIRECT_URL=... POOLED_URL=... node semantics.mjs [--clients 8]
 *
 * Why this uses several concurrent clients
 * ----------------------------------------
 * A single idle connection cannot detect transaction pooling. With no
 * contention PgBouncer hands the same backend back every time, so a lone probe
 * sees textbook session semantics and reports a clean bill of health it has not
 * earned. The breakage only appears when clients outnumber backends and the
 * pooler starts reassigning them mid-session — which is exactly the condition
 * your app hits in production and never hits in a quick manual psql test.
 *
 * So every check below runs across `--clients` connections in interleaved
 * rounds, and asks the question that actually matters: can one client observe
 * or clobber another client's session state?
 *
 * "works on direct, broken on pgbouncer" is the expected result in transaction
 * mode. It is not a misconfiguration — it is the trade you are making.
 */
import { parseArgs } from 'node:util';

import { makeClient } from './lib.mjs';

const { values } = parseArgs({
  options: { clients: { type: 'string', default: '8' } },
});
const N = Number(values.clients);

const TARGETS = [
  { label: 'direct', url: process.env.DIRECT_URL },
  { label: 'pgbouncer', url: process.env.POOLED_URL },
].filter((t) => t.url);

if (TARGETS.length === 0) {
  console.error('Set DIRECT_URL and/or POOLED_URL.');
  process.exit(1);
}

/** Run one query on every client at once, forcing the pooler to interleave. */
const roundRobin = (clients, sql) => Promise.all(clients.map((c) => c.query(sql)));

const checks = [
  {
    name: 'stable backend per connection',
    why: 'If one client connection is served by several backends, every session-scoped guarantee below is void.',
    async run(clients) {
      const seen = clients.map(() => new Set());
      // Interleaved rounds: concurrency is what makes the pooler reassign.
      for (let round = 0; round < 6; round++) {
        const results = await roundRobin(clients, 'select pg_backend_pid() as pid');
        results.forEach((r, i) => seen[i].add(r.rows[0].pid));
      }
      const worst = Math.max(...seen.map((s) => s.size));
      const distinct = new Set(seen.flatMap((s) => [...s]));
      return {
        ok: worst === 1,
        detail: `${distinct.size} backend(s) for ${clients.length} clients; worst connection saw ${worst}`,
      };
    },
  },
  {
    name: 'session GUC stays private',
    why: 'The multi-tenancy footgun: `SET app.tenant_id` outside a transaction writes to a borrowed backend, so another tenant\'s request can read or inherit it. If you gate row-level security on this, pooling becomes a data-leak.',
    async run(clients) {
      // A custom GUC, as an app would use for RLS tenant scoping. Note this is
      // deliberately NOT application_name: PgBouncer tracks that one and
      // re-applies it per client, which would mask the problem.
      await Promise.all(
        clients.map((c, i) => c.query(`set app.tenant_id = 'client-${i}'`)),
      );
      const results = await roundRobin(
        clients,
        `select current_setting('app.tenant_id', true) as tenant`,
      );
      const wrong = results
        .map((r, i) => ({ i, got: r.rows[0].tenant ?? '(unset)', want: `client-${i}` }))
        .filter((r) => r.got !== r.want);
      return {
        ok: wrong.length === 0,
        detail:
          wrong.length === 0
            ? 'every client read back its own tenant'
            : `${wrong.length}/${clients.length} saw the wrong tenant (client-${wrong[0].i} read "${wrong[0].got}")`,
      };
    },
  },
  {
    name: 'SET LOCAL inside a transaction',
    why: 'The pooling-safe way to scope a setting. Should hold on both endpoints.',
    async run(clients) {
      const check = async (c, i) => {
        await c.query('begin');
        await c.query(`set local application_name = 'txn-${i}'`);
        const { rows } = await c.query('show application_name');
        await c.query('commit');
        return rows[0].application_name === `txn-${i}`;
      };
      const oks = await Promise.all(clients.map(check));
      const bad = oks.filter((o) => !o).length;
      return { ok: bad === 0, detail: bad === 0 ? 'held for all clients' : `${bad} client(s) lost it` };
    },
  },
  {
    name: 'advisory lock mutual exclusion',
    why: 'Advisory locks belong to a backend, not a client. Sharing backends means two clients can hold the same "exclusive" lock.',
    async run(clients) {
      const KEY = 987654;
      await clients[0].query(`select pg_advisory_lock(${KEY})`);
      // Nobody else should be able to take it.
      const others = await Promise.all(
        clients.slice(1).map((c) => c.query(`select pg_try_advisory_lock(${KEY}) as got`)),
      );
      const stolen = others.filter((r) => r.rows[0].got === true).length;
      await Promise.all(
        clients.map((c) => c.query(`select pg_advisory_unlock_all()`).catch(() => {})),
      );
      return {
        ok: stolen === 0,
        detail:
          stolen === 0
            ? 'lock held exclusively'
            : `${stolen} other client(s) acquired a lock that was already held`,
      };
    },
  },
  {
    name: 'temp table visibility',
    why: 'Temp tables live in a backend. Under pooling they leak to other clients or vanish from yours.',
    async run(clients) {
      await clients[0].query('create temp table probe_tmp (v int)');
      await clients[0].query('insert into probe_tmp values (1)');

      const mine = await clients[0]
        .query('select count(*)::int as n from probe_tmp')
        .then((r) => r.rows[0].n)
        .catch(() => -1);

      const leaks = await Promise.all(
        clients.slice(1).map((c) =>
          c
            .query('select count(*)::int as n from probe_tmp')
            .then(() => true)
            .catch(() => false),
        ),
      );
      const leaked = leaks.filter(Boolean).length;
      await clients[0].query('drop table if exists probe_tmp').catch(() => {});

      return {
        ok: mine === 1 && leaked === 0,
        detail:
          mine !== 1
            ? 'creator could not see its own temp table'
            : leaked > 0
              ? `visible to ${leaked} other client(s)`
              : 'private to its creator',
      };
    },
  },
  {
    name: 'LISTEN / NOTIFY delivery',
    why: 'Notifications go to a backend. Transaction pooling makes LISTEN unreliable or useless.',
    async run(clients) {
      const listener = clients[0];
      const notifier = clients[1] ?? clients[0];

      await listener.query('listen probe_channel');
      const received = new Promise((resolve) => {
        const onNote = (msg) => {
          if (msg.channel === 'probe_channel') {
            listener.off('notification', onNote);
            resolve(true);
          }
        };
        listener.on('notification', onNote);
        setTimeout(() => {
          listener.off('notification', onNote);
          resolve(false);
        }, 3000);
      });

      await notifier.query("notify probe_channel, 'ping'");
      const got = await received;
      await listener.query('unlisten probe_channel').catch(() => {});
      return { ok: got, detail: got ? 'delivered' : 'not delivered within 3s' };
    },
  },
  {
    name: 'cursor WITH HOLD after commit',
    why: 'A held cursor outlives its transaction but not its backend.',
    async run(clients) {
      const c = clients[0];
      try {
        await c.query('begin');
        await c.query('declare probe_cur cursor with hold for select generate_series(1, 5)');
        await c.query('commit');
        const { rows } = await c.query('fetch 2 from probe_cur');
        await c.query('close probe_cur').catch(() => {});
        return { ok: rows.length === 2, detail: `fetched ${rows.length}` };
      } catch (err) {
        await c.query('rollback').catch(() => {});
        return { ok: false, detail: err.message.split('\n')[0] };
      }
    },
  },
  {
    name: 'transaction atomicity under load',
    why: 'The baseline. Transactions must be correct on both endpoints — if this fails, pooling is misconfigured, not merely restrictive.',
    async run(clients) {
      await clients[0].query('create table if not exists probe_txn (client int)');
      await clients[0].query('truncate probe_txn');

      // Each client opens a transaction, writes, and rolls back — concurrently.
      await Promise.all(
        clients.map(async (c, i) => {
          await c.query('begin');
          await c.query(`insert into probe_txn values (${i})`);
          await c.query('rollback');
        }),
      );

      const { rows } = await clients[0].query('select count(*)::int as n from probe_txn');
      await clients[0].query('drop table if exists probe_txn').catch(() => {});
      return { ok: rows[0].n === 0, detail: `${rows[0].n} row(s) survived rollback` };
    },
  },
];

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const results = new Map();

for (const target of TARGETS) {
  console.log(`\n=== ${target.label} ${DIM}(${N} concurrent clients)${RESET} ===`);

  const clients = Array.from({ length: N }, () => makeClient(target.url));
  try {
    await Promise.all(clients.map((c) => c.connect()));
  } catch (err) {
    console.log(`  ${RED}connection failed${RESET}: ${err.message}`);
    await Promise.all(clients.map((c) => c.end().catch(() => {})));
    continue;
  }

  for (const check of checks) {
    let outcome;
    try {
      outcome = await check.run(clients);
    } catch (err) {
      outcome = { ok: false, detail: err.message.split('\n')[0] };
    }
    results.set(`${check.name}|${target.label}`, outcome.ok);
    const mark = outcome.ok ? `${GREEN}works ${RESET}` : `${RED}broken${RESET}`;
    console.log(`  ${mark}  ${check.name.padEnd(34)} ${DIM}${outcome.detail}${RESET}`);
  }

  await Promise.all(clients.map((c) => c.end().catch(() => {})));
}

if (TARGETS.length === 2) {
  const regressions = checks.filter(
    (c) => results.get(`${c.name}|direct`) && !results.get(`${c.name}|pgbouncer`),
  );

  console.log('\n' + '─'.repeat(76));
  if (regressions.length === 0) {
    console.log('No session-scoped behaviour changed under contention.');
    console.log(`${DIM}If the pool is in session mode this is expected — and you are also`);
    console.log(`getting far less pooling than transaction mode would give you.${RESET}`);
  } else {
    console.log(`${regressions.length} guarantee(s) hold on a direct connection but break through PgBouncer:\n`);
    for (const r of regressions) {
      console.log(`  ${RED}•${RESET} ${r.name}`);
      console.log(`    ${DIM}${r.why}${RESET}`);
    }
    console.log('\nAudit the app for these before switching DATABASE_URL to the pool.');
    console.log('Options: use SET LOCAL instead of SET, replace advisory locks with');
    console.log('row locks or a table, move LISTEN/NOTIFY to a dedicated direct');
    console.log('connection, or run the pool in session mode and pool less aggressively.');
  }
}

process.exit(0);
