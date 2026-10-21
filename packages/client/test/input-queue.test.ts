import { expect, test } from 'bun:test';
import {
  createClient,
  type ReorderPendingInputsRequest,
  type WithdrawPendingInputRequest,
} from '../src';

test('pending queue requires capability, validates closed intent and response order, and never retries mutations', async () => {
  let calls = 0;
  let capabilities: string[] = [];
  const revision = 'a'.repeat(64);
  const writes: unknown[] = [];
  let response: unknown = {
    commands: [],
    orders: [],
    nextAfterOrder: null,
    revision,
    snapshotCursor: '0',
  };
  const profile = { dataRoot: '/queue-fixture', name: 'test', accessKey: 'key' };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      calls++;
      if (new URL(request.url).pathname === '/v1/server')
        return Response.json({
          instanceId: 'fixture',
          buildId: 'fixture',
          apiMajor: 1,
          capabilities,
          profile,
          dataAvailability: 'available',
          storeId: 'store',
        });
      if (request.method === 'POST') {
        writes.push(await request.json());
        return new Response('{}');
      }
      return Response.json(response);
    },
  });
  const client = createClient({
    endpoint: server.url.href,
    token: 'private',
    expected: { profile, apiMajor: 1, requiredCapabilities: [] },
  });
  const withdraw: WithdrawPendingInputRequest = {
    kind: 'input.withdraw',
    commandId: 'withdraw',
    expectedStoreId: 'store',
    targetCommandId: 'original',
    expectedRevision: revision,
  };
  const reorder: ReorderPendingInputsRequest = {
    kind: 'input.reorder',
    commandId: 'reorder',
    expectedStoreId: 'store',
    commandIds: ['b', 'a'],
    expectedRevision: revision,
  };
  try {
    expect(() => client.getPendingInputQueue('s', { storeId: 'store' })).toThrow(
      'connection_not_admitted',
    );
    expect(calls).toBe(0);
    await client.connect();
    for (const invoke of [
      () => client.getPendingInputQueue('s', { storeId: 'store' }),
      () => client.withdrawPendingInput('s', withdraw),
      () => client.reorderPendingInputs('s', reorder),
    ])
      expect(invoke).toThrow('capability_unavailable');
    expect(calls).toBe(1);
    capabilities = ['pending_input_queue'];
    await client.connect();
    expect(() => client.getPendingInputQueue('s', { storeId: 'store', limit: 1.5 })).toThrow(
      'Invalid PendingInputQueueQuery',
    );
    expect(() =>
      client.getPendingInputQueue('s', { storeId: 'store', afterOrder: '9223372036854775808' }),
    ).toThrow();
    expect(() =>
      client.withdrawPendingInput('s', {
        ...withdraw,
        subjectId: 'forged',
      } as WithdrawPendingInputRequest),
    ).toThrow('Invalid WithdrawPendingInputRequest');
    expect(() => client.reorderPendingInputs('s', { ...reorder, expectedRevision: 'bad' })).toThrow(
      'Invalid ReorderPendingInputsRequest',
    );
    expect(calls).toBe(2);
    expect(await client.getPendingInputQueue('s', { storeId: 'store' })).toEqual({
      commands: [],
      orders: [],
      nextAfterOrder: null,
      revision,
      snapshotCursor: '0',
    });
    response = { commands: [], orders: ['1'], nextAfterOrder: '1', revision, snapshotCursor: '0' };
    await expect(client.getPendingInputQueue('s', { storeId: 'store' })).rejects.toMatchObject({
      code: 'invalid_response',
    });
    response = {
      commands: [],
      orders: [],
      nextAfterOrder: null,
      revision: 'b'.repeat(64),
      snapshotCursor: '0',
    };
    await expect(
      client.getPendingInputQueue('s', { storeId: 'store', expectedRevision: revision }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    const pending = client.reorderPendingInputs('s', reorder);
    reorder.commandIds.reverse();
    await expect(pending).rejects.toThrow();
    await expect(client.withdrawPendingInput('s', withdraw)).rejects.toThrow();
    expect(writes).toEqual([{ ...reorder, commandIds: ['b', 'a'] }, withdraw]);
    expect(client.lastAppliedCursor).toBeUndefined();
  } finally {
    client.disposeNetwork();
    await server.stop(true);
  }
});
