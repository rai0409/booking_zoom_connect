import { IQueue } from "./queue.interface";

export class ServiceBusQueue<T> implements IQueue<T> {
  constructor(
    private readonly connectionString: string,
    private readonly queueName: string
  ) {}

  async enqueue(_job: T): Promise<void> {
    throw new Error("Service Bus adapter not implemented");
  }

  async dequeue(): Promise<T | null> {
    throw new Error("Service Bus adapter not implemented");
  }
}
