#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

require() { command -v "$1" >/dev/null 2>&1 || { echo "missing command: $1" >&2; exit 1; }; }
require curl
require jq
require psql
require python3

# load .env if exists
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
import uuid; print(uuid.uuid4())
PY
}

say() { printf '[smoke] %s\n' "$*"; }

# ---- preflight: API up + ready ok + DB ok ----
say "check /health"
curl -fsS "$BASE_URL/health" | jq -e '.status=="ok"' >/dev/null

say "check /ready"
curl -fsS "$BASE_URL/ready" | jq -e '.ok==true' >/dev/null

say "check DB"
psql "$DB_NO_SCHEMA" -c "select 1;" >/dev/null

# ---- resolve tenant + salesperson ----
say "resolve tenant by slug=$TENANT_SLUG"
TENANT_ID="$(psql "$DB_NO_SCHEMA" -Atc "select id from tenants where slug='${TENANT_SLUG}' limit 1;")"
[[ -n "$TENANT_ID" ]] || { echo "[smoke] tenant not found for slug=$TENANT_SLUG" >&2; exit 1; }
say "TENANT_ID=$TENANT_ID"

say "pick salesperson for tenant"
SP_ID="$(psql "$DB_NO_SCHEMA" -Atc "select id from salespersons where tenant_id='${TENANT_ID}' and active=true order by created_at asc limit 1;")"
[[ -n "$SP_ID" ]] || { echo "[smoke] active salesperson not found for tenant_id=$TENANT_ID" >&2; exit 1; }
say "SP_ID=$SP_ID"

DATE="${DATE:-$(date +%F)}" # yyyy-mm-dd (UTC/JSTどちらでもOK。API側で扱える前提)

# ---- availability ----
say "GET availability"
AVAIL="$(
  curl -fsS "$BASE_URL/v1/public/${TENANT_SLUG}/availability?salesperson=${SP_ID}&date=${DATE}"
)"
echo "$AVAIL" | jq -e 'type=="array" and length>0 and .[0].start_at_utc and .[0].end_at_utc' >/dev/null

START_AT="$(echo "$AVAIL" | jq -r '.[0].start_at_utc')"
END_AT="$(echo "$AVAIL" | jq -r '.[0].end_at_utc')"
say "slot: $START_AT -> $END_AT"

# ---- create hold ----
IDEMP="$(uuid)"
EMAIL="smoke+$(date +%s)@example.com"

say "POST hold (idemp=$IDEMP)"
HOLD_RES="$(
  curl -fsS -X POST "$BASE_URL/v1/public/${TENANT_SLUG}/holds" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: ${IDEMP}" \
    -d "$(jq -n \
      --arg sp "$SP_ID" \
      --arg s "$START_AT" \
      --arg e "$END_AT" \
      --arg email "$EMAIL" \
      '{salesperson_id:$sp,start_at:$s,end_at:$e,customer:{email:$email,name:"Smoke"}}'
    )"
)"
BOOKING_ID="$(echo "$HOLD_RES" | jq -r '.id // empty')"
[[ -n "$BOOKING_ID" ]] || { echo "[smoke] hold response missing id" >&2; echo "$HOLD_RES" | jq . >&2; exit 1; }
say "BOOKING_ID=$BOOKING_ID"

# ---- verify-email -> token ----
IDEMP="$(uuid)"
say "POST verify-email (idemp=$IDEMP)"
VERIFY_RES="$(
  curl -fsS -X POST "$BASE_URL/v1/public/${TENANT_SLUG}/auth/verify-email" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: ${IDEMP}" \
    -d "$(jq -n --arg id "$BOOKING_ID" '{booking_id:$id}')"
)"
TOKEN="$(echo "$VERIFY_RES" | jq -r '.token // empty')"
[[ -n "$TOKEN" ]] || { echo "[smoke] verify-email missing token" >&2; echo "$VERIFY_RES" | jq . >&2; exit 1; }
say "TOKEN=${TOKEN:0:24}..."

# ---- confirm ----
IDEMP="$(uuid)"
say "POST confirm (idemp=$IDEMP)"
CONFIRM_RES="$(
  curl -fsS -X POST "$BASE_URL/v1/public/${TENANT_SLUG}/confirm" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: ${IDEMP}" \
    -d "$(jq -n --arg t "$TOKEN" '{token:$t}')"
)"
echo "$CONFIRM_RES" | jq -e '.status=="confirmed" and .booking_id=="'"$BOOKING_ID"'"' >/dev/null
say "confirmed"

# ---- DB assert ----
say "DB assert status=confirmed"
DB_STATUS="$(psql "$DB_NO_SCHEMA" -Atc "select status from bookings where id='${BOOKING_ID}' limit 1;")"
[[ "$DB_STATUS" == "confirmed" ]] || { echo "[smoke] DB status expected confirmed but got: $DB_STATUS" >&2; exit 1; }

say "OK"
