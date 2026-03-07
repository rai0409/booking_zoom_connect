#!/usr/bin/env bash
set -euo pipefail

# ========= 設定 =========
# ここを実際のリポジトリルートに変更
REPO_DIR="${REPO_DIR:-$HOME/booking_zoom_connect}"

# 出力先
TS="$(date +%Y%m%d_%H%M%S)"
OUT_DIR="${OUT_DIR:-$HOME/booking_collect_$TS}"
PKG_NAME="booking_context_$TS"
ZIP_PATH="$HOME/${PKG_NAME}.zip"

mkdir -p "$OUT_DIR"

cd "$REPO_DIR"

echo "[1/8] prisma migrations を取得"
if [ -d "apps/api/prisma/migrations" ]; then
  mkdir -p "$OUT_DIR/apps/api/prisma"
  cp -R "apps/api/prisma/migrations" "$OUT_DIR/apps/api/prisma/"
else
  echo "WARN: apps/api/prisma/migrations が見つかりません"
fi

echo "[2/8] web UI(app配下) を取得"
if [ -d "apps/web/app" ]; then
  mkdir -p "$OUT_DIR/apps/web"
  cp -R "apps/web/app" "$OUT_DIR/apps/web/"
else
  echo "WARN: apps/web/app が見つかりません"
fi

echo "[3/8] .env.example を取得"
if [ -f ".env.example" ]; then
  cp ".env.example" "$OUT_DIR/.env.example"
elif [ -f "apps/api/.env.example" ]; then
  mkdir -p "$OUT_DIR/apps/api"
  cp "apps/api/.env.example" "$OUT_DIR/apps/api/.env.example"
else
  echo "WARN: .env.example が見つかりません"
fi

echo "[4/8] デプロイ資料候補を取得"
mkdir -p "$OUT_DIR/deploy_docs"

find . \
  \( -iname "*docker*" -o -iname "docker-compose*.yml" -o -iname "compose*.yml" -o \
     -iname "*render*" -o -iname "*azure*" -o -iname "*aca*" -o \
     -iname "*.md" -o -iname "*.yaml" -o -iname "*.yml" -o -iname "*.json" \) \
  -not -path "*/node_modules/*" \
  -not -path "*/.next/*" \
  -not -path "*/dist/*" \
  -not -path "*/coverage/*" \
  -print > "$OUT_DIR/deploy_docs_candidate_paths.txt"

# デプロイ関連っぽいものだけコピー
while IFS= read -r f; do
  case "$f" in
    *Dockerfile*|*docker-compose*.yml|*compose*.yml|*render*|*azure*|*aca*|*.md|*.yaml|*.yml|*.json)
      mkdir -p "$OUT_DIR/deploy_docs/$(dirname "$f")"
      cp -f "$f" "$OUT_DIR/deploy_docs/$f" 2>/dev/null || true
      ;;
  esac
done < "$OUT_DIR/deploy_docs_candidate_paths.txt"

echo "[5/8] smoke script を取得"
mkdir -p "$OUT_DIR/scripts_snapshot"
find . \
  -type f \
  \( -iname "*smoke*" -o -iname "*verify*" -o -iname "*dev-up*" -o -iname "*seed*" \) \
  -not -path "*/node_modules/*" \
  -not -path "*/.next/*" \
  -not -path "*/dist/*" \
  -print > "$OUT_DIR/smoke_related_paths.txt"

while IFS= read -r f; do
  mkdir -p "$OUT_DIR/scripts_snapshot/$(dirname "$f")"
  cp -f "$f" "$OUT_DIR/scripts_snapshot/$f" 2>/dev/null || true
done < "$OUT_DIR/smoke_related_paths.txt"

echo "[6/8] 実行ログ候補を取得"
mkdir -p "$OUT_DIR/logs"

# よくあるログ置き場
for p in \
  /tmp/api_dev.log \
  /tmp/web_dev.log \
  /tmp/worker.log \
  ./tmp/api_dev.log \
  ./tmp/web_dev.log \
  ./tmp/worker.log
do
  if [ -f "$p" ]; then
    cp -f "$p" "$OUT_DIR/logs/$(basename "$p")"
  fi
done

# リポジトリ内の log / logs も候補として取得
find . \
  \( -path "*/log/*" -o -path "*/logs/*" -o -iname "*.log" \) \
  -not -path "*/node_modules/*" \
  -not -path "*/.next/*" \
  -not -path "*/dist/*" \
  -type f \
  -print > "$OUT_DIR/log_candidate_paths.txt"

while IFS= read -r f; do
  mkdir -p "$OUT_DIR/logs/repo_logs/$(dirname "$f")"
  cp -f "$f" "$OUT_DIR/logs/repo_logs/$f" 2>/dev/null || true
done < "$OUT_DIR/log_candidate_paths.txt"

echo "[7/8] 失敗調査用の情報をテキスト化"
{
  echo "===== pwd ====="
  pwd
  echo

  echo "===== git status -sb ====="
  git status -sb || true
  echo

  echo "===== recent commits ====="
  git log --oneline -n 20 || true
  echo

  echo "===== pnpm scripts ====="
  if [ -f package.json ]; then
    cat package.json
  fi
  echo

  echo "===== app/api package.json ====="
  if [ -f apps/api/package.json ]; then
    cat apps/api/package.json
  fi
  echo

  echo "===== app/web package.json ====="
  if [ -f apps/web/package.json ]; then
    cat apps/web/package.json
  fi
  echo
} > "$OUT_DIR/repo_snapshot.txt"

# 失敗に関わりやすい grep
{
  echo "===== rg: error / fail / invalid / conflict / prisma ====="
  rg -n "error|fail|invalid|conflict|prisma|migration|webhook|compensation" . \
    --glob '!node_modules/**' \
    --glob '!.next/**' \
    --glob '!dist/**' || true
} > "$OUT_DIR/error_keywords_scan.txt"

echo "[8/8] zip 化"
PARENT_DIR="$(dirname "$OUT_DIR")"
BASE_DIR="$(basename "$OUT_DIR")"

cd "$PARENT_DIR"
zip -r "$ZIP_PATH" "$BASE_DIR" >/dev/null

echo
echo "完了:"
echo "  展開物: $OUT_DIR"
echo "  zip:    $ZIP_PATH"
