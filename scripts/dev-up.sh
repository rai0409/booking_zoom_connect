#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT/apps/api"
LOG_FILE="${LOG_FILE:-/tmp/api-dev.log}"
BASE_URL="${BASE_URL:-http://localhost:4000}"

require() { command -v "$1" >/dev/null 2>&1 || { echo "missing command: $1" >&2; exit 1; }; }
require curl
require pnpm
require python3
require psql
# docker は必須ではないが、あるなら確認する
command -v docker >/dev/null 2>&1 && HAS_DOCKER=1 || HAS_DOCKER=0

detect_host_ip() {
  # 1) host.docker.internal が引けるならそれ
  if command -v getent >/dev/null 2>&1; then
    if getent hosts host.docker.internal >/dev/null 2>&1; then
      getent hosts host.docker.internal | awk '{print $1; exit}'
      return
    fi
  fi
  # 2) default gateway（WSL→Windows の経路でだいたいこれ）
  if command -v ip >/dev/null 2>&1; then
    ip route | awk '/^default/ {print $3; exit}'
    return
  fi
  # 3) resolv.conf nameserver fallback
  awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf
}

rewrite_db_url_host_if_localhost() {
  local host_ip="$1"
  python3 - <<'PY' "$host_ip"
import os, sys
from urllib.parse import urlparse, urlunparse

host_ip = sys.argv[1]
url = os.environ.get("DATABASE_URL","").strip()
if not url:
    print("", end="")
    sys.exit(0)

u = urlparse(url)
# Only rewrite if host is localhost/127.0.0.1
hostname = u.hostname or ""
if hostname not in ("localhost", "127.0.0.1"):
    print(url, end="")
    sys.exit(0)

port = f":{u.port}" if u.port else ""
userinfo = ""
if u.username:
    userinfo = u.username
    if u.password:
        userinfo += f":{u.password}"
    userinfo += "@"

netloc = f"{userinfo}{host_ip}{port}"
new_u = u._replace(netloc=netloc)
print(urlunparse(new_u), end="")
PY
}

docker_db_check() {
  if [[ "$HAS_DOCKER" -ne 1 ]]; then
    echo "[dev-up] docker not found; skip docker ps check" >&2
    return 0
  fi
  echo "[dev-up] docker ps (ports contains 5432?):" >&2
  docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' | sed -n '1,120p' >&2
}

wait_http_200() {
  local url="$1"
  local name="$2"
  for i in $(seq 1 60); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      echo "[dev-up] OK: $name" >&2
      return 0
    fi
    sleep 1
  done
  echo "[dev-up] FAIL: $name did not become ready: $url" >&2
  return 1
}

db_check() {
  local dburl="$1"
  local base="${dburl%%\?schema=*}"
  psql "$base" -c "select 1;" >/dev/null
}

main() {
  [[ -d "$API_DIR" ]] || { echo "missing dir: $API_DIR" >&2; exit 1; }

  docker_db_check

  # Load .env if exists (so DATABASE_URL/JWT_SECRET etc are present)
  if [[ -f "$API_DIR/.env" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$API_DIR/.env"
    set +a
  fi

  # Inject fixed toggles (MVP stability)
  export GRAPH_ENABLED="${GRAPH_ENABLED:-0}"
  export EXPIRY_WORKER_ENABLED="${EXPIRY_WORKER_ENABLED:-0}"

  # Detect host ip and rewrite DATABASE_URL if it points to localhost
  HOST_IP="${HOST_IP:-$(detect_host_ip)}"
  if [[ -n "${DATABASE_URL:-}" && -n "$HOST_IP" ]]; then
    NEW_DB="$(rewrite_db_url_host_if_localhost "$HOST_IP")"
    if [[ -n "$NEW_DB" && "$NEW_DB" != "$DATABASE_URL" ]]; then
      export DATABASE_URL="$NEW_DB"
      echo "[dev-up] DATABASE_URL rewritten to use HOST_IP=$HOST_IP" >&2
    fi
  fi

  : "${DATABASE_URL:?DATABASE_URL is required (set in apps/api/.env or env)}"

  # Start API in background, tee logs to fixed location
  echo "[dev-up] starting API (logs -> $LOG_FILE)" >&2
  rm -f "$LOG_FILE"
  (
    cd "$API_DIR"
    pnpm -s dev
  ) 2>&1 | tee "$LOG_FILE" &
  API_PID=$!

  cleanup() {
    if kill -0 "$API_PID" >/dev/null 2>&1; then
      kill "$API_PID" >/dev/null 2>&1 || true
    fi
  }
  trap cleanup EXIT INT TERM

  # Readiness checks
  wait_http_200 "$BASE_URL/health" "/health"
  wait_http_200 "$BASE_URL/ready"  "/ready"
  db_check "$DATABASE_URL"
  echo "[dev-up] OK: DB select 1" >&2

  echo "[dev-up] dev-up completed; API running (pid=$API_PID)" >&2
  echo "[dev-up] tail logs: tail -n 200 $LOG_FILE" >&2

  # Keep foreground attached
  wait "$API_PID"
}

main "$@"
