import { ServiceBusClient, ServiceBusReceiver, ServiceBusSender } from "@azure/service-bus";
import { IQueue } from "./queue.interface";
import { log } from "../utils/logger";

export class ServiceBusQueue<T> implements IQueue<T> {
  private client: ServiceBusClient;
  private sender: ServiceBusSender;
  private receiver: ServiceBusReceiver;
  private subscription: { close(): Promise<void> } | null = null;
  private consumeWaiter: Promise<void> | null = null;
  private resolveConsumeWaiter: (() => void) | null = null;
  private closed = false;

  constructor(private readonly connectionString: string, private readonly queueName: string) {
    if (!connectionString) {
      throw new Error("SERVICEBUS_CONNECTION is required when QUEUE_DRIVER=servicebus");
    }
    if (!queueName) {
      throw new Error("SERVICEBUS_QUEUE_NAME is required when QUEUE_DRIVER=servicebus");
    }
    this.client = new ServiceBusClient(connectionString);
    this.sender = this.client.createSender(queueName);
    this.receiver = this.client.createReceiver(queueName, { receiveMode: "peekLock" });
  }

  async enqueue(job: T): Promise<void> {
    await this.sender.sendMessages({ body: job });
  }

  async dequeue(): Promise<T | null> {
    const msgs = await this.receiver.receiveMessages(1, { maxWaitTimeInMs: 500 });
    if (!msgs.length) return null;

    const msg = msgs[0];
    try {
      // Complete first to avoid duplicate triggers; the source of truth is DB.
      await this.receiver.completeMessage(msg);
    } catch {
      // ignore complete failure
    }

    return (msg.body as T) ?? null;
  }

  async consume(handler: (item: T) => Promise<void>): Promise<void> {
    if (this.closed) return;
    if (this.consumeWaiter) return this.consumeWaiter;

    this.subscription = this.receiver.subscribe(
      {
        processMessage: async (message) => {
          const item = (message.body as T) ?? null;
          if (!item) {
            await this.receiver.completeMessage(message).catch(() => {});
            return;
          }

          try {
            await handler(item);
            await this.receiver.completeMessage(message);
          } catch (err) {
            log("warn", "servicebus_message_handler_failed", {
              queueName: this.queueName,
              err: err instanceof Error ? err.message : String(err)
            });
            await this.receiver.abandonMessage(message).catch(() => {});
          }
        },
        processError: async (args) => {
          log("error", "servicebus_consume_error", {
            queueName: this.queueName,
            source: args.errorSource,
            err: args.error?.message || String(args.error)
          });
        }
      },
      {
        maxConcurrentCalls: 1,
        autoCompleteMessages: false
      }
    );

    this.consumeWaiter = new Promise<void>((resolve) => {
      this.resolveConsumeWaiter = resolve;
    });

    return this.consumeWaiter;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.subscription) {
      await this.subscription.close().catch(() => {});
      this.subscription = null;
    }
    if (this.resolveConsumeWaiter) {
      this.resolveConsumeWaiter();
      this.resolveConsumeWaiter = null;
    }

    await this.receiver.close().catch(() => {});
    await this.sender.close().catch(() => {});
    await this.client.close().catch(() => {});
  }
}
