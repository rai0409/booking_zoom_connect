# Booking MVP 実装計画（確定版）

## 目的
- 会社の複数Outlook（Microsoft 365）と連携し、営業担当の空き枠を顧客向けUIで提示
- 顧客が予約すると、Outlook予定が自動作成/更新され、確認メールが送られる

## 確定した方針

### UI/公開仕様
- 予約UIは **日表示（枠一覧）**で開始（＝月表示は初期スコープ外）
- 公開範囲は **担当者単位**（salesperson が確定）で開始
- 将来拡張として **チーム単位（team選択＋routing）** を追加できる構造にしておく

### Microsoft 365（Outlook）連携
- Graph連携は **App-only（管理者同意）** を標準
- free/busy取得・予定作成・subscription運用を **ユーザーのログイン状態に依存しない**

### Outlook予定ポリシー（PII/可視性/テンプレ）
- デフォルト：**最小PII + private/busy + 本文テンプレ**
  - 件名：顧客名は入れない（例：`Appointment` / `Busy`）
  - 表示：`private` / `busy` を基本
  - 本文：必要最低限（場所 / Zoomリンク（将来）/ キャンセル導線）をテンプレで差し込み
  - 顧客名/相談内容などのPIIは **テナント設定でON/OFF可能**

### 予約フロー
- 初期は **即確定 → 確認メール送信**（verify-email必須にしない）
- verify-email は将来必要になった時に戻せるよう **機能/導線は残す**（UIでは初期利用しない）

### 非同期処理（キュー）
- **Azure Service Bus 前提**で設計
- 運用で最低限見るもの：
  - `ActiveMessages`（滞留）
  - `DeadletteredMessages`（DLQ）

### 監視・運用（最小構成）
- 例外監視：Sentry
- キュー監視：Azure Monitor（Active/DLQアラート）
- トレース/ログ相関：Application Insights（相関IDを通す）
- アラート通知先：メール

### 送信元メール
- 予約通知専用の **共有メールボックス**を新規作成して送信元にする

### セキュリティ（最低限）
- レート制限・最低限のBot耐性は **初期から**入れる
  - 対象：`holds` / `confirm`（必要なら verify-email）
  - 単位：IP + tenant（必要なら email）

### Zoom連携
- 現状のコードは **概念（クライアント枠・呼び出し導線）あり**、実連携は未実装
- 将来的に Zoom SDK/API 実装を追加して拡張

## 実装順（最短で商用っぽく動く）

1. **日表示の空き枠計算を確定**
   - `Tenant.public_business_hours`（v1）を定義
   - `BookingService.getAvailability()` を設定反映に置換（slot/lead/buffer/breaks/maxDaysAhead/closedDates）

2. **即確定フローに切替**
   - UI：`hold → verify-email → confirm(token)`
   - API：`POST /v1/public/:tenantSlug/confirm` は `token` のみ受け付ける

3. **Service Bus の実装（まずWebhookキュー）**
   - `ServiceBusQueue` を実装
   - Webhook再試行は DB の `next_run_at_utc` を用いて永続化（setTimeout依存を排除）

4. **GraphClient を実装（App-only）**
   - token取得（client_credentials）
   - getSchedule / createEvent / sendMail / subscriptions（create/renew）

5. **Webhookの安全性（clientState検証）**
   - 通知の `clientState` と DB の `client_state` を照合

6. **最小監視を配線**
   - Sentry / Azure Monitor(Service Bus) / App Insights（相関ID）

7. **最低限のレート制限を導入**
   - `/holds` と `/confirm` を中心に導入（後から強化可能）

## 外部リソース（E2E検証に必要）
- Microsoft 365
  - `MS_CLIENT_ID`, `MS_CLIENT_SECRET`
  - 管理者同意できるテストテナント（tenantId）
  - 共有メールボックス（`MS_SHARED_MAILBOX`）
  - Webhook通知を受ける公開HTTPS URL（`BASE_URL`）
- Azure Service Bus
  - `SERVICEBUS_CONNECTION`, `SERVICEBUS_QUEUE_NAME`
