#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
set -a; source .env; set +a

TENANT="${TENANT:-acme}"
SALESPERSON_ID="${SALESPERSON_ID:-b806673d-144e-448d-ab4f-ce91885f48e8}"
START_AT="${START_AT:-2026-02-27T05:00:00Z}"
END_AT="${END_AT:-2026-02-27T06:00:00Z}"
EMAIL="${EMAIL:-smoke+confirm2@example.com}"

HOLD_JSON=$(curl -fsS -X POST "http://127.0.0.1:4000/v1/public/$TENANT/holds" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: hold-$(date +%s%N)" \
  -d "{\"salesperson_id\":\"$SALESPERSON_ID\",\"start_at\":\"$START_AT\",\"end_at\":\"$END_AT\",\"booking_mode\":\"online\",\"customer\":{\"email\":\"$EMAIL\",\"name\":\"Smoke Confirm\"}}")

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
