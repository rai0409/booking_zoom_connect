/*
  Warnings:

  - A unique constraint covering the columns `[dedupe_key]` on the table `webhook_jobs` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "graph_subscriptions" ADD COLUMN     "client_state" TEXT;

-- AlterTable
ALTER TABLE "webhook_jobs" ADD COLUMN     "dedupe_key" TEXT,
ADD COLUMN     "next_run_at_utc" TIMESTAMPTZ(6),
ADD COLUMN     "processing_started_at_utc" TIMESTAMPTZ(6),
ADD COLUMN     "raw_notification" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "webhook_jobs_dedupe_key_key" ON "webhook_jobs"("dedupe_key");

-- CreateIndex
CREATE INDEX "webhook_jobs_status_next_run_at_utc_idx" ON "webhook_jobs"("status", "next_run_at_utc");
