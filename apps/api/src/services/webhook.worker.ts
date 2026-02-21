import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { prisma } from "../prisma";
import { IQueue } from "../queue/queue.interface";
import { WEBHOOK_QUEUE, WebhookQueueItem } from "../queue/webhook.queue";
import { GraphReconciliationService } from "./graph-reconciliation.service";
import { utcNow } from "../utils/time";
import { WebhookJobStatus } from "@prisma/client";
import { DateTime } from "luxon";

const MAX_ATTEMPTS = 5;

@Injectable()
export class WebhookWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(WEBHOOK_QUEUE) private readonly queue: IQueue<WebhookQueueItem>,
    private readonly reconciliation: GraphReconciliationService
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      this.tick().catch(() => {
        // ignore worker errors
      });
    }, 2_000);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async tick() {
    if (this.running) return;
    this.running = true;

    try {
      // Ensure durable retries: enqueue due pending jobs from DB.
      await this.enqueueDueJobs();

      let item = await this.queue.dequeue();
      while (item) {
        await this.processItem(item);
        item = await this.queue.dequeue();
      }
    } finally {
      this.running = false;
    }
  }

  private async enqueueDueJobs() {
    const now = utcNow();
    const due = await prisma.webhookJob.findMany({
      where: {
        status: WebhookJobStatus.pending,
        attempts: { lt: MAX_ATTEMPTS },
        next_run_at_utc: { lte: now },
        OR: [
          { processing_started_at_utc: null },
          { processing_started_at_utc: { lt: DateTime.fromJSDate(now).minus({ minutes: 5 }).toJSDate() } }
        ]
      },
      orderBy: { next_run_at_utc: "asc" },
      take: 25,
      select: { id: true }
    });

    await Promise.all(
      due.map(async (j) => {
        // claim for enqueue to prevent tight-loop duplicate enqueue
        const claimed = await prisma.webhookJob.updateMany({
          where: { id: j.id, status: WebhookJobStatus.pending, processing_started_at_utc: null },
          data: { processing_started_at_utc: now }
        });
        if (claimed.count === 0) return;

        try {
          await this.queue.enqueue({ jobId: j.id });
        } catch {
          // release claim if enqueue fails
          await prisma.webhookJob.update({
            where: { id: j.id },
            data: { processing_started_at_utc: null }
          }).catch(() => {});
        }
      })
    );
  }

  private async processItem(item: WebhookQueueItem) {
    const job = await prisma.webhookJob.findUnique({ where: { id: item.jobId } });
    if (!job) return;

    if (job.status === WebhookJobStatus.done || job.status === WebhookJobStatus.failed) {
      return;
    }

    // Respect next_run_at_utc
    if (job.next_run_at_utc && job.next_run_at_utc > utcNow()) {
      // release claim
      await prisma.webhookJob.update({
        where: { id: job.id },
        data: { processing_started_at_utc: null }
      }).catch(() => {});
      return;
    }

    // If another worker is already processing and it's not stale, skip
    if (job.status === WebhookJobStatus.processing && job.processing_started_at_utc) {
      const started = DateTime.fromJSDate(job.processing_started_at_utc);
      if (DateTime.utc() < started.plus({ minutes: 5 })) {
        return;
      }
    }

    const attempts = job.attempts + 1;

    await prisma.webhookJob.update({
      where: { id: job.id },
      data: {
        status: WebhookJobStatus.processing,
        attempts,
        last_error: null,
        processing_started_at_utc: utcNow()
      }
    });

    await this.auditJobStatus(job.tenant_id, job.id, "processing");

    try {
      await this.reconciliation.handleWebhookJob(job);

      await prisma.webhookJob.update({
        where: { id: job.id },
        data: { status: WebhookJobStatus.done, processing_started_at_utc: null }
      });

      await this.auditJobStatus(job.tenant_id, job.id, "done");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      if (attempts >= MAX_ATTEMPTS) {
        await prisma.webhookJob.update({
          where: { id: job.id },
          data: { status: WebhookJobStatus.failed, last_error: errorMessage, processing_started_at_utc: null }
        });
        await this.auditJobStatus(job.tenant_id, job.id, "failed", errorMessage);
        return;
      }

      const delayMs = Math.min(60_000, 1000 * 2 ** (attempts - 1));
      await prisma.webhookJob.update({
        where: { id: job.id },
        data: {
          status: WebhookJobStatus.pending,
          last_error: errorMessage,
          next_run_at_utc: DateTime.fromJSDate(utcNow()).plus({ milliseconds: delayMs }).toJSDate(),
          processing_started_at_utc: null
        }
      });

      await this.auditJobStatus(job.tenant_id, job.id, "pending", errorMessage);
    }
  }

  private async auditJobStatus(tenantId: string, jobId: string, status: string, error?: string) {
    await prisma.auditLog.create({
      data: {
        tenant_id: tenantId,
        actor_type: "system",
        actor_id: "webhook-worker",
        action: "webhook_job_status",
        target_type: "webhook_job",
        target_id: jobId,
        meta_json: { status, error },
        created_at_utc: utcNow()
      }
    });
  }
}
