import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { BookingService } from "./booking.service";

@Injectable()
export class ExpiryWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly bookingService: BookingService) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      this.bookingService.expireHolds().catch(() => {
        // ignore worker errors
      });
    }, 60_000);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }
}
