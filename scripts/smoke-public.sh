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

say "DB assert status=confirmed"
DB_STATUS="$(psql "$DB_NO_SCHEMA" -Atc "select status from bookings where id='${BOOKING_ID}' limit 1;")"
[[ "$DB_STATUS" == "confirmed" ]] || { echo "[smoke] DB status expected confirmed but got: $DB_STATUS" >&2; exit 1; }

cat > "$ARTIFACT_DIR/final-summary.json" <<JSON
{
  "tenant_slug": "$TENANT_SLUG",
  "booking_id": "$BOOKING_ID",
  "status": "$DB_STATUS",
  "artifact_dir": "$ARTIFACT_DIR"
}
JSON

say "OK booking_id=$BOOKING_ID"
say "request-id map: $REQUEST_FILE"
