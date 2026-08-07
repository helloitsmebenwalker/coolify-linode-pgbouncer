#!/usr/bin/env bash
#
# Manage the PgBouncer connection pool on an Akamai Managed PostgreSQL cluster.
#
# The Linode Terraform provider does not expose connection pools yet, so this
# talks to the REST API added in the March 2026 Managed Databases update:
#
#   POST   /databases/postgresql/instances/{id}/connection-pools
#   GET    /databases/postgresql/instances/{id}/connection-pools
#   GET    /databases/postgresql/instances/{id}/connection-pools/{name}
#   PUT    /databases/postgresql/instances/{id}/connection-pool/{name}
#   DELETE /databases/postgresql/instances/{id}/connection-pool/{name}
#
# Usage:
#   pgbouncer-pool.sh apply     create or update the pool  (needs POOL_* env)
#   pgbouncer-pool.sh show      print pool details + a ready-to-use URL
#   pgbouncer-pool.sh list      raw JSON for every pool on the cluster
#   pgbouncer-pool.sh delete    remove the pool
#
set -euo pipefail

API="${LINODE_API_URL:-https://api.linode.com/v4}"
TOKEN="${LINODE_TOKEN:-${TF_VAR_linode_token:-}}"

if [[ -z "$TOKEN" ]]; then
  echo "error: LINODE_TOKEN is not set" >&2
  exit 1
fi

for cmd in curl jq; do
  command -v "$cmd" >/dev/null || { echo "error: $cmd is required" >&2; exit 1; }
done

# Resolve the instance id from Terraform state when not passed explicitly.
if [[ -z "${INSTANCE_ID:-}" ]]; then
  INSTANCE_ID="$(terraform -chdir="$(dirname "$0")/.." output -raw instance_id 2>/dev/null || true)"
fi
if [[ -z "${INSTANCE_ID:-}" ]]; then
  echo "error: INSTANCE_ID not set and could not be read from terraform output" >&2
  exit 1
fi

POOL_NAME="${POOL_NAME:-app-pool}"
BASE="$API/databases/postgresql/instances/$INSTANCE_ID"

# api <METHOD> <PATH> [BODY] — prints the response body, fails loudly on >=400.
api() {
  local method="$1" path="$2" body="${3:-}"
  local response status payload

  if [[ -n "$body" ]]; then
    response="$(curl -sS -w $'\n%{http_code}' -X "$method" "$path" \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: application/json" \
      -d "$body")"
  else
    response="$(curl -sS -w $'\n%{http_code}' -X "$method" "$path" \
      -H "Authorization: Bearer $TOKEN")"
  fi

  status="$(tail -n1 <<<"$response")"
  payload="$(sed '$d' <<<"$response")"

  if [[ "$status" -ge 400 ]]; then
    echo "API $method $path -> HTTP $status" >&2
    jq . <<<"$payload" >&2 2>/dev/null || echo "$payload" >&2
    # A 400 here is usually a field-name mismatch. `list` shows the real shape.
    [[ "$status" == "400" ]] && echo "hint: run '$0 list' to see the schema the API returns" >&2
    return 1
  fi

  echo "$payload"
}

pool_exists() {
  api GET "$BASE/connection-pools/$POOL_NAME" >/dev/null 2>&1
}

cmd_apply() {
  local body
  body="$(jq -n \
    --arg label "$POOL_NAME" \
    --arg database "${POOL_DB:-defaultdb}" \
    --arg mode "${POOL_MODE:-transaction}" \
    --arg username "${POOL_USER:-}" \
    --argjson size "${POOL_SIZE:-10}" \
    '{label: $label, database: $database, mode: $mode, size: $size}
     + (if $username == "" then {} else {username: $username} end)')"

  if pool_exists; then
    echo "==> updating pool '$POOL_NAME' (mode=${POOL_MODE:-transaction} size=${POOL_SIZE:-10})"
    api PUT "$BASE/connection-pool/$POOL_NAME" "$body" | jq .
  else
    echo "==> creating pool '$POOL_NAME' (mode=${POOL_MODE:-transaction} size=${POOL_SIZE:-10})"
    api POST "$BASE/connection-pools" "$body" | jq .
  fi

  echo
  cmd_show
}

cmd_show() {
  local pool host port user
  pool="$(api GET "$BASE/connection-pools/$POOL_NAME")"

  # Field names vary slightly by API version; take the first key that exists.
  host="$(jq -r '.host // .host_primary // .hostname // empty' <<<"$pool")"
  port="$(jq -r '.port // empty' <<<"$pool")"
  user="$(jq -r '.username // .user // empty' <<<"$pool")"

  echo "--- pool: $POOL_NAME ---"
  jq . <<<"$pool"

  if [[ -n "$host" && -n "$port" ]]; then
    local password
    password="$(terraform -chdir="$(dirname "$0")/.." output -raw root_password 2>/dev/null || echo 'PASSWORD')"
    echo
    echo "PgBouncer DATABASE_URL:"
    echo "  postgres://${user:-USER}:${password}@${host}:${port}/$(jq -r '.database // "defaultdb"' <<<"$pool")?sslmode=require"
  fi
}

cmd_list()   { api GET "$BASE/connection-pools" | jq .; }
cmd_delete() {
  echo "==> deleting pool '$POOL_NAME'"
  api DELETE "$BASE/connection-pool/$POOL_NAME" | jq . 2>/dev/null || true
}

case "${1:-show}" in
  apply)  cmd_apply  ;;
  show)   cmd_show   ;;
  list)   cmd_list   ;;
  delete) cmd_delete ;;
  *) echo "usage: $0 {apply|show|list|delete}" >&2; exit 1 ;;
esac
