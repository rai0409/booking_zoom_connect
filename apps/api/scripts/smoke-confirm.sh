#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
set -a; source .env; set +a
export PUBLIC_RETURN_VERIFY_TOKEN=1

TENANT="${TENANT:-acme}"
SALESPERSON_ID="${SALESPERSON_ID:-b806673d-144e-448d-ab4f-ce91885f48e8}"
START_AT="${START_AT:-$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)}"
END_AT="${END_AT:-$(date -u -d '+3 hours' +%Y-%m-%dT%H:%M:%SZ)}"
EMAIL="${EMAIL:-smoke+confirm2@example.com}"

try_create_hold() {
  local start_at="$1"
  local end_at="$2"
  curl -sS -w "\n%{http_code}" -X POST "http://127.0.0.1:4000/v1/public/$TENANT/holds" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: hold-$(date +%s%N)" \
    -d "{\"salesperson_id\":\"$SALESPERSON_ID\",\"start_at\":\"$start_at\",\"end_at\":\"$end_at\",\"booking_mode\":\"online\",\"customer\":{\"email\":\"$EMAIL\",\"name\":\"Smoke Confirm\"}}"
}

HOLD_JSON=""
for i in {1..12}; do
  # 409回避のため、毎回+${i}時間の枠を試す
  CUR_START="$(date -u -d "$START_AT +${i} hour" +%Y-%m-%dT%H:%M:%SZ)"
  CUR_END="$(date -u -d "$END_AT +${i} hour" +%Y-%m-%dT%H:%M:%SZ)"
  RESP="$(try_create_hold "$CUR_START" "$CUR_END")"
  CODE="$(echo "$RESP" | tail -n 1)"
  BODY="$(echo "$RESP" | sed '$d')"
  if [ "$CODE" = "201" ] || [ "$CODE" = "200" ]; then
    START_AT="$CUR_START"
    END_AT="$CUR_END"
    HOLD_JSON="$BODY"
    break
  fi
  if [ "$CODE" != "409" ]; then
    echo "ERROR: hold create failed (code=$CODE)"
    echo "$BODY"
    exit 1
  fi
done

if [ -z "$HOLD_JSON" ]; then
  echo "ERROR: could not find free slot (last tried START_AT=$CUR_START END_AT=$CUR_END)"
  exit 1
fi
BOOKING_ID=$(echo "$HOLD_JSON" | jq -r .id)
echo "BOOKING_ID=$BOOKING_ID"

VERIFY_JSON=$(curl -fsS -X POST "http://127.0.0.1:4000/v1/public/$TENANT/auth/verify-email" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: verify-$(date +%s%N)" \
  -d "{\"booking_id\":\"$BOOKING_ID\"}")

TOKEN=$(echo "$VERIFY_JSON" | jq -r .token)

curl -fsS -X POST "http://127.0.0.1:4000/v1/public/$TENANT/confirm" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: confirm-$(date +%s%N)" \
  -d "{\"token\":\"$TOKEN\"}" | jq .

psql "${DATABASE_URL%\?schema=public}" -c "select id, status from bookings where id='$BOOKING_ID';"
psql "${DATABASE_URL%\?schema=public}" -c "select booking_id from holds where booking_id='$BOOKING_ID';"
