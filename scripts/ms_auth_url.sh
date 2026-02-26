#!/usr/bin/env bash
set -euo pipefail

TENANT_ID="${TENANT_ID:-8e3c4e0d-f0c6-4956-9347-07d101302911}"
CLIENT_ID="${CLIENT_ID:?CLIENT_ID required}"
REDIRECT_URI="${REDIRECT_URI:-http://localhost:3000/auth/microsoft/callback}"
SCOPE="${SCOPE:-openid profile email offline_access User.Read Calendars.ReadWrite}"
PKCE_FILE="${PKCE_FILE:-/tmp/pkce.json}"

python3 - <<PY
import os, base64, hashlib, json, urllib.parse
tenant="${TENANT_ID}"
client_id="${CLIENT_ID}"
redirect_uri="${REDIRECT_URI}"
scope="${SCOPE}"

verifier=base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=")
challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
open("${PKCE_FILE}","w").write(json.dumps({"verifier":verifier,"challenge":challenge,"redirect_uri":redirect_uri,"scope":scope}))

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
print("AUTH_URL=" + url)
print("PKCE_FILE=" + "${PKCE_FILE}")
PY
