#!/usr/bin/env bash
set -euo pipefail

TENANT_SLUG="${TENANT_SLUG:-acme}"
API_BASE="${API_BASE:-http://localhost:4000}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
RUN_ID="$(date +%Y%m%d_%H%M%S)"
RUN_DIR="${RUN_DIR:-$ROOT_DIR/runs/availability_debug_$RUN_ID}"
SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"

DEBUG_SALESPERSON_ID="${DEBUG_SALESPERSON_ID:-63d22e6c-1ab3-4306-a9b2-dac9767fa528}"
DEBUG_DATE="${DEBUG_DATE:-2026-03-16}"
TARGET_START_UTC="${TARGET_START_UTC:-2026-03-16T00:00:00.000Z}"
TARGET_END_UTC="${TARGET_END_UTC:-2026-03-16T01:00:00.000Z}"
EXPECTED_SECOND_START_UTC="${EXPECTED_SECOND_START_UTC:-2026-03-16T01:00:00.000Z}"
EXPECTED_SECOND_END_UTC="${EXPECTED_SECOND_END_UTC:-2026-03-16T02:00:00.000Z}"
PUBLIC_BASE_URL_EFFECTIVE="${PUBLIC_BASE_URL_EFFECTIVE:-}"
API_LOG_SOURCE="${API_LOG_SOURCE:-}"

mkdir -p "$RUN_DIR"
SUMMARY_FILE="$RUN_DIR/summary.txt"
REQUEST_FILE="$RUN_DIR/request_ids.tsv"
: > "$SUMMARY_FILE"
printf 'step\thttp_code\tx_request_id\n' > "$REQUEST_FILE"

require() { command -v "$1" >/dev/null 2>&1 || { echo "missing command: $1" >&2; exit 1; }; }
require curl
require jq
require date
require sed
require grep

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -z "$PUBLIC_BASE_URL_EFFECTIVE" ]]; then
  PUBLIC_BASE_URL_EFFECTIVE="${PUBLIC_BASE_URL:-${BASE_URL:-http://localhost:3000}}"
fi
PUBLIC_BASE_URL_EFFECTIVE="${PUBLIC_BASE_URL_EFFECTIVE%/}"

export PUBLIC_RETURN_VERIFY_TOKEN=1

log() {
  printf '[availability-debug] %s\n' "$*" >&2
  printf '%s\n' "$*" >> "$SUMMARY_FILE"
}

fail() {
  log "ERROR: $*"
  exit 1
}

header_value() {
  local key="$1"
  local hdr="$2"
  awk -v k="$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')" '
    {
      line=$0
      gsub("\r", "", line)
      split(line, a, ":")
      h=tolower(a[1])
      if (h==k) {
        sub(/^[^:]*:[[:space:]]*/, "", line)
        print line
        exit
      }
    }
  ' "$hdr"
}

record_step() {
  local name="$1"
  local code="$2"
  local req_id="$3"
  printf '%s\t%s\t%s\n' "$name" "$code" "$req_id" >> "$REQUEST_FILE"
  log "step=$name http=$code x-request-id=${req_id:-N/A}"
}

http_call() {
  local name="$1"
  shift
  local hdr="$RUN_DIR/$name.hdr"
  local body="$RUN_DIR/$name.res"
  local code

  code="$(curl -sS -D "$hdr" -o "$body" -w '%{http_code}' "$@")" || code="000"
  printf '%s' "$code" > "$RUN_DIR/$name.code"

  local req_id
  req_id="$(header_value "x-request-id" "$hdr" || true)"
  printf '%s' "$req_id" > "$RUN_DIR/$name.request_id"
  record_step "$name" "$code" "$req_id"

  printf '%s' "$code"
}

expect_2xx() {
  local code="$1"
  local name="$2"
  if [[ ! "$code" =~ ^2 ]]; then
    log "HTTP failure at $name"
    cat "$RUN_DIR/$name.hdr" || true
    cat "$RUN_DIR/$name.res" || true
    fail "$name failed (http=$code)"
  fi
}

json_get() {
  local file="$1"
  local expr="$2"
  jq -r "$expr" "$file"
}

save_availability() {
  local step="$1"
  local out="$2"
  expect_2xx "$(http_call "$step" "$API_BASE/v1/public/$TENANT_SLUG/availability?salesperson=$DEBUG_SALESPERSON_ID&date=$DEBUG_DATE")" "$step"
  cp "$RUN_DIR/$step.res" "$RUN_DIR/$out"
}

write_meta() {
  local booking_id="$1"
  local verify_url="$2"
  local cancel_url="$3"
  local cancel_token="$4"
  local verify_token="$5"
  local booking_status="${6:-}"

  jq -n \
    --arg tenantSlug "$TENANT_SLUG" \
    --arg salespersonId "$DEBUG_SALESPERSON_ID" \
    --arg date "$DEBUG_DATE" \
    --arg booking_id "$booking_id" \
    --arg verify_url "$verify_url" \
    --arg cancel_url "$cancel_url" \
    --arg cancel_token "$cancel_token" \
    --arg verify_token "$verify_token" \
    --arg requestedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg scriptName "$SCRIPT_NAME" \
    --arg runDir "$RUN_DIR" \
    --arg envFile "$ENV_FILE" \
    --arg apiBase "$API_BASE" \
    --arg publicBase "$PUBLIC_BASE_URL_EFFECTIVE" \
    --arg publicReturnVerifyToken "${PUBLIC_RETURN_VERIFY_TOKEN:-}" \
    --arg baseUrl "${BASE_URL:-}" \
    --arg apiBaseUrlEnv "${API_BASE_URL:-}" \
    --arg graphEnabled "${GRAPH_ENABLED:-}" \
    --arg graphMock "${GRAPH_MOCK:-}" \
    --arg zoomMock "${ZOOM_MOCK:-}" \
    --arg queueDriver "${QUEUE_DRIVER:-}" \
    --arg databaseUrlSet "$([[ -n "${DATABASE_URL:-}" ]] && printf 'true' || printf 'false')" \
    --arg bookingStatus "$booking_status" \
    --slurpfile reqs <(awk 'NR>1 {print}' "$REQUEST_FILE" | jq -R -s '
      split("\n")
      | map(select(length > 0))
      | map(split("\t"))
      | map({step: .[0], http_code: .[1], x_request_id: .[2]})
    ') \
    '{
      tenantSlug: $tenantSlug,
      salespersonId: $salespersonId,
      date: $date,
      booking_id: $booking_id,
      verify_url: $verify_url,
      cancel_url: $cancel_url,
      cancel_token: $cancel_token,
      verify_token: $verify_token,
      request_timestamp: $requestedAt,
      script_name: $scriptName,
      debug_run_directory_path: $runDir,
      env_summary: {
        ENV_FILE: $envFile,
        API_BASE: $apiBase,
        PUBLIC_BASE_URL_EFFECTIVE: $publicBase,
        PUBLIC_RETURN_VERIFY_TOKEN: $publicReturnVerifyToken,
        BASE_URL: $baseUrl,
        API_BASE_URL: $apiBaseUrlEnv,
        GRAPH_ENABLED: $graphEnabled,
        GRAPH_MOCK: $graphMock,
        ZOOM_MOCK: $zoomMock,
        QUEUE_DRIVER: $queueDriver,
        DATABASE_URL_SET: $databaseUrlSet
      },
      request_info: $reqs[0],
      booking_status: $bookingStatus
    }' > "$RUN_DIR/booking_flow_meta.json"
}

maybe_capture_db_status() {
  if ! command -v psql >/dev/null 2>&1; then
    return 0
  fi
  if [[ -z "${DATABASE_URL:-}" || -z "${BOOKING_ID:-}" ]]; then
    return 0
  fi

  local db_url
  db_url="${DATABASE_URL%%\?schema=*}"
  psql "$db_url" -AtF $'\t' -c \
    "select id,status,salesperson_id,to_char(start_at_utc at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'),to_char(end_at_utc at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') from bookings where id='${BOOKING_ID}' limit 1;" \
    | awk -F '\t' 'NF==5 {printf("{\"id\":\"%s\",\"status\":\"%s\",\"salesperson_id\":\"%s\",\"start_at_utc\":\"%s\",\"end_at_utc\":\"%s\"}\n",$1,$2,$3,$4,$5)}' \
    > "$RUN_DIR/booking_status.json" || true
}

capture_api_debug_log() {
  if [[ -z "$API_LOG_SOURCE" || ! -f "$API_LOG_SOURCE" ]]; then
    : > "$RUN_DIR/api_debug_grep.log"
    return 0
  fi
  grep -E 'availability_debug_|public_booking_cancel_|availability_cache_invalidated' "$API_LOG_SOURCE" > "$RUN_DIR/api_debug_grep.log" || true
}

log "run_dir=$RUN_DIR"
log "tenant_slug=$TENANT_SLUG salesperson_id=$DEBUG_SALESPERSON_ID date=$DEBUG_DATE"

expect_2xx "$(http_call health "$API_BASE/health")" "health"
expect_2xx "$(http_call ready "$API_BASE/ready")" "ready"

save_availability "availability_before" "before_availability.json"

if ! jq -e --arg s "$TARGET_START_UTC" --arg e "$TARGET_END_UTC" 'any(.[]; .start_at_utc == $s and .end_at_utc == $e)' "$RUN_DIR/before_availability.json" >/dev/null; then
  fail "target slot $TARGET_START_UTC - $TARGET_END_UTC not present before hold"
fi
if ! jq -e --arg s "$EXPECTED_SECOND_START_UTC" --arg e "$EXPECTED_SECOND_END_UTC" 'any(.[]; .start_at_utc == $s and .end_at_utc == $e)' "$RUN_DIR/before_availability.json" >/dev/null; then
  fail "expected second slot $EXPECTED_SECOND_START_UTC - $EXPECTED_SECOND_END_UTC not present before hold"
fi

EMAIL="availability-debug-$(date +%s)@example.com"
cat > "$RUN_DIR/hold_payload.json" <<JSON
{
  "salesperson_id": "$DEBUG_SALESPERSON_ID",
  "start_at": "$TARGET_START_UTC",
  "end_at": "$TARGET_END_UTC",
  "booking_mode": "online",
  "public_notes": "availability debug hold",
  "customer": { "email": "$EMAIL", "name": "Availability Debug", "company": "Acme" }
}
JSON

expect_2xx "$(http_call hold -X POST \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: availability-debug-hold-$RUN_ID" \
  "$API_BASE/v1/public/$TENANT_SLUG/holds" \
  --data-binary "@$RUN_DIR/hold_payload.json")" "hold"

BOOKING_ID="$(json_get "$RUN_DIR/hold.res" '.id // empty')"
[[ -n "$BOOKING_ID" ]] || fail "BOOKING_ID_EMPTY"

save_availability "availability_after_hold" "after_hold_availability.json"

expect_2xx "$(http_call verify -X POST \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: availability-debug-verify-$RUN_ID" \
  "$API_BASE/v1/public/$TENANT_SLUG/auth/verify-email" \
  -d "{\"booking_id\":\"$BOOKING_ID\"}")" "verify"

VERIFY_TOKEN="$(json_get "$RUN_DIR/verify.res" '.token // empty')"
[[ -n "$VERIFY_TOKEN" ]] || fail "VERIFY_TOKEN_EMPTY"
VERIFY_URL="$PUBLIC_BASE_URL_EFFECTIVE/public/$TENANT_SLUG?token=$VERIFY_TOKEN"

expect_2xx "$(http_call confirm -X POST \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: availability-debug-confirm-$RUN_ID" \
  "$API_BASE/v1/public/$TENANT_SLUG/confirm" \
  -d "{\"token\":\"$VERIFY_TOKEN\"}")" "confirm"

CANCEL_URL="$(json_get "$RUN_DIR/confirm.res" '.cancel_url // empty')"
[[ -n "$CANCEL_URL" ]] || fail "CANCEL_URL_EMPTY"
CANCEL_BOOKING_ID="$(printf '%s' "$CANCEL_URL" | sed -n 's/.*[?&]booking_id=\([^&]*\).*/\1/p')"
CANCEL_TOKEN="$(printf '%s' "$CANCEL_URL" | sed -n 's/.*[?&]token=\([^&]*\).*/\1/p')"
[[ "$CANCEL_BOOKING_ID" == "$BOOKING_ID" ]] || fail "CANCEL_BOOKING_ID_MISMATCH"
[[ -n "$CANCEL_TOKEN" ]] || fail "CANCEL_TOKEN_EMPTY"

save_availability "availability_after_confirm" "after_confirm_availability.json"

expect_2xx "$(http_call cancel -X POST \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: availability-debug-cancel-$RUN_ID" \
  "$API_BASE/v1/public/$TENANT_SLUG/bookings/$CANCEL_BOOKING_ID/cancel" \
  -d "{\"token\":\"$CANCEL_TOKEN\"}")" "cancel"

save_availability "availability_after_cancel" "after_cancel_availability.json"

maybe_capture_db_status
BOOKING_STATUS_VALUE="$(jq -r '.status // empty' "$RUN_DIR/booking_status.json" 2>/dev/null || true)"
capture_api_debug_log
write_meta "$BOOKING_ID" "$VERIFY_URL" "$CANCEL_URL" "$CANCEL_TOKEN" "$VERIFY_TOKEN" "$BOOKING_STATUS_VALUE"

log "booking_id=$BOOKING_ID"
log "verify_url=$VERIFY_URL"
log "cancel_url=$CANCEL_URL"
log "api_debug_log=$RUN_DIR/api_debug_grep.log"
log "DONE"
