#!/usr/bin/env bash
set -euo pipefail

ZIP_PATH="${1:?Usage: ./generate_impl_inventory.sh /path/to/project.zip}"
TS="$(date +%Y%m%d_%H%M%S)"
WORKDIR="impl_review_${TS}"
OUTDIR="${WORKDIR}/report"
SRCDIR="${WORKDIR}/src"

mkdir -p "$OUTDIR"
unzip -q "$ZIP_PATH" -d "$SRCDIR"

ROOT="$(find "$SRCDIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [ -z "${ROOT:-}" ]; then
  echo "ERROR: unzip後のルートディレクトリが見つかりません"
  exit 1
fi

echo "ROOT=$ROOT" | tee "$OUTDIR/00_root.txt"

# 0) 全体構造
find "$ROOT" -maxdepth 4 | sort > "$OUTDIR/01_tree.txt"

# 1) package / workflow / env / deploy系
find "$ROOT" -type f \( \
  -name 'package.json' -o \
  -name 'pnpm-workspace.yaml' -o \
  -name 'turbo.json' -o \
  -name '.env.example' -o \
  -name 'docker-compose*.yml' -o \
  -name 'docker-compose*.yaml' -o \
  -name 'Dockerfile*' -o \
  -path '*/.github/workflows/*' -o \
  -path '*/k8s/*' -o \
  -path '*/helm/*' \
\) | sort > "$OUTDIR/02_build_deploy_files.txt"

# 2) Public / Internal / Webhook エンドポイント
rg -n --no-heading \
  '@Controller|@Get|@Post|@Patch|@Delete|availability|holds|verify-email|confirm|cancel|reschedule|webhooks' \
  "$ROOT/apps/api/src" > "$OUTDIR/03_endpoints.txt" || true

# 3) BookingService 主要関数
rg -n --no-heading \
  'async (getAvailabilityPublic|listSalespersonsPublic|createHoldPublic|sendVerificationPublic|confirmBookingPublic|confirmBookingPublicById|cancelBookingPublic|rescheduleBookingPublic|expireHolds|reinviteBookingInternal)' \
  "$ROOT/apps/api/src/services/booking.service.ts" > "$OUTDIR/04_booking_service_functions.txt" || true

# 4) 状態遷移の根拠
{
  echo '=== BookingStatus enum ==='
  rg -n --no-heading 'enum BookingStatus|hold|pending_verify|confirmed|canceled|expired' \
    "$ROOT/apps/api/prisma/schema.prisma" || true
  echo
  echo '=== booking.service.ts status updates ==='
  rg -n --no-heading 'status:\s*BookingStatus\.' \
    "$ROOT/apps/api/src/services/booking.service.ts" || true
} > "$OUTDIR/05_status_transitions_raw.txt"

# 5) 冪等性の根拠
{
  echo '=== booking unique / idempotency schema ==='
  rg -n --no-heading 'IdempotencyKey|idempotency_key|@@unique' \
    "$ROOT/apps/api/prisma/schema.prisma" || true
  echo
  echo '=== service idempotency usage ==='
  rg -n --no-heading 'checkIdempotency|recordIdempotency|idempotencyKey|idempotency_key' \
    "$ROOT/apps/api/src/services/booking.service.ts" || true
} > "$OUTDIR/06_idempotency_raw.txt"

# 6) Graph 連携の到達点
{
  echo '=== graph client ==='
  rg -n --no-heading 'class GraphClient|async (getBusySlots|sendMail|createEvent|updateEventTimes|updateEventBody|deleteEvent)' \
    "$ROOT/apps/api/src/clients/graph.client.ts" || true
  echo
  echo '=== graph usage in booking/webhook/mail ==='
  rg -n --no-heading 'graph\.|GraphMailSender|sendConfirmationEmailBestEffort|ensureGraphEventForConfirmedBookingBestEffort|patchGraphEventTimesBestEffort|reinviteBookingInternal|handleWebhookJob' \
    "$ROOT/apps/api/src" || true
} > "$OUTDIR/07_graph_paths_raw.txt"

# 7) Zoom 実装状態
{
  echo '=== zoom client ==='
  sed -n '1,240p' "$ROOT/apps/api/src/clients/zoom.client.ts" || true
} > "$OUTDIR/08_zoom_client.txt"

# 8) 観測 / ログ / request-id / shutdown
{
  echo '=== observability related search ==='
  rg -n --no-heading 'APPINSIGHTS|appinsights|ApplicationInsights|otel|opentelemetry|sentry|request-id|x-request-id|shutdown|enableShutdownHooks|logger' \
    "$ROOT" || true
} > "$OUTDIR/09_observability_raw.txt"

# 9) Queue / Worker / Compensation
{
  echo '=== queue / worker ==='
  rg -n --no-heading 'class .*Worker|enqueue|dequeue|WebhookJob|CompensationJob|customer_notify_required|reinvite_required|next_run_at|attempt_count|max_attempts' \
    "$ROOT/apps/api/src" "$ROOT/apps/api/prisma/schema.prisma" || true
} > "$OUTDIR/10_workers_queue_raw.txt"

# 10) Web 側の公開フロー
{
  echo '=== web public flow ==='
  rg -n --no-heading 'availability|holds|verify-email|confirm|cancel|reschedule|token|selectedSlot|submitBooking' \
    "$ROOT/apps/web" || true
} > "$OUTDIR/11_web_public_flow_raw.txt"

# 11) docs / runbook / samples
find "$ROOT/docs" -type f | sort > "$OUTDIR/12_docs_files.txt"
{
  echo '=== docs keywords ==='
  rg -n --no-heading 'MVP|hold|verify|confirm|Graph|Zoom|Service Bus|AppInsights|deploy' \
    "$ROOT/docs" || true
} > "$OUTDIR/13_docs_keywords_raw.txt"

# 12) デプロイ不足の断定材料
{
  echo '=== docker/k8s existence check ==='
  find "$ROOT" -type f \( -name 'Dockerfile*' -o -path '*/k8s/*' -o -path '*/helm/*' \) | sort
} > "$OUTDIR/14_deploy_artifacts_check.txt"

# 13) 台帳ひな形作成
cat > "$OUTDIR/15_impl_inventory_template.md" <<'MD'
# 実装確認台帳

## 記入ルール
- 実装状態: 実装済み / 部分実装 / 未実装 / モックのみ / envのみ
- 根拠は必ずファイルパスと関数名で残す

| 機能名 | endpoint / 入口 | service / 実処理 | 実装状態 | 前提 env | 状態遷移 | 冪等性 | DB副作用 | 外部副作用 | 失敗時挙動 | 根拠ファイル | 商用残課題 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| holds |  |  |  |  |  |  |  |  |  |  |  |
| verify-email |  |  |  |  |  |  |  |  |  |  |  |
| confirm |  |  |  |  |  |  |  |  |  |  |  |
| confirm-by-id |  |  |  |  |  |  |  |  |  |  |  |
| cancel |  |  |  |  |  |  |  |  |  |  |  |
| reschedule |  |  |  |  |  |  |  |  |  |  |  |
| availability |  |  |  |  |  |  |  |  |  |  |  |
| Graph webhook |  |  |  |  |  |  |  |  |  |  |  |
| compensation worker |  |  |  |  |  |  |  |  |  |  |  |
| Zoom |  |  |  |  | - | - |  |  |  |  |  |
| observability |  |  |  |  | - | - |  |  |  |  |  |
| deploy |  |  |  |  | - | - |  |  |  |  |  |
MD

# 14) 簡易サマリ
{
  echo "# 自動抽出サマリ"
  echo
  echo "生成日時: $TS"
  echo "解析対象: $ROOT"
  echo
  echo "## 主要確認ファイル"
  echo "- apps/api/src/services/booking.service.ts"
  echo "- apps/api/src/public.controller.ts"
  echo "- apps/api/src/webhooks.controller.ts"
  echo "- apps/api/src/clients/graph.client.ts"
  echo "- apps/api/src/clients/zoom.client.ts"
  echo "- apps/api/prisma/schema.prisma"
  echo "- apps/web/app/public/[tenantSlug]/page.tsx"
  echo
  echo "## 次に人手で埋めるべきファイル"
  echo "- 05_status_transitions_raw.txt"
  echo "- 06_idempotency_raw.txt"
  echo "- 07_graph_paths_raw.txt"
  echo "- 08_zoom_client.txt"
  echo "- 09_observability_raw.txt"
  echo "- 14_deploy_artifacts_check.txt"
  echo "- 15_impl_inventory_template.md"
} > "$OUTDIR/16_summary.md"

echo
echo "完了: $OUTDIR"
echo "次に確認するファイル:"
echo "  $OUTDIR/16_summary.md"
echo "  $OUTDIR/15_impl_inventory_template.md"
