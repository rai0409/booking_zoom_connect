#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="/home/rai/booking_zoom_connect"
API_DIR="$ROOT/apps/api"
WEB_DIR="$ROOT/apps/web"
LOG_DIR="${TMPDIR:-/tmp}/booking_zoom_connect_verify"
API_LOG="$LOG_DIR/api.log"
WEB_LOG="$LOG_DIR/web.log"
SUMMARY="$LOG_DIR/summary.log"

mkdir -p "$LOG_DIR"
: > "$API_LOG"
: > "$WEB_LOG"
: > "$SUMMARY"

API_PID=""
WEB_PID=""

cleanup() {
  set +e
  [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true
  [[ -n "${WEB_PID:-}" ]] && kill "$WEB_PID" 2>/dev/null || true
}
trap cleanup EXIT
free_port() {
  local port="$1"
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" 2>/dev/null || true
  fi
}

on_error() {
  local exit_code=$?
  echo
  echo "=================================================="
  echo "FAILED: Sprint 4 verification"
  echo "exit_code=$exit_code"
  echo "log_dir=$LOG_DIR"
  echo "=================================================="
  echo

  echo "[1] API log tail"
  tail -n 120 "$API_LOG" || true
  echo

  echo "[2] WEB log tail"
  tail -n 120 "$WEB_LOG" || true
  echo

  echo "[3] API likely error lines"
  rg -n -i \
    "error|exception|invalid|expired|booking_id|token|confirm|cancel|reschedule|conflict|500|400|401|403|404|409|422|prisma|jwt|fetch failed|ECONNREFUSED|EADDRINUSE" \
    "$API_LOG" | tail -n 80 || true
  echo

  echo "[4] WEB likely error lines"
  rg -n -i \
    "error|invalid|expired|booking_id|token|confirm|cancel|reschedule|failed|TypeError|ReferenceError|fetch|500|400|401|403|404|409|422" \
    "$WEB_LOG" | tail -n 80 || true
  echo

  echo "[5] Last git diff stat"
  git -C "$ROOT" diff --stat || true
  echo

  echo "[6] Hint"
  echo "- build failure -> TypeScript / import / route shape mismatch"
  echo "- smoke fail at cancel_url/reschedule_url -> backend contract mismatch"
  echo "- smoke fail at reschedule POST -> page/proxy/body shape mismatch"
  echo "- invalid/expired/missing booking_id -> safe-stop 分岐を確認"
  echo "- explicit smoke reason codes -> SP_ID_EMPTY / AVAILABILITY_NOT_ARRAY / NO_SLOT_FOUND / BOOKING_ID_EMPTY / VERIFY_TOKEN_EMPTY"
  echo "- EADDRINUSE -> 3000/4000 の既存プロセスを停止"
  echo
  exit "$exit_code"
}
trap on_error ERR

log() {
  printf '[verify] %s\n' "$*" | tee -a "$SUMMARY"
}

wait_http() {
  local url="$1"
  local name="$2"
  for _ in $(seq 1 90); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      log "$name ready: $url"
      return 0
    fi
    sleep 1
  done
  echo "$name not ready: $url" >&2
  return 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing command: $1" >&2; exit 1; }
}

require_cmd pnpm
require_cmd curl
require_cmd rg
require_cmd jq
require_cmd python3
require_cmd psql
require_cmd bash

log "ROOT=$ROOT"
log "LOG_DIR=$LOG_DIR"

log "git status"
git -C "$ROOT" status --short | tee -a "$SUMMARY"
log "free ports 3000 and 4000"
free_port 3000
free_port 4000

log "install deps"
pnpm -C "$ROOT" install --frozen-lockfile

log "prisma generate"
(
  cd "$API_DIR"
  pnpm exec prisma generate
)

log "api build"
pnpm -C "$API_DIR" build | tee -a "$SUMMARY"

log "clean web build cache"
rm -rf "$WEB_DIR/.next"

log "unset non-standard NODE_ENV for web build"
unset NODE_ENV || true

log "web build"
pnpm -C "$WEB_DIR" build | tee -a "$SUMMARY"

log "start api dev server"
(
  cd "$API_DIR"
  pnpm dev >"$API_LOG" 2>&1
) &
API_PID=$!

log "start web dev server"
(
  cd "$WEB_DIR"
  unset NODE_ENV || true
  pnpm dev >"$WEB_LOG" 2>&1
) &
WEB_PID=$!

wait_http "http://localhost:4000/v1/public/acme/salespersons" "api"
wait_http "http://localhost:3000/public/acme" "web"

log "run smoke_public_flow_safe.sh"
(
  cd "$ROOT"
  bash scripts/smoke_public_flow_safe.sh
) | tee -a "$SUMMARY"


echo
echo "=================================================="
echo "SUCCESS: Sprint 4 verification passed"
echo "log_dir=$LOG_DIR"
echo "=================================================="
echo

echo "[summary tail]"
tail -n 80 "$SUMMARY" || true
