# coolify-linode-pgbouncer

A Dockerised app deployed with [Coolify](https://coolify.io) on Linode (Akamai
Cloud), plus a test rig for Akamai's Aiven-backed Managed PostgreSQL and its
PgBouncer connection pooling.

```
.devcontainer/     dev container: docker, terraform, node 22, linode-cli
app/               sample Fastify + Postgres app, multi-stage Dockerfile
infra/coolify/     terraform: Linode host, firewall, cloud-init that installs Coolify
infra/database/    terraform: Akamai Managed PostgreSQL + PgBouncer pool
bench/             direct-vs-pooled benchmark and a pooling-safety audit
docker-compose.yml            local dev
docker-compose.pgbouncer.yml  local dev + PgBouncer (overlay)
docker-compose.coolify.yml    what Coolify deploys
```

Everything is driven by `make`; run `make help` for the list.

## Quick start

```bash
cp .env.example .env
make dev          # http://localhost:3000
```

The app exposes `/` (a small status page), `/healthz`, `/api/info` and
`/api/visits`. Migrations run automatically at boot.

## Deploying to Linode with Coolify

**[DEPLOY.md](DEPLOY.md) has the full walkthrough**, plus a Coolify crash course
and the gotchas worth knowing before you hit them. The short version:

```bash
export LINODE_TOKEN=...                        # host shell

cd infra/coolify
cp terraform.tfvars.example terraform.tfvars   # your SSH key + your IP
cd ../..

make tf-init tf-apply
make coolify-install-log                       # installer runs on after apply returns
make coolify-url                               # claim the admin account promptly
```

Then in Coolify: *New Resource → Docker Compose*, point it at this repo, set the
compose location to `/docker-compose.coolify.yml`, assign a domain, deploy.

`docker-compose.coolify.yml` deliberately publishes no ports — Coolify's proxy
routes to the container via `SERVICE_FQDN_APP_3000`. Publishing ports there
would bypass TLS.

## Managed PostgreSQL and PgBouncer

Akamai's Managed Databases are [powered by
Aiven](https://www.akamai.com/blog/developers/akamai-managed-database-services-powered-by-aiven),
and PgBouncer connection pooling is exposed natively — you don't self-host it.
A pool is a first-class object on the cluster with its own host, port and
credentials, so switching your app to the pooler is a `DATABASE_URL` change.

```bash
cd infra/database
cp terraform.tfvars.example terraform.tfvars   # set allow_list, pool_mode, pool_size
cd ../..
make db-apply
make pool-show      # prints the PgBouncer host/port and DATABASE_URL
```

Then set `DATABASE_URL` in Coolify's environment editor to the pooled URL and
delete the bundled `db` service from the compose file — along with `app`'s
`depends_on: db`, or the compose project no longer parses.

### What the pooler is actually doing

```
your app ──┐
your app ──┤                        ┌── backend ──┐
your app ──┼── PgBouncer ───────────┼── backend ──┼── Postgres
your app ──┤   (up to pool_size     └── backend ──┘
your app ──┘    backends)
   many                                  few
```

Postgres gives every connection its own OS process with its own memory, so
connections are expensive and finite — the cluster has a hard `max_connections`
and hands out `sorry, too many clients already` past it. PgBouncer sits in
front, accepts far more client connections than the database could hold, and
multiplexes them onto a small set of reusable backends.

Two numbers govern this, and they are not the same:

| | what it caps | in this repo |
|---|---|---|
| `pool_size` | backend connections to Postgres | `pool_size` in `infra/database/terraform.tfvars` (default 10) |
| `max_client_conn` | client connections the pooler accepts | managed by Akamai; the local overlay sets 1000 |

A client that arrives when all backends are busy is **queued**, not refused.
That is the whole trade: latency under contention instead of connection errors.
It is exactly what the `saturate` benchmark above shows — direct refused 61 of
150 clients, the pooler served all 150 more slowly.

Size `pool_size` against the cluster's `max_connections`, not against your
traffic. Every pool on the cluster draws from the same budget, so the pools plus
any direct connections have to fit inside it. Bigger is not better: past the
point where backends outnumber usable cores, throughput flattens and latency
rises.

### Pool modes

| mode | backend held for | use when |
|---|---|---|
| `transaction` | one transaction | default; the reason to run PgBouncer at all |
| `session` | the whole client connection | you need session state and can accept much less pooling |
| `statement` | one statement | rare; forbids multi-statement transactions |

Mode is the single most consequential setting. In `session` mode a backend is
tied up for as long as a client stays connected, so an app holding 100 idle
connections still pins 100 backends and you have gained almost nothing. Only
`transaction` mode delivers the many-to-few ratio in the diagram — which is why
it is the default here, and why the next section exists.

### What transaction mode breaks

A backend is returned to the pool at every `COMMIT`, so anything Postgres scopes
to a *session* rather than a *transaction* silently stops behaving. Your next
statement may land on a different backend, and a backend you used may be handed
to another tenant mid-request.

`make semantics-local` runs eight checks against a real PgBouncer, covering each
of these plus two controls — that `SET LOCAL` does survive, and that a backend
really is being shared:

| session-scoped thing | what happens in transaction mode | safe equivalent |
|---|---|---|
| `SET app.tenant_id = …` | leaks to other clients, and yours is lost | `SET LOCAL` inside a transaction |
| `pg_advisory_lock()` | no longer mutually exclusive | `pg_advisory_xact_lock()` |
| `CREATE TEMP TABLE` | visible to other clients | a real table, or keep it inside one transaction |
| `LISTEN` / `NOTIFY` | notifications never arrive | poll a table, or a dedicated session-mode connection |
| `DECLARE … CURSOR WITH HOLD` | gone after commit | fetch in one transaction, or paginate with keyset |
| client-side transaction spanning round-trips | may execute across different backends | issue `BEGIN`…`COMMIT` within one checkout |

The tenant leak is the one to take seriously. If you scope row-level security
with a session GUC, transaction pooling turns that into a **cross-tenant data
leak** — not an error, not a crash, just the wrong rows. `SET LOCAL` is the fix
and passes in both modes.

Two things the harness does not cover:

- **Named prepared statements.** `pg` uses unnamed statements for ordinary
  parameterised queries, which are fine. If you pass `name:` to `client.query()`
  — or use a library that does — those need PgBouncer 1.21+ with
  `max_prepared_statements` enabled. Verify before relying on it.
- **`WITH HOLD` and session state set by extensions or connection-init hooks**,
  including anything an ORM runs once per connection. If your ORM sets a
  timezone or search_path on connect, confirm it does so per transaction.

When something genuinely needs session semantics, the answer is usually two
URLs: the pooled one for normal traffic, a direct connection for the background
worker that runs `LISTEN`. Both are outputs of `infra/database`.

### A caveat on Terraform

The Linode provider has no resource for connection pools yet — the API gained
`POST /databases/postgresql/instances/{id}/connection-pools` in the March 2026
Managed Databases update, ahead of provider support. So `infra/database` creates
the cluster declaratively and drives the pool through
[`scripts/pgbouncer-pool.sh`](infra/database/scripts/pgbouncer-pool.sh) from a
`terraform_data` provisioner. The script is idempotent and prints raw API errors;
if a field name is rejected, `make pool-list` shows the schema the API actually
returns.

## Testing PgBouncer

Two questions matter before you move an app onto a pooler: *is it safe?* and
*is it worth it?* There is a target for each, and both can run entirely locally
against a real PgBouncer container — no Linode account, no spend.

### Is it safe?

```bash
make pgb-up
make semantics-local
```

This opens several concurrent connections and checks the session-scoped
guarantees that transaction pooling breaks. Sample output against a local pool
with `pool_size=2` and 8 clients:

```
=== direct (8 concurrent clients) ===
  works   stable backend per connection      8 backend(s) for 8 clients; worst connection saw 1
  works   session GUC stays private          every client read back its own tenant
  works   advisory lock mutual exclusion     lock held exclusively
  works   temp table visibility              private to its creator
  works   LISTEN / NOTIFY delivery           delivered

=== pgbouncer (8 concurrent clients) ===
  broken  stable backend per connection      2 backend(s) for 8 clients; worst connection saw 2
  broken  session GUC stays private          6/8 saw the wrong tenant (client-0 read "client-7")
  broken  advisory lock mutual exclusion     4 other client(s) acquired a lock that was already held
  broken  temp table visibility              visible to 4 other client(s)
  broken  LISTEN / NOTIFY delivery           not delivered within 3s
```

(Abridged — the run also reports `SET LOCAL inside a transaction`,
`cursor WITH HOLD after commit` and `transaction atomicity under load`.)

Those are the real hazards, not theoretical ones. The tenant leak is the one to
take seriously: if you scope row-level security with `SET app.tenant_id` outside
a transaction, transaction pooling turns that into a cross-tenant data leak.
`SET LOCAL` inside a transaction is the safe equivalent and passes on both.

Note that a **single** connection cannot detect any of this. With no contention
PgBouncer hands the same backend back every time, so a lone `psql` session sees
textbook semantics and gives you a clean bill of health it hasn't earned. That
is why these checks run concurrently with clients outnumbering backends.

`application_name` is deliberately not used as the probe GUC — PgBouncer tracks
and re-applies that one specifically, which would mask the problem.

### Is it worth it?

```bash
make bench-local C=150 DURATION=10 SCENARIO=saturate
```

Three scenarios: `churn` (a fresh connection per query), `saturate` (hold N
connections open), `txn` (client-side pool running transactions).

The `saturate` result is the honest case for pooling:

```
  scenario    ops   err      rps     mean      p50      p95      p99
    direct 274579    61  45668.9      1.9      1.9      2.2      2.8
 pgbouncer 197161     0  32832.9      4.5      3.6      7.6      8.5

direct errors (61):  61x  sorry, too many clients already
```

Direct looks *faster* — but it refused 61 of 150 clients, and its latency covers
only the ones it let in. Those refusals are an outage. PgBouncer served all 150
with zero errors by queueing them onto a smaller set of backends. That is the
trade: some latency, in exchange for not falling over.

**Local results understate the benefit**, especially for `churn`. On loopback
there is no TLS handshake and no network round trip, so opening a connection is
nearly free and the pooler is pure overhead — locally it loses the churn test.
Against a managed cluster, where every new connection pays TLS negotiation plus
real RTT, churn is exactly where pooling wins biggest. Use the local run to
check *correctness*; run `make bench` against the real cluster for numbers you'd
base a decision on.

```bash
make bench SCENARIO=churn C=100    # against the provisioned Linode cluster
make semantics                     # the safety audit, against the real pool
```

## Notes

- Coolify's documented minimum is 2 CPU / 2 GB. The default `g6-standard-2`
  (2 vCPU, 4 GB) leaves room for build containers; cloud-init also adds 2 GB of
  swap, because image builds on small instances OOM otherwise.
- The local Postgres publishes on **55432**, not 5432, and PgBouncer on
  **56432**. A Postgres installed directly on your machine binds
  `127.0.0.1:5432` and silently wins, which makes `psql localhost:5432` hit the
  wrong server.
- Managed databases require TLS. The generated URLs carry `?sslmode=require`,
  and that parameter has to be stripped from the string before `pg` parses it —
  otherwise pg-connection-string synthesises its own `ssl` object from it and
  overwrites the one you passed, CA and all, failing with
  `SELF_SIGNED_CERT_IN_CHAIN`. Both
  [`bench/lib.mjs`](bench/lib.mjs) and [`app/src/db.ts`](app/src/db.ts) strip it
  and configure TLS themselves. Set `PGSSLROOTCERT_PEM` to the cluster CA for
  full verification instead of encrypt-only:

  ```bash
  export PGSSLROOTCERT_PEM="$(terraform -chdir=infra/database output -raw ca_cert)"
  ```

  `-raw` matters — without it Terraform wraps the PEM in `<<EOT` heredoc markers
  and the certificate will not parse.
- `*.tfvars` and `*.tfstate` are gitignored. State is local; for anything beyond
  a spike, move it to a remote backend.

## Teardown

```bash
make db-destroy
make tf-destroy
```
