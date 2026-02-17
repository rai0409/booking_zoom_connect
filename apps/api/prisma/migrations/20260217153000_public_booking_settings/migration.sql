-- Public booking settings: enforceable tenant boundary for /v1/public

ALTER TABLE "tenants" ADD COLUMN "public_booking_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "public_timezone" TEXT NOT NULL DEFAULT 'Asia/Tokyo';
ALTER TABLE "tenants" ADD COLUMN "public_business_hours" JSONB;

-- Dev convenience: keep existing smoke tenant working.
-- (If your dev tenant slug differs, change 'acme' accordingly.)
UPDATE "tenants" SET "public_booking_enabled" = true WHERE "slug" = 'acme';
