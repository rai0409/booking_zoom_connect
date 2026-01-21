-- Initial schema
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE TYPE "TenantStatus" AS ENUM ('pending', 'active', 'disabled');
CREATE TYPE "BookingStatus" AS ENUM ('hold', 'pending_verify', 'confirmed', 'canceled', 'expired');
CREATE TYPE "MeetingProvider" AS ENUM ('zoom', 'teams');
CREATE TYPE "WebhookJobStatus" AS ENUM ('queued', 'processing', 'completed', 'failed', 'dead');

CREATE TABLE "tenants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "m365_tenant_id" text,
  "status" "TenantStatus" NOT NULL DEFAULT 'pending',
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "salespersons" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "graph_user_id" text NOT NULL,
  "display_name" text NOT NULL,
  "timezone" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "customers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text,
  "email" text NOT NULL,
  "company" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("tenant_id", "email")
);

CREATE TABLE "bookings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "salesperson_id" uuid NOT NULL REFERENCES "salespersons"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "start_at_utc" timestamptz NOT NULL,
  "end_at_utc" timestamptz NOT NULL,
  "status" "BookingStatus" NOT NULL,
  "idempotency_key" text NOT NULL,
  "verify_token_jti" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("tenant_id", "idempotency_key")
);

CREATE TABLE "holds" (
  "booking_id" uuid PRIMARY KEY REFERENCES "bookings"("id") ON DELETE CASCADE,
  "expires_at_utc" timestamptz NOT NULL
);

CREATE TABLE "meetings" (
  "booking_id" uuid PRIMARY KEY REFERENCES "bookings"("id") ON DELETE CASCADE,
  "provider" "MeetingProvider" NOT NULL,
  "provider_meeting_id" text NOT NULL,
  "join_url" text NOT NULL,
  "start_url" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "graph_events" (
  "booking_id" uuid PRIMARY KEY REFERENCES "bookings"("id") ON DELETE CASCADE,
  "organizer_user_id" text NOT NULL,
  "event_id" text NOT NULL,
  "iCalUId" text NOT NULL,
  "etag" text NOT NULL,
  "updated_at" timestamptz NOT NULL,
  UNIQUE ("event_id")
);

CREATE TABLE "tracking_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "booking_id" uuid NOT NULL REFERENCES "bookings"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "occurred_at_utc" timestamptz NOT NULL,
  "meta_json" jsonb
);

CREATE TABLE "audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "actor_type" text NOT NULL,
  "actor_id" text NOT NULL,
  "action" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text NOT NULL,
  "meta_json" jsonb,
  "created_at_utc" timestamptz NOT NULL
);

CREATE TABLE "webhook_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "salesperson_id" uuid NOT NULL REFERENCES "salespersons"("id") ON DELETE CASCADE,
  "subscription_id" text NOT NULL,
  "change_type" text NOT NULL,
  "resource_id" text NOT NULL,
  "received_at_utc" timestamptz NOT NULL,
  "status" "WebhookJobStatus" NOT NULL DEFAULT 'queued',
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "created_at_utc" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "graph_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "salesperson_id" uuid NOT NULL REFERENCES "salespersons"("id") ON DELETE CASCADE,
  "subscription_id" text NOT NULL,
  "resource" text NOT NULL,
  "expiration_utc" timestamptz NOT NULL,
  "created_at_utc" timestamptz NOT NULL DEFAULT now(),
  "updated_at_utc" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("tenant_id", "salesperson_id"),
  UNIQUE ("subscription_id")
);

CREATE TABLE "idempotency_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "scope" text NOT NULL,
  "key" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("tenant_id", "scope", "key")
);

CREATE TABLE "compensation_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "booking_id" uuid NOT NULL REFERENCES "bookings"("id") ON DELETE CASCADE,
  "status" text NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "bookings_active_slot_unique"
  ON "bookings" ("tenant_id", "salesperson_id", "start_at_utc", "end_at_utc")
  WHERE "status" IN ('hold', 'pending_verify', 'confirmed');

CREATE INDEX "bookings_tenant_salesperson_idx" ON "bookings" ("tenant_id", "salesperson_id");
CREATE INDEX "tracking_events_tenant_booking_idx" ON "tracking_events" ("tenant_id", "booking_id");
CREATE INDEX "audit_logs_tenant_target_idx" ON "audit_logs" ("tenant_id", "target_id");
CREATE INDEX "webhook_jobs_tenant_salesperson_idx" ON "webhook_jobs" ("tenant_id", "salesperson_id");
CREATE INDEX "compensation_jobs_tenant_booking_idx" ON "compensation_jobs" ("tenant_id", "booking_id");
