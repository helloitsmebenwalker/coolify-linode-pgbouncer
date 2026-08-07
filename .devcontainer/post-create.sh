#!/usr/bin/env bash
set -euo pipefail

echo "==> Installing linode-cli"
pipx install linode-cli 2>/dev/null || pip install --user --break-system-packages linode-cli

echo "==> Installing app dependencies"
(cd app && npm install)

echo "==> Installing benchmark dependencies"
(cd bench && npm install)

echo "==> Terraform init"
for stack in infra/coolify infra/database; do
  (cd "$stack" && terraform init -backend=false -input=false) || \
    echo "    $stack init skipped — run 'make tf-init' later"
done

if [ ! -f .env ]; then
  cp .env.example .env
  echo "==> Created .env from .env.example"
fi

cat <<'EOF'

  Dev container ready.  `make help` lists everything.

    make dev               app + postgres locally (http://localhost:3000)
    make pgb-up            same, with PgBouncer in front of postgres
    make semantics-local   what transaction pooling breaks (no Linode needed)

    make tf-apply          provision the Coolify host on Linode
    make db-apply          provision managed Postgres + the PgBouncer pool

  Set LINODE_TOKEN in your *host* shell before opening the container
  if you want Terraform and linode-cli to authenticate automatically.

EOF
