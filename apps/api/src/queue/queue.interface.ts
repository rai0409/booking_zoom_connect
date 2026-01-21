export interface IQueue<T> {
  enqueue(job: T): Promise<void>;
  dequeue(): Promise<T | null>;
}
