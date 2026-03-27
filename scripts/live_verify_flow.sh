#!/usr/bin/env bash
set -euo pipefail

TENANT="${TENANT:-acme}"
API_BASE="${API_BASE:-http://127.0.0.1:4000}"
EMAIL="${EMAIL:-rairairai0409@gmail.com}"

echo "===== salespersons ====="
SALES_JSON="$(curl -sS "$API_BASE/v1/public/$TENANT/salespersons")"
echo "$SALES_JSON" | jq .
SP_ID="$(echo "$SALES_JSON" | jq -r '.[0].id // empty')"
[ -n "$SP_ID" ] || { echo "SP_ID_EMPTY"; exit 1; }
echo "SP_ID=$SP_ID"

FOUND=""
for d in $(seq 0 14); do
  DATE="$(date -u -d "+$d days" +%F)"
  RES="$(curl -sS "$API_BASE/v1/public/$TENANT/availability?salesperson=$SP_ID&date=$DATE")"
  if ! echo "$RES" | jq -e 'type=="array"' >/dev/null 2>&1; then
    echo "AVAILABILITY_NOT_ARRAY DATE=$DATE"
    echo "$RES"
    exit 1
  fi
  CNT="$(echo "$RES" | jq 'length')"
  echo "DATE=$DATE COUNT=$CNT"
  if [ "$CNT" -gt 0 ]; then
    SLOT="$(echo "$RES" | jq -c '.[0]')"
    START="$(echo "$SLOT" | jq -r '.start_at_utc')"
    END="$(echo "$SLOT" | jq -r '.end_at_utc')"
    FOUND=1
    break
  fi
done

[ -n "$FOUND" ] || { echo "NO_SLOT_FOUND"; exit 1; }

echo
echo "===== hold ====="
curl -sS -D /tmp/hold_live.hdr -o /tmp/hold_live.body \
  -X POST "$API_BASE/v1/public/$TENANT/holds" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: hold-live-$(date +%s%N)" \
  -d "$(jq -n \
    --arg salesperson_id "$SP_ID" \
    --arg start_at "$START" \
    --arg end_at "$END" \
    --arg email "$EMAIL" \
    '{
      salesperson_id: $salesperson_id,
      start_at: $start_at,
      end_at: $end_at,
      booking_mode: "online",
      customer: {
        email: $email,
        name: "Live Verify"
      }
    }'
  )"

BOOKING_ID="$(jq -r '.id // empty' /tmp/hold_live.body)"
[ -n "$BOOKING_ID" ] || { echo "BOOKING_ID_EMPTY"; cat /tmp/hold_live.body; exit 1; }

echo
echo "===== verify-email ====="
curl -sS -D /tmp/verify_live.hdr -o /tmp/verify_live.body \
  -X POST "$API_BASE/v1/public/$TENANT/auth/verify-email" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: verify-live-$(date +%s%N)" \
  -d "{\"booking_id\":\"$BOOKING_ID\"}"

VERIFY_TOKEN="$(jq -r '.token // empty' /tmp/verify_live.body)"
[ -n "$VERIFY_TOKEN" ] || { echo "VERIFY_TOKEN_EMPTY"; cat /tmp/verify_live.body; exit 1; }

echo
echo '===== HOLD BODY ====='
cat /tmp/hold_live.body
echo
echo '===== VERIFY BODY ====='
cat /tmp/verify_live.body
echo
echo "BOOKING_ID=$BOOKING_ID"
echo "EMAIL=$EMAIL"
echo "VERIFY_TOKEN=$VERIFY_TOKEN"
