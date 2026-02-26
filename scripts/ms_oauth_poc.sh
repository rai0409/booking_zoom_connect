#!/usr/bin/env bash
set -euo pipefail

TENANT_ID="${TENANT_ID:-8e3c4e0d-f0c6-4956-9347-07d101302911}"
CLIENT_ID="${CLIENT_ID:-}"
REDIRECT_URI="${REDIRECT_URI:-http://localhost:3000/auth/microsoft/callback}"
SCOPE="${SCOPE:-openid profile email offline_access User.Read Calendars.ReadWrite}"

if [[ -z "$CLIENT_ID" ]]; then
  echo "ERROR: CLIENT_ID is required"
  echo "Usage: CLIENT_ID=... $0"
  exit 1
fi

PKCE_FILE="${PKCE_FILE:-/tmp/pkce.json}"
TOKEN_FILE="${TOKEN_FILE:-/tmp/ms_token.json}"

# 1) Generate PKCE + AUTH URL
python3 - <<PY
import os, base64, hashlib, json, urllib.parse
tenant="${TENANT_ID}"
client_id="${CLIENT_ID}"
redirect_uri="${REDIRECT_URI}"
scope="${SCOPE}"

verifier=base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=")
challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")

open("${PKCE_FILE}","w").write(json.dumps({"verifier":verifier,"challenge":challenge,"redirect_uri":redirect_uri}))
params={
  "client_id":client_id,
  "response_type":"code",
  "redirect_uri":redirect_uri,
  "response_mode":"query",
  "scope":scope,
  "state":"dev",
  "code_challenge":challenge,
  "code_challenge_method":"S256",
}
url=f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize?"+urllib.parse.urlencode(params)
print("=== 1) Open this URL in browser (address bar) ===")
print(url)
print("")
print("=== 2) After login, copy ONLY the code value from:")
print("    http://localhost:3000/auth/microsoft/callback?code=...&state=dev")
print("")
PY

# Optional: open browser automatically on Windows via WSL
if command -v cmd.exe >/dev/null 2>&1; then
  AUTH_URL="$(python3 - <<PY
import json, urllib.parse
import os
from urllib.parse import urlencode
import json as js
d=js.load(open("${PKCE_FILE}"))
tenant="${TENANT_ID}"
client_id="${CLIENT_ID}"
redirect_uri="${REDIRECT_URI}"
scope="${SCOPE}"
params={
  "client_id":client_id,
  "response_type":"code",
  "redirect_uri":redirect_uri,
  "response_mode":"query",
  "scope":scope,
  "state":"dev",
  "code_challenge":d["challenge"],
  "code_challenge_method":"S256",
}
print(f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize?"+urlencode(params))
PY
)"
  echo "Opening browser..."
  cmd.exe /c start "$AUTH_URL" >/dev/null 2>&1 || true
fi

read -r -p "Paste CODE here (only the code value): " CODE
if [[ -z "$CODE" ]]; then
  echo "ERROR: CODE is empty"
  exit 1
fi

CODE_VERIFIER="$(python3 - <<PY
import json; print(json.load(open("${PKCE_FILE}"))["verifier"])
PY
)"

# 2) Exchange code -> token
curl -sS -o "${TOKEN_FILE}" -X POST "https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token" \
  -H "content-type: application/x-www-form-urlencoded" \
  --data-urlencode "client_id=${CLIENT_ID}" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "code=${CODE}" \
  --data-urlencode "redirect_uri=${REDIRECT_URI}" \
  --data-urlencode "code_verifier=${CODE_VERIFIER}"
  --data-urlencode "scope=${SCOPE}"

python3 - <<PY
import json, sys
d=json.load(open("${TOKEN_FILE}"))
if "error" in d:
  print("TOKEN ERROR:", d.get("error"))
  print("DESC:", d.get("error_description","")[:250])
  sys.exit(1)
print("OK: got access_token + refresh_token =", "refresh_token" in d)
print("expires_in:", d.get("expires_in"))
PY

ACCESS_TOKEN="$(python3 - <<PY
import json; print(json.load(open("${TOKEN_FILE}"))["access_token"])
PY
)"

# 3) mailboxSettings check
curl -sS -D /tmp/mbx.hdr -o /tmp/mbx.json \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "https://graph.microsoft.com/v1.0/me/mailboxSettings" >/dev/null || true

echo "mailboxSettings status: $(head -n 1 /tmp/mbx.hdr || true)"
if ! head -n 1 /tmp/mbx.hdr | grep -q " 200 "; then
  echo "mailboxSettings body (first 400 chars):"
  head -c 400 /tmp/mbx.json; echo
  exit 1
fi

# 4) create event (optional)
NOW_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
END_UTC="$(date -u -d '+30 minutes' +%Y-%m-%dT%H:%M:%SZ)"

cat > /tmp/event.json <<JSON
{
  "subject": "POC Test Booking",
  "showAs": "busy",
  "sensitivity": "private",
  "start": { "dateTime": "${NOW_UTC}", "timeZone": "UTC" },
  "end":   { "dateTime": "${END_UTC}", "timeZone": "UTC" }
}
JSON

curl -sS -D /tmp/ev.hdr -o /tmp/ev.json -X POST \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  "https://graph.microsoft.com/v1.0/me/events" \
  --data-binary @/tmp/event.json >/dev/null || true

echo "create event status: $(head -n 1 /tmp/ev.hdr || true)"
if ! head -n 1 /tmp/ev.hdr | grep -q " 201 "; then
  echo "event body (first 600 chars):"
  head -c 600 /tmp/ev.json; echo
  exit 1
fi

echo "SUCCESS: mailboxSettings=200, create event=201"
