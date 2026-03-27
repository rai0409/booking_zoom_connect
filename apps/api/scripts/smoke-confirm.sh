#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
set -a; source .env; set +a
export PUBLIC_RETURN_VERIFY_TOKEN=1

TENANT="${TENANT:-acme}"
BASE_URL="${BASE_URL:-http://127.0.0.1:4000}"
EMAIL="${EMAIL:-smoke+confirm-$(date +%s)@example.com}"
ARTIFACT_DIR="${ARTIFACT_DIR:-/tmp/smoke-confirm-$(date +%Y%m%d_%H%M%S)}"
mkdir -p "$ARTIFACT_DIR"

fail() {
  local code="$1"
  local detail="${2:-}"
  if [[ -n "$detail" ]]; then
    echo "ERROR: ${code}: ${detail}" >&2
  else
    echo "ERROR: ${code}" >&2
  fi
  exit 1
}

http_call() {
  local name="$1"
  shift
  local body="$ARTIFACT_DIR/$name.json"
  local code
  code="$(curl -sS -o "$body" -w '%{http_code}' "$@")" || code="000"
  echo "$code"
}

SALES_CODE="$(http_call salespersons "$BASE_URL/v1/public/$TENANT/salespersons")"
[[ "$SALES_CODE" =~ ^2 ]] || fail "SP_ID_EMPTY" "salespersons http=$SALES_CODE"
if ! jq -e 'type=="array"' "$ARTIFACT_DIR/salespersons.json" >/dev/null 2>&1; then
  fail "SP_ID_EMPTY" "salespersons response is not array"
fi
SALESPERSON_ID="$(jq -r '.[0].id' "$ARTIFACT_DIR/salespersons.json")"
if [[ "$SALESPERSON_ID" == "null" ]]; then
  SALESPERSON_ID=""
fi
[[ -n "$SALESPERSON_ID" ]] || fail "SP_ID_EMPTY"

SLOT=""
for d in {0..14}; do
  YMD="$(date -u -d "+$d days" +%F)"
  AVAIL_CODE="$(http_call "availability_$d" "$BASE_URL/v1/public/$TENANT/availability?salesperson=$SALESPERSON_ID&date=$YMD")"
  [[ "$AVAIL_CODE" =~ ^2 ]] || fail "NO_SLOT_FOUND" "availability http=$AVAIL_CODE date=$YMD"
  if ! jq -e 'type=="array"' "$ARTIFACT_DIR/availability_$d.json" >/dev/null 2>&1; then
    fail "AVAILABILITY_NOT_ARRAY" "date=$YMD"
  fi
  if jq -e 'length==0' "$ARTIFACT_DIR/availability_$d.json" >/dev/null 2>&1; then
    continue
  fi
  SLOT="$(jq -c '.[0] // empty' "$ARTIFACT_DIR/availability_$d.json")"
  [[ -n "$SLOT" ]] && break
done
[[ -n "$SLOT" ]] || fail "NO_SLOT_FOUND"

START_AT="$(printf '%s' "$SLOT" | jq -r '.start_at_utc // empty')"
END_AT="$(printf '%s' "$SLOT" | jq -r '.end_at_utc // empty')"
[[ -n "$START_AT" && -n "$END_AT" ]] || fail "NO_SLOT_FOUND" "slot payload missing start/end"

cat > "$ARTIFACT_DIR/hold_payload.json" <<JSON
{
  "salesperson_id": "$SALESPERSON_ID",
  "start_at": "$START_AT",
  "end_at": "$END_AT",
  "booking_mode": "online",
  "customer": { "email": "$EMAIL", "name": "Smoke Confirm" }
}
JSON
HOLD_CODE="$(http_call hold -X POST "$BASE_URL/v1/public/$TENANT/holds" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: hold-$(date +%s%N)" \
  --data-binary "@$ARTIFACT_DIR/hold_payload.json")"
[[ "$HOLD_CODE" =~ ^2 ]] || fail "BOOKING_ID_EMPTY" "hold http=$HOLD_CODE"

BOOKING_ID="$(jq -r '.id // empty' "$ARTIFACT_DIR/hold.json")"
[[ -n "$BOOKING_ID" ]] || fail "BOOKING_ID_EMPTY"
echo "BOOKING_ID=$BOOKING_ID"

VERIFY_CODE="$(http_call verify -X POST "$BASE_URL/v1/public/$TENANT/auth/verify-email" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: verify-$(date +%s%N)" \
  -d "{\"booking_id\":\"$BOOKING_ID\"}")"
[[ "$VERIFY_CODE" =~ ^2 ]] || fail "VERIFY_TOKEN_EMPTY" "verify http=$VERIFY_CODE"
TOKEN="$(jq -r '.token // empty' "$ARTIFACT_DIR/verify.json")"
[[ -n "$TOKEN" ]] || fail "VERIFY_TOKEN_EMPTY"

CONFIRM_CODE="$(http_call confirm -X POST "$BASE_URL/v1/public/$TENANT/confirm" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: confirm-$(date +%s%N)" \
  -d "{\"token\":\"$TOKEN\"}")"
[[ "$CONFIRM_CODE" =~ ^2 ]] || fail "INTERNAL_ERROR" "confirm http=$CONFIRM_CODE"
jq '.' "$ARTIFACT_DIR/confirm.json"

psql "${DATABASE_URL%\?schema=public}" -c "select id, status from bookings where id='$BOOKING_ID';"
psql "${DATABASE_URL%\?schema=public}" -c "select booking_id from holds where booking_id='$BOOKING_ID';"
