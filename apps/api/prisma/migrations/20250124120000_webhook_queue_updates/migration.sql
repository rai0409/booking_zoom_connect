-- Add booking flags for webhook reconciliation
ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "customer_reinvite_required" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "customer_notify_required" BOOLEAN NOT NULL DEFAULT false;

-- Update webhook job status enum
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'WebhookJobStatus') THEN
    -- FIX: enum 型変更前に status の DEFAULT を必ず落とす（42804 対策）
    ALTER TABLE "webhook_jobs"
      ALTER COLUMN "status" DROP DEFAULT;
    ALTER TYPE "WebhookJobStatus" RENAME TO "WebhookJobStatus_old";
    CREATE TYPE "WebhookJobStatus" AS ENUM ('pending', 'processing', 'done', 'failed');
    ALTER TABLE "webhook_jobs"
      ALTER COLUMN "status" TYPE "WebhookJobStatus"
      USING (CASE
        WHEN "status"::text = 'queued' THEN 'pending'
        WHEN "status"::text = 'completed' THEN 'done'
        WHEN "status"::text = 'dead' THEN 'failed'
        ELSE "status"::text
      END)::"WebhookJobStatus";
    ALTER TABLE "webhook_jobs"
      ALTER COLUMN "status" SET DEFAULT 'pending'::"WebhookJobStatus";
    DROP TYPE "WebhookJobStatus_old";
  ELSE
    -- init 側に enum が無いケースでも動くように保険
    CREATE TYPE "WebhookJobStatus" AS ENUM ('pending', 'processing', 'done', 'failed');
    ALTER TABLE "webhook_jobs"
      ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "webhook_jobs"
      ALTER COLUMN "status" TYPE "WebhookJobStatus"
      USING (CASE
        WHEN "status"::text = 'queued' THEN 'pending'
        WHEN "status"::text = 'completed' THEN 'done'
        WHEN "status"::text = 'dead' THEN 'failed'
        ELSE "status"::text
      END)::"WebhookJobStatus";
    ALTER TABLE "webhook_jobs"
      ALTER COLUMN "status" SET DEFAULT 'pending'::"WebhookJobStatus";
  END IF;
END$$;

ALTER TABLE "webhook_jobs"
  ADD COLUMN IF NOT EXISTS "notification_id" TEXT,
  ADD COLUMN IF NOT EXISTS "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "updated_at_utc" TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE "webhook_jobs"
  ALTER COLUMN "status" SET DEFAULT 'pending'::"WebhookJobStatus";

CREATE UNIQUE INDEX IF NOT EXISTS "webhook_jobs_notification_id_key" ON "webhook_jobs"("notification_id");
