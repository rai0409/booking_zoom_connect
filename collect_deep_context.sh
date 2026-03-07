#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/booking_zoom_connect}"
TS="$(date +%Y%m%d_%H%M%S)"
OUT_DIR="${OUT_DIR:-$HOME/booking_deep_collect_$TS}"
ZIP_PATH="${ZIP_PATH:-$HOME/booking_deep_collect_$TS.zip}"

mkdir -p "$OUT_DIR"
cd "$REPO_DIR"

copy_if_exists() {
  local src="$1"
  local dst_root="$2"
  if [ -e "$src" ]; then
    mkdir -p "$dst_root/$(dirname "$src")"
    cp -R "$src" "$dst_root/$src"
    echo "[OK] copied: $src"
  else
    echo "[WARN] not found: $src"
  fi
}

echo "=== 1) apps/api/src 一式 ==="
copy_if_exists "apps/api/src" "$OUT_DIR"

echo "=== 2) apps/api/prisma/schema.prisma ==="
copy_if_exists "apps/api/prisma/schema.prisma" "$OUT_DIR"

echo "=== 3) test 一式 ==="
copy_if_exists "apps/api/test" "$OUT_DIR"
copy_if_exists "test" "$OUT_DIR"

echo "=== 4) Dockerfile 一式 ==="
mkdir -p "$OUT_DIR/docker_inventory"
find . \
  -type f \
  \( -iname "Dockerfile" -o -iname "Dockerfile.*" -o -iname "*.dockerfile" -o -iname "docker-compose*.yml" -o -iname "docker-compose*.yaml" -o -iname "compose*.yml" -o -iname "compose*.yaml" \) \
  -not -path "*/node_modules/*" \
  -not -path "*/.next/*" \
  -not -path "*/dist/*" \
  -not -path "*/coverage/*" \
  -print | tee "$OUT_DIR/docker_inventory/docker_files.txt"

while IFS= read -r f; do
  [ -n "$f" ] || continue
  mkdir -p "$OUT_DIR/$(dirname "$f")"
  cp -f "$f" "$OUT_DIR/$f"
done < "$OUT_DIR/docker_inventory/docker_files.txt"

echo "=== 5) worker 関連ログ ==="
mkdir -p "$OUT_DIR/worker_logs"

# よくある既知ログ
for f in \
  /tmp/api_dev.log \
  /tmp/web_dev.log \
  /tmp/worker.log \
  /tmp/webhook_worker.log \
  /tmp/compensation_worker.log \
  /tmp/notify_worker.log \
  ./tmp/api_dev.log \
  ./tmp/worker.log \
  ./logs/worker.log
do
  if [ -f "$f" ]; then
    cp -f "$f" "$OUT_DIR/worker_logs/$(basename "$f")"
    echo "[OK] copied log: $f"
  fi
done

# repo内から worker / webhook / compensation / notify 関連のlogを広く回収
find . \
  -type f \
  \( -iname "*.log" -o -path "*/logs/*" -o -path "*/log/*" \) \
  -not -path "*/node_modules/*" \
  -not -path "*/.next/*" \
  -not -path "*/dist/*" \
  | while IFS= read -r f; do
      if echo "$f" | grep -Ei 'worker|webhook|compensation|notify|notification|queue' >/dev/null; then
        mkdir -p "$OUT_DIR/worker_logs/repo/$(dirname "$f")"
        cp -f "$f" "$OUT_DIR/worker_logs/repo/$f" || true
        echo "[OK] copied related log: $f"
      fi
    done

echo "=== 6) worker 関連の調査テキストも保存 ==="
{
  echo "===== worker/webhook/compensation/notify files ====="
  find apps -type f 2>/dev/null | grep -Ei 'worker|webhook|compensation|notify|notification|queue' || true
  echo
  echo "===== rg in src/test for worker/webhook/compensation/notify ====="
  rg -n "worker|webhook|compensation|notify|notification|queue" apps/api/src apps/api/test test 2>/dev/null || true
  echo
  echo "===== recent git status ====="
  git status -sb || true
  echo
  echo "===== recent commits ====="
  git log --oneline -n 30 || true
} > "$OUT_DIR/worker_logs/worker_related_inventory.txt"

echo "=== 7) zip 化 ==="
cd "$(dirname "$OUT_DIR")"
zip -r "$ZIP_PATH" "$(basename "$OUT_DIR")" >/dev/null

echo
echo "完了"
echo "展開先: $OUT_DIR"
echo "zip:    $ZIP_PATH"
