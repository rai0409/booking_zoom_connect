# Sprint 3 手動確認チェックリスト

対象: `booking_zoom_connect`
目的: Sprint 3 の UI 最小補修が、Sprint 2 の前提を壊さずに意図通り動作するかを手動確認する。
前提: Sprint 2 は closed。backend の canonical flow / smoke / DB trace を source of truth とする。

---

## 0. 確認対象

今回の手動確認で見る対象は以下です。

- 通常フォームで予約導線が動く
- confirm link で予約完了になる
- cancel link でキャンセル完了になる
- reschedule link で confirm に流れない
- reschedule 情報不足時に安全に止まる
- confirm 再送 UI が confirm 導線だけに出る

今回の確認は UI 最小補修の確認であり、backend の新規機能追加確認ではありません。

---

## 1. 事前準備

### 1-1. `NODE_ENV` を正常化

```bash
cd /home/rai/booking_zoom_connect/apps/web
unset NODE_ENV
printf 'NODE_ENV=%s\n' "$NODE_ENV"
```

期待値:
- `NODE_ENV=` と空で表示される、または shell 上で未設定になる

### 1-2. 依存関係と build 確認

```bash
cd /home/rai/booking_zoom_connect/apps/web
rm -rf .next
npm run build
```

期待値:
- `Compiled successfully`
- `Generating static pages ...` 完了
- `/public/[tenantSlug]` と `/[tenantSlug]/book` が route 一覧に出る
- build exit code = 0

---

## 2. 起動

### 2-1. API 起動

別ターミナルで実行:

```bash
cd /home/rai/booking_zoom_connect
pnpm -C apps/api dev
```

期待値:
- API が `http://localhost:4000` で起動
- health / ready が返る

確認:

```bash
curl -i http://localhost:4000/health
curl -i http://localhost:4000/ready
```

### 2-2. Web 起動

別ターミナルで実行:

```bash
cd /home/rai/booking_zoom_connect/apps/web
unset NODE_ENV
npm run dev
```

期待値:
- Web が `http://localhost:3000` で起動

---

## 3. Sprint 2 非破壊確認

UI 確認に入る前に、既存 smoke が壊れていないことを確認します。

### 3-1. 最小正常系 smoke

```bash
cd /home/rai/booking_zoom_connect
bash scripts/smoke-public.sh
```

期待値:
- hold 201
- verify 201
- confirm 201
- DB assert status=confirmed
- artifact 保存成功

### 3-2. 主 smoke

```bash
cd /home/rai/booking_zoom_connect
API_BASE=http://localhost:4000 bash scripts/smoke_public_flow_safe.sh
```

期待値:
- health / ready / salespersons / availability / hold / verify / confirm / cancel / reschedule が最後まで通る
- request-ids.tsv が生成される
- final-summary.json が生成される

---

## 4. Sprint 3 UI 手動確認

### 4-1. 通常フォーム表示確認

ブラウザで開く:

```text
http://localhost:3000/public/acme
```

確認項目:
- ページが表示される
- 予約フォームが表示される
- 日付入力が見える
- 時間枠一覧が表示される、または空でも適切なメッセージが出る
- エラーで即落ちしない

合格条件:
- token なしアクセスで通常フォーム UI になる
- confirm/cancel/reschedule 導線 UI にはならない

---

### 4-2. 通常予約 -> verification sent

操作:
- 日付を選ぶ
- 空き枠を選ぶ
- 名前を入力
- メールアドレスを入力
- 必要なら public_notes を入力
- 「予約する」を押す

期待値:
- hold -> verify-email が通る
- 画面上で「確認メールを送信しました」相当が表示される
- localStorage に booking_id が保存される
- 画面が confirm 完了扱いにならない

ブラウザ開発者ツールで確認する場合:
- Application > Local Storage に `public-booking:acme:booking_id` がある

合格条件:
- successType が `verification_sent` 相当の表示になる
- 通常フォーム導線が confirm 完了と混同されない

---

### 4-3. confirm link で予約完了

取得元は以下のどちらか:
- 開発用 verify token を画面上で確認
- `scripts/smoke-public.sh` / `scripts/smoke_public_flow_safe.sh` の artifact
- API response / mail mock

ブラウザで開く例:

```text
http://localhost:3000/public/acme?action=confirm&token=<CONFIRM_TOKEN>
```

旧リンク後方互換も確認する場合:

```text
http://localhost:3000/public/acme?token=<CONFIRM_TOKEN>
```

確認項目:
- 「予約を確認しています...」相当が一時表示される
- 最終的に「予約完了」が表示される
- `cancel_url` が表示される
- `reschedule_url` が表示される
- confirm 成功後、localStorage の booking_id が削除される

合格条件:
- action=confirm が `/api/public/acme/confirm` に流れる
- action なし token は legacy fallback として confirm 扱いになる
- confirm 成功で cancel/reschedule link が出る

---

### 4-4. confirm retryable error と再送 UI

確認したい状態:
- token expired / already used などの retryable error

方法:
- 期限切れ token を使う
- 既使用 token を再度開く

期待値:
- fatal ではなく retryable error 相当の表示になる
- `確認メールを再送する` ボタンが出る
- このボタンは confirm 導線のときだけ出る

再送操作:
- `確認メールを再送する` を押す

期待値:
- `/api/public/acme/verify-email` に流れる
- `verification_sent` 相当の表示になる

合格条件:
- confirm 導線でのみ再送 UI が表示される
- cancel / reschedule では再送 UI が出ない

---

### 4-5. cancel link でキャンセル完了

confirm 完了画面に出た `cancel_url` を開く。
例:

```text
http://localhost:3000/public/acme?action=cancel&token=<CANCEL_TOKEN>&booking_id=<BOOKING_ID>
```

確認項目:
- 「予約をキャンセルしています...」相当が表示される
- confirm 処理に流れない
- 最終的に「キャンセル完了」が表示される
- 対象 booking が localStorage に残っていた場合は削除される

必要なら DB 確認:

```bash
cd /home/rai/booking_zoom_connect
DB_NO_SCHEMA="${DATABASE_URL%%\?schema=*}"
psql "$DB_NO_SCHEMA" -c "select id, status from bookings order by created_at desc limit 10;"
```

合格条件:
- cancel link が confirm に誤送されない
- `cancel_success` 相当の完了画面になる

---

### 4-6. reschedule link が confirm に流れない

confirm 完了画面に出た `reschedule_url` を開く。
例:

```text
http://localhost:3000/public/acme?action=reschedule&token=<RESCHEDULE_TOKEN>&booking_id=<BOOKING_ID>&new_start_at=<ISO>&new_end_at=<ISO>
```

確認項目:
- 「日程変更を処理しています...」相当が表示される
- confirm 処理に流れない
- 最終的に「日程変更完了」になる、または不足情報時に retry_required で止まる

合格条件:
- reschedule link が confirm に誤送されない
- reschedule 分岐として処理される

---

### 4-7. reschedule 情報不足時の安全停止

以下のように、`new_start_at` / `new_end_at` を付けずに開く。

```text
http://localhost:3000/public/acme?action=reschedule&token=<RESCHEDULE_TOKEN>&booking_id=<BOOKING_ID>
```

確認項目:
- 処理が confirm に流れない
- 500 にならない
- `retry_required` 相当の表示になる
- TODO 方針どおり、安全側で停止する

合格条件:
- reschedule 情報不足時に API を無理に叩かない、または安全に止まる
- confirm 扱いにならない

---

## 5. 追加の確認コマンド

### localStorage 確認
ブラウザ DevTools を使う。

保存キー:

```text
public-booking:acme:booking_id
```

### 直近 booking 状態確認

```bash
cd /home/rai/booking_zoom_connect
DB_NO_SCHEMA="${DATABASE_URL%%\?schema=*}"
psql "$DB_NO_SCHEMA" -c "
select b.id, b.status, b.start_at_utc, b.end_at_utc, c.email
from bookings b
join customers c on c.id = b.customer_id
order by b.created_at desc
limit 20;
"
```

### tracking_events 確認

```bash
cd /home/rai/booking_zoom_connect
DB_NO_SCHEMA="${DATABASE_URL%%\?schema=*}"
psql "$DB_NO_SCHEMA" -c "
select booking_id, type, occurred_at_utc
from tracking_events
order by occurred_at_utc desc
limit 30;
"
```

---

## 6. 合格条件

以下を満たせば Sprint 3 UI 手動確認は合格。

- build が通る
- Sprint 2 の既存 smoke が通る
- `/public/[tenantSlug]` の通常フォーム導線が動く
- confirm link で予約完了になる
- cancel link でキャンセル完了になる
- reschedule link が confirm に流れない
- reschedule 情報不足時に安全に止まる
- confirm 再送 UI が confirm 導線だけに出る

---

## 7. 今回の範囲外

今回の確認では以下は対象外。

- Graph / Zoom 実接続の本格確認
- multi-mailbox 最適化
- `/[tenantSlug]/book` の整理・削除
- reschedule の fully interactive slot selection UI
- backend の新規機能追加

---

## 8. 補足

今回の build では、非標準 `NODE_ENV` があると Next.js build が不安定化しました。
今後 build 前は以下を推奨します。

```bash
unset NODE_ENV
```

または `development` / `production` / `test` のいずれかのみを使ってください。
