#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:?Usage: ./generate_impl_inventory_from_dir.sh /path/to/project_dir}"
TS="$(date +%Y%m%d_%H%M%S)"
OUTDIR="impl_review_${TS}"

if [ ! -d "$ROOT_DIR" ]; then
  echo "ERROR: directory not found: $ROOT_DIR"
  exit 1
fi

mkdir -p "$OUTDIR"

echo "ROOT=$ROOT_DIR" | tee "$OUTDIR/00_root.txt"

# 0) 全体構造
find "$ROOT_DIR" -maxdepth 4 | sort > "$OUTDIR/01_tree.txt"

# 1) package / workflow / env / deploy系
find "$ROOT_DIR" -type f \( \
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
  "$ROOT_DIR/apps/api/src" > "$OUTDIR/03_endpoints.txt" || true

# 3) BookingService 主要関数
rg -n --no-heading \
  'async (getAvailabilityPublic|listSalespersonsPublic|createHoldPublic|sendVerificationPublic|confirmBookingPublic|confirmBookingPublicById|cancelBookingPublic|rescheduleBookingPublic|expireHolds|reinviteBookingInternal)' \
  "$ROOT_DIR/apps/api/src/services/booking.service.ts" > "$OUTDIR/04_booking_service_functions.txt" || true

# 4) 状態遷移の根拠
{
  echo '=== BookingStatus enum ==='
  rg -n --no-heading 'enum BookingStatus|hold|pending_verify|confirmed|canceled|expired' \
    "$ROOT_DIR/apps/api/prisma/schema.prisma" || true
  echo
  echo '=== booking.service.ts status updates ==='
  rg -n --no-heading 'status:\s*BookingStatus\.' \
    "$ROOT_DIR/apps/api/src/services/booking.service.ts" || true
} > "$OUTDIR/05_status_transitions_raw.txt"

# 5) 冪等性の根拠
{
  echo '=== booking unique / idempotency schema ==='
  rg -n --no-heading 'IdempotencyKey|idempotency_key|@@unique' \
    "$ROOT_DIR/apps/api/prisma/schema.prisma" || true
  echo
  echo '=== service idempotency usage ==='
  rg -n --no-heading 'checkIdempotency|recordIdempotency|idempotencyKey|idempotency_key' \
    "$ROOT_DIR/apps/api/src/services/booking.service.ts" || true
} > "$OUTDIR/06_idempotency_raw.txt"

# 6) Graph 連携の到達点
{
  echo '=== graph client ==='
  rg -n --no-heading 'class GraphClient|async (getBusySlots|sendMail|createEvent|updateEventTimes|updateEventBody|deleteEvent)' \
    "$ROOT_DIR/apps/api/src/clients/graph.client.ts" || true
  echo
  echo '=== graph usage in booking/webhook/mail ==='
  rg -n --no-heading 'graph\.|GraphMailSender|sendConfirmationEmailBestEffort|ensureGraphEventForConfirmedBookingBestEffort|patchGraphEventTimesBestEffort|reinviteBookingInternal|handleWebhookJob' \
    "$ROOT_DIR/apps/api/src" || true
} > "$OUTDIR/07_graph_paths_raw.txt"

# 7) Zoom 実装状態
{
  echo '=== zoom client ==='
  sed -n '1,240p' "$ROOT_DIR/apps/api/src/clients/zoom.client.ts" || true
} > "$OUTDIR/08_zoom_client.txt"

# 8) 観測 / ログ / request-id / shutdown
{
  echo '=== observability related search ==='
  rg -n --no-heading 'APPINSIGHTS|appinsights|ApplicationInsights|otel|opentelemetry|sentry|request-id|x-request-id|shutdown|enableShutdownHooks|logger' \
    "$ROOT_DIR" || true
} > "$OUTDIR/09_observability_raw.txt"

# 9) Queue / Worker / Compensation
{
  echo '=== queue / worker ==='
  rg -n --no-heading 'class .*Worker|enqueue|dequeue|WebhookJob|CompensationJob|customer_notify_required|customer_reinvite_required|next_run_at|attempt_count|max_attempts' \
    "$ROOT_DIR/apps/api/src" "$ROOT_DIR/apps/api/prisma/schema.prisma" || true
} > "$OUTDIR/10_workers_queue_raw.txt"

# 10) Web 側の公開フロー
{
  echo '=== web public flow ==='
  rg -n --no-heading 'availability|holds|verify-email|confirm|cancel|reschedule|token|selectedSlot|submitBooking' \
    "$ROOT_DIR/apps/web" || true
} > "$OUTDIR/11_web_public_flow_raw.txt"

# 11) docs / runbook / samples
if [ -d "$ROOT_DIR/docs" ]; then
  find "$ROOT_DIR/docs" -type f | sort > "$OUTDIR/12_docs_files.txt"
  {
    echo '=== docs keywords ==='
    rg -n --no-heading 'MVP|hold|verify|confirm|Graph|Zoom|Service Bus|AppInsights|deploy' \
      "$ROOT_DIR/docs" || true
  } > "$OUTDIR/13_docs_keywords_raw.txt"
fi

# 12) デプロイ不足の断定材料
{
  echo '=== docker/k8s existence check ==='
  find "$ROOT_DIR" -type f \( -name 'Dockerfile*' -o -path '*/k8s/*' -o -path '*/helm/*' \) | sort
} > "$OUTDIR/14_deploy_artifacts_check.txt"

# 13) 台帳ひな形
cat > "$OUTDIR/15_impl_inventory_template.md" <<'MD'
# 実装確認台帳

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

cat > "$OUTDIR/16_summary.md" <<EOF
生成日時: $TS
解析対象: $ROOT_DIR

まず見るファイル:
- $OUTDIR/05_status_transitions_raw.txt
- $OUTDIR/06_idempotency_raw.txt
- $OUTDIR/07_graph_paths_raw.txt
- $OUTDIR/08_zoom_client.txt
- $OUTDIR/09_observability_raw.txt
- $OUTDIR/14_deploy_artifacts_check.txt
- $OUTDIR/15_impl_inventory_template.md
EOF

echo
echo "完了: $OUTDIR"
