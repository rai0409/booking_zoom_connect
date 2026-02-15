import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { BookingService } from "./booking.service";
import { log } from "../utils/logger";

@Injectable()
export class ExpiryWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly bookingService: BookingService) {}

  onModuleInit() {
    if (process.env.EXPIRY_WORKER_ENABLED === "0") {
      log("info", "expiry_worker_disabled", {});
      return;
    }
    this.timer = setInterval(() => {
      try {
        // Prevent process crash if DI failed and bookingService is undefined
        if (!this.bookingService || typeof (this.bookingService as any).expireHolds !== "function") {
          log("warn", "expiry_worker_booking_service_missing", {});
          return;
        }

        void this.bookingService.expireHolds().catch((e) => {
          log("warn", "expiry_worker_error", {
            err: e instanceof Error ? e.message : String(e)
          });
        });
      } catch (e) {
        // Also catch synchronous errors to avoid crashing the whole process
        log("error", "expiry_worker_crash_prevented", {
          err: e instanceof Error ? e.message : String(e)
        });
      }
    }, 60_000);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
