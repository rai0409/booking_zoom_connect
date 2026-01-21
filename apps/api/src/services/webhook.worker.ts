import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { prisma } from "../prisma";
import { IQueue } from "../queue/queue.interface";
import { WEBHOOK_QUEUE, WebhookQueueItem } from "../queue/webhook.queue";
import { GraphReconciliationService } from "./graph-reconciliation.service";
import { utcNow } from "../utils/time";
import { WebhookJobStatus } from "@prisma/client";

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
      let item = await this.queue.dequeue();
      while (item) {
        await this.processItem(item);
        item = await this.queue.dequeue();
      }
    } finally {
      this.running = false;
    }
  }

  private async processItem(item: WebhookQueueItem) {
    const job = await prisma.webhookJob.findUnique({ where: { id: item.jobId } });
    if (!job) return;
    if (job.status === WebhookJobStatus.done || job.status === WebhookJobStatus.failed) {
      return;
    }

    const attempts = job.attempts + 1;

    await prisma.webhookJob.update({
      where: { id: job.id },
      data: {
        status: WebhookJobStatus.processing,
        attempts,
        last_error: null
      }
    });

    await this.auditJobStatus(job.tenant_id, job.id, "processing");

    try {
      await this.reconciliation.handleWebhookJob(job);

      await prisma.webhookJob.update({
        where: { id: job.id },
        data: { status: WebhookJobStatus.done }
      });

      await this.auditJobStatus(job.tenant_id, job.id, "done");
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      if (attempts >= MAX_ATTEMPTS) {
        await prisma.webhookJob.update({
          where: { id: job.id },
          data: { status: WebhookJobStatus.failed, last_error: errorMessage }
        });
        await this.auditJobStatus(job.tenant_id, job.id, "failed", errorMessage);
        return;
      }

      await prisma.webhookJob.update({
        where: { id: job.id },
        data: { status: WebhookJobStatus.pending, last_error: errorMessage }
      });

      await this.auditJobStatus(job.tenant_id, job.id, "pending", errorMessage);

      const delayMs = Math.min(60_000, 1000 * 2 ** (attempts - 1));
      setTimeout(() => {
        this.queue.enqueue({ jobId: job.id }).catch(() => {
          // ignore enqueue errors
        });
      }, delayMs);
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
