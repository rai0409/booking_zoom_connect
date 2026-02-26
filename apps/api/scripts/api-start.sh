#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

LOG="${LOG:-/tmp/api_current.log}"

# stop (best effort)
pkill -f "node -r ts-node/register src/main\.ts|pnpm -s dev" || true
lsof -ti :4000 | xargs -r kill -9 || true

rm -f "$LOG"
nohup bash -lc "cd $(pwd) && pnpm -s dev" > "$LOG" 2>&1 < /dev/null &

# wait up to 10s for LISTEN
for i in {1..10}; do
  lsof -nP -iTCP:4000 -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 1
done

lsof -nP -iTCP:4000 -sTCP:LISTEN || { echo "ERROR: not listening on :4000"; tail -n 80 "$LOG" || true; exit 1; }
curl -fsS http://127.0.0.1:4000/health >/dev/null || { echo "ERROR: health failed"; tail -n 80 "$LOG" || true; exit 1; }

echo "OK: started. log=$LOG"
