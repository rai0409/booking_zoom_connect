# Booking Zoom Connect

Monorepo for a multi-tenant scheduling MVP on Azure (NestJS + Next.js + Postgres).

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

- API: http://localhost:4000
- Web: http://localhost:3000

## Environment variables

Copy `.env.example` to `.env` and fill values.

Required locally:
- `DATABASE_URL`
- `MS_CLIENT_ID`, `MS_CLIENT_SECRET`
- `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`
- `ADMIN_API_KEY`
- `JWT_SECRET`
- `QUEUE_DRIVER=memory` (default)
- `SERVICEBUS_CONNECTION` and `SERVICEBUS_QUEUE_NAME` when using `QUEUE_DRIVER=servicebus`
- `GRAPH_MOCK=true` and `ZOOM_MOCK=true` for local mocks
- `NEXT_PUBLIC_API_BASE=http://localhost:4000` for the web app

## Seeding

Seed script creates a default tenant and 1–2 salespersons with placeholder Graph IDs.

```bash
pnpm -C apps/api db:seed
```

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

Example CLI snippet:

```bash
az containerapp update \
  --name booking-api \
  --resource-group <rg> \
  --min-replicas 1
```
