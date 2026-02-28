# Booking Zoom Connect

Monorepo for a multi-tenant scheduling MVP (NestJS + Next.js + Postgres).

Local defaults:
- API: http://localhost:4000
- Web: http://localhost:3000

## Local run

1) Start database

```bash
docker compose up -d
```

2) Install dependencies

```bash
pnpm -w install
```

3) Create schema and seed

```bash
pnpm -w db:migrate
pnpm -w db:seed
```

4) Run apps

```bash
pnpm -w dev
```

If you run apps separately (example):

```bash
# API
pnpm -C apps/api dev

# Web
pnpm -C apps/web dev
```

## Environment variables

Copy `.env.example` to `.env` and fill values.

```bash
cp .env.example .env
```
### Required for local core (DB + public booking flow)

- `DATABASE_URL`
- `JWT_SECRET`
- `ADMIN_API_KEY`
- `BASE_URL=http://localhost:3000` (token issuer / links)
- `NEXT_PUBLIC_API_BASE=http://localhost:4000` (web app -> API)

### Optional (integrations)

Microsoft Graph / Zoom are only required when you actually enable those paths.

- Graph (if enabled):
  - `MS_CLIENT_ID`, `MS_CLIENT_SECRET` (and tenant/app settings)
  - Local mock: `GRAPH_MOCK=true`
- Zoom (if enabled):
  - `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`
  - Local mock: `ZOOM_MOCK=true`

Queue:
- `QUEUE_DRIVER=memory` (default)
- `SERVICEBUS_CONNECTION` and `SERVICEBUS_QUEUE_NAME` when using `QUEUE_DRIVER=servicebus`

## Seeding

Seed script creates a default tenant and 1–2 salespersons.

```bash
pnpm -C apps/api db:seed
```

## Public booking API (core endpoints)

- `GET /v1/public/:tenantSlug/availability?date=YYYY-MM-DD`
- `POST /v1/public/:tenantSlug/holds`
- `POST /v1/public/:tenantSlug/auth/verify-email`
- `POST /v1/public/:tenantSlug/confirm`
- `POST /v1/public/:tenantSlug/bookings/:bookingId/cancel`
- `POST /v1/public/:tenantSlug/bookings/:bookingId/reschedule`

## Internal admin API (for debugging/ops)

All internal endpoints require:

- Header: `x-admin-api-key: ${ADMIN_API_KEY}`

Endpoints:
- `GET /v1/internal/:tenantSlug/bookings?from&to&limit`
- `GET /v1/internal/:tenantSlug/bookings/:bookingId/links`
  Regenerates cancel/reschedule links for an already confirmed booking (useful when tokens are lost).

## Smoke test (public flow)

This script runs:
- create booking1 -> confirm -> regenerate links -> cancel
- create booking2 -> confirm -> regenerate links -> reschedule

Run:

```bash
sed -i 's/\r$//' scripts/smoke_public_flow_safe.sh
chmod +x scripts/smoke_public_flow_safe.sh
bash scripts/smoke_public_flow_safe.sh
```

Env (optional overrides):
- `TENANT_SLUG` (default: `acme`)
- `API_BASE` (default: `http://localhost:4000`)
- `ENV_FILE` (default: repo root `./.env`)

Expected output:
- `booking1(canceled)=...`
- `booking2(rescheduled)=...`

## Booking state machine

| State | Allowed transitions |
| --- | --- |
| hold | pending_verify, expired |
| pending_verify | confirmed, expired |
| confirmed | canceled, hold (reschedule) |
| canceled | — |
| expired | — |

## Entra ID (multi-tenant)

- Admin consent flow starts at `GET /v1/tenants/connect`
- Entra redirects to `GET /v1/tenants/callback`
- Required Microsoft Graph permissions (high-level): `Calendars.ReadWrite`, `MailboxSettings.Read`, `User.Read`, `offline_access`

## Zoom (Server-to-Server OAuth)

- Create a Zoom Server-to-Server OAuth app
- Store `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` as env vars
- The API uses these credentials to create and delete meetings

## Azure Container Apps (outline)

1) Build and push image
2) Create Container App with env vars
3) Set min replicas to 1 for webhook responsiveness

Example:

```bash
az containerapp update \
  --name booking-api \
  --resource-group <rg> \
  --min-replicas 1
```
