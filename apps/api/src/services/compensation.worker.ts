import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { ZoomClient } from "../clients/zoom.client";
import { prisma } from "../prisma";
import { log } from "../utils/logger";

const MAX_BATCH_SIZE = 20;
const MAX_ATTEMPTS = 10;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

@Injectable()
export class CompensationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly zoom = new ZoomClient();
  private running = false;

  onModuleInit() {
    if (process.env.COMPENSATION_WORKER_ENABLED === "0") {
      log("info", "compensation_worker_disabled", {});
    }
  }

  onModuleDestroy() {
    this.running = false;
  }

  @Interval(10_000)
  async tick() {
    if (process.env.COMPENSATION_WORKER_ENABLED === "0") return;
    if (this.running) return;

    this.running = true;
    try {
      const now = new Date();
      const jobs = await prisma.$queryRaw<Array<{ id: string; reason: string; payload: Prisma.JsonValue | null }>>`
        SELECT "id", "reason", "payload"
        FROM "compensation_jobs"
        WHERE "status" = 'pending'
          AND ("next_run_at" IS NULL OR "next_run_at" <= ${now})
        ORDER BY "created_at" ASC
        LIMIT ${MAX_BATCH_SIZE}
      `;

      for (const job of jobs) {
        await this.processJob(job);
      }
    } catch (e) {
      log("warn", "compensation_worker_tick_failed", {
        err: e instanceof Error ? e.message : String(e)
      });
    } finally {
      this.running = false;
    }
  }

  private async processJob(job: { id: string; reason: string; payload: Prisma.JsonValue | null }) {
    const claimed = await prisma.$executeRaw`
      UPDATE "compensation_jobs"
      SET "status" = 'processing',
          "updated_at" = NOW()
      WHERE "id" = ${job.id}::uuid
        AND "status" = 'pending'
    `;
    if (claimed !== 1) return;

    try {
      if (job.reason === "graph_failed_after_zoom") {
        const meetingId = this.readZoomMeetingId(job.payload);
        await this.zoom.deleteMeeting(meetingId);
        await prisma.$executeRaw`
          UPDATE "compensation_jobs"
          SET "status" = 'done',
              "last_error" = NULL,
              "next_run_at" = NULL,
              "updated_at" = NOW()
          WHERE "id" = ${job.id}::uuid
            AND "status" = 'processing'
        `;
        return;
      }

      throw new Error(`unsupported compensation reason: ${job.reason}`);
    } catch (e) {
      await this.retryOrFail(job.id, e);
    }
  }

  private readZoomMeetingId(payload: Prisma.JsonValue | null): string {
    if (!payload || Array.isArray(payload) || typeof payload !== "object") {
      throw new Error("compensation payload missing zoom_meeting_id");
    }

    const meetingId = (payload as Record<string, unknown>).zoom_meeting_id;
    if (typeof meetingId !== "string" || meetingId.trim() === "") {
      throw new Error("compensation payload missing zoom_meeting_id");
    }

    return meetingId;
  }

  private async retryOrFail(jobId: string, error: unknown) {
    const rows = await prisma.$queryRaw<Array<{ attempts: number; status: string }>>`
      SELECT "attempts", "status"
      FROM "compensation_jobs"
      WHERE "id" = ${jobId}::uuid
      LIMIT 1
    `;
    const current = rows[0];
    if (!current || current.status !== "processing") return;

    const nextAttempts = current.attempts + 1;
    const message = error instanceof Error ? error.message : String(error);

    if (nextAttempts >= MAX_ATTEMPTS) {
      const updated = await prisma.$executeRaw`
        UPDATE "compensation_jobs"
        SET "status" = 'failed',
            "attempts" = ${nextAttempts},
            "last_error" = ${message},
            "next_run_at" = NULL,
            "updated_at" = NOW()
        WHERE "id" = ${jobId}::uuid
          AND "status" = 'processing'
          AND "attempts" = ${current.attempts}
      `;
      if (updated !== 1) return;
      log("error", "compensation_job_failed", { jobId, attempts: nextAttempts, err: message });
      return;
    }

    const nextRunAt = new Date(Date.now() + this.computeBackoffMs(nextAttempts));
    const updated = await prisma.$executeRaw`
      UPDATE "compensation_jobs"
      SET "status" = 'pending',
          "attempts" = ${nextAttempts},
          "last_error" = ${message},
          "next_run_at" = ${nextRunAt},
          "updated_at" = NOW()
      WHERE "id" = ${jobId}::uuid
        AND "status" = 'processing'
        AND "attempts" = ${current.attempts}
    `;
    if (updated !== 1) return;
    log("warn", "compensation_job_retry_scheduled", {
      jobId,
      attempts: nextAttempts,
      nextRunAt: nextRunAt.toISOString(),
      err: message
    });
  }

  private computeBackoffMs(attempts: number): number {
    const baseDelay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempts);
    const jitter = Math.floor(Math.random() * Math.min(5_000, Math.floor(baseDelay * 0.2)));
    return Math.min(MAX_BACKOFF_MS, baseDelay + jitter);
  }
}
