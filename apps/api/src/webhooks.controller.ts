import { Body, Controller, Post, Query, Res } from "@nestjs/common";
import { Response } from "express";
import { prisma } from "./prisma";
import { utcNow } from "./utils/time";
import { GraphWebhookJobPayloadSchema } from "@booking/shared";
import { IQueue } from "./queue/queue.interface";
import { WEBHOOK_QUEUE, WebhookQueueItem } from "./queue/webhook.queue";
import { Inject } from "@nestjs/common";

type GraphNotification = {
  id?: string;
  subscriptionId?: string;
  changeType?: string;
  resource?: string;
  resourceData?: { id?: string };
};

@Controller("/v1/webhooks")
export class WebhooksController {
  constructor(
    @Inject(WEBHOOK_QUEUE) private readonly queue: IQueue<WebhookQueueItem>
  ) {}

  @Post("/graph")
  async graphWebhook(
    @Query("validationToken") validationToken: string | undefined,
    @Body() body: { value?: GraphNotification[] },
    @Res() res: Response
  ) {
    if (validationToken) {
      res.status(200).type("text/plain").send(validationToken);
      return;
    }

    const notifications = Array.isArray(body?.value) ? body.value : [];
    const receivedAt = utcNow().toISOString();

    await Promise.all(
      notifications.map(async (notification) => {
        const subscriptionId = notification.subscriptionId;
        const changeType = (notification.changeType || "").toLowerCase();
        if (!subscriptionId || !changeType) return;

        const resourceId = notification.resourceData?.id || extractResourceId(notification.resource);
        if (!resourceId) return;

        const subscription = await prisma.graphSubscription.findUnique({
          where: { subscription_id: subscriptionId }
        });
        if (!subscription) return;

        const parsed = GraphWebhookJobPayloadSchema.safeParse({
          tenant_id: subscription.tenant_id,
          salesperson_id: subscription.salesperson_id,
          subscription_id: subscriptionId,
          change_type: changeType,
          resource_id: resourceId,
          received_at_utc: receivedAt
        });
        if (!parsed.success) return;
        const payload = parsed.data;

        const existing = notification.id
          ? await prisma.webhookJob.findUnique({ where: { notification_id: notification.id } })
          : await prisma.webhookJob.findFirst({
              where: {
                subscription_id: subscriptionId,
                resource_id: resourceId,
                change_type: changeType
              }
            });

        if (existing) return;

        const job = await prisma.webhookJob.create({
          data: {
            tenant_id: payload.tenant_id,
            salesperson_id: payload.salesperson_id,
            subscription_id: payload.subscription_id,
            change_type: payload.change_type,
            resource_id: payload.resource_id,
            received_at_utc: new Date(payload.received_at_utc),
            notification_id: notification.id,
            payload
          }
        });

        await this.queue.enqueue({ jobId: job.id });
      })
    );

    res.status(202).send();
  }
}

function extractResourceId(resource?: string) {
  if (!resource) return null;
  const parts = resource.split("/").filter(Boolean);
  return parts[parts.length - 1] || null;
}
