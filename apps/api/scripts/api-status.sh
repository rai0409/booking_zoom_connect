#!/usr/bin/env bash
set -euo pipefail

LISTEN="$(lsof -nP -iTCP:4000 -sTCP:LISTEN || true)"
if [ -z "$LISTEN" ]; then
  echo "status: DOWN (not listening :4000)"
  exit 1
fi

echo "$LISTEN"
curl -fsS -D - http://127.0.0.1:4000/health -o /dev/null

PID="$(echo "$LISTEN" | awk '$1=="node"{print $2; exit}')"
echo "PID=$PID"
if [ -n "${PID:-}" ] && [ -r "/proc/$PID/environ" ]; then
  tr '\0' '\n' < /proc/"$PID"/environ | rg -n '^(EXPIRY_WORKER_TRACE|BOOT_TRACE|EXPIRY_WORKER_FAIL_FAST)=' || echo "no debug env in process"
else
  echo "warn: PID not found for :4000"
fi

echo "status: UP"
