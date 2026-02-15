#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

require() { command -v "$1" >/dev/null 2>&1 || { echo "missing command: $1" >&2; exit 1; }; }
require docker
require curl
require pnpm
require python3
require psql

# load .env if exists
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

BASE_URL="${BASE_URL:-http://localhost:4000}"

# must inject
export GRAPH_ENABLED=0
export EXPIRY_WORKER_ENABLED=0

docker info >/dev/null 2>&1 || { echo "Docker daemon not reachable. Start Docker Desktop." >&2; exit 1; }

[[ -n "${DATABASE_URL:-}" ]] || { echo "DATABASE_URL is not set." >&2; exit 1; }

detect_wsl_host_ip() { ip route | awk '/default/ {print $3; exit}'; }

rewrite_db_host() {
  local url="$1" host="$2"
  python3 - <<'PY' "$url" "$host"
import sys
from urllib.parse import urlparse, urlunparse
url=sys.argv[1]; host=sys.argv[2]
u=urlparse(url)
netloc=u.netloc
auth, rest = (netloc.split("@",1)+[""])[:2] if "@" in netloc else ("", netloc)
if ":" in rest:
  _, port = rest.rsplit(":",1)
  rest=f"{host}:{port}"
else:
  rest=host
netloc=f"{auth}@{rest}" if auth else rest
print(urlunparse((u.scheme, netloc, u.path, u.params, u.query, u.fragment)))
PY
}

strip_schema_query() { echo "${1%%\?schema=*}"; }
test_psql() { psql "$1" -c "select 1;" >/dev/null 2>&1; }

HOST_IP="$(detect_wsl_host_ip || true)"
candidates=("127.0.0.1" "host.docker.internal")
[[ -n "${HOST_IP:-}" ]] && candidates+=("$HOST_IP")

ORIG_URL="$DATABASE_URL"
SELECTED_URL=""
for h in "${candidates[@]}"; do
  u="$(rewrite_db_host "$ORIG_URL" "$h")"
  u_noschema="$(strip_schema_query "$u")"
  if test_psql "$u_noschema"; then
    SELECTED_URL="$u"
    echo "[dev-up] db ok via host=$h"
    break
  else
    echo "[dev-up] db ng via host=$h"
  fi
done

[[ -n "$SELECTED_URL" ]] || { echo "Cannot connect to Postgres from WSL." >&2; exit 1; }
export DATABASE_URL="$SELECTED_URL"

LOG_FILE="/tmp/api-dev.log"
echo "[dev-up] start API -> $LOG_FILE"
(
  cd "$ROOT"
  pnpm -C apps/api dev
) 2>&1 | tee "$LOG_FILE" &
API_PID=$!

trap 'kill "$API_PID" >/dev/null 2>&1 || true' EXIT INT TERM

echo "[dev-up] wait /health 200..."
for i in $(seq 1 60); do
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    echo "[dev-up] /health ok"
    break
  fi
  sleep 1
  kill -0 "$API_PID" >/dev/null 2>&1 || { echo "API exited. See $LOG_FILE" >&2; exit 1; }
done

DB_NOSCHEMA="$(strip_schema_query "$DATABASE_URL")"
psql "$DB_NOSCHEMA" -c "select 1;" >/dev/null
echo "[dev-up] startup OK (health + db)"

wait "$API_PID"
