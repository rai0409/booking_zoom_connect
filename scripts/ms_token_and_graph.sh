#!/usr/bin/env bash
set -euo pipefail

TENANT_ID="${TENANT_ID:-8e3c4e0d-f0c6-4956-9347-07d101302911}"
CLIENT_ID="${CLIENT_ID:?CLIENT_ID required}"
CLIENT_SECRET="${CLIENT_SECRET:?CLIENT_SECRET required}"
REDIRECT_URI="${REDIRECT_URI:-http://localhost:3000/auth/microsoft/callback}"
# scopeは“ここで手動指定”できるようにする（mailboxSettings 確実化のため MailboxSettings.Read を追加）
SCOPE="${SCOPE:-openid profile email offline_access User.Read Calendars.ReadWrite MailboxSettings.Read}"

PKCE_FILE="${PKCE_FILE:-/tmp/pkce.json}"
TOKEN_FILE="${TOKEN_FILE:-/tmp/ms_token.json}"

read -r -p "Paste CODE (only code value): " CODE
if [[ -z "$CODE" ]]; then echo "CODE empty"; exit 1; fi

CODE_VERIFIER="$(python3 - <<PY
import json
print(json.load(open("${PKCE_FILE}"))["verifier"])
PY
)"

curl -sS -o "${TOKEN_FILE}" -X POST "https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token" \
  -H "content-type: application/x-www-form-urlencoded" \
  --data-urlencode "client_id=${CLIENT_ID}" \
  --data-urlencode "client_secret=${CLIENT_SECRET}" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=${CODE}" \
  --data-urlencode "redirect_uri=${REDIRECT_URI}" \
  --data-urlencode "code_verifier=${CODE_VERIFIER}" \
  --data-urlencode "scope=${SCOPE}"

python3 - <<PY
import json,sys
d=json.load(open("${TOKEN_FILE}"))
if "error" in d:
  print("TOKEN ERROR:", d.get("error"))
  print("DESC:", d.get("error_description","")[:250])
  sys.exit(1)
print("OK: access_token=", "access_token" in d, "refresh_token=", "refresh_token" in d)
PY

ACCESS_TOKEN="$(python3 - <<PY
import json
print(json.load(open("${TOKEN_FILE}"))["access_token"])
PY
)"

echo "ACCESS_TOKEN len(in script)=${#ACCESS_TOKEN}"

# mailboxSettings
curl -sS -D /tmp/mbx.hdr -o /tmp/mbx.json \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "https://graph.microsoft.com/v1.0/me/mailboxSettings" >/dev/null || true
echo "mailboxSettings status: $(head -n 1 /tmp/mbx.hdr || true)"
if ! head -n 1 /tmp/mbx.hdr | grep -q " 200 "; then
  head -c 600 /tmp/mbx.json; echo
  exit 1
fi

# create event
NOW_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
END_UTC="$(date -u -d '+30 minutes' +%Y-%m-%dT%H:%M:%SZ)"
cat > /tmp/event.json <<JSON
{"subject":"POC Test Booking","showAs":"busy","sensitivity":"private",
"start":{"dateTime":"$NOW_UTC","timeZone":"UTC"},
"end":{"dateTime":"$END_UTC","timeZone":"UTC"}}
JSON

curl -sS -D /tmp/ev.hdr -o /tmp/ev.json -X POST \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  "https://graph.microsoft.com/v1.0/me/events" \
  --data-binary @/tmp/event.json >/dev/null || true
echo "create event status: $(head -n 1 /tmp/ev.hdr || true)"
if ! head -n 1 /tmp/ev.hdr | grep -q " 201 "; then
  head -c 600 /tmp/ev.json; echo
  exit 1
fi

echo "SUCCESS"
