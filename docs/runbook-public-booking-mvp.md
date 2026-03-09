# Sprint 2/4 Public Booking Operational Runbook

## 1. Purpose and Scope
This runbook defines Sprint 2 canonical flow acceptance with Sprint 4 contract fix for public cancel/reschedule links in a constrained local environment (single-tenant / single-mailbox assumptions).

In-scope:
- public API flow verification (no UI dependency)
- public action link contract verification (`booking_id` + `token`)
- smoke execution artifacts
- request-id traceability
- DB state verification

Out-of-scope:
- UI acceptance/design
- multi-mailbox optimization
- large architecture refactors

## 2. Acceptance Source of Truth
- Source of truth is current code + tests + smoke scripts + DB evidence.
- UI is **not** the source of truth for Sprint 2 acceptance.
- `docs/booking_mvp_plan.md` is legacy context only.

Primary acceptance flow order:
1. `salespersons`
2. `availability`
3. `hold`
4. `verify-email`
5. `confirm`
6. `cancel` / `reschedule`

`confirm-by-id` is secondary/compatibility behavior, not primary acceptance flow.

## 3. Preconditions
- Repository: `booking_zoom_connect`
- Local Postgres is running from repo root `docker-compose.yml`
- API is running locally (`http://localhost:4000`)
- `.env` is present at repo root with required local values

Recommended preflight:
```bash
cd /home/rai/booking_zoom_connect
docker compose up -d postgres
curl -fsS http://localhost:4000/health
curl -fsS http://localhost:4000/ready
```

## 4. Required Environment Variables
Required for Sprint 2 acceptance:
- `DATABASE_URL`
- `BASE_URL`
- `API_BASE_URL`
- `NEXT_PUBLIC_API_BASE`
- `JWT_SECRET`
- `PUBLIC_RETURN_VERIFY_TOKEN=1` (for local smoke verification)

Local default assumptions used by smoke:
- `GRAPH_ENABLED=0`
- `ZOOM_ENABLED=0`
- `GRAPH_MOCK=true`
- `ZOOM_MOCK=true`

## 5. Seed Assumptions
- Dev tenant slug is `acme`
- Public booking is enabled on `acme`
- Seeded salespersons exist and at least one is active
- `apps/api/prisma/seed.ts` supports `ACTIVE_SEED_COUNT` switching (default `3`)

Example seed execution:
```bash
cd apps/api
pnpm prisma migrate dev --schema prisma/schema.prisma
pnpm prisma generate --schema prisma/schema.prisma
pnpm db:seed
```

## 6. Expected Status Matrix
- `hold` creation: booking status `hold`
- `verify-email`: booking transitions to `pending_verify` (or stays valid through idempotency)
- `confirm` success: booking status `confirmed`, hold row removed
- `cancel` success (before deadline): booking status `canceled`
- `reschedule` success (confirmed only, before deadline): booking stays `confirmed` with updated slot
- expired hold: booking status `expired`, hold row removed

## 7. Sprint 2 Execution Procedure
Main operational smoke:
```bash
bash scripts/smoke_public_flow_safe.sh
```

Minimal happy-path smoke:
```bash
bash scripts/smoke-public.sh
```

Both scripts are API-only and do not require UI interaction.
Both scripts verify public confirm response links and enforce this contract:
- `cancel_url = /public/:tenantSlug?action=cancel&booking_id=...&token=...`
- `reschedule_url = /public/:tenantSlug?action=reschedule&booking_id=...&token=...`

## 8. x-request-id Tracing Procedure
1. For each write request, capture response headers and extract `x-request-id`.
2. Keep per-step artifacts (`.hdr`, `.json`, `.code`) from smoke output.
3. Correlate with API logs by request id.

Manual example:
```bash
curl -sS -D /tmp/hold.hdr -o /tmp/hold.json \
  -X POST "http://localhost:4000/v1/public/acme/holds" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-hold-1' \
  --data-binary @/tmp/hold_payload.json

rg -n '^x-request-id:' /tmp/hold.hdr
```

## 9. DB Verification Procedure
Use:
- `docs/sql/public-booking-sprint2-check.sql`

Recommended invocation:
```bash
set -a; source .env; set +a
psql "${DATABASE_URL%%\?schema=*}" -f docs/sql/public-booking-sprint2-check.sql
```

For booking-focused checks:
```bash
psql "${DATABASE_URL%%\?schema=*}" -v booking_id='<BOOKING_UUID>' -f docs/sql/public-booking-sprint2-check.sql
psql "${DATABASE_URL%%\?schema=*}" -v customer_email='user@example.com' -f docs/sql/public-booking-sprint2-check.sql
```

## 10. Cancel / Reschedule Checks
Cancel checks:
- token purpose is `cancel`
- booking currently `confirmed`
- cancel deadline not passed
- `booking_id` is carried in `cancel_url` query and matches booking id
- result status is `canceled`

Reschedule checks:
- token purpose is `reschedule`
- booking currently `confirmed`
- reschedule deadline not passed
- `booking_id` is carried in `reschedule_url` query and matches booking id
- `new_start_at` / `new_end_at` are request body fields (not URL query)
- new slot is accepted (409 conflicts may require retry)
- result contains updated slot fields

## 10.1 Public UI Safe-stop Checks (Sprint 4)
For `/public/:tenantSlug` token-action page:
- missing `booking_id` in `action=cancel` / `action=reschedule` must stop as invalid link
- invalid/expired token must stop with error state (no fallback to confirm)
- `action=reschedule` must select new slot in UI and send `new_start_at/new_end_at` in request body
- client-side token decode is prohibited

## 11. Hold Expiry Checks
To verify expiry behavior:
1. Create hold
2. Force hold expiry in DB (local test env only)
3. Run expiry worker path (`expireHolds`) or wait scheduled execution
4. Confirm booking is `expired` and hold row is removed

## 12. Failure-case Checklist
When flow fails, collect in this order:
1. `x-request-id` from response headers
2. request/response artifact files for failed step
3. relevant API log lines for the same request id
4. DB evidence from SQL doc queries

Typical failure classes to label:
- validation failure (400)
- token failure (401/403)
- state/deadline conflict (409)
- slot conflict (409)
- idempotency replay behavior

## 13. Artifacts / Evidence to Keep
Keep one timestamped artifact directory per run containing:
- per-step response headers (`*.hdr`)
- per-step response bodies (`*.res` / `*.json`)
- per-step status codes (`*.code`)
- extracted request-id summary
- final operator summary (booking ids + terminal states)

Acceptance is based on these artifacts + DB/log traceability, not UI screenshots.
