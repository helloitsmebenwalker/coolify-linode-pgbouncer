# Deploying to Linode with Coolify

A walkthrough of getting this project onto a Linode host, plus enough Coolify
background to operate it. For what the project _is_, see [README.md](README.md).

- [Deployment, step by step](#deployment-step-by-step)
- [Coolify crash course](#coolify-crash-course)
- [Gotchas that cost real time](#gotchas-that-cost-real-time)

---

## Deployment, step by step

### 0. Prerequisites

- A Linode account and an API token with **read/write** on Linodes, Firewalls
  and Databases (Cloud Manager → API Tokens)
- An SSH keypair (`ssh-keygen -t ed25519` if you need one)
- A domain you can add DNS records to. Optional, but without one there is no
  HTTPS — Let's Encrypt will not issue a certificate for a bare IP
- This repo pushed to GitHub. Coolify deploys _from git_, not from your laptop

```bash
export LINODE_TOKEN=...        # host shell, before opening the dev container
curl -s ifconfig.me            # your public IP — you will need it twice
```

### 1. Configure the host stack

```bash
cd infra/coolify
cp terraform.tfvars.example terraform.tfvars
```

Set `authorized_keys` to your public key, and `admin_ipv4_cidrs` to
`["<your-ip>/32"]`.

That second variable locks SSH and the entire Coolify admin surface to you.
Leaving it empty closes those ports completely, which locks you out of the
dashboard as well as everyone else.

### 2. Provision

```bash
make tf-init
make tf-apply
```

This creates the Linode, attaches a cloud firewall and runs cloud-init.

**`apply` returns long before Coolify is ready.** Terraform waits for the
instance to exist, not for the installer inside it to finish.

**New instance, new host key.** Every `tf-apply` after a `tf-destroy` lands on
a fresh IP, so your SSH client has never seen its host key and will stop with
a `yes/no/[fingerprint]` prompt. That's fine at an interactive terminal — type
`yes` — but it fails as `Host key verification failed.` when `make ssh` or
`make coolify-install-log` runs somewhere without a TTY attached (a script, a
CI step, an agent harness). Pre-accept the key to avoid the prompt entirely:

```bash
ssh-keyscan -H "$(terraform -chdir=infra/coolify output -raw ipv4)" >> ~/.ssh/known_hosts
```

### 3. Watch the install finish

```bash
make coolify-install-log     # tails /var/log/coolify-install.log over SSH
```

Budget 3–8 minutes: apt upgrade, Docker install, then Coolify pulling images.

### 4. Claim the instance — immediately

```bash
make coolify-url             # http://<ip>:8000
```

The first visit is a **registration** page, and the first account created
becomes root admin of the whole instance. There is no default password.

The firewall restricting port 8000 to your IP is what makes this window safe.
Even so, do not provision on a Friday and claim it on Monday.

### 5. Point DNS at the host

```bash
terraform -chdir=infra/coolify output ipv4
```

Add an `A` record: `app.yourdomain.com → <ip>`.

Let it propagate _before_ assigning the domain in Coolify. Let's Encrypt
validates over port 80, and issuance fails if DNS is not yet live.

### 6. Deploy the app

In the Coolify UI:

1. **Projects → + Add**, name it. You get a `production` environment.
2. **+ New Resource → Docker Compose**. Not "Application" — that path assumes a
   single container, and this stack has more than one.
3. Choose **Public Repository**, paste the GitHub URL, branch `main`.
4. Set **Docker Compose Location** to `/docker-compose.coolify.yml`.
5. Coolify parses the file and lists the services. On the `app` service, set the
   domain to `https://app.yourdomain.com`.
6. **Deploy**.

Coolify clones the repo, builds [app/Dockerfile](app/Dockerfile), starts the
stack, waits for the healthcheck to pass, then points Traefik at it and requests
a certificate.

If you skipped step 5, Coolify still assigns a working URL of the form
`http://app-<uuid>.<ip>.sslip.io` — `sslip.io` resolves the IP out of the
hostname, so it needs no DNS of your own. Plain HTTP only; Let's Encrypt needs
a domain you control. `docker inspect <container> | grep COOLIFY_FQDN` prints
it, as does the **Links** menu on the resource page.

### 7. Provision managed Postgres and the PgBouncer pool

The database needs to allow connections from the Coolify host:

```bash
terraform -chdir=infra/coolify output -raw database_allow_list_entry
```

Put that, plus your own IP, into `infra/database/terraform.tfvars`. Then:

```bash
make db-apply
make pool-show      # PgBouncer host, port, and a ready-to-use DATABASE_URL
```

### 8. Decide whether to use the pooler — before you switch

```bash
make semantics      # what transaction pooling breaks, on the real cluster
make bench SCENARIO=churn C=100
```

Run this **now**, while the direct URL is still in use. If the app relies on
advisory locks, `LISTEN`/`NOTIFY`, or `SET` outside a transaction, you want to
find out before the pooled URL is in production rather than after.

See [README.md](README.md#testing-pgbouncer) for how to read the output.

### 9. Point the app at the database

In Coolify → your resource → **Environment Variables**:

- `DATABASE_URL` — the pooled URL from `make pool-show` (or the direct URL from
  `make db-url` if step 8 turned up a blocker). It carries `?sslmode=require`.
- `DATABASE_CA_CERT` — optional, from
  `terraform -chdir=infra/database output -raw ca_cert`. Without it, `require`
  means encrypted but unverified, which still leaves you open to an active
  machine-in-the-middle.

Then comment out the `db` service and the `pgdata` volume from
`docker-compose.coolify.yml`, commit, and redeploy.

**Remove `app`'s `depends_on: db` in the same edit.** Commenting out the service
while leaving the dependency behind fails the build before it starts, with
`service "app" depends on undefined service "db": invalid compose project`.
Catch it without a deploy cycle by running the same parse Coolify runs:

```bash
docker compose -f docker-compose.coolify.yml config
```

### 10. Optional: the mail pipeline

[`mailhook/`](mailhook/) — Microsoft 365 mail into Object Storage, with an event
on a Postgres queue — deploys as part of the same compose resource. It needs an
Entra app registration, a bucket, and a real domain (Graph will not call the
`sslip.io` fallback, because it is plain HTTP).

**[mailhook/DEPLOY.md](mailhook/DEPLOY.md)** is the runbook.

### 11. Teardown

```bash
make storage-destroy   # only if you did step 10; unsubscribe first, see its runbook
make db-destroy
make tf-destroy
```

---

## Coolify crash course

### What it actually is

A self-hosted Heroku or Vercel. Concretely: a web control plane that SSHes into
servers you own and drives Docker on them. It generates compose files, manages a
Traefik reverse proxy, terminates TLS through Let's Encrypt, and rebuilds
containers when you push.

There is no proprietary runtime. If Coolify disappeared tomorrow your containers
would keep running, which is the main argument for it over a hosted PaaS.

### The object model

```
Server                  a machine Coolify manages over SSH (localhost, or remote)
└── Project             logical grouping, e.g. "coolify-linode-pgbouncer"
    └── Environment     production / staging
        └── Resource    the thing that actually runs
```

Four resource types:

| Type               | What it is                                                     |
| ------------------ | -------------------------------------------------------------- |
| **Application**    | A git repo built into a single container                       |
| **Database**       | Postgres/MySQL/Redis/Mongo, run as a container Coolify manages |
| **Service**        | One-click templates — Plausible, n8n, Supabase, etc.           |
| **Docker Compose** | Multi-container, from a compose file in your repo              |

This project uses **Docker Compose**, because an app plus a database is two
containers.

### Build packs

| Pack               | Use when                                                      |
| ------------------ | ------------------------------------------------------------- |
| **Nixpacks**       | No Dockerfile; auto-detects the language. Convenient, opaque. |
| **Dockerfile**     | You control the build.                                        |
| **Docker Compose** | Several services in one resource. ← this project              |
| **Static**         | Plain HTML or an SPA build output.                            |

### How a deploy runs

```
trigger (webhook or manual)
  → clone repo
  → build image on the server
  → start new container
  → wait for healthcheck to pass     ← the important step
  → flip Traefik to the new container
  → stop and remove the old one
```

That healthcheck is what makes deploys zero-downtime. Without one, Coolify
switches traffic as soon as the container _starts_, and users hit an app that is
still booting. This is why [app/Dockerfile](app/Dockerfile) declares a
`HEALTHCHECK` and the app serves `/healthz`, which returns 503 while the
database is unreachable.

### Domains and TLS

Set an FQDN on a service and Coolify configures Traefik and requests a
certificate. Two requirements:

- DNS must already resolve to the host
- Port 80 must be open to the world, because ACME validates over it

Setting a **wildcard domain** on the server makes Coolify auto-assign
subdomains to new resources.

### Environment variables

Four kinds: **runtime**, **build-time** (passed as `--build-arg`), **shared**
(reusable at team, project or environment scope), and **magic**.

Magic variables are generated by Coolify on first deploy and then persisted:

| Pattern                                       | Effect                                                   |
| --------------------------------------------- | -------------------------------------------------------- |
| `SERVICE_FQDN_<SERVICE>_<PORT>`               | Assigns a domain, wires the proxy to that container port |
| `SERVICE_URL_<SERVICE>_<PORT>`                | Same, exposed as a full URL                              |
| `SERVICE_PASSWORD_<NAME>`                     | Generates a password once, reuses it forever             |
| `SERVICE_BASE64_<NAME>`, `SERVICE_HEX_<NAME>` | Generated secrets                                        |

Both of the first two appear in
[docker-compose.coolify.yml](docker-compose.coolify.yml).

One parsing rule worth knowing: **service names in these variables use hyphens,
not underscores**, when a port suffix is present. `SERVICE_FQDN_MY-APP_3000`
parses correctly; `SERVICE_FQDN_MY_APP_3000` does not. The service here is
called `app`, so it is unaffected — but this bites anyone who names a service
`web_api`.

### Worth turning on

- **Auto-deploy** — install the Coolify GitHub App, or add the webhook manually
  for a public repo, and pushes to `main` deploy themselves
- **Preview deployments** — every PR gets its own URL on a subdomain
- **Scheduled backups** — database dumps pushed to S3-compatible storage.
  Configure this the moment you have data you would miss
- **Automated cleanup** — see the disk gotcha below

---

## Gotchas that cost real time

**Never publish ports in a Coolify compose file.** `ports:` binds to the host
and bypasses Traefik entirely: no TLS, and anything you expose that way is on
the public internet. Use `SERVICE_FQDN_*` and let the proxy route to the
container. This is why [docker-compose.coolify.yml](docker-compose.coolify.yml)
declares no `ports:` while [docker-compose.yml](docker-compose.yml) does — the
local file is meant to be reachable from your laptop, the production one is not.

**Coolify needs ports 6001 and 6002 open to your browser, not just 8000.**
8000 is the dashboard, 6001 carries the realtime channel that streams build and
deployment logs into the UI, and 6002 backs the in-browser terminal. Open only
8000 and you get a dashboard whose logs never load, with no error explaining
why. [infra/coolify/main.tf](infra/coolify/main.tf) opens all three to
`admin_ipv4_cidrs`. Once the dashboard sits behind a domain on 443, all three
can be closed.

**Docker punches straight through UFW.** Docker writes NAT iptables rules that
sidestep host firewalls, so a UFW rule blocking a published port frequently does
nothing. Use the provider's firewall — which is what the `linode_firewall`
resource in [infra/coolify/main.tf](infra/coolify/main.tf) is for.

**Builds run on the production host.** A build competing with your live app for
2 GB of RAM is how you OOM halfway through and are left with a half-built image.
Hence the 2 GB swap file in [infra/coolify/cloud-init.yaml](infra/coolify/cloud-init.yaml)
and `g6-standard-2` as the default plan. Coolify's documented minimum is 2 CPU /
2 GB / 30 GB.

**Handle SIGTERM, or every redeploy stalls for 30 seconds.** Node as PID 1
ignores the default signal disposition, so Docker waits out the full stop
timeout before SIGKILL. That is what `tini` in [app/Dockerfile](app/Dockerfile)
and the signal handlers in [app/src/server.ts](app/src/server.ts) are for.

**Disk fills with old images.** Every deploy leaves layers behind. Turn on
scheduled cleanup in the server settings, or run `docker system prune -af` on a
cron. Running out of disk on a Coolify host fails deploys in confusing ways.

**Coolify runs its own Postgres and Redis** for its own state. Do not confuse
those containers with your application's database, and do not prune them.

**`sslmode` in the URL silently overrides the `ssl` object you pass to `pg`.**
`ConnectionParameters` does `Object.assign({}, config, parse(connectionString))`,
and `pg-connection-string` builds its own `ssl` object whenever `sslmode` is
present — so the parsed value lands last and discards your `ssl.ca`. Against a
managed database with a private CA that surfaces as
`SELF_SIGNED_CERT_IN_CHAIN`, on a certificate that `openssl s_client -CAfile`
verifies without complaint. The tell is that raw `tls.connect()` with the same
CA string succeeds while `new Pool()` fails. [app/src/db.ts](app/src/db.ts)
strips `sslmode` from the string and configures TLS itself.

Verifying a CA change actually verifies: point `DATABASE_CA_CERT` at an
unrelated CA and confirm the connection *fails*. A config that succeeds with
both the right and the wrong CA is not checking anything.

**Editing the compose file may need a re-parse.** Adding a service in git is not
always enough; Coolify re-reads the file on redeploy, and occasionally you need
"Reload Compose File" before new services appear in the UI.

---

## A note on accuracy

The Terraform, Docker and application layers here have been run end to end, as
have the Coolify UI steps — against Coolify v4.1.2. Coolify's interface changes
quickly between releases, so the concepts are stable and the button labels less
so; if a menu name does not match, the underlying idea should still apply.

Two places where v4.1.2 differed from the flow described above: the onboarding
wizard opens with a **Choose Server Type** step (pick **This Machine** — Coolify
manages the host it runs on, and skips the SSH connection step entirely), and
the compose-location field defaulted to `.yaml` where this repo uses `.yml`.

Sources: [Coolify installation](https://coolify.io/docs/get-started/installation),
[firewall ports](https://coolify.io/docs/knowledge-base/server/firewall),
[Docker Compose magic variables](https://coolify.io/docs/knowledge-base/docker/compose).
