import { expect, test } from 'bun:test';
import type { AgentClient } from '@kite-ai/client';
import { prepareTuiObservationStart } from '../host/tui-observation';

test('reset freezes original global read baseline before selected reads without acknowledging events', async () => {
  const order: string[] = [];
  const client = {
    lastAppliedCursor: { storeId: 'store', sequence: '3' },
    listSessionDirectory: async (query: unknown) => {
      order.push('baseline');
      expect(query).toEqual({ storeId: 'store', limit: 1 });
      return { storeId: 'store', snapshotCursor: '9007199254740993' };
    },
  } as unknown as AgentClient;
  const start = await prepareTuiObservationStart(
    client,
    'store',
    async () => {
      order.push('facts');
    },
    new AbortController().signal,
  );
  expect(order).toEqual(['baseline', 'facts']);
  expect(start).toEqual({ storeId: 'store', sequence: '9007199254740993' });
  expect(client.lastAppliedCursor).toEqual({ storeId: 'store', sequence: '3' });
});

test('wrong Store, failed full reread and disposed reads cannot supply a recovery start', async () => {
  const abort = new AbortController();
  let facts = 0;
  const client = {
    listSessionDirectory: async () => ({ storeId: 'foreign', snapshotCursor: '5' }),
  } as unknown as AgentClient;
  await expect(
    prepareTuiObservationStart(
      client,
      'store',
      async () => {
        facts++;
      },
      abort.signal,
    ),
  ).rejects.toThrow('store_identity_mismatch');
  expect(facts).toBe(0);
  client.listSessionDirectory = async () => ({ storeId: 'store', snapshotCursor: '5' }) as never;
  await expect(
    prepareTuiObservationStart(
      client,
      'store',
      async () => {
        throw Error('snapshot unavailable');
      },
      abort.signal,
    ),
  ).rejects.toThrow('snapshot unavailable');
  await expect(
    prepareTuiObservationStart(
      client,
      'store',
      async () => {
        abort.abort();
      },
      abort.signal,
    ),
  ).rejects.toThrow();
});
