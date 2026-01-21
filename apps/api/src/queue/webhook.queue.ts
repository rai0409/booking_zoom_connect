import { config } from "../config";
import { IQueue } from "./queue.interface";
import { MemoryQueue } from "./memory.queue";
import { ServiceBusQueue } from "./servicebus.queue";

export type WebhookQueueItem = { jobId: string };

export const WEBHOOK_QUEUE = "WEBHOOK_QUEUE";

export function createWebhookQueue(): IQueue<WebhookQueueItem> {
  if (config.queueDriver === "servicebus") {
    return new ServiceBusQueue<WebhookQueueItem>(
      config.serviceBusConnection,
      config.serviceBusQueueName
    );
  }
  return new MemoryQueue<WebhookQueueItem>();
}
