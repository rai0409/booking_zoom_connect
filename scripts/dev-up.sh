#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

require() { command -v "$1" >/dev/null 2>&1 || { echo "missing command: $1" >&2; exit 1; }; }
require docker
require curl
require jq
require pnpm
require python3
require psql
require ss
require ps
require awk
require sed
require grep

# load .env if exists
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

BASE_URL="${BASE_URL:-http://localhost:4000}"
PORT="${PORT:-4000}"

# must inject
export GRAPH_ENABLED=0
export EXPIRY_WORKER_ENABLED=0

docker info >/dev/null 2>&1 || { echo "Docker daemon not reachable. Start Docker Desktop." >&2; exit 1; }
[[ -n "${DATABASE_URL:-}" ]] || { echo "DATABASE_URL is not set." >&2; exit 1; }

find_pids_on_port() {
  local port="$1"
  ss -ltnp | awk -v p=":${port}" '
    $4 ~ p {
      if (match($0, /pid=([0-9]+)/, m)) print m[1];
    }
  ' | sort -u
}

kill_listeners_on_port() {
  local port="$1"
  local pids cmd
  pids="$(find_pids_on_port "$port" || true)"
  [[ -z "${pids:-}" ]] && return 0

  echo "[dev-up] port ${port} is in use. checking owners..."
  for p in $pids; do
    cmd="$(ps -p "$p" -o cmd= 2>/dev/null || true)"
    echo "[dev-up] pid=$p cmd=$cmd"
    # 誤kill防止：自分のアプリっぽい時だけ落とす
    echo "$cmd" | grep -Eq "booking_zoom_connect|apps/api|tsx watch|@booking/api" || {
      echo "[dev-up] refusing to kill pid=$p (not recognized as this app)" >&2
      echo "[dev-up] please free :${port} manually or set PORT/BASE_URL" >&2
      exit 1
    }
  done

  echo "[dev-up] stopping existing listener(s) on :${port}..."
  kill $pids || true
  for _ in $(seq 1 20); do
    if ! ss -ltnp | grep -q ":${port}"; then
      echo "[dev-up] :${port} freed"
      return 0
    fi
    sleep 0.2
  done
  kill -9 $pids || true
  ss -ltnp | grep -q ":${port}" && { echo "[dev-up] failed to free :${port}" >&2; exit 1; }
  echo "[dev-up] :${port} freed"
}

detect_wsl_host_ip() { ip route | awk '/default/ {print $3; exit}'; }

rewrite_db_host() {
  local url="$1" host="$2"
  python3 - <<'PY' "$url" "$host"
import sys
from urllib.parse import urlparse, urlunparse
url=sys.argv[1]; host=sys.argv[2]
u=urlparse(url)
netloc=u.netloc
if "@" in netloc:
  auth, rest = netloc.split("@", 1)
else:
  auth, rest = "", netloc
if ":" in rest:
  _, port = rest.rsplit(":", 1)
  rest = f"{host}:{port}"
else:
  rest = host
netloc = f"{auth}@{rest}" if auth else rest
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

# 二重起動対策（ここが今回のEADDRINUSEの根治）
kill_listeners_on_port "$PORT"

echo "[dev-up] prisma migrate deploy"
( cd "$ROOT/apps/api" && pnpm -s prisma migrate deploy ) || { echo "[dev-up] migrate deploy failed" >&2; exit 1; }

LOG_FILE="/tmp/api-dev.log"
echo "[dev-up] start API -> $LOG_FILE"

(
  cd "$ROOT"
  pnpm -C apps/api dev
) 2>&1 | tee "$LOG_FILE" &
API_PIPE_PID=$!

# pipeline全体を止める（teeだけ殺してnodeが残るのを防ぐ）
API_PGID="$(ps -o pgid= "$API_PIPE_PID" | tr -d ' ')"
trap 'kill -- -"$API_PGID" >/dev/null 2>&1 || true' EXIT INT TERM

echo "[dev-up] wait /health 200..."
for i in $(seq 1 60); do
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    echo "[dev-up] /health ok"
    break
  fi
  sleep 1
  kill -0 "$API_PIPE_PID" >/dev/null 2>&1 || { echo "API exited. See $LOG_FILE" >&2; exit 1; }
done

echo "[dev-up] wait /ready 200..."
for i in $(seq 1 60); do
  if curl -fsS "$BASE_URL/ready" >/dev/null 2>&1; then
    echo "[dev-up] /ready ok"
    break
  fi
  sleep 1
  kill -0 "$API_PIPE_PID" >/dev/null 2>&1 || { echo "API exited. See $LOG_FILE" >&2; exit 1; }
done

if ! curl -fsS "$BASE_URL/ready" >/dev/null 2>&1; then
  echo "[dev-up] /ready not OK. details:" >&2
  curl -sS "$BASE_URL/ready" | jq . >&2 || true
  exit 1
fi

DB_NOSCHEMA="$(strip_schema_query "$DATABASE_URL")"
psql "$DB_NOSCHEMA" -c "select 1;" >/dev/null
echo "[dev-up] startup OK (health + ready + db)"

wait "$API_PIPE_PID"
