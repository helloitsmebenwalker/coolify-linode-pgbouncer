SHELL := /bin/bash
.DEFAULT_GOAL := help

COOLIFY_DIR := infra/coolify
DB_DIR      := infra/database
STORAGE_DIR := infra/storage
POOL        := $(DB_DIR)/scripts/pgbouncer-pool.sh

# Benchmark knobs
C        ?= 50
DURATION ?= 10
SCENARIO ?= churn

## ---- local development --------------------------------------------------

.PHONY: dev
dev: ## Start app + postgres locally (http://localhost:3000)
	docker compose up --build

.PHONY: down
down: ## Stop the local stack
	docker compose down

.PHONY: clean
clean: ## Stop the local stack and delete its volumes
	docker compose down -v

.PHONY: logs
logs: ## Tail local app logs
	docker compose logs -f app

.PHONY: build
build: ## Build the production image exactly as Coolify will
	docker build -t coolify-linode-pgbouncer-app:local ./app

.PHONY: typecheck
typecheck: ## Typecheck the app and the mailhook service
	cd app && npm run typecheck
	cd mailhook && npm run typecheck

## ---- mailhook (M365 -> bucket -> queue) ---------------------------------

MAILHOOK_URL ?= http://localhost:$(or $(MAILHOOK_PORT),3001)

.PHONY: mailhook-up
mailhook-up: ## Start mailhook + MinIO + postgres locally
	docker compose up -d --build mailhook

.PHONY: mailhook-logs
mailhook-logs: ## Tail mailhook logs
	docker compose logs -f mailhook

.PHONY: mailhook-stats
mailhook-stats: ## Intake and queue depth
	@curl -sS $(MAILHOOK_URL)/api/stats; echo

.PHONY: mailhook-ingest
mailhook-ingest: ## Push a .eml through the pipeline locally. Vars: EML=path/to/message.eml
	@test -n "$(EML)" || { echo "usage: make mailhook-ingest EML=message.eml"; exit 1; }
	@curl -sS --data-binary @$(EML) -H 'content-type: message/rfc822' \
		$(MAILHOOK_URL)/dev/ingest; echo

.PHONY: mailhook-consume
mailhook-consume: ## Drain the mail_events queue with the reference consumer
	docker compose exec -T mailhook node dist/consumer.js

.PHONY: sub-create sub-list sub-renew sub-delete
sub-create: ## Subscribe the configured mailbox (service must be publicly reachable)
	docker compose exec -T mailhook node dist/subscriptions.js create

sub-list: ## Show Graph subscriptions and the local record of them
	docker compose exec -T mailhook node dist/subscriptions.js list

sub-renew: ## Renew every active subscription now
	docker compose exec -T mailhook node dist/subscriptions.js renew

sub-delete: ## Unsubscribe. Vars: ID=<subscription-id>
	@test -n "$(ID)" || { echo "usage: make sub-delete ID=<subscription-id>"; exit 1; }
	docker compose exec -T mailhook node dist/subscriptions.js delete $(ID)

## ---- infrastructure -----------------------------------------------------

.PHONY: tf-init
tf-init: ## terraform init for every stack
	terraform -chdir=$(COOLIFY_DIR) init
	terraform -chdir=$(DB_DIR) init
	terraform -chdir=$(STORAGE_DIR) init

.PHONY: tf-plan
tf-plan: ## Plan the Coolify host
	terraform -chdir=$(COOLIFY_DIR) plan

.PHONY: tf-apply
tf-apply: ## Provision the Coolify host on Linode
	terraform -chdir=$(COOLIFY_DIR) apply

.PHONY: tf-destroy
tf-destroy: ## Destroy the Coolify host
	terraform -chdir=$(COOLIFY_DIR) destroy

.PHONY: coolify-url
coolify-url: ## Print the Coolify dashboard URL
	@terraform -chdir=$(COOLIFY_DIR) output -raw coolify_dashboard; echo

.PHONY: ssh
ssh: ## SSH to the Coolify host
	@eval "$$(terraform -chdir=$(COOLIFY_DIR) output -raw ssh)"

.PHONY: coolify-install-log
coolify-install-log: ## Tail the Coolify installer log on the host (useful while cloud-init runs)
	@ssh root@$$(terraform -chdir=$(COOLIFY_DIR) output -raw ipv4) \
		'tail -f /var/log/coolify-install.log'

## ---- managed postgres + pgbouncer ---------------------------------------

.PHONY: db-plan db-apply db-destroy
db-plan: ## Plan the managed Postgres cluster
	terraform -chdir=$(DB_DIR) plan

db-apply: ## Provision managed Postgres + create the PgBouncer pool
	terraform -chdir=$(DB_DIR) apply

db-destroy: ## Destroy the managed Postgres cluster
	terraform -chdir=$(DB_DIR) destroy

.PHONY: pool-show pool-list pool-apply
pool-show: ## Print PgBouncer pool details and its DATABASE_URL
	@$(POOL) show

pool-list: ## Raw JSON for all pools on the cluster
	@$(POOL) list

pool-apply: ## Re-create/update the pool from current tfvars
	@INSTANCE_ID=$$(terraform -chdir=$(DB_DIR) output -raw instance_id) \
	 POOL_NAME=$$(terraform -chdir=$(DB_DIR) output -raw pool_name) \
	 POOL_USER=$$(terraform -chdir=$(DB_DIR) output -raw root_username) \
	 $(POOL) apply

.PHONY: db-url
db-url: ## Print the DIRECT (non-pooled) DATABASE_URL
	@terraform -chdir=$(DB_DIR) output -raw direct_database_url; echo

## ---- object storage -----------------------------------------------------

.PHONY: storage-plan storage-apply storage-destroy storage-env
storage-plan: ## Plan the Object Storage bucket + scoped access key
	terraform -chdir=$(STORAGE_DIR) plan

storage-apply: ## Create the bucket and its access key
	terraform -chdir=$(STORAGE_DIR) apply

storage-destroy: ## Delete the bucket (must be empty) and the key
	terraform -chdir=$(STORAGE_DIR) destroy

storage-env: ## Print the S3_* block to paste into Coolify's env editor
	@terraform -chdir=$(STORAGE_DIR) output -raw mailhook_env

## ---- pgbouncer testing --------------------------------------------------

.PHONY: bench-deps
bench-deps:
	@cd bench && [ -d node_modules ] || npm install

.PHONY: bench
bench: bench-deps ## Compare direct vs pooled. Vars: C, DURATION, SCENARIO={churn|saturate|txn}
	@DIRECT_URL="$$(terraform -chdir=$(DB_DIR) output -raw direct_database_url)" \
	 POOLED_URL="$$($(POOL) show | awk '/^  postgres:/{print $$1}')" \
	 node bench/bench.mjs --concurrency $(C) --duration $(DURATION) --scenario $(SCENARIO)

.PHONY: bench-all
bench-all: bench-deps ## Run all three scenarios back to back
	@for s in churn saturate txn; do $(MAKE) --no-print-directory bench SCENARIO=$$s C=$(C) DURATION=$(DURATION); done

.PHONY: semantics
semantics: bench-deps ## Show which session features transaction pooling breaks
	@DIRECT_URL="$$(terraform -chdir=$(DB_DIR) output -raw direct_database_url)" \
	 POOLED_URL="$$($(POOL) show | awk '/^  postgres:/{print $$1}')" \
	 node bench/semantics.mjs --clients $(CLIENTS)

## ---- pgbouncer testing, locally (no Linode account needed) ---------------

LOCAL_DIRECT := postgres://app:devpassword@localhost:$(or $(POSTGRES_HOST_PORT),55432)/app?sslmode=disable
LOCAL_POOLED := postgres://app:devpassword@localhost:$(or $(PGBOUNCER_HOST_PORT),56432)/app?sslmode=disable
COMPOSE_PGB  := docker compose -f docker-compose.yml -f docker-compose.pgbouncer.yml
CLIENTS      ?= 8

.PHONY: pgb-up
pgb-up: ## Start the local stack with a PgBouncer in front of Postgres
	POOL_SIZE=$(or $(POOL_SIZE),10) $(COMPOSE_PGB) up -d

.PHONY: pgb-down
pgb-down: ## Stop the local PgBouncer stack
	$(COMPOSE_PGB) down

.PHONY: semantics-local
semantics-local: bench-deps ## Which guarantees break under transaction pooling (local)
	@POOL_SIZE=2 $(COMPOSE_PGB) up -d pgbouncer >/dev/null 2>&1 && sleep 4 && \
	 DIRECT_URL="$(LOCAL_DIRECT)" POOLED_URL="$(LOCAL_POOLED)" \
	 node bench/semantics.mjs --clients $(CLIENTS)

.PHONY: bench-local
bench-local: bench-deps ## Benchmark direct vs local PgBouncer. Vars: C, DURATION, SCENARIO
	@DIRECT_URL="$(LOCAL_DIRECT)" POOLED_URL="$(LOCAL_POOLED)" \
	 node bench/bench.mjs --concurrency $(C) --duration $(DURATION) --scenario $(SCENARIO)

## ---- meta ---------------------------------------------------------------

.PHONY: help
help:
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'
