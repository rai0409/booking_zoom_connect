ALTER TABLE "tenants"
  ADD COLUMN "public_location_text" TEXT,
  ADD COLUMN "rr_cursor" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "bookings"
  ADD COLUMN "public_notes" TEXT,
  ADD COLUMN "booking_mode" TEXT;
