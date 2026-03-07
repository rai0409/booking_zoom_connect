# Sprint 1 Local DB Runbook (booking_zoom_connect)

## 1. 目的
Sprint 1 のローカル再現（Postgres 起動、Prisma migrate/generate/seed、API 起動確認）を安定して実行する。
本書はローカル手順のみを扱い、本番運用手順は含めない。

## 2. 前提ファイル（repo 内根拠）
- `docker-compose.yml`
  - `postgres` サービス（`postgres:16`）
  - `POSTGRES_USER=booking`
  - `POSTGRES_PASSWORD=booking`
  - `POSTGRES_DB=booking`
  - `5432:5432`
  - `pgdata:/var/lib/postgresql/data`
- `.env`（repo 直下）
  - `DATABASE_URL=postgresql://booking:booking@localhost:5432/booking?schema=public`
- `apps/api/package.json`
  - `db:migrate`: `prisma migrate dev --schema prisma/schema.prisma`
  - `db:seed`: `prisma db seed --schema prisma/schema.prisma`
  - `prisma.seed`: `tsx prisma/seed.ts`
- `README.md`
  - ローカル起動で `docker compose up -d` と migrate/seed の流れが記載されている

## 3. 確定していること
- Postgres は repo ルートの `docker-compose.yml` で起動する。
- Prisma migrate は `apps/api` から実行する。
- seed は `apps/api/package.json` の `db:seed`（内部で `prisma db seed --schema prisma/schema.prisma`）が根拠付きの実行方法。
- seed 実体は `tsx prisma/seed.ts`。

## 4. 未確定なこと
- `.env` の読み込み元は実行コンテキストに依存する。
  - `.env` は repo 直下にあるが、`apps/api` から実行する Prisma コマンド時に環境変数が未注入だと `DATABASE_URL not set` が起きる可能性がある。
  - そのため本 runbook ではコマンド実行前に `DATABASE_URL` を明示確認する。

## 5. 成功フロー（再現手順）

### Step 0: repo ルートへ移動
```bash
cd /home/rai/booking_zoom_connect
```

### Step 1: Postgres 起動
```bash
docker compose up -d postgres
```

### Step 2: DATABASE_URL 確認
```bash
# repo 直下 .env の確認
rg '^DATABASE_URL=' .env

# 現在シェルの環境変数として有効化（必要時）
set -a
source .env
set +a

echo "$DATABASE_URL"
```

### Step 3: migration 適用前の重複確認（重要）
```sql
select tenant_id, graph_user_id, count(*)
from salespersons
group by tenant_id, graph_user_id
having count(*) > 1;
```

例: 実行コマンド
```bash
psql "${DATABASE_URL%%\?schema=*}" -c "select tenant_id, graph_user_id, count(*) from salespersons group by tenant_id, graph_user_id having count(*) > 1;"
```

### Step 4: Prisma migrate（apps/api から）
```bash
cd apps/api
pnpm prisma migrate dev --schema prisma/schema.prisma
```

### Step 5: Prisma generate（apps/api から）
```bash
pnpm prisma generate --schema prisma/schema.prisma
```

### Step 6: seed（apps/api から）
```bash
pnpm db:seed
```

## 6. API 起動確認

### Step 7: API 起動
```bash
pnpm dev
```

### Step 8: 成功確認ポイント
別ターミナルで:
```bash
curl -i http://localhost:4000/health
curl -i "http://localhost:4000/v1/public/acme/availability?date=2026-03-07"
```

期待値:
- `health` が `200` を返す
- `availability` が `400` にならず（date 形式が正しければ）レスポンスが返る
- seed 後に `acme` tenant が存在し、`public_booking_enabled=true`, `public_timezone=Asia/Tokyo`

確認 SQL（任意）:
```bash
psql "${DATABASE_URL%%\?schema=*}" -c "select slug, public_booking_enabled, public_timezone from tenants where slug='acme';"
psql "${DATABASE_URL%%\?schema=*}" -c "select tenant_id, graph_user_id, active from salespersons order by graph_user_id;"
```
