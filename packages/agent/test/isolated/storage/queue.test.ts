import { expect, test } from 'bun:test';
import type { WorkerRequest } from '../../../src/storage/worker/protocol';
import { WorkerQueue } from '../../../src/storage/worker/queue';

function request(id: number, method: WorkerRequest['method']): WorkerRequest {
  return { id, method, args: [] } as WorkerRequest;
}
test('weighted Worker queue prioritizes control while preserving body/query progress', () => {
  const queue = new WorkerQueue();
  for (let i = 1; i <= 30; i++) queue.push(request(i, 'getMetadata'));
  for (let i = 31; i <= 40; i++) queue.push(request(i, 'cancelCommand'));
  for (let i = 41; i <= 43; i++) queue.push(request(i, 'persistModelPartial'));
  const first = Array.from({ length: 6 }, () => queue.next()!.method);
  expect(first).toEqual([
    'cancelCommand',
    'cancelCommand',
    'cancelCommand',
    'cancelCommand',
    'persistModelPartial',
    'getMetadata',
  ]);
});
test('reserved control capacity is real and close drains earlier work', () => {
  const queue = new WorkerQueue();
  for (let i = 1; i <= 224; i++) queue.push(request(i, 'getMetadata'));
  expect(() => queue.push(request(225, 'getMetadata'))).toThrow('storage_queue_full');
  queue.push(request(225, 'cancelCommand'));
  queue.push(request(226, 'close'));
  expect(queue.next()!.method).toBe('cancelCommand');
  const rest: WorkerRequest[] = [];
  while (queue.size) rest.push(queue.next()!);
  expect(rest.at(-1)!.method).toBe('close');
  expect(rest).toHaveLength(225);
});
