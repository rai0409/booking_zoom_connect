#!/usr/bin/env bash
# make_zip_apps_packages.sh
# 使い方:
#   bash make_zip_apps_packages.sh
#   bash make_zip_apps_packages.sh output.zip
#   bash make_zip_apps_packages.sh output.zip /home/rai/booking_zoom_connect
#
# 出力:
#   <stem>_apps.zip
#   <stem>_packages.zip
#
set -euo pipefail

OUT="${1:-output.zip}"
TARGET="${2:-$(pwd)}"

if ! command -v zip >/dev/null 2>&1; then
  echo "zip コマンドが見つかりません。Ubuntuなら: sudo apt-get update && sudo apt-get install -y zip" >&2
  exit 1
fi

if [ ! -d "$TARGET" ]; then
  echo "対象ディレクトリが存在しません: $TARGET" >&2
  exit 1
fi

# 出力パスを絶対パス化
OUT_ABS="$(python3 - "$OUT" <<'PY'
import os,sys
print(os.path.abspath(sys.argv[1]))
PY
)"

# 同名がある場合は採番
OUT_ABS="$(python3 - "$OUT_ABS" <<'PY'
import os, sys
path = sys.argv[1]
dir_ = os.path.dirname(path)
base = os.path.basename(path)
stem, ext = os.path.splitext(base)
if not os.path.exists(path):
    print(path); raise SystemExit
i = 2
while True:
    cand = os.path.join(dir_, f"{stem}{i}{ext}")
    if not os.path.exists(cand):
        print(cand); break
    i += 1
PY
)"

DIR_OUT="$(dirname "$OUT_ABS")"
BASE_OUT="$(basename "$OUT_ABS")"
STEM_OUT="${BASE_OUT%.zip}"

OUT_APPS="$DIR_OUT/${STEM_OUT}_apps.zip"
OUT_PACKAGES="$DIR_OUT/${STEM_OUT}_packages.zip"

# 既存があれば採番
OUT_APPS="$(python3 - "$OUT_APPS" <<'PY'
import os, sys
path = sys.argv[1]
dir_ = os.path.dirname(path)
base = os.path.basename(path)
stem, ext = os.path.splitext(base)
if not os.path.exists(path):
    print(path); raise SystemExit
i=2
while True:
    cand=os.path.join(dir_, f"{stem}{i}{ext}")
    if not os.path.exists(cand):
        print(cand); break
    i+=1
PY
)"
OUT_PACKAGES="$(python3 - "$OUT_PACKAGES" <<'PY'
import os, sys
path = sys.argv[1]
dir_ = os.path.dirname(path)
base = os.path.basename(path)
stem, ext = os.path.splitext(base)
if not os.path.exists(path):
    print(path); raise SystemExit
i=2
while True:
    cand=os.path.join(dir_, f"{stem}{i}{ext}")
    if not os.path.exists(cand):
        print(cand); break
    i+=1
PY
)"

EXCLUDES=(
  "*/.git/*"
  "*/node_modules/*"
  "*/dist/*"
  "*/build/*"
  "*/.next/*"
  "*/out/*"
  "*/coverage/*"
  "*/.turbo/*"
  "*/.cache/*"
  "*/.venv/*"
  "*/venv/*"
  "*/__pycache__/*"
  "*/.pytest_cache/*"
  "*/.mypy_cache/*"
  "*/.idea/*"
  "*/.vscode/*"
  "*/tmp/*"
  "*/logs/*"
  "*/outputs/*"
  "*/.DS_Store"
  "*/.env"
  "*/.env.*"
  "*/**/*.pem"
  "*/**/*.key"
  "*/**/*secret*"
  # DBデータ（よくある）
  "*/postgres-data/*"
  "*/pgdata/*"
  "*/.postgres/*"
  "*/.db/*"
  "*/database/*"
  "*/data/*"
  "*/**/*.sqlite"
  "*/**/*.sqlite3"
  "*/**/*.db"
)

cd "$TARGET"

# 自己包含防止（TARGET配下に出る場合）
EXCLUDES+=("./$(basename "$OUT_APPS")")
EXCLUDES+=("./$(basename "$OUT_PACKAGES")")

rm -f "$OUT_APPS" "$OUT_PACKAGES"

if [ -d "apps" ]; then
  zip -r -y "$OUT_APPS" "apps" -x "${EXCLUDES[@]}"
  echo "OK: $OUT_APPS"
else
  echo "SKIP: apps/ がありません: $TARGET" >&2
fi

if [ -d "packages" ]; then
  zip -r -y "$OUT_PACKAGES" "packages" -x "${EXCLUDES[@]}"
  echo "OK: $OUT_PACKAGES"
else
  echo "SKIP: packages/ がありません: $TARGET" >&2
fi

echo "対象: $TARGET"
