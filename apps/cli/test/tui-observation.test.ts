import { expect, test } from 'bun:test';
import type { AgentClient } from '@kite-ai/client';
import { TuiController, type TuiPort, type TuiSnapshot } from '@kite-ai/ui/tui';
import { prepareTuiObservationStart, refreshTuiObservation } from '../host/tui-observation';

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

test('observation ready rereads the current Session without repeating its explicit activation reconciliation', async () => {
  let reconciliations = 0,
    reads = 0,
    writes = 0;
  const forbidden = async () => {
    writes++;
    throw Error('unexpected_business_write');
  };
  const controller = new TuiController({
    storeId: 'store',
    nextCommandId: () => {
      throw Error('unexpected_new_identity');
    },
    listSessions: async () => [],
    reconcileSession: async () => {
      reconciliations++;
    },
    readSession: async (id) => {
      reads++;
      return {
        storeId: 'store',
        view: {
          storeId: 'store',
          session: {
            id,
            workspaceId: 'w',
            title: id,
            contextSelectionId: 'selection',
            nextSeq: '0',
            controlRevision: '1',
          },
          runs: [],
          executions: [],
          messages: [],
        },
        messages: [],
        interactions: [],
      } as unknown as TuiSnapshot;
    },
    submit: forbidden,
    answer: forbidden,
    cancel: forbidden,
    getCommand: forbidden,
  } as TuiPort);
  try {
    await controller.select('original');
    expect(reconciliations).toBe(1);
    controller.observationUnavailable('network');
    await refreshTuiObservation(controller, 'store');
    await refreshTuiObservation(controller, 'store');
    expect(reconciliations).toBe(1);
    expect(reads).toBe(3);
    expect(writes).toBe(0);
    expect(controller.state.sessionId).toBe('original');
    expect(controller.state.stale).toBe(false);
  } finally {
    controller.dispose();
  }
});
