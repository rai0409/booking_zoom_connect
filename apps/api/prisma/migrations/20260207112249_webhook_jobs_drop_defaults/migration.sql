-- AlterTable
ALTER TABLE "graph_subscriptions" ALTER COLUMN "updated_at_utc" DROP DEFAULT;

-- AlterTable
ALTER TABLE "webhook_jobs" ALTER COLUMN "payload" SET DEFAULT '{}'::jsonb,
ALTER COLUMN "updated_at_utc" DROP DEFAULT;
