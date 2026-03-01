#!/usr/bin/env bash
set -euo pipefail

TENANT_SLUG="${TENANT_SLUG:-acme}"
API_BASE="${API_BASE:-http://localhost:4000}"
ARTIFACT_DIR="${ARTIFACT_DIR:-}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

WORKDIR="$(mktemp -d)"
cleanup() {
  if [[ -n "${ARTIFACT_DIR}" ]]; then
    mkdir -p "$ARTIFACT_DIR"
    cp -a "$WORKDIR/." "$ARTIFACT_DIR/" || true
  fi
}
trap cleanup EXIT
require() { command -v "$1" >/dev/null 2>&1 || { echo "missing command: $1" >&2; exit 1; }; }
require curl
require jq
require date
require sed

# load env (ADMIN_API_KEY, etc.)
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

# curl wrapper: always write headers/body/status
http() {
  # usage: http <name> <curl args...>
  local name="$1"; shift
  local hdr="$WORKDIR/$name.hdr"
  local body="$WORKDIR/$name.res"
  local code
  code="$(curl -sS -D "$hdr" -o "$body" -w '%{http_code}' "$@")" || true
  echo "$code" > "$WORKDIR/$name.code"
  [[ "$code" =~ ^2 ]] || { echo "HTTP $code ($name)"; cat "$hdr" || true; cat "$body" || true; exit 1; }
}
# -------- helpers --------
get_token_from_url() {
  # $1=url -> print token
  printf '%s' "$1" | sed -n 's/.*[?&]token=\([^&]*\).*/\1/p'
}

pick_future_slot() {
  # Choose a slot whose start_at_utc is >= now + 48h (in seconds).
  local min_epoch
  min_epoch="$(date -u -d '+48 hours' +%s)"

  # Search next 7 days (business hours maxDaysAhead default is 7 in your code)
  for d in {0..7}; do
    local ymd
    ymd="$(date -u -d "+$d days" +%F)"
    local slots_json
    slots_json="$(curl -sS "$API_BASE/v1/public/$TENANT_SLUG/availability?date=$ymd")"

    # take first slot that satisfies future condition
    local slot
    slot="$(echo "$slots_json" | jq -c --argjson min "$min_epoch" '
      def to_epoch:
        .start_at_utc
        | sub("\\.[0-9]+Z$"; "Z")
        | fromdateiso8601;
      map(select(to_epoch >= $min)) | .[0] // empty
    ')"

    if [[ -n "$slot" ]]; then
      echo "$slot"
      return 0
    fi
  done

  echo ""  # not found
  return 1
}

echo "[1] pick future slot (>= now+48h) ..."
SLOT="$(pick_future_slot || true)"
if [[ -z "$SLOT" ]]; then
  echo "No suitable slot found (>=48h). Try increasing tenant max_days_ahead or business hours." >&2
  exit 1
fi

START="$(echo "$SLOT" | jq -r '.start_at_utc')"
END="$(echo "$SLOT" | jq -r '.end_at_utc')"
echo "START=$START"
echo "END=$END"

EMAIL="smoke+safe-$(date +%s)@example.com"

cat > /tmp/hold.json <<JSON
{
  "start_at": "$START",
  "end_at": "$END",
  "booking_mode": "online",
  "public_notes": "相談: smoke test",
  "customer": { "email": "$EMAIL", "name": "Safe Smoke", "company": "Acme" }
}
JSON

echo "[2] create hold ..."
http hold -X POST \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: smoke-hold-$(date +%s)" \
  "$API_BASE/v1/public/$TENANT_SLUG/holds" \
  --data-binary @/tmp/hold.json
cat "$WORKDIR/hold.res" | jq .
BOOKING_ID="$(jq -r '.id' "$WORKDIR/hold.res")"

[[ -n "$BOOKING_ID" && "$BOOKING_ID" != "null" ]] || { echo "booking_id missing" >&2; exit 1; }
echo "BOOKING_ID=$BOOKING_ID"

echo "[3] verify-email (get verify token) ..."
http verify -X POST \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: smoke-verify-$(date +%s%N)" \
  "$API_BASE/v1/public/$TENANT_SLUG/auth/verify-email" \
  -d "{\"booking_id\":\"$BOOKING_ID\"}"

cat "$WORKDIR/verify.res" | jq .
VERIFY_TOKEN="$(jq -r '.token' "$WORKDIR/verify.res")"
[[ -n "$VERIFY_TOKEN" && "$VERIFY_TOKEN" != "null" ]] || { echo "verify token missing" >&2; exit 1; }

echo "[4] confirm ..."
http confirm -X POST \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: smoke-confirm-$(date +%s)" \
  "$API_BASE/v1/public/$TENANT_SLUG/confirm" \
  -d "{\"token\":\"$VERIFY_TOKEN\"}"

cat "$WORKDIR/confirm.res" | jq .
CONF_STATUS="$(jq -r '.status' "$WORKDIR/confirm.res")"
[[ "$CONF_STATUS" == "confirmed" ]] || { echo "confirm failed" >&2; exit 1; }

echo "[5] internal links regenerate (reliable) ..."
http links -H "x-admin-api-key: $ADMIN_API_KEY" \
  "$API_BASE/v1/internal/$TENANT_SLUG/bookings/$BOOKING_ID/links"
cat "$WORKDIR/links.res" | tee /tmp/links.json | jq .

CANCEL_URL="$(jq -r '.cancel_url' "$WORKDIR/links.res")"
RESCH_URL="$(jq -r '.reschedule_url' "$WORKDIR/links.res")"
CANCEL_TOKEN="$(get_token_from_url "$CANCEL_URL")"
RESCH_TOKEN="$(get_token_from_url "$RESCH_URL")"
echo "cancel_token_len=${#CANCEL_TOKEN}"
echo "reschedule_token_len=${#RESCH_TOKEN}"
[[ ${#CANCEL_TOKEN} -gt 50 ]] || { echo "cancel token parse failed" >&2; exit 1; }
[[ ${#RESCH_TOKEN} -gt 50 ]] || { echo "reschedule token parse failed" >&2; exit 1; }

echo "[6] cancel (should succeed because booking is >=48h ahead) ..."
http cancel -X POST \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: smoke-cancel-$(date +%s)" \
  "$API_BASE/v1/public/$TENANT_SLUG/bookings/$BOOKING_ID/cancel" \
  -d "{\"token\":\"$CANCEL_TOKEN\"}"
cat "$WORKDIR/cancel.res" | jq .

echo "[7] (optional) reschedule test:"
echo "    reschedule works only for CONFIRMED bookings in your code."
echo "    Since we just canceled, reschedule will conflict. So we create a SECOND booking and reschedule that."

echo "[7-1] create second booking for reschedule ..."
echo "[7-1a] pick initial slot for booking2 (different from booking1) ..."

DATE1="$(date -u -d "$START" +%F)"
YMD_NEXT="$(date -u -d "$DATE1 +1 day" +%F)"

CANDIDATES_JSON="$(curl -sS "$API_BASE/v1/public/$TENANT_SLUG/availability?date=$DATE1" \
  | jq -c --arg start "$START" 'map(select(.start_at_utc != $start))')"
if [[ -z "$CANDIDATES_JSON" || "$CANDIDATES_JSON" == "null" ]]; then
  CANDIDATES_JSON="[]"
fi

# If same-day has too few slots, append next-day slots as fallback.
NEXTDAY_JSON="$(curl -sS "$API_BASE/v1/public/$TENANT_SLUG/availability?date=$YMD_NEXT" | jq -c '.')"
if [[ -n "$NEXTDAY_JSON" && "$NEXTDAY_JSON" != "null" ]]; then
  CANDIDATES_JSON="$(jq -c --argjson a "$CANDIDATES_JSON" --argjson b "$NEXTDAY_JSON" '$a + $b' <<< 'null')"
  # Above line uses jq for concatenation without relying on shell array behavior
  CANDIDATES_JSON="$(jq -c --argjson a "$CANDIDATES_JSON" --argjson b "$NEXTDAY_JSON" '$a + $b' <<< "$CANDIDATES_JSON")"
fi

# Try up to 5 candidates until holds succeeds (409 -> next candidate).
BOOKING2_ID=""
SLOT2=""
for i in 0 1 2 3 4; do
  SLOT2="$(echo "$CANDIDATES_JSON" | jq -c ".[$i] // empty")"
  if [[ -z "$SLOT2" ]]; then
    break
  fi
  START2="$(echo "$SLOT2" | jq -r '.start_at_utc')"
  END2="$(echo "$SLOT2" | jq -r '.end_at_utc')"
  EMAIL2="smoke+safe2-$(date +%s%N)@example.com"

  cat > /tmp/hold2.json <<JSON
{
  "start_at": "$START2",
  "end_at": "$END2",
  "booking_mode": "online",
  "public_notes": "相談: smoke reschedule",
  "customer": { "email": "$EMAIL2", "name": "Safe Smoke2", "company": "Acme" }
}
JSON

  curl -sS -D /tmp/hold2.hdr -o /tmp/hold2.res \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: smoke-hold2-$(date +%s%N)" \
    "$API_BASE/v1/public/$TENANT_SLUG/holds" \
    --data-binary @/tmp/hold2.json >/dev/null || true

  HOLD2_STATUS="$(head -n 1 /tmp/hold2.hdr 2>/dev/null || true)"
  CODE2="$(echo "$HOLD2_STATUS" | awk '{print $2}')"

  if [[ "$CODE2" == "201" ]]; then
    BOOKING2_ID="$(jq -r '.id' /tmp/hold2.res)"
    if [[ -n "$BOOKING2_ID" && "$BOOKING2_ID" != "null" ]]; then
      echo "booking2 hold created (attempt=$i) START2=$START2 END2=$END2"
      break
    fi
  fi

  # If conflict, try next candidate.
  if [[ "$CODE2" == "409" ]]; then
    echo "hold2 conflict (attempt=$i) START2=$START2 END2=$END2 -> retry next slot" >&2
    continue
  fi

  echo "hold2 failed (attempt=$i) status=$HOLD2_STATUS" >&2
  cat /tmp/hold2.res >&2 || true
  exit 1
done

[[ -n "$BOOKING2_ID" && "$BOOKING2_ID" != "null" ]] || { echo "booking2_id missing (all candidates failed)" >&2; cat /tmp/hold2.res >&2 || true; exit 1; }
curl -sS -o /tmp/verify2.res \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: smoke-verify2-$(date +%s%N)" \
  "$API_BASE/v1/public/$TENANT_SLUG/auth/verify-email" \
  -d "{\"booking_id\":\"$BOOKING2_ID\"}"
VERIFY2_TOKEN="$(jq -r '.token' /tmp/verify2.res)"

curl -sS -o /tmp/confirm2.res \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: smoke-resched-$(date +%s%N)" \
  "$API_BASE/v1/public/$TENANT_SLUG/confirm" \
  -d "{\"token\":\"$VERIFY2_TOKEN\"}"
CONF2_STATUS="$(jq -r '.status' /tmp/confirm2.res)"
[[ "$CONF2_STATUS" == "confirmed" ]] || { echo "confirm2 failed" >&2; exit 1; }

curl -sS -H "x-admin-api-key: $ADMIN_API_KEY" \
  "$API_BASE/v1/internal/$TENANT_SLUG/bookings/$BOOKING2_ID/links" \
  | tee /tmp/links2.json >/dev/null

RESCH2_URL="$(jq -r '.reschedule_url' /tmp/links2.json)"
RESCH2_TOKEN="$(get_token_from_url "$(printf '%s' "$RESCH2_URL" | tr -d '\r')")"
[[ ${#RESCH2_TOKEN} -gt 50 ]] || { echo "reschedule2 token parse failed" >&2; exit 1; }

# booking2 current slot (must differ from NEW slot)
OLD2_START="$(echo "$SLOT2" | jq -r '.start_at_utc')"
OLD2_END="$(echo "$SLOT2" | jq -r '.end_at_utc')"
# pick a different future slot (availability-based) + retry on 409
echo "[7-2] pick new slot for reschedule ..."
RESCH_DATE="$(date -u -d "$OLD2_START" +%F)"

  # gather candidate slots: same day (exclude old slot), then next day as fallback
  CAND_SLOTS="$(curl -sS "$API_BASE/v1/public/$TENANT_SLUG/availability?date=$RESCH_DATE" \
    | jq -c --arg os "$OLD2_START" --arg oe "$OLD2_END" '
        map(select(.start_at_utc != $os or .end_at_utc != $oe))
      ')"

  if [[ "$(echo "$CAND_SLOTS" | jq 'length')" -eq 0 ]]; then
    YMD_NEXT="$(date -u -d "$RESCH_DATE +1 day" +%F)"
    CAND_SLOTS="$(curl -sS "$API_BASE/v1/public/$TENANT_SLUG/availability?date=$YMD_NEXT" | jq -c 'map(.)')"
  fi

  [[ "$(echo "$CAND_SLOTS" | jq 'length')" -gt 0 ]] || { echo "no alternative slot found for reschedule" >&2; exit 1; }

  echo "[7-3] reschedule booking2 (retry on 409) ..."
  RESCHEDULE_OK=0
  MAX_TRY=5

  for i in $(seq 0 $((MAX_TRY-1))); do
    NEW_SLOT="$(echo "$CAND_SLOTS" | jq -c ".[$i] // empty")"
    [[ -n "$NEW_SLOT" ]] || break

    NEW_START="$(echo "$NEW_SLOT" | jq -r '.start_at_utc')"
    NEW_END="$(echo "$NEW_SLOT" | jq -r '.end_at_utc')"

    echo "TRY=$((i+1)) NEW_START=$NEW_START"
    echo "TRY=$((i+1)) NEW_END=$NEW_END"

    # no-op guard
    if [[ "$NEW_START" == "$OLD2_START" && "$NEW_END" == "$OLD2_END" ]]; then
      echo "skip no-op slot" >&2
      continue
    fi

    CODE="$(curl -sS -D /tmp/reschedule.hdr -o /tmp/reschedule.res -w '%{http_code}' \
      -X POST \
      -H "Content-Type: application/json" \
      -H "Idempotency-Key: smoke-resched-$((i+1))-$(date +%s%N)" \
      "$API_BASE/v1/public/$TENANT_SLUG/bookings/$BOOKING2_ID/reschedule" \
      -d "{\"token\":\"$RESCH2_TOKEN\",\"new_start_at\":\"$NEW_START\",\"new_end_at\":\"$NEW_END\"}" || true)"

    cat /tmp/reschedule.res | jq . || cat /tmp/reschedule.res

    if [[ "$CODE" == "200" || "$CODE" == "201" ]]; then
      RESCHEDULE_OK=1
      break
    fi

    if [[ "$CODE" == "409" ]]; then
      echo "reschedule conflict -> try next slot" >&2
      continue
    fi

    echo "reschedule failed http=$CODE" >&2
    exit 1
  done

  [[ "$RESCHEDULE_OK" -eq 1 ]] || { echo "reschedule failed after retries (all conflicts)" >&2; exit 1; }

echo "[DONE] smoke flow finished."
echo "booking1(canceled)=$BOOKING_ID"
echo "booking2(rescheduled)=$BOOKING2_ID"
