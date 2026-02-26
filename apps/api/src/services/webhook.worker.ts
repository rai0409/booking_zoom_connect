import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { prisma } from "../prisma";
import { IQueue } from "../queue/queue.interface";
import { WEBHOOK_QUEUE, WebhookQueueItem } from "../queue/webhook.queue";
import { GraphReconciliationService } from "./graph-reconciliation.service";
import { utcNow } from "../utils/time";
import { WebhookJobStatus } from "@prisma/client";
import { DateTime } from "luxon";
import { log } from "../utils/logger";

const MAX_ATTEMPTS = 5;
const STALE_MINUTES = 5;
const ENQUEUE_INTERVAL_MS = 2_000;
const DEQUEUE_IDLE_WAIT_MS = 500;

@Injectable()
export class WebhookWorker implements OnModuleInit, OnModuleDestroy {
  private enqueueTimer: NodeJS.Timeout | null = null;
  private queueTask: Promise<void> | null = null;
  private running = false;

  constructor(
    @Inject(WEBHOOK_QUEUE) private readonly queue: IQueue<WebhookQueueItem>,
    private readonly reconciliation: GraphReconciliationService
  ) {}

  onModuleInit() {
    this.running = true;

    this.enqueueTimer = setInterval(() => {
      this.enqueueDueJobs().catch((err) => {
        log("error", "webhook_enqueue_due_jobs_failed", {
          err: err instanceof Error ? err.message : String(err)
        });
      });
    }, ENQUEUE_INTERVAL_MS);

    void this.enqueueDueJobs().catch((err) => {
      log("error", "webhook_enqueue_due_jobs_failed", {
        err: err instanceof Error ? err.message : String(err)
      });
    });

    if (this.queue.consume) {
      this.queueTask = this.queue.consume(async (item) => {
        await this.processItem(item);
      }).catch((err) => {
        log("error", "webhook_queue_consume_failed", {
          err: err instanceof Error ? err.message : String(err)
        });
      });
      return;
    }

    this.queueTask = this.runDequeueLoop();
  }

  async onModuleDestroy() {
    this.running = false;
    if (this.enqueueTimer) {
      clearInterval(this.enqueueTimer);
      this.enqueueTimer = null;
    }
    if (this.queue.close) {
      await this.queue.close().catch((err) => {
        log("warn", "webhook_queue_close_failed", {
          err: err instanceof Error ? err.message : String(err)
        });
      });
    }
    if (this.queueTask) {
      await this.queueTask.catch(() => {
        // already logged
      });
      this.queueTask = null;
    }
  }

  private async runDequeueLoop() {
    while (this.running) {
      let item: WebhookQueueItem | null = null;
      try {
        item = await this.queue.dequeue();
      } catch (err) {
        log("warn", "webhook_queue_dequeue_failed", {
          err: err instanceof Error ? err.message : String(err)
        });
        await this.sleep(DEQUEUE_IDLE_WAIT_MS);
        continue;
      }

      if (!item) {
        await this.sleep(DEQUEUE_IDLE_WAIT_MS);
        continue;
      }

      try {
        await this.processItem(item);
      } catch (err) {
        log("error", "webhook_process_item_failed", {
          jobId: item.jobId,
          err: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  private async enqueueDueJobs() {
    const now = utcNow();
    const staleBefore = DateTime.fromJSDate(now).minus({ minutes: STALE_MINUTES }).toJSDate();
    const due = await prisma.webhookJob.findMany({
      where: {
        status: WebhookJobStatus.pending,
        attempts: { lt: MAX_ATTEMPTS },
        next_run_at_utc: { lte: now },
        OR: [
          { processing_started_at_utc: null },
          { processing_started_at_utc: { lt: staleBefore } }
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
          where: {
            id: j.id,
            status: WebhookJobStatus.pending,
            OR: [
              { processing_started_at_utc: null },
              { processing_started_at_utc: { lt: staleBefore } }
            ]
          },
          data: { processing_started_at_utc: now }
        });
        if (claimed.count !== 1) return;

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
      if (DateTime.utc() < started.plus({ minutes: STALE_MINUTES })) {
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

  private async sleep(ms: number) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
