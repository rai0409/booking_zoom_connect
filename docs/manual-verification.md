# Manual verification

This project was manually verified in a real local environment using the public booking UI, API endpoints, and PostgreSQL.

## Environment used
- Web: `http://localhost:3000`
- API: `http://localhost:4000`
- Public route tested: `/public/acme`
- External access route tested via ngrok

## Service availability
The application services were confirmed to be up and reachable.

- `GET /health` returned `200 OK`
- `GET /ready` returned `200 OK`

The readiness response also confirmed:
- database connectivity
- required tables present
- required columns present
- required environment variables loaded

## Public booking page
The public booking page for tenant `acme` rendered successfully.

Verified route:
- `GET /public/acme` -> `200 OK`

## Availability checks
The public availability endpoint was queried successfully for multiple dates.

Verified requests:
- `GET /v1/public/acme/availability?date=2026-04-17` -> `200 OK`
- `GET /v1/public/acme/availability?date=2026-04-29` -> `200 OK`

For both dates, the endpoint returned nine one-hour slots:
- 09:00-10:00 JST
- 10:00-11:00 JST
- 11:00-12:00 JST
- 12:00-13:00 JST
- 13:00-14:00 JST
- 14:00-15:00 JST
- 15:00-16:00 JST
- 16:00-17:00 JST
- 17:00-18:00 JST

## End-to-end booking flow
The UI-driven booking flow was exercised successfully through the public interface.

Observed successful responses:
- `POST /api/public/acme/holds` -> `201`
- `POST /api/public/acme/verify-email` -> `201`
- `POST /api/public/acme/confirm` -> `201`
- `GET /public/acme/confirm?...` -> `200`

This confirms that the public flow reached:
- slot selection
- hold creation
- verify-email step
- confirm step

## Database verification
A persisted confirmed booking row was verified directly in PostgreSQL.

Confirmed row:
- tenant: `acme`
- booking id: `ff68ad08-68ff-42f4-b899-7073a02a4669`
- start_at_utc: `2026-04-17 06:00:00+00`
- end_at_utc: `2026-04-17 07:00:00+00`
- status: `confirmed`

This corresponds to:
- `2026-04-17 15:00-16:00 JST`

## Schema verification
The running schema was also inspected directly.

Confirmed `bookings` columns include:
- `id`
- `tenant_id`
- `salesperson_id`
- `customer_id`
- `start_at_utc`
- `end_at_utc`
- `status`
- `idempotency_key`
- `verify_token_jti`

Confirmed `holds` columns include:
- `booking_id`
- `expires_at_utc`

This supports the observed implementation model:
- booking state is stored in `bookings`
- hold expiration is tracked via `holds`

## Scope of verification
The following were verified directly:
- public page rendering
- health/readiness responses
- availability responses for multiple dates
- successful hold / verify / confirm API flow
- persisted confirmed booking row in PostgreSQL

The following should be treated as not yet fully proven in this verification note:
- exclusion of the confirmed slot from subsequent availability responses
- broader multi-user concurrency behavior
- production deployment behavior outside the local/ngrok environment

## Raw evidence collected
The following evidence was captured during verification:
- `GET /health` response: `200 OK`
- `GET /ready` response: `200 OK`
- successful availability responses for `2026-04-17` and `2026-04-29`
- application logs showing:
  - `POST /api/public/acme/holds 201`
  - `POST /api/public/acme/verify-email 201`
  - `POST /api/public/acme/confirm 201`
  - `GET /public/acme/confirm?... 200`
- PostgreSQL query result confirming a persisted `confirmed` booking row
