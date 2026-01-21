-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_customer_id_fkey";

-- DropForeignKey
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_salesperson_id_fkey";

-- DropForeignKey
ALTER TABLE "bookings" DROP CONSTRAINT "bookings_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "compensation_jobs" DROP CONSTRAINT "compensation_jobs_booking_id_fkey";

-- DropForeignKey
ALTER TABLE "compensation_jobs" DROP CONSTRAINT "compensation_jobs_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "customers" DROP CONSTRAINT "customers_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "graph_events" DROP CONSTRAINT "graph_events_booking_id_fkey";

-- DropForeignKey
ALTER TABLE "graph_subscriptions" DROP CONSTRAINT "graph_subscriptions_salesperson_id_fkey";

-- DropForeignKey
ALTER TABLE "graph_subscriptions" DROP CONSTRAINT "graph_subscriptions_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "holds" DROP CONSTRAINT "holds_booking_id_fkey";

-- DropForeignKey
ALTER TABLE "idempotency_keys" DROP CONSTRAINT "idempotency_keys_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "meetings" DROP CONSTRAINT "meetings_booking_id_fkey";

-- DropForeignKey
ALTER TABLE "salespersons" DROP CONSTRAINT "salespersons_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "tracking_events" DROP CONSTRAINT "tracking_events_booking_id_fkey";

-- DropForeignKey
ALTER TABLE "tracking_events" DROP CONSTRAINT "tracking_events_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "webhook_jobs" DROP CONSTRAINT "webhook_jobs_salesperson_id_fkey";

-- DropForeignKey
ALTER TABLE "webhook_jobs" DROP CONSTRAINT "webhook_jobs_tenant_id_fkey";

-- AlterTable
ALTER TABLE "audit_logs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "bookings" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "compensation_jobs" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "customers" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "graph_subscriptions" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at_utc" DROP DEFAULT;

-- AlterTable
ALTER TABLE "idempotency_keys" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "salespersons" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tenants" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tracking_events" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "webhook_jobs" ALTER COLUMN "id" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "salespersons" ADD CONSTRAINT "salespersons_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_salesperson_id_fkey" FOREIGN KEY ("salesperson_id") REFERENCES "salespersons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "holds" ADD CONSTRAINT "holds_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "graph_events" ADD CONSTRAINT "graph_events_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_events" ADD CONSTRAINT "tracking_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_events" ADD CONSTRAINT "tracking_events_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_jobs" ADD CONSTRAINT "webhook_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_jobs" ADD CONSTRAINT "webhook_jobs_salesperson_id_fkey" FOREIGN KEY ("salesperson_id") REFERENCES "salespersons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "graph_subscriptions" ADD CONSTRAINT "graph_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "graph_subscriptions" ADD CONSTRAINT "graph_subscriptions_salesperson_id_fkey" FOREIGN KEY ("salesperson_id") REFERENCES "salespersons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensation_jobs" ADD CONSTRAINT "compensation_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compensation_jobs" ADD CONSTRAINT "compensation_jobs_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "audit_logs_tenant_target_idx" RENAME TO "audit_logs_tenant_id_target_id_idx";

-- RenameIndex
ALTER INDEX "bookings_tenant_salesperson_idx" RENAME TO "bookings_tenant_id_salesperson_id_idx";

-- RenameIndex
ALTER INDEX "compensation_jobs_tenant_booking_idx" RENAME TO "compensation_jobs_tenant_id_booking_id_idx";

-- RenameIndex
ALTER INDEX "tracking_events_tenant_booking_idx" RENAME TO "tracking_events_tenant_id_booking_id_idx";

-- RenameIndex
ALTER INDEX "webhook_jobs_tenant_salesperson_idx" RENAME TO "webhook_jobs_tenant_id_salesperson_id_idx";
