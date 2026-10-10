import { AgentError } from '../types';
import type { WorkerRequest } from './protocol';

type Category = 'control' | 'body' | 'query';
const schedule: Category[] = ['control', 'control', 'control', 'control', 'body', 'query'];
/** Bounded weighted scheduling between transactions. Running SQL is never interrupted. */
export class WorkerQueue {
  private readonly queues: Record<Category, { request: WorkerRequest; bytes: number }[]> = {
    control: [],
    body: [],
    query: [],
  };
  private position = 0;
  private count = 0;
  private bytes = 0;
  push(request: WorkerRequest): void {
    const category = categoryOf(request.method);
    const bytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
    if (
      this.count >= (category === 'control' ? 256 : 224) ||
      this.bytes + bytes > (category === 'control' ? 16 : 14) * 1024 * 1024
    )
      throw new AgentError('storage_queue_full');
    this.queues[category].push({ request, bytes });
    this.count++;
    this.bytes += bytes;
  }
  next(): WorkerRequest | undefined {
    for (let i = 0; i < schedule.length; i++) {
      const category = schedule[this.position]!;
      this.position = (this.position + 1) % schedule.length;
      const queue = this.queues[category];
      let item = queue[0];
      // close drains every previously accepted message, regardless of its priority.
      if (
        item?.request.method === 'close' &&
        Object.values(this.queues).some((other) =>
          other.some((prior) => prior.request.id < item!.request.id),
        )
      )
        continue;
      item = queue.shift();
      if (item) {
        this.count--;
        this.bytes -= item.bytes;
        return item.request;
      }
    }
    return undefined;
  }
  get size(): number {
    return this.count;
  }
}
function categoryOf(method: WorkerRequest['method']): Category {
  if (method === 'persistModelPartial' || method === 'appendExecutionOutput') return 'body';
  if (
    method === 'readRunResumeExecutionPage' ||
    method.startsWith('get') ||
    method.startsWith('list')
  )
    return 'query';
  return 'control';
}
