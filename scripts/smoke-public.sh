#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RUN_ID="$(date +%Y%m%d_%H%M%S)"
ARTIFACT_DIR="${ARTIFACT_DIR:-$ROOT/artifacts/smoke-public/$RUN_ID}"
mkdir -p "$ARTIFACT_DIR"
SUMMARY_FILE="$ARTIFACT_DIR/summary.txt"
REQUEST_FILE="$ARTIFACT_DIR/request-ids.tsv"
: > "$SUMMARY_FILE"
: > "$REQUEST_FILE"
printf 'step\thttp_code\tx_request_id\n' >> "$REQUEST_FILE"

require() { command -v "$1" >/dev/null 2>&1 || { echo "missing command: $1" >&2; exit 1; }; }
require curl
require jq
require psql
require python3

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

export PUBLIC_RETURN_VERIFY_TOKEN=1

BASE_URL="${BASE_URL:-http://localhost:4000}"
TENANT_SLUG="${TENANT_SLUG:-acme}"

: "${DATABASE_URL:?DATABASE_URL required (set in .env or env)}"
DB_NO_SCHEMA="${DATABASE_URL%%\?schema=*}"

uuid() { python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
}

extract_query_param() {
  local url="$1"
  local key="$2"
  python3 - "$url" "$key" <<'PY'
import sys
from urllib.parse import urlparse, parse_qs

url = sys.argv[1]
key = sys.argv[2]
parsed = urlparse(url)
vals = parse_qs(parsed.query).get(key, [""])
print(vals[0])
PY
}

say() {
  printf '[smoke] %s\n' "$*" >&2
  printf '%s\n' "$*" >> "$SUMMARY_FILE"
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

http_call() {
  local name="$1"
  shift
  local hdr="$ARTIFACT_DIR/$name.hdr"
  local body="$ARTIFACT_DIR/$name.res"
  local code req_id

  code="$(curl -sS -D "$hdr" -o "$body" -w '%{http_code}' "$@")" || code="000"
  printf '%s' "$code" > "$ARTIFACT_DIR/$name.code"
  req_id="$(header_value "x-request-id" "$hdr" || true)"
  printf '%s' "$req_id" > "$ARTIFACT_DIR/$name.request_id"
  printf '%s\t%s\t%s\n' "$name" "$code" "$req_id" >> "$REQUEST_FILE"
  say "step=$name http=$code x-request-id=${req_id:-N/A}"
  printf '%s' "$code"
}

expect_2xx() {
  local code="$1"
  local name="$2"
  if [[ ! "$code" =~ ^2 ]]; then
    cat "$ARTIFACT_DIR/$name.hdr" >&2 || true
    cat "$ARTIFACT_DIR/$name.res" >&2 || true
    echo "[smoke] $name failed (http=$code)" >&2
    exit 1
  fi
}

say "artifact_dir=$ARTIFACT_DIR"

say "check /health"
curl -fsS "$BASE_URL/health" | jq -e '.status=="ok"' >/dev/null

say "check /ready"
curl -fsS "$BASE_URL/ready" | jq -e '.ok==true' >/dev/null

say "check DB"
psql "$DB_NO_SCHEMA" -c "select 1;" >/dev/null

say "resolve tenant by slug=$TENANT_SLUG"
TENANT_ID="$(psql "$DB_NO_SCHEMA" -Atc "select id from tenants where slug='${TENANT_SLUG}' limit 1;")"
[[ -n "$TENANT_ID" ]] || { echo "[smoke] tenant not found for slug=$TENANT_SLUG" >&2; exit 1; }

say "pick salesperson for tenant"
SP_ID="$(psql "$DB_NO_SCHEMA" -Atc "select id from salespersons where tenant_id='${TENANT_ID}' and active=true order by created_at asc limit 1;")"
[[ -n "$SP_ID" ]] || { echo "[smoke] active salesperson not found for tenant_id=$TENANT_ID" >&2; exit 1; }

pick_slot() {
  local d ymd avail
  for d in {0..7}; do
    ymd="$(date -u -d "+$d days" +%F)"
    avail="$(curl -fsS "$BASE_URL/v1/public/${TENANT_SLUG}/availability?salesperson=${SP_ID}&date=${ymd}")"
    printf '%s\n' "$avail" > "$ARTIFACT_DIR/availability_${d}.res"
    if echo "$avail" | jq -e 'type=="array" and length>0 and .[0].start_at_utc and .[0].end_at_utc' >/dev/null; then
      cp "$ARTIFACT_DIR/availability_${d}.res" "$ARTIFACT_DIR/availability.res"
      START_AT="$(echo "$avail" | jq -r '.[0].start_at_utc')"
      END_AT="$(echo "$avail" | jq -r '.[0].end_at_utc')"
      say "availability_date=$ymd"
      say "slot: $START_AT -> $END_AT"
      return 0
    fi
  done
  return 1
}

say "GET availability (find first slot in next 7 days)"
pick_slot || { echo "[smoke] no availability in next 7 days for salesperson=$SP_ID" >&2; exit 1; }

IDEMP="$(uuid)"
EMAIL="smoke+$(date +%s)@example.com"

cat > "$ARTIFACT_DIR/hold_payload.json" <<JSON
{
  "salesperson_id": "$SP_ID",
  "start_at": "$START_AT",
  "end_at": "$END_AT",
  "customer": { "email": "$EMAIL", "name": "Smoke" }
}
JSON

say "POST hold"
expect_2xx "$(http_call hold -X POST "$BASE_URL/v1/public/${TENANT_SLUG}/holds" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ${IDEMP}" \
  --data-binary "@$ARTIFACT_DIR/hold_payload.json")" "hold"

BOOKING_ID="$(jq -r '.id // empty' "$ARTIFACT_DIR/hold.res")"
[[ -n "$BOOKING_ID" ]] || { echo "[smoke] hold response missing id" >&2; cat "$ARTIFACT_DIR/hold.res" >&2; exit 1; }

IDEMP="$(uuid)"
say "POST verify-email"
expect_2xx "$(http_call verify -X POST "$BASE_URL/v1/public/${TENANT_SLUG}/auth/verify-email" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ${IDEMP}" \
  -d "$(jq -n --arg id "$BOOKING_ID" '{booking_id:$id}')")" "verify"

TOKEN="$(jq -r '.token // empty' "$ARTIFACT_DIR/verify.res")"
[[ -n "$TOKEN" ]] || { echo "[smoke] verify-email missing token" >&2; cat "$ARTIFACT_DIR/verify.res" >&2; exit 1; }

IDEMP="$(uuid)"
say "POST confirm"
expect_2xx "$(http_call confirm -X POST "$BASE_URL/v1/public/${TENANT_SLUG}/confirm" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ${IDEMP}" \
  -d "$(jq -n --arg t "$TOKEN" '{token:$t}')")" "confirm"

jq -e '.status=="confirmed" and .booking_id=="'"$BOOKING_ID"'"' "$ARTIFACT_DIR/confirm.res" >/dev/null

CANCEL_URL="$(jq -r '.cancel_url // empty' "$ARTIFACT_DIR/confirm.res")"
RESCHEDULE_URL="$(jq -r '.reschedule_url // empty' "$ARTIFACT_DIR/confirm.res")"
[[ -n "$CANCEL_URL" ]] || { echo "[smoke] confirm response missing cancel_url" >&2; cat "$ARTIFACT_DIR/confirm.res" >&2; exit 1; }
[[ -n "$RESCHEDULE_URL" ]] || { echo "[smoke] confirm response missing reschedule_url" >&2; cat "$ARTIFACT_DIR/confirm.res" >&2; exit 1; }

CANCEL_BOOKING_ID="$(extract_query_param "$CANCEL_URL" "booking_id")"
CANCEL_TOKEN="$(extract_query_param "$CANCEL_URL" "token")"
RESCHEDULE_BOOKING_ID="$(extract_query_param "$RESCHEDULE_URL" "booking_id")"
RESCHEDULE_TOKEN="$(extract_query_param "$RESCHEDULE_URL" "token")"
[[ "$CANCEL_BOOKING_ID" == "$BOOKING_ID" ]] || { echo "[smoke] cancel_url booking_id mismatch: $CANCEL_BOOKING_ID" >&2; exit 1; }
[[ "$RESCHEDULE_BOOKING_ID" == "$BOOKING_ID" ]] || { echo "[smoke] reschedule_url booking_id mismatch: $RESCHEDULE_BOOKING_ID" >&2; exit 1; }
[[ ${#CANCEL_TOKEN} -gt 50 ]] || { echo "[smoke] cancel token parse failed" >&2; exit 1; }
[[ ${#RESCHEDULE_TOKEN} -gt 50 ]] || { echo "[smoke] reschedule token parse failed" >&2; exit 1; }

IDEMP="$(uuid)"
say "POST cancel (from confirm link contract)"
expect_2xx "$(http_call cancel -X POST "$BASE_URL/v1/public/${TENANT_SLUG}/bookings/${CANCEL_BOOKING_ID}/cancel" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ${IDEMP}" \
  -d "$(jq -n --arg t "$CANCEL_TOKEN" '{token:$t}')")" "cancel"
jq -e '.status=="canceled"' "$ARTIFACT_DIR/cancel.res" >/dev/null

say "DB assert booking1 status=canceled"
BOOKING1_STATUS="$(psql "$DB_NO_SCHEMA" -Atc "select status from bookings where id='${BOOKING_ID}' limit 1;")"
[[ "$BOOKING1_STATUS" == "canceled" ]] || { echo "[smoke] booking1 DB status expected canceled but got: $BOOKING1_STATUS" >&2; exit 1; }

say "GET availability for booking2"
pick_slot || { echo "[smoke] no availability for booking2 in next 7 days for salesperson=$SP_ID" >&2; exit 1; }

IDEMP="$(uuid)"
EMAIL2="smoke2+$(date +%s)@example.com"

cat > "$ARTIFACT_DIR/hold2_payload.json" <<JSON
{
  "salesperson_id": "$SP_ID",
  "start_at": "$START_AT",
  "end_at": "$END_AT",
  "customer": { "email": "$EMAIL2", "name": "Smoke2" }
}
JSON

say "POST hold (booking2)"
expect_2xx "$(http_call hold2 -X POST "$BASE_URL/v1/public/${TENANT_SLUG}/holds" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ${IDEMP}" \
  --data-binary "@$ARTIFACT_DIR/hold2_payload.json")" "hold2"

BOOKING2_ID="$(jq -r '.id // empty' "$ARTIFACT_DIR/hold2.res")"
[[ -n "$BOOKING2_ID" ]] || { echo "[smoke] hold2 response missing id" >&2; cat "$ARTIFACT_DIR/hold2.res" >&2; exit 1; }
OLD2_START="$(jq -r '.start_at_utc // empty' "$ARTIFACT_DIR/hold2.res")"
OLD2_END="$(jq -r '.end_at_utc // empty' "$ARTIFACT_DIR/hold2.res")"
[[ -n "$OLD2_START" && -n "$OLD2_END" ]] || { echo "[smoke] hold2 missing start/end" >&2; exit 1; }

IDEMP="$(uuid)"
say "POST verify-email (booking2)"
expect_2xx "$(http_call verify2 -X POST "$BASE_URL/v1/public/${TENANT_SLUG}/auth/verify-email" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ${IDEMP}" \
  -d "$(jq -n --arg id "$BOOKING2_ID" '{booking_id:$id}')")" "verify2"

TOKEN2="$(jq -r '.token // empty' "$ARTIFACT_DIR/verify2.res")"
[[ -n "$TOKEN2" ]] || { echo "[smoke] verify-email2 missing token" >&2; cat "$ARTIFACT_DIR/verify2.res" >&2; exit 1; }

IDEMP="$(uuid)"
say "POST confirm (booking2)"
expect_2xx "$(http_call confirm2 -X POST "$BASE_URL/v1/public/${TENANT_SLUG}/confirm" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ${IDEMP}" \
  -d "$(jq -n --arg t "$TOKEN2" '{token:$t}')")" "confirm2"
jq -e '.status=="confirmed" and .booking_id=="'"$BOOKING2_ID"'"' "$ARTIFACT_DIR/confirm2.res" >/dev/null

RESCHEDULE2_URL="$(jq -r '.reschedule_url // empty' "$ARTIFACT_DIR/confirm2.res")"
[[ -n "$RESCHEDULE2_URL" ]] || { echo "[smoke] confirm2 response missing reschedule_url" >&2; cat "$ARTIFACT_DIR/confirm2.res" >&2; exit 1; }
RESCHEDULE2_BOOKING_ID="$(extract_query_param "$RESCHEDULE2_URL" "booking_id")"
RESCHEDULE2_TOKEN="$(extract_query_param "$RESCHEDULE2_URL" "token")"
[[ "$RESCHEDULE2_BOOKING_ID" == "$BOOKING2_ID" ]] || { echo "[smoke] confirm2 reschedule_url booking_id mismatch: $RESCHEDULE2_BOOKING_ID" >&2; exit 1; }
[[ ${#RESCHEDULE2_TOKEN} -gt 50 ]] || { echo "[smoke] reschedule2 token parse failed" >&2; exit 1; }

OLD2_DATE="$(date -u -d "$OLD2_START" +%F)"
NEXT2_DATE="$(date -u -d "$OLD2_DATE +1 day" +%F)"
expect_2xx "$(http_call availability_reschedule_old "$BASE_URL/v1/public/${TENANT_SLUG}/availability?salesperson=${SP_ID}&date=${OLD2_DATE}")" "availability_reschedule_old"
expect_2xx "$(http_call availability_reschedule_next "$BASE_URL/v1/public/${TENANT_SLUG}/availability?salesperson=${SP_ID}&date=${NEXT2_DATE}")" "availability_reschedule_next"

jq -c --arg os "$OLD2_START" --arg oe "$OLD2_END" '
  map(select(.start_at_utc != $os or .end_at_utc != $oe))
' "$ARTIFACT_DIR/availability_reschedule_old.res" > "$ARTIFACT_DIR/reschedule_candidates_old.json"
jq -c -s '.[0] + .[1]' \
  "$ARTIFACT_DIR/reschedule_candidates_old.json" \
  "$ARTIFACT_DIR/availability_reschedule_next.res" > "$ARTIFACT_DIR/reschedule_candidates_all.json"

RESCHEDULE_OK=0
RESCHEDULED_START=""
RESCHEDULED_END=""
for i in 0 1 2 3 4; do
  TARGET="$(jq -c ".[$i] // empty" "$ARTIFACT_DIR/reschedule_candidates_all.json")"
  [[ -n "$TARGET" ]] || break
  NEW_START="$(printf '%s' "$TARGET" | jq -r '.start_at_utc')"
  NEW_END="$(printf '%s' "$TARGET" | jq -r '.end_at_utc')"

  CODER="$(http_call "reschedule_try_$((i+1))" -X POST "$BASE_URL/v1/public/${TENANT_SLUG}/bookings/${RESCHEDULE2_BOOKING_ID}/reschedule" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: smoke-public-reschedule-$((i+1))-$(date +%s%N)" \
    -d "$(jq -n --arg t "$RESCHEDULE2_TOKEN" --arg ns "$NEW_START" --arg ne "$NEW_END" '{token:$t,new_start_at:$ns,new_end_at:$ne}')")"

  if [[ "$CODER" =~ ^2 ]]; then
    RESCHEDULE_OK=1
    RESCHEDULED_START="$NEW_START"
    RESCHEDULED_END="$NEW_END"
    break
  fi

  if [[ "$CODER" == "409" ]]; then
    say "reschedule conflict -> retry next candidate"
    continue
  fi

  echo "[smoke] reschedule failed (http=$CODER)" >&2
  cat "$ARTIFACT_DIR/reschedule_try_$((i+1)).res" >&2 || true
  exit 1
done

[[ "$RESCHEDULE_OK" -eq 1 ]] || { echo "[smoke] reschedule failed after retry budget" >&2; exit 1; }

say "DB assert booking2 status=confirmed and slot updated"
BOOKING2_STATUS="$(psql "$DB_NO_SCHEMA" -Atc "select status from bookings where id='${BOOKING2_ID}' limit 1;")"
[[ "$BOOKING2_STATUS" == "confirmed" ]] || { echo "[smoke] booking2 DB status expected confirmed but got: $BOOKING2_STATUS" >&2; exit 1; }
BOOKING2_START_DB="$(psql "$DB_NO_SCHEMA" -Atc "select to_char(start_at_utc at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') from bookings where id='${BOOKING2_ID}' limit 1;")"
[[ "$BOOKING2_START_DB" == "${RESCHEDULED_START%%.*}Z" || "$BOOKING2_START_DB" == "$RESCHEDULED_START" ]] || {
  echo "[smoke] booking2 start_at_utc mismatch expected=$RESCHEDULED_START db=$BOOKING2_START_DB" >&2
  exit 1
}

cat > "$ARTIFACT_DIR/final-summary.json" <<JSON
{
  "tenant_slug": "$TENANT_SLUG",
  "booking1_canceled": "$BOOKING_ID",
  "booking2_rescheduled": "$BOOKING2_ID",
  "booking1_status": "$BOOKING1_STATUS",
  "booking2_status": "$BOOKING2_STATUS",
  "artifact_dir": "$ARTIFACT_DIR"
}
JSON

say "OK booking1(canceled)=$BOOKING_ID booking2(rescheduled)=$BOOKING2_ID"
say "request-id map: $REQUEST_FILE"
