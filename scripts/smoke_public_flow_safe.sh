#!/usr/bin/env bash
set -euo pipefail

TENANT_SLUG="${TENANT_SLUG:-acme}"
API_BASE="${API_BASE:-http://localhost:4000}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
RUN_ID="$(date +%Y%m%d_%H%M%S)"
ARTIFACT_DIR="${ARTIFACT_DIR:-$ROOT_DIR/artifacts/smoke_public_flow_safe/$RUN_ID}"

mkdir -p "$ARTIFACT_DIR"
SUMMARY_FILE="$ARTIFACT_DIR/summary.txt"
REQUEST_FILE="$ARTIFACT_DIR/request-ids.tsv"
: > "$SUMMARY_FILE"
: > "$REQUEST_FILE"
printf 'step\thttp_code\tx_request_id\n' >> "$REQUEST_FILE"

require() { command -v "$1" >/dev/null 2>&1 || { echo "missing command: $1" >&2; exit 1; }; }
require curl
require jq
require date
require sed

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

export PUBLIC_RETURN_VERIFY_TOKEN=1

if [[ -z "${ADMIN_API_KEY:-}" ]]; then
  echo "ADMIN_API_KEY missing in .env" >&2
  exit 1
fi

log() {
  printf '[smoke-safe] %s\n' "$*" >&2
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
  local hdr="$ARTIFACT_DIR/$name.hdr"
  local body="$ARTIFACT_DIR/$name.res"
  local code

  code="$(curl -sS -D "$hdr" -o "$body" -w '%{http_code}' "$@")" || code="000"
  printf '%s' "$code" > "$ARTIFACT_DIR/$name.code"

  local req_id
  req_id="$(header_value "x-request-id" "$hdr" || true)"
  printf '%s' "$req_id" > "$ARTIFACT_DIR/$name.request_id"
  record_step "$name" "$code" "$req_id"

  printf '%s' "$code"
}

expect_2xx() {
  local code="$1"
  local name="$2"
  if [[ ! "$code" =~ ^2 ]]; then
    log "HTTP failure at $name"
    cat "$ARTIFACT_DIR/$name.hdr" || true
    cat "$ARTIFACT_DIR/$name.res" || true
    fail "$name failed (http=$code)"
  fi
}

json_get() {
  local file="$1"
  local expr="$2"
  jq -r "$expr" "$file"
}

fallback_salesperson_from_db() {
  if ! command -v psql >/dev/null 2>&1; then
    return 1
  fi
  if [[ -z "${DATABASE_URL:-}" ]]; then
    return 1
  fi

  local db_url tenant_id sp_id
  db_url="${DATABASE_URL%%\?schema=*}"
  tenant_id="$(psql "$db_url" -Atc "select id from tenants where slug='${TENANT_SLUG}' limit 1;" 2>/dev/null || true)"
  [[ -n "$tenant_id" ]] || return 1

  sp_id="$(psql "$db_url" -Atc "select id from salespersons where tenant_id='${tenant_id}' and active=true order by display_name asc limit 1;" 2>/dev/null || true)"
  [[ -n "$sp_id" ]] || return 1

  printf '%s' "$sp_id"
}

pick_future_slot() {
  local salesperson_id="$1"
  local min_epoch ymd code slot
  min_epoch="$(date -u -d '+48 hours' +%s)"

  for d in {0..7}; do
    ymd="$(date -u -d "+$d days" +%F)"
    code="$(http_call "availability_$d" "$API_BASE/v1/public/$TENANT_SLUG/availability?salesperson=$salesperson_id&date=$ymd")"
    expect_2xx "$code" "availability_$d"

    slot="$(jq -c --argjson min "$min_epoch" '
      map(
        select(
          (.start_at_utc | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) >= $min
        )
      ) | .[0] // empty
    ' "$ARTIFACT_DIR/availability_$d.res")"

    if [[ -n "$slot" ]]; then
      printf '%s' "$slot"
      return 0
    fi
  done

  return 1
}

log "artifact_dir=$ARTIFACT_DIR"

# Preflight
expect_2xx "$(http_call health "$API_BASE/health")" "health"
expect_2xx "$(http_call ready "$API_BASE/ready")" "ready"

# Salesperson discovery: API first
SP_SOURCE="api"
SP_ID=""
SALES_CODE="$(http_call salespersons "$API_BASE/v1/public/$TENANT_SLUG/salespersons")"
expect_2xx "$SALES_CODE" "salespersons"

if jq -e 'type=="array" and length>0' "$ARTIFACT_DIR/salespersons.res" >/dev/null 2>&1; then
  SP_ID="$(json_get "$ARTIFACT_DIR/salespersons.res" '.[0].id // empty')"
fi

if [[ -z "$SP_ID" ]]; then
  SP_SOURCE="db-fallback"
  SP_ID="$(fallback_salesperson_from_db || true)"
fi

[[ -n "$SP_ID" ]] || fail "No salesperson found (API empty and DB fallback failed)"
log "salesperson_source=$SP_SOURCE salesperson_id=$SP_ID"

# booking1: hold -> verify -> confirm -> cancel
SLOT="$(pick_future_slot "$SP_ID" || true)"
[[ -n "$SLOT" ]] || fail "No slot found (>=48h). Check business hours / max_days_ahead / seed"

START="$(printf '%s' "$SLOT" | jq -r '.start_at_utc')"
END="$(printf '%s' "$SLOT" | jq -r '.end_at_utc')"
EMAIL="smoke+safe-$(date +%s)@example.com"

cat > "$ARTIFACT_DIR/hold_payload.json" <<JSON
{
  "salesperson_id": "$SP_ID",
  "start_at": "$START",
  "end_at": "$END",
  "booking_mode": "online",
  "public_notes": "smoke safe hold",
  "customer": { "email": "$EMAIL", "name": "Safe Smoke", "company": "Acme" }
}
JSON

expect_2xx "$(http_call hold -X POST \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: smoke-hold-$(date +%s%N)" \
  "$API_BASE/v1/public/$TENANT_SLUG/holds" \
  --data-binary "@$ARTIFACT_DIR/hold_payload.json")" "hold"

BOOKING_ID="$(json_get "$ARTIFACT_DIR/hold.res" '.id // empty')"
[[ -n "$BOOKING_ID" ]] || fail "booking_id missing in hold response"

expect_2xx "$(http_call verify -X POST \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: smoke-verify-$(date +%s%N)" \
  "$API_BASE/v1/public/$TENANT_SLUG/auth/verify-email" \
  -d "{\"booking_id\":\"$BOOKING_ID\"}")" "verify"

VERIFY_TOKEN="$(json_get "$ARTIFACT_DIR/verify.res" '.token // empty')"
[[ -n "$VERIFY_TOKEN" ]] || fail "verify token missing"

expect_2xx "$(http_call confirm -X POST \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: smoke-confirm-$(date +%s%N)" \
  "$API_BASE/v1/public/$TENANT_SLUG/confirm" \
  -d "{\"token\":\"$VERIFY_TOKEN\"}")" "confirm"

[[ "$(json_get "$ARTIFACT_DIR/confirm.res" '.status // empty')" == "confirmed" ]] || fail "confirm did not return status=confirmed"

expect_2xx "$(http_call links -H "x-admin-api-key: $ADMIN_API_KEY" \
  "$API_BASE/v1/internal/$TENANT_SLUG/bookings/$BOOKING_ID/links")" "links"

CANCEL_URL="$(json_get "$ARTIFACT_DIR/links.res" '.cancel_url // empty')"
RESCH_URL="$(json_get "$ARTIFACT_DIR/links.res" '.reschedule_url // empty')"
CANCEL_TOKEN="$(printf '%s' "$CANCEL_URL" | sed -n 's/.*[?&]token=\([^&]*\).*/\1/p')"
RESCH_TOKEN="$(printf '%s' "$RESCH_URL" | sed -n 's/.*[?&]token=\([^&]*\).*/\1/p')"
[[ ${#CANCEL_TOKEN} -gt 50 ]] || fail "cancel token parse failed"
[[ ${#RESCH_TOKEN} -gt 50 ]] || fail "reschedule token parse failed"

expect_2xx "$(http_call cancel -X POST \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: smoke-cancel-$(date +%s%N)" \
  "$API_BASE/v1/public/$TENANT_SLUG/bookings/$BOOKING_ID/cancel" \
  -d "{\"token\":\"$CANCEL_TOKEN\"}")" "cancel"

# booking2: hold -> verify -> confirm -> reschedule (with 409 retry)
DATE1="$(date -u -d "$START" +%F)"
DATE2="$(date -u -d "$DATE1 +1 day" +%F)"

expect_2xx "$(http_call availability_resched_same_day "$API_BASE/v1/public/$TENANT_SLUG/availability?salesperson=$SP_ID&date=$DATE1")" "availability_resched_same_day"
expect_2xx "$(http_call availability_resched_next_day "$API_BASE/v1/public/$TENANT_SLUG/availability?salesperson=$SP_ID&date=$DATE2")" "availability_resched_next_day"

jq -c --arg start "$START" '
  map(select(.start_at_utc != $start))
' "$ARTIFACT_DIR/availability_resched_same_day.res" > "$ARTIFACT_DIR/resched_candidates_same_day.json"

jq -c -s '.[0] + .[1]' \
  "$ARTIFACT_DIR/resched_candidates_same_day.json" \
  "$ARTIFACT_DIR/availability_resched_next_day.res" > "$ARTIFACT_DIR/resched_candidates_all.json"

BOOKING2_ID=""
OLD2_START=""
OLD2_END=""

for i in 0 1 2 3 4; do
  SLOT2="$(jq -c ".[$i] // empty" "$ARTIFACT_DIR/resched_candidates_all.json")"
  [[ -n "$SLOT2" ]] || break

  START2="$(printf '%s' "$SLOT2" | jq -r '.start_at_utc')"
  END2="$(printf '%s' "$SLOT2" | jq -r '.end_at_utc')"

  cat > "$ARTIFACT_DIR/hold2_payload_try_$((i+1)).json" <<JSON
{
  "salesperson_id": "$SP_ID",
  "start_at": "$START2",
  "end_at": "$END2",
  "booking_mode": "online",
  "public_notes": "smoke safe reschedule target",
  "customer": { "email": "smoke+safe2-$(date +%s%N)@example.com", "name": "Safe Smoke2", "company": "Acme" }
}
JSON

  CODE2="$(http_call "hold2_try_$((i+1))" -X POST \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: smoke-hold2-$((i+1))-$(date +%s%N)" \
    "$API_BASE/v1/public/$TENANT_SLUG/holds" \
    --data-binary "@$ARTIFACT_DIR/hold2_payload_try_$((i+1)).json")"

  if [[ "$CODE2" =~ ^2 ]]; then
    BOOKING2_ID="$(json_get "$ARTIFACT_DIR/hold2_try_$((i+1)).res" '.id // empty')"
    OLD2_START="$START2"
    OLD2_END="$END2"
    break
  fi

  if [[ "$CODE2" == "409" ]]; then
    log "hold2 conflict -> retry next candidate"
    continue
  fi

  fail "hold2 failed with http=$CODE2"
done

[[ -n "$BOOKING2_ID" ]] || fail "booking2 creation failed after candidate retries"

expect_2xx "$(http_call verify2 -X POST \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: smoke-verify2-$(date +%s%N)" \
  "$API_BASE/v1/public/$TENANT_SLUG/auth/verify-email" \
  -d "{\"booking_id\":\"$BOOKING2_ID\"}")" "verify2"

VERIFY2_TOKEN="$(json_get "$ARTIFACT_DIR/verify2.res" '.token // empty')"
[[ -n "$VERIFY2_TOKEN" ]] || fail "verify2 token missing"

expect_2xx "$(http_call confirm2 -X POST \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: smoke-confirm2-$(date +%s%N)" \
  "$API_BASE/v1/public/$TENANT_SLUG/confirm" \
  -d "{\"token\":\"$VERIFY2_TOKEN\"}")" "confirm2"

[[ "$(json_get "$ARTIFACT_DIR/confirm2.res" '.status // empty')" == "confirmed" ]] || fail "confirm2 did not return confirmed"

expect_2xx "$(http_call links2 -H "x-admin-api-key: $ADMIN_API_KEY" \
  "$API_BASE/v1/internal/$TENANT_SLUG/bookings/$BOOKING2_ID/links")" "links2"

RESCH2_URL="$(json_get "$ARTIFACT_DIR/links2.res" '.reschedule_url // empty')"
RESCH2_TOKEN="$(printf '%s' "$RESCH2_URL" | sed -n 's/.*[?&]token=\([^&]*\).*/\1/p')"
[[ ${#RESCH2_TOKEN} -gt 50 ]] || fail "reschedule2 token parse failed"

expect_2xx "$(http_call availability_reschedule_target "$API_BASE/v1/public/$TENANT_SLUG/availability?salesperson=$SP_ID&date=$(date -u -d "$OLD2_START" +%F)")" "availability_reschedule_target"

jq -c --arg os "$OLD2_START" --arg oe "$OLD2_END" '
  map(select(.start_at_utc != $os or .end_at_utc != $oe))
' "$ARTIFACT_DIR/availability_reschedule_target.res" > "$ARTIFACT_DIR/reschedule_targets.json"

if [[ "$(jq 'length' "$ARTIFACT_DIR/reschedule_targets.json")" -eq 0 ]]; then
  NEXT_DATE="$(date -u -d "$(date -u -d "$OLD2_START" +%F) +1 day" +%F)"
  expect_2xx "$(http_call availability_reschedule_target_next "$API_BASE/v1/public/$TENANT_SLUG/availability?salesperson=$SP_ID&date=$NEXT_DATE")" "availability_reschedule_target_next"
  cp "$ARTIFACT_DIR/availability_reschedule_target_next.res" "$ARTIFACT_DIR/reschedule_targets.json"
fi

[[ "$(jq 'length' "$ARTIFACT_DIR/reschedule_targets.json")" -gt 0 ]] || fail "no candidate slot for reschedule"

RESCHEDULE_OK=0
for i in 0 1 2 3 4; do
  TARGET="$(jq -c ".[$i] // empty" "$ARTIFACT_DIR/reschedule_targets.json")"
  [[ -n "$TARGET" ]] || break

  NEW_START="$(printf '%s' "$TARGET" | jq -r '.start_at_utc')"
  NEW_END="$(printf '%s' "$TARGET" | jq -r '.end_at_utc')"

  if [[ "$NEW_START" == "$OLD2_START" && "$NEW_END" == "$OLD2_END" ]]; then
    continue
  fi

  CODER="$(http_call "reschedule_try_$((i+1))" -X POST \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: smoke-reschedule-$((i+1))-$(date +%s%N)" \
    "$API_BASE/v1/public/$TENANT_SLUG/bookings/$BOOKING2_ID/reschedule" \
    -d "{\"token\":\"$RESCH2_TOKEN\",\"new_start_at\":\"$NEW_START\",\"new_end_at\":\"$NEW_END\"}")"

  if [[ "$CODER" =~ ^2 ]]; then
    RESCHEDULE_OK=1
    break
  fi

  if [[ "$CODER" == "409" ]]; then
    log "reschedule conflict -> retry next candidate"
    continue
  fi

  fail "reschedule failed with http=$CODER"
done

[[ "$RESCHEDULE_OK" -eq 1 ]] || fail "reschedule failed after retry budget"

cat > "$ARTIFACT_DIR/final-summary.json" <<JSON
{
  "tenant_slug": "$TENANT_SLUG",
  "salesperson_source": "$SP_SOURCE",
  "salesperson_id": "$SP_ID",
  "booking1_canceled": "$BOOKING_ID",
  "booking2_rescheduled": "$BOOKING2_ID",
  "artifact_dir": "$ARTIFACT_DIR"
}
JSON

log "DONE booking1(canceled)=$BOOKING_ID booking2(rescheduled)=$BOOKING2_ID"
log "request-id map: $REQUEST_FILE"
log "artifacts: $ARTIFACT_DIR"
