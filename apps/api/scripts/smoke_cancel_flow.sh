#!/usr/bin/env bash
set -euo pipefail

load_dotenv_if_exists() {
  local envfile="$API_DIR/.env"
  if [[ -f "$envfile" ]]; then
    set -a
    source "$envfile"
    set +a
  fi
}

API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BASE_URL="${BASE_URL:-http://localhost:4000}"
TENANT_SLUG="${TENANT_SLUG:-acme}"
SALESPERSON_ID="${SALESPERSON_ID:?Set SALESPERSON_ID}"
DATE="${DATE:-$(date +%F)}" # yyyy-mm-dd
CUSTOMER_EMAIL="${CUSTOMER_EMAIL:-smoke+$(date +%s)@example.com}"
CUSTOMER_NAME="${CUSTOMER_NAME:-Smoke Cancel}"

require() { command -v "$1" >/dev/null 2>&1 || { echo "missing command: $1" >&2; exit 1; }; }
require curl
require jq
require pnpm
require python3

uuid() { python3 - <<'PY'
import uuid; print(uuid.uuid4())
PY
}

# ---- curl helpers (safe: http code + body file) ----
curl_json() {
  # usage: curl_json <METHOD> <URL> <IDEM> <JSON_PAYLOAD or empty>
  local method="$1"; shift
  local url="$1"; shift
  local idem="${1:-}"; shift || true
  local payload="${1:-}"; shift || true

  local tmp; tmp="$(mktemp)"
  local http
  local -a args
  args=( -sS -o "$tmp" -w "%{http_code}" -X "$method" "$url" -H "Content-Type: application/json" )
  if [[ -n "${idem}" ]]; then
    args+=( -H "Idempotency-Key: ${idem}" )
  fi
  if [[ -n "${payload}" ]]; then
    args+=( --data-binary "$payload" )
  fi
  http="$(curl "${args[@]}" || true)"


  # return: set globals
  RESP_HTTP="$http"
  RESP_FILE="$tmp"
}

curl_get() {
  # usage: curl_get <URL> [query args...]
  local url="$1"; shift
  local tmp; tmp="$(mktemp)"
  local http
  http="$(curl -sS -o "$tmp" -w "%{http_code}" -G "$url" "$@" || true)"
  RESP_HTTP="$http"
  RESP_FILE="$tmp"
}

cleanup_resp() { [[ -n "${RESP_FILE:-}" && -f "${RESP_FILE:-}" ]] && rm -f "$RESP_FILE" || true; }

# ---- token issuance (must match runtime issuer/audience) ----
issue_token() {
  local purpose="$1"   # cancel
  local booking_id="$2"
  local exp_offset_sec="${3:-3600}" # default 1h

  local script
  script="$(mktemp "$API_DIR/.tmp_issue_token.XXXXXX.ts")"

  cat >"$script" <<'TS'
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { signBookingToken } from "./src/utils/jwt";

const prisma = new PrismaClient();

const bookingId = process.env.BOOKING_ID!;
const purpose = process.env.PURPOSE!;
const expOffset = Number(process.env.EXP_OFFSET_SEC ?? "3600");
const tenantOverride = process.env.TENANT_ID_OVERRIDE;

if (!bookingId) throw new Error("BOOKING_ID is required");
if (!purpose) throw new Error("PURPOSE is required");

const exp = Math.floor(Date.now() / 1000) + expOffset; // seconds
const jti = `${purpose}-${bookingId}-${exp}`;

(async () => {
  const b = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { tenant_id: true },
  });
  if (!b) throw new Error(`booking not found: ${bookingId}`);

  const token = signBookingToken({
    exp,
    jti,
    booking_id: bookingId,
    tenant_id: tenantOverride || b.tenant_id,
    purpose: purpose as any,
  });

  process.stdout.write(token);
})()
  .catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
TS

  (
    trap 'rm -f "$script" || true' EXIT
    cd "$API_DIR"
    BASE_URL="$BASE_URL" PUBLIC_BASE_URL="$BASE_URL" APP_BASE_URL="$BASE_URL" \
    PURPOSE="$purpose" BOOKING_ID="$booking_id" EXP_OFFSET_SEC="$exp_offset_sec" TENANT_ID_OVERRIDE="${TENANT_ID_OVERRIDE:-}" \
    pnpm -s exec tsx "$script"
  )
}

db_booking_status() {
  local booking_id="$1"

  local script
  script="$(mktemp "$API_DIR/.tmp_booking_status.XXXXXX.ts")"

  cat >"$script" <<'TS'
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const bookingId = process.env.BOOKING_ID!;
if (!bookingId) throw new Error("BOOKING_ID is required");

(async () => {
  const b = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { status: true },
  });
  if (!b) throw new Error(`booking not found: ${bookingId}`);
  process.stdout.write(String(b.status));
})()
  .catch((e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
TS

  (
    trap 'rm -f "$script" || true' EXIT
    cd "$API_DIR"
    BOOKING_ID="$booking_id" pnpm -s exec tsx "$script"
  )
}
get_availability() {
  local url="$BASE_URL/v1/public/$TENANT_SLUG/availability"
  curl_get "$url" \
    --data-urlencode "salesperson=$SALESPERSON_ID" \
    --data-urlencode "date=$DATE"

  local http="$RESP_HTTP"
  local body; body="$(cat "$RESP_FILE")"
  cleanup_resp

  [[ "$http" == "200" ]] || { echo "availability http=$http body=$body" >&2; exit 1; }
  echo "$body" | jq -e 'type=="array"' >/dev/null 2>&1 || {
    echo "availability response is not an array. response:" >&2
    echo "$body" >&2
    exit 1
  }
  echo "$body"
}

contains_slot() {
  local json="$1"; local start="$2"; local end="$3"
  echo "$json" | jq -e --arg s "$start" --arg e "$end" '
    [ .[] | select((.start_at_utc==$s) and (.end_at_utc==$e)) ] | length > 0
  ' >/dev/null 2>&1
}

post_hold() {
  local start_at="$1"; local end_at="$2"; local idem="$3"
  local url="$BASE_URL/v1/public/$TENANT_SLUG/holds"
  local payload
  payload="$(jq -nc \
    --arg salesperson_id "$SALESPERSON_ID" \
    --arg start_at "$start_at" \
    --arg end_at "$end_at" \
    --arg email "$CUSTOMER_EMAIL" \
    --arg name "$CUSTOMER_NAME" \
    '{salesperson_id:$salesperson_id,start_at:$start_at,end_at:$end_at,customer:{email:$email,name:$name}}')"
  curl_json POST "$url" "$idem" "$payload"
}

post_verify() {
  local booking_id="$1"; local idem="$2"
  local url="$BASE_URL/v1/public/$TENANT_SLUG/auth/verify-email"
  local payload; payload="$(jq -nc --arg id "$booking_id" '{booking_id:$id}')"
  curl_json POST "$url" "$idem" "$payload"
}

post_confirm() {
  local token="$1"; local idem="$2"
  local url="$BASE_URL/v1/public/$TENANT_SLUG/confirm"
  local payload; payload="$(jq -nc --arg t "$token" '{token:$t}')"
  curl_json POST "$url" "$idem" "$payload"
}

post_cancel() {
  local booking_id="$1"; local token="$2"; local idem="$3"
  local url="$BASE_URL/v1/public/$TENANT_SLUG/bookings/$booking_id/cancel"
  local payload; payload="$(jq -nc --arg t "$token" '{token:$t}')"
  curl_json POST "$url" "$idem" "$payload"
}

echo "[0] precheck: api listens on $BASE_URL (port 4000 assumed)"
curl_get "$BASE_URL/v1/public/$TENANT_SLUG/availability" \
  --data-urlencode "salesperson=$SALESPERSON_ID" \
  --data-urlencode "date=$DATE"
echo "http=$RESP_HTTP"
if [[ "$RESP_HTTP" != "200" ]]; then
  echo "precheck failed body:" >&2
  cat "$RESP_FILE" >&2 || true
  cleanup_resp
  exit 1
fi
cleanup_resp

echo "[1] availability pre"
avail1="$(get_availability)"
len="$(echo "$avail1" | jq -r 'length')"
if [[ "$len" == "0" ]]; then
  echo "availability is empty for DATE=$DATE salesperson=$SALESPERSON_ID" >&2
  echo "Try: DATE=2026-02-17 (or any date that has slots) and rerun." >&2
  exit 1
fi

start="$(echo "$avail1" | jq -r '.[0].start_at_utc')"
end="$(echo "$avail1"   | jq -r '.[0].end_at_utc')"
echo "picked slot: $start - $end"

echo "[2] hold"
idem_hold="$(uuid)"
post_hold "$start" "$end" "$idem_hold"
http_hold="$RESP_HTTP"; body_hold="$(cat "$RESP_FILE")"; cleanup_resp
echo "http=$http_hold"
echo "$body_hold" | jq -c '{id:.id,status:.status,start_at_utc:.start_at_utc,end_at_utc:.end_at_utc,hold:.hold}' || true
[[ "$http_hold" == "201" ]] || { echo "expected 201, got $http_hold body=$body_hold" >&2; exit 1; }
booking_id="$(echo "$body_hold" | jq -r '.id')"
echo "booking_id=$booking_id"

echo "[3] verify-email"
idem_v="$(uuid)"
post_verify "$booking_id" "$idem_v"
http_v="$RESP_HTTP"; body_v="$(cat "$RESP_FILE")"; cleanup_resp
echo "http=$http_v"
echo "$body_v" | jq -c '.' || true
[[ "$http_v" == "201" ]] || { echo "expected 201, got $http_v body=$body_v" >&2; exit 1; }
verify_token="$(echo "$body_v" | jq -r '.token')"
[[ -n "$verify_token" && "$verify_token" != "null" ]] || { echo "token missing" >&2; exit 1; }

echo "[4] confirm"
idem_c="$(uuid)"
post_confirm "$verify_token" "$idem_c"
http_c="$RESP_HTTP"; body_c="$(cat "$RESP_FILE")"; cleanup_resp
echo "http=$http_c"
echo "$body_c" | jq -c '{id:.id,status:.status}' || true
[[ "$http_c" == "201" ]] || { echo "expected 201, got $http_c body=$body_c" >&2; exit 1; }

st="$(db_booking_status "$booking_id")"
[[ "$st" == "confirmed" ]] || { echo "expected db status confirmed, got $st" >&2; exit 1; }
echo "[5] availability after confirm -> slot removed"
ok=0
for i in 1 2 3 4 5; do
  a="$(get_availability)"
  if contains_slot "$a" "$start" "$end"; then
    echo "attempt $i: slot STILL present"
    sleep 1
  else
    echo "slot removed ✅"
    ok=1; break
  fi
done
[[ "$ok" == "1" ]] || { echo "slot not removed after confirm" >&2; exit 1; }

echo "[6] expired cancel token -> must be 401/409 (NOT 500) (must run BEFORE successful cancel)"
expired_cancel_token="$(issue_token cancel "$booking_id" -60)" # already expired
idem_x0="$(uuid)"
post_cancel "$booking_id" "$expired_cancel_token" "$idem_x0"
http_x0="$RESP_HTTP"; body_x0="$(cat "$RESP_FILE")"; cleanup_resp
echo "http=$http_x0"
echo "$body_x0" | jq -c '.' || true
if [[ "$http_x0" != "401" && "$http_x0" != "409" ]]; then
  echo "expected 401/409 for expired token, got $http_x0 body=$body_x0" >&2
  exit 1
fi
echo "expired token ✅ ($http_x0)"

echo "[6b] wrong purpose token (verify) -> must be 401/403/409"
wrong_purpose_token="$(issue_token verify "$booking_id" 3600)"
idem_wp="$(uuid)"
post_cancel "$booking_id" "$wrong_purpose_token" "$idem_wp"
http_wp="$RESP_HTTP"; body_wp="$(cat "$RESP_FILE")"; cleanup_resp
echo "http=$http_wp"
echo "$body_wp" | jq -c '.' || true
if [[ "$http_wp" != "401" && "$http_wp" != "403" && "$http_wp" != "409" ]]; then
  echo "expected 401/403/409 for wrong purpose token, got $http_wp body=$body_wp" >&2
  exit 1
fi
echo "wrong purpose ✅ ($http_wp)"

echo "[6c] wrong tenant_id token -> must be 401/403/409"
bad_tenant_id="$(uuid)"
TENANT_ID_OVERRIDE="$bad_tenant_id" wrong_tenant_token="$(issue_token cancel "$booking_id" 3600)"
unset TENANT_ID_OVERRIDE || true
idem_wt="$(uuid)"
post_cancel "$booking_id" "$wrong_tenant_token" "$idem_wt"
http_wt="$RESP_HTTP"; body_wt="$(cat "$RESP_FILE")"; cleanup_resp
echo "http=$http_wt"
echo "$body_wt" | jq -c '.' || true
if [[ "$http_wt" != "401" && "$http_wt" != "403" && "$http_wt" != "409" ]]; then
  echo "expected 401/403/409 for wrong tenant token, got $http_wt body=$body_wt" >&2
  exit 1
fi
echo "wrong tenant ✅ ($http_wt)"

echo "[7] issue fresh cancel token (purpose=cancel)"
cancel_token="$(issue_token cancel "$booking_id" 3600)"
[[ -n "$cancel_token" ]] || { echo "failed to issue cancel token" >&2; exit 1; }
echo "[8] POST cancel (1st)"
idem_x="$(uuid)"
post_cancel "$booking_id" "$cancel_token" "$idem_x"
http_x="$RESP_HTTP"; body_x="$(cat "$RESP_FILE")"; cleanup_resp
echo "http=$http_x"
echo "$body_x" | jq -c '.' || true
[[ "$http_x" == "200" || "$http_x" == "201" ]] || { echo "expected 200/201, got $http_x body=$body_x" >&2; exit 1; }
st="$(db_booking_status "$booking_id")"
[[ "$st" == "canceled" ]] || { echo "expected db status canceled, got $st" >&2; exit 1; }
echo "[9] availability after cancel -> slot must reappear (no 45s wait)"
ok=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  a="$(get_availability)"
  if contains_slot "$a" "$start" "$end"; then
    echo "slot restored ✅ (attempt $i)"
    ok=1; break
  else
    echo "attempt $i: slot still missing"
    sleep 1
  fi
done
[[ "$ok" == "1" ]] || { echo "slot did not reappear after cancel" >&2; exit 1; }

echo "[10] cancel again (same token, different Idempotency-Key) -> must be idempotent"
idem_x2="$(uuid)"
post_cancel "$booking_id" "$cancel_token" "$idem_x2"
http_x2="$RESP_HTTP"; body_x2="$(cat "$RESP_FILE")"; cleanup_resp
echo "http=$http_x2"
echo "$body_x2" | jq -c '.' || true
[[ "$http_x2" == "200" || "$http_x2" == "201" ]] || { echo "expected 200/201, got $http_x2 body=$body_x2" >&2; exit 1; }

st="$(db_booking_status "$booking_id")"
[[ "$st" == "canceled" ]] || { echo "expected db status canceled (after idempotent cancel), got $st" >&2; exit 1; }
echo "✅ smoke cancel flow ok"
echo "booking_id=$booking_id"
