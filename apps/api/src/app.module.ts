import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { HealthController } from "./health.controller";
import { ReadyController } from "./ready.controller";
import { PublicController } from "./public.controller";
import { InternalController } from "./internal.controller";
import { BookingService } from "./services/booking.service";
import { ReadyService } from "./ready.service";
import { ExpiryWorker } from "./services/expiry.worker";
import { WebhooksController } from "./webhooks.controller";
import { createWebhookQueue, WEBHOOK_QUEUE } from "./queue/webhook.queue";
import { WebhookWorker } from "./services/webhook.worker";
import { GraphReconciliationService } from "./services/graph-reconciliation.service";
import { GraphSubscriptionWorker } from "./services/graph-subscription.worker";

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [
    HealthController,
    ReadyController,
    PublicController,
    InternalController,
    WebhooksController,
  ],
  providers: [
    BookingService,
    ExpiryWorker,
    WebhookWorker,
    ReadyService,
    GraphReconciliationService,
    GraphSubscriptionWorker,
    { provide: WEBHOOK_QUEUE, useFactory: () => createWebhookQueue() }
  ]
})
export class AppModule {}
