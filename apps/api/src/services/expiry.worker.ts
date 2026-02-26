import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { BookingService } from "./booking.service";
import { log } from "../utils/logger";

@Injectable()
export class ExpiryWorker implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly bookingService: BookingService) {}
  onModuleInit() {
    if (process.env.EXPIRY_WORKER_ENABLED === "0") {
      log("info", "expiry_worker_disabled", {});
      return;
    }

    try {
      const svc: any = this.bookingService;
      const hasSvc = svc != null;
      const hasFn = hasSvc && typeof svc.expireHolds === "function";
      if (!hasFn) {
        log("error", "expiry_worker_booking_service_invalid", {
          hasSvc,
          hasFn,
          svcType: hasSvc ? svc?.constructor?.name : null,
          keys: hasSvc ? Object.keys(svc ?? {}) : [],
        });
        if (process.env.EXPIRY_WORKER_FAIL_FAST === "1") {
          throw new Error("expiry_worker_di_failed_fatal");
        }
        return;

      }
    } catch (e) {
      log("error", "expiry_worker_crash_prevented", {
        err: e instanceof Error ? e.message : String(e),
      });
      if (process.env.EXPIRY_WORKER_FAIL_FAST === "1") {
        throw e;
      }
      return;
    }
  }

  @Cron("*/1 * * * *")
  async tick() {
    if (process.env.EXPIRY_WORKER_TRACE === "1") {
      log("info", "expiry_worker_tick", { ts: new Date().toISOString(), pid: process.pid });
    }
    if (process.env.EXPIRY_WORKER_ENABLED === "0") {
      return;
    }
    try {
      const svc: any = this.bookingService;
      if (!svc || typeof svc.expireHolds !== "function") {
        log("error", "expiry_worker_booking_service_invalid", {
          hasSvc: !!svc,
          hasFn: false,
          svcType: svc?.constructor?.name ?? null,
          keys: svc ? Object.keys(svc) : [],
        });
        if (process.env.EXPIRY_WORKER_FAIL_FAST === "1") {
          throw new Error("expiry_worker_di_failed_fatal");
        }
        return;
      }
      if (process.env.EXPIRY_WORKER_TRACE === "1") {
        log("info", "expiry_worker_expire_start", {});
      }
      const res = await svc.expireHolds();
      if (process.env.EXPIRY_WORKER_TRACE === "1") {
        log("info", "expiry_worker_expire_done", { res });
      }
    } catch (e) {
      log("warn", "expiry_worker_error", {
        err: e instanceof Error ? e.message : String(e),
      });
      if (process.env.EXPIRY_WORKER_FAIL_FAST === "1") {
        throw e;
      }
    }
  }

  onModuleDestroy() {
  }
}
