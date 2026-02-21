import { ServiceBusClient, ServiceBusReceiver, ServiceBusSender } from "@azure/service-bus";
import { IQueue } from "./queue.interface";

export class ServiceBusQueue<T> implements IQueue<T> {
  private client: ServiceBusClient;
  private sender: ServiceBusSender;
  private receiver: ServiceBusReceiver;

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
}
