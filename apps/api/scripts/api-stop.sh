#!/usr/bin/env bash
set -euo pipefail

pkill -f "node -r ts-node/register src/main\.ts|pnpm -s dev" || true
lsof -ti :4000 | xargs -r kill -9 || true

echo "OK: stopped"
