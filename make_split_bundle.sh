#!/usr/bin/env bash
# make_split_bundle.sh
#
# 使い方:
#   bash make_split_bundle.sh
#   bash make_split_bundle.sh output /home/rai/booking_zoom_connect
#   bash make_split_bundle.sh output /home/rai/booking_zoom_connect /home/rai/booking_zoom_connect/_bundle_out
#
# 出力例:
#   /path/to/_bundle_out/output_app.tar.gz
#   /path/to/_bundle_out/output_ops.tar.gz
#
# 方針:
# - docs は除外
# - node_modules / dist / .next など重いものは除外
# - 実装本体(app) と 運用・設定(ops) を2分割
# - ChatGPT分析用に manifest / tree / rg検索結果 を同梱
# - .env / secret / バイナリ / 画像 / 大きいデータは除外
#
# 備考:
# - tar はほぼ標準で使えるため zip 依存より軽い
# - rg(ripgrep) があれば、原因特定に必要な候補ファイル一覧も保存する

set -euo pipefail

BASE_NAME="${1:-output}"
TARGET="${2:-$(pwd)}"
OUT_DIR="${3:-$(pwd)}"

if ! command -v tar >/dev/null 2>&1; then
  echo "tar コマンドが見つかりません。" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 が見つかりません。" >&2
  exit 1
fi

if [ ! -d "$TARGET" ]; then
  echo "対象ディレクトリが存在しません: $TARGET" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

abs_path() {
  python3 - "$1" <<'PY'
import os, sys
print(os.path.abspath(sys.argv[1]))
PY
}

next_free_path() {
  python3 - "$1" <<'PY'
import os, sys

path = sys.argv[1]
dir_ = os.path.dirname(path)
base = os.path.basename(path)
stem, ext = os.path.splitext(base)

# .tar.gz 対応
if stem.endswith(".tar"):
    stem2 = stem[:-4]
    ext2 = ".tar" + ext
else:
    stem2 = stem
    ext2 = ext

cand = path
if not os.path.exists(cand):
    print(cand)
    raise SystemExit

i = 2
while True:
    cand = os.path.join(dir_, f"{stem2}{i}{ext2}")
    if not os.path.exists(cand):
        print(cand)
        break
    i += 1
PY
}

TARGET="$(abs_path "$TARGET")"
OUT_DIR="$(abs_path "$OUT_DIR")"

APP_OUT="$(next_free_path "$OUT_DIR/${BASE_NAME}_app.tar.gz")"
OPS_OUT="$(next_free_path "$OUT_DIR/${BASE_NAME}_ops.tar.gz")"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

APP_STAGE="$TMP_DIR/app_stage"
OPS_STAGE="$TMP_DIR/ops_stage"
APP_META="$APP_STAGE/_bundle_meta"
OPS_META="$OPS_STAGE/_bundle_meta"

mkdir -p "$APP_STAGE" "$OPS_STAGE" "$APP_META" "$OPS_META"

APP_LIST="$TMP_DIR/app.lst"
OPS_LIST="$TMP_DIR/ops.lst"
: > "$APP_LIST"
: > "$OPS_LIST"

cd "$TARGET"

add_if_exists() {
  local list_file="$1"
  shift
  for p in "$@"; do
    if [ -e "$p" ]; then
      echo "$p" >> "$list_file"
    fi
  done
}

# -------------------------
# 1) app側: 実装本体
# -------------------------
add_if_exists "$APP_LIST" \
  apps \
  packages \
  prisma \
  src \
  lib \
  public \
  types \
  shared \
  features \
  modules \
  components \
  hooks \
  utils \
  server \
  client

add_if_exists "$APP_LIST" \
  package.json \
  pnpm-lock.yaml \
  pnpm-workspace.yaml \
  yarn.lock \
  package-lock.json \
  turbo.json \
  nx.json \
  tsconfig.json \
  tsconfig.base.json \
  tsconfig.build.json \
  nest-cli.json \
  next.config.js \
  next.config.mjs \
  next.config.ts \
  postcss.config.js \
  postcss.config.cjs \
  tailwind.config.js \
  tailwind.config.cjs \
  tailwind.config.ts \
  eslint.config.js \
  eslint.config.mjs \
  .eslintrc \
  .eslintrc.json \
  .prettierrc \
  .prettierrc.json \
  .gitignore \
  .npmrc \
  Dockerfile \
  Dockerfile.api \
  Dockerfile.web \
  docker-compose.yml \
  docker-compose.yaml \
  README.md

# -------------------------
# 2) ops側: scripts / infra / CI / DB補助
# -------------------------
add_if_exists "$OPS_LIST" \
  scripts \
  infra \
  .github \
  prisma \
  migrations \
  sql \
  seed \
  seeds \
  docker \
  deployments \
  configs \
  config \
  ops \
  bin \
  tools \
  Makefile \
  docker-compose.yml \
  docker-compose.yaml \
  .env.example \
  .env.local.example \
  .env.development.example \
  .env.production.example \
  package.json \
  pnpm-lock.yaml \
  pnpm-workspace.yaml \
  yarn.lock \
  package-lock.json \
  turbo.json \
  nx.json \
  tsconfig.json \
  tsconfig.base.json \
  tsconfig.build.json \
  nest-cli.json \
  README.md

if [ ! -s "$APP_LIST" ]; then
  echo "app用に対象が見つかりませんでした。対象構成を確認してください。" >&2
  exit 1
fi

if [ ! -s "$OPS_LIST" ]; then
  echo "ops用に対象が見つかりませんでした。対象構成を確認してください。" >&2
  exit 1
fi

# -------------------------
# 除外ルール
# -------------------------
should_exclude() {
  local p="$1"

  case "$p" in
    .git|.git/*) return 0 ;;
    node_modules|node_modules/*|*/node_modules|*/node_modules/*) return 0 ;;
    dist|dist/*|*/dist|*/dist/*) return 0 ;;
    build|build/*|*/build|*/build/*) return 0 ;;
    .next|.next/*|*/.next|*/.next/*) return 0 ;;
    out|out/*|*/out|*/out/*) return 0 ;;
    coverage|coverage/*|*/coverage|*/coverage/*) return 0 ;;
    .turbo|.turbo/*|*/.turbo|*/.turbo/*) return 0 ;;
    .cache|.cache/*|*/.cache|*/.cache/*) return 0 ;;
    .venv|.venv/*|*/.venv|*/.venv/*) return 0 ;;
    venv|venv/*|*/venv|*/venv/*) return 0 ;;
    __pycache__|__pycache__/*|*/__pycache__|*/__pycache__/*) return 0 ;;
    .pytest_cache|.pytest_cache/*|*/.pytest_cache|*/.pytest_cache/*) return 0 ;;
    .mypy_cache|.mypy_cache/*|*/.mypy_cache|*/.mypy_cache/*) return 0 ;;
    .idea|.idea/*|*/.idea|*/.idea/*) return 0 ;;
    .vscode|.vscode/*|*/.vscode|*/.vscode/*) return 0 ;;
    tmp|tmp/*|*/tmp|*/tmp/*) return 0 ;;
    temp|temp/*|*/temp|*/temp/*) return 0 ;;
    logs|logs/*|*/logs|*/logs/*) return 0 ;;
    outputs|outputs/*|*/outputs|*/outputs/*) return 0 ;;
    docs|docs/*|*/docs|*/docs/*) return 0 ;;
  esac

  case "$p" in
    *.DS_Store) return 0 ;;
    *.log) return 0 ;;
    *.sqlite|*.db) return 0 ;;
    *.tar|*.tar.gz|*.tgz|*.zip|*.7z|*.rar) return 0 ;;
    *.pt|*.pth|*.onnx|*.bin) return 0 ;;
    *.parquet|*.feather|*.csv|*.tsv) return 0 ;;
    *.jpg|*.jpeg|*.png|*.webp|*.gif|*.bmp|*.ico|*.svg) return 0 ;;
    *.mp4|*.mov|*.avi|*.mkv|*.mp3|*.wav) return 0 ;;
    *.pdf) return 0 ;;
    *.pem|*.key|*.p12|*.pfx) return 0 ;;
  esac

  case "$p" in
    .env|.env.*)
      case "$p" in
        .env.example|.env.local.example|.env.development.example|.env.production.example) ;;
        *) return 0 ;;
      esac
      ;;
  esac

  # secretっぽい名前
  case "$p" in
    *secret*|*SECRET*|*Secret*) return 0 ;;
  esac

  return 1
}

copy_selected() {
  local list_file="$1"
  local stage_dir="$2"
  local copied_list="$3"
  : > "$copied_list"

  while IFS= read -r entry; do
    [ -z "$entry" ] && continue
    if [ ! -e "$entry" ]; then
      continue
    fi

    if [ -d "$entry" ]; then
      while IFS= read -r sub; do
        rel="${sub#./}"
        rel="${rel#/}"
        [ -z "$rel" ] && continue
        should_exclude "$rel" && continue

        if [ -d "$sub" ]; then
          mkdir -p "$stage_dir/$rel"
        elif [ -f "$sub" ] || [ -L "$sub" ]; then
          mkdir -p "$(dirname "$stage_dir/$rel")"
          cp -a "$sub" "$stage_dir/$rel"
          echo "$rel" >> "$copied_list"
        fi
      done < <(find "$entry" -mindepth 1)
    else
      rel="$entry"
      should_exclude "$rel" && continue
      mkdir -p "$(dirname "$stage_dir/$rel")"
      cp -a "$entry" "$stage_dir/$rel"
      echo "$rel" >> "$copied_list"
    fi
  done < "$list_file"
}

APP_COPIED="$TMP_DIR/app_copied.lst"
OPS_COPIED="$TMP_DIR/ops_copied.lst"

echo "[1/6] appステージを作成中..."
copy_selected "$APP_LIST" "$APP_STAGE" "$APP_COPIED"

echo "[2/6] opsステージを作成中..."
copy_selected "$OPS_LIST" "$OPS_STAGE" "$OPS_COPIED"

if [ ! -s "$APP_COPIED" ]; then
  echo "app側でコピー対象が0件でした。対象構成または除外条件を確認してください。" >&2
  exit 1
fi

if [ ! -s "$OPS_COPIED" ]; then
  echo "ops側でコピー対象が0件でした。対象構成または除外条件を確認してください。" >&2
  exit 1
fi

# -------------------------
# metadata 生成
# -------------------------
write_common_meta() {
  local meta_dir="$1"
  local kind="$2"
  local copied_list="$3"

  {
    echo "bundle_kind=$kind"
    echo "target=$TARGET"
    echo "created_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "host=$(hostname 2>/dev/null || true)"
    echo "base_name=$BASE_NAME"
    echo "file_count=$(wc -l < "$copied_list" | tr -d ' ')"
    echo "rg_available=$(command -v rg >/dev/null 2>&1 && echo yes || echo no)"
  } > "$meta_dir/bundle_info.txt"

  {
    echo "# included files"
    sort -u "$copied_list"
  } > "$meta_dir/included_files.txt"

  {
    echo "# root entries"
    find "$TARGET" -maxdepth 2 \
      \( -path '*/.git' -o -path '*/node_modules' -o -path '*/dist' -o -path '*/.next' \) -prune -o \
      -print | sed "s#^$TARGET#.#" | sort
  } > "$meta_dir/tree_root_depth2.txt"

  {
    echo "# package.json files"
    find "$TARGET" -name package.json \
      -not -path '*/node_modules/*' \
      -not -path '*/dist/*' \
      -not -path '*/.next/*' \
      | sed "s#^$TARGET/##" | sort
  } > "$meta_dir/package_json_files.txt"

  {
    echo "# tsconfig files"
    find "$TARGET" \( -name 'tsconfig*.json' -o -name 'nest-cli.json' -o -name 'next.config.*' \) \
      -not -path '*/node_modules/*' \
      -not -path '*/dist/*' \
      -not -path '*/.next/*' \
      | sed "s#^$TARGET/##" | sort
  } > "$meta_dir/config_files.txt"
}

write_app_analysis_hints() {
  local meta_dir="$1"

  if command -v rg >/dev/null 2>&1; then
    {
      echo "# availability / busy / overlap / cache candidates"
      rg -n \
        "getAvailability|buildAvailabilityContext|slotOverlapsBusy|overlap|busy|invalidate.*avail|avail.*invalidate|cache.*avail|getSchedule|graph_busy" \
        "$TARGET" \
        -g '!**/node_modules/**' \
        -g '!**/dist/**' \
        -g '!**/.next/**' \
        -g '!**/docs/**' \
        -g '!**/coverage/**' \
        || true
    } > "$meta_dir/rg_availability_candidates.txt"

    {
      echo "# booking lifecycle candidates"
      rg -n \
        "hold|pending_verify|confirm|cancel|verify" \
        "$TARGET" \
        -g '!**/node_modules/**' \
        -g '!**/dist/**' \
        -g '!**/.next/**' \
        -g '!**/docs/**' \
        -g '!**/coverage/**' \
        || true
    } > "$meta_dir/rg_booking_flow_candidates.txt"

    {
      echo "# frontend token action candidates"
      rg -n \
        "processedTokenActionKeys|useRef|token action|verify.*page|confirm.*page|cancel.*page|useSearchParams|router.replace|router.push" \
        "$TARGET" \
        -g '!**/node_modules/**' \
        -g '!**/dist/**' \
        -g '!**/.next/**' \
        -g '!**/docs/**' \
        -g '!**/coverage/**' \
        || true
    } > "$meta_dir/rg_frontend_candidates.txt"

    {
      echo "# prisma / booking schema candidates"
      rg -n \
        "model Booking|booking|status|startAtUtc|endAtUtc|holdExpiresAt|salespersonId" \
        "$TARGET/prisma" "$TARGET/apps" "$TARGET/packages" "$TARGET/src" 2>/dev/null || true
    } > "$meta_dir/rg_schema_candidates.txt"
  else
    {
      echo "ripgrep (rg) がないため検索結果は作成されていません。"
      echo "Ubuntuなら: sudo apt-get update && sudo apt-get install -y ripgrep"
    } > "$meta_dir/rg_unavailable.txt"
  fi
}

write_ops_analysis_hints() {
  local meta_dir="$1"

  if command -v rg >/dev/null 2>&1; then
    {
      echo "# scripts / runbook / smoke candidates"
      rg -n \
        "smoke|dev-up|seed|migrate|prisma|docker compose|pnpm dev|start:dev|start:prod|cancelBooking|verifyBookingToken" \
        "$TARGET" \
        -g '!**/node_modules/**' \
        -g '!**/dist/**' \
        -g '!**/.next/**' \
        -g '!**/docs/**' \
        || true
    } > "$meta_dir/rg_ops_candidates.txt"
  else
    {
      echo "ripgrep (rg) がないため検索結果は作成されていません。"
    } > "$meta_dir/rg_unavailable.txt"
  fi
}

write_common_meta "$APP_META" "app" "$APP_COPIED"
write_common_meta "$OPS_META" "ops" "$OPS_COPIED"
write_app_analysis_hints "$APP_META"
write_ops_analysis_hints "$OPS_META"

# 簡易 README
cat > "$APP_META/README_BUNDLE.txt" <<'EOF'
この bundle は ChatGPT でコード分析しやすくするための app 側アーカイブです。

主に含むもの:
- apps / packages / src / prisma などの実装本体
- ルート設定ファイル
- _bundle_meta 配下の manifest / 検索結果

まず見るべきファイル:
- _bundle_meta/rg_availability_candidates.txt
- _bundle_meta/rg_booking_flow_candidates.txt
- _bundle_meta/rg_frontend_candidates.txt
- _bundle_meta/included_files.txt
EOF

cat > "$OPS_META/README_BUNDLE.txt" <<'EOF'
この bundle は ChatGPT で運用・起動・スモークテストを確認しやすくするための ops 側アーカイブです。

主に含むもの:
- scripts / infra / docker / .github / prisma など
- ルート設定ファイル
- _bundle_meta 配下の manifest / 検索結果

まず見るべきファイル:
- _bundle_meta/rg_ops_candidates.txt
- _bundle_meta/included_files.txt
EOF

# -------------------------
# tar.gz 作成
# -------------------------
echo "[3/6] app tar.gz を作成中: $APP_OUT"
tar -C "$APP_STAGE" -czf "$APP_OUT" .

echo "[4/6] ops tar.gz を作成中: $OPS_OUT"
tar -C "$OPS_STAGE" -czf "$OPS_OUT" .

echo "[5/6] 出力内容サマリを作成中..."
APP_SIZE="$(du -h "$APP_OUT" | awk '{print $1}')"
OPS_SIZE="$(du -h "$OPS_OUT" | awk '{print $1}')"
APP_COUNT="$(wc -l < "$APP_COPIED" | tr -d ' ')"
OPS_COUNT="$(wc -l < "$OPS_COPIED" | tr -d ' ')"

SUMMARY="$OUT_DIR/${BASE_NAME}_bundle_summary.txt"
cat > "$SUMMARY" <<EOF
created_at_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)
target=$TARGET

app_archive=$APP_OUT
app_size=$APP_SIZE
app_file_count=$APP_COUNT

ops_archive=$OPS_OUT
ops_size=$OPS_SIZE
ops_file_count=$OPS_COUNT
EOF

echo "[6/6] 完了"

echo
echo "OK:"
echo "  app     : $APP_OUT"
echo "  ops     : $OPS_OUT"
echo "  summary : $SUMMARY"
echo "対象 : $TARGET"
echo
echo "app 件数 : $APP_COUNT"
echo "ops 件数 : $OPS_COUNT"
echo "app 容量 : $APP_SIZE"
echo "ops 容量 : $OPS_SIZE"
