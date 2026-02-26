export interface IQueue<T> {
  enqueue(job: T): Promise<void>;
  dequeue(): Promise<T | null>;
  consume?(handler: (item: T) => Promise<void>): Promise<void>;
  close?(): Promise<void>;
}
