import { Injectable } from "@nestjs/common";
import { prisma } from "../prisma";
import { GraphClient } from "../clients/graph.client";
import { utcNow, parseIsoToUtc } from "../utils/time";
import { BookingStatus, WebhookJob } from "@prisma/client";

@Injectable()
export class GraphReconciliationService {
  private graph = new GraphClient();

  async handleWebhookJob(job: WebhookJob) {
    const booking = await prisma.booking.findFirst({
      where: { graph_event: { event_id: job.resource_id } },
      include: { graph_event: true }
    });

    if (!booking) {
      return;
    }

    if (job.change_type === "deleted") {
      await prisma.$transaction(async (tx) => {
        await tx.booking.update({
          where: { id: booking.id },
          data: {
            status: BookingStatus.canceled,
            customer_notify_required: true
          }
        });

        await tx.trackingEvent.create({
          data: {
            tenant_id: booking.tenant_id,
            booking_id: booking.id,
            type: "event_deleted_by_sales",
            occurred_at_utc: utcNow(),
            meta_json: { source: "sales_manual", resource_id: job.resource_id }
          }
        });

        await tx.auditLog.create({
          data: {
            tenant_id: booking.tenant_id,
            actor_type: "system",
            actor_id: "webhook-worker",
            action: "booking_canceled_by_webhook",
            target_type: "booking",
            target_id: booking.id,
            meta_json: { job_id: job.id, source: "sales_manual" },
            created_at_utc: utcNow()
          }
        });
      });

      return;
    }

    if (job.change_type === "updated") {
      const event = await this.graph.getEvent(job.resource_id);
      const newStart = parseIsoToUtc(event.startUtc);
      const newEnd = parseIsoToUtc(event.endUtc);

      await prisma.$transaction(async (tx) => {
        await tx.booking.update({
          where: { id: booking.id },
          data: {
            start_at_utc: newStart,
            end_at_utc: newEnd,
            customer_reinvite_required: true
          }
        });

        await tx.trackingEvent.create({
          data: {
            tenant_id: booking.tenant_id,
            booking_id: booking.id,
            type: "event_moved_by_sales",
            occurred_at_utc: utcNow(),
            meta_json: { resource_id: job.resource_id }
          }
        });

        await tx.auditLog.create({
          data: {
            tenant_id: booking.tenant_id,
            actor_type: "system",
            actor_id: "webhook-worker",
            action: "booking_moved_by_webhook",
            target_type: "booking",
            target_id: booking.id,
            meta_json: { job_id: job.id },
            created_at_utc: utcNow()
          }
        });
      });
    }
  }
}
