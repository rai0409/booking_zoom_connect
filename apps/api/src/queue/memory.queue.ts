import { IQueue } from "./queue.interface";

export class MemoryQueue<T> implements IQueue<T> {
  private items: T[] = [];

  async enqueue(job: T): Promise<void> {
    this.items.push(job);
  }

  async dequeue(): Promise<T | null> {
    return this.items.shift() ?? null;
  }
}
