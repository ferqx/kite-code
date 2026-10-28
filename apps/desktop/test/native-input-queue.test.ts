import { expect, test } from 'bun:test';
import {
  type AgentClient,
  ClientError,
  type Command,
  type PendingInputQueue,
  type ReorderPendingInputsRequest,
  type WithdrawPendingInputRequest,
} from '@kite-ai/client';
import { callerDigest } from '../electron/caller-journal';
import { NativeInputQueue } from '../electron/native-input-queue';
import { decodeNativeRequest } from '../electron/native-ipc';
import { memoryPrivateData } from './private-data.fixture';

const revision = 'a'.repeat(64);
const scope = {
  generation: 1,
  viewSelection: 2,
  historyEpoch: 3,
  storeId: 'store',
  sessionId: 'session',
  workspaceId: 'workspace',
  subjectId: 'user',
};
const read = {
  method: 'input.queue.read' as const,
  generation: 1,
  viewSelection: 2,
  historyEpoch: 3,
  readId: 'queue',
};
function pending(
  id: string,
  extra: Record<string, unknown> = {},
): PendingInputQueue['commands'][number] {
  return {
    id,
    sessionId: 'session',
    kind: 'input.steer',
    status: 'accepted',
    receipt: {},
    originStoreId: 'store',
    subjectId: 'user',
    requestDigest: 'digest',
    cancelRequestedAt: null,
    seq: id === 'first' ? '1' : '2',
    request: {
      kind: 'input.steer',
      content: `原文 **${id}**\r\n雪🙂`,
      targetRunId: 'run',
      contextSelectionId: 'context',
      ...extra,
    },
  } as PendingInputQueue['commands'][number];
}
function fixture() {
  let current = { ...scope },
    lose = false,
    lookupFail = false,
    fail: string | undefined,
    corrupt = false;
  let calls = 0,
    lookups = 0;
  let active = false;
  let commands = [pending('first'), pending('second')];
  const saved = new Map<string, Command>(),
    queries: unknown[] = [],
    data = memoryPrivateData();
  let beforePost: (() => Promise<void>) | undefined;
  const client = {
    serverInfo: { storeId: 'store', subjectId: 'user', capabilities: ['pending_input_queue'] },
    getView: async (sessionId: string) => ({
      storeId: current.storeId,
      session: {
        id: sessionId,
        workspaceId: 'workspace',
        parentSessionId: null,
        deletedAt: null,
        contextSelectionId: 'context',
      },
      runs: active ? [{ id: 'run', originCommandId: 'origin', isActive: true }] : [],
    }),
    getPendingInputQueue: async (_sessionId: string, input: unknown) => {
      queries.push(input);
      return {
        commands: structuredClone(commands),
        orders: commands.map((_, i) => String(i + 1)),
        revision,
        snapshotCursor: '0',
        nextAfterOrder: null,
      };
    },
    withdrawPendingInput: async (_sessionId: string, input: WithdrawPendingInputRequest) =>
      post(input),
    reorderPendingInputs: async (_sessionId: string, input: ReorderPendingInputsRequest) =>
      post(input),
    getCommand: async (id: string) => {
      lookups++;
      if (lookupFail) throw Error('lookup_lost');
      return {
        ...(id === 'origin'
          ? { id, kind: 'run.start' }
          : (saved.get(id) ?? commands.find((item) => item.id === id)!)),
        ...(corrupt ? { requestDigest: 'wrong' } : {}),
      };
    },
  } as unknown as AgentClient;
  async function post(input: WithdrawPendingInputRequest | ReorderPendingInputsRequest) {
    calls++;
    if (beforePost) await beforePost();
    if (fail) throw new ClientError(fail);
    const { expectedStoreId: _store, commandId: _command, ...body } = input;
    const command: Command = {
      id: input.commandId,
      kind: input.kind,
      sessionId: 'session',
      originStoreId: 'store',
      subjectId: 'user',
      requestDigest: callerDigest(body),
      cancelRequestedAt: null,
      status: 'applied',
      receipt:
        input.kind === 'input.withdraw'
          ? { outcome: 'input_withdrawn', targetCommandId: input.targetCommandId }
          : { outcome: 'inputs_reordered' },
    };
    saved.set(command.id, command);
    if (input.kind === 'input.withdraw')
      commands = commands.filter((c) => c.id !== input.targetCommandId);
    if (lose) throw Error('post_response_lost');
    return command;
  }
  const create = () =>
    new NativeInputQueue(
      client,
      () => current,
      () => data,
      () => {},
    );
  return {
    create,
    client,
    data,
    queries,
    saved,
    setActive: (value: boolean) => {
      active = value;
    },
    get calls() {
      return calls;
    },
    get lookups() {
      return lookups;
    },
    setCommands: (v: typeof commands) => {
      commands = v;
    },
    setScope: (v: Partial<typeof scope>) => {
      current = { ...current, ...v };
    },
    setLose: (v: boolean) => {
      lose = v;
    },
    setLookupFail: (v: boolean) => {
      lookupFail = v;
    },
    setCorrupt: (v: boolean) => {
      corrupt = v;
    },
    setFail: (v: string) => {
      fail = v;
    },
    setBeforePost: (v: () => Promise<void>) => {
      beforePost = v;
    },
  };
}

test('guidance uses Main-owned complete queued input, rejects stale scope and consumes observation once without a renderer body', async () => {
  const f = fixture();
  f.setActive(true);
  const item = pending('first');
  item.kind = 'input.follow_up';
  item.request = {
    kind: 'input.follow_up',
    content: '完整\r\n雪🙂',
    afterRunId: 'run',
    contextSelectionId: 'context',
    files: [{ name: 'read.txt', uri: 'file:///read.txt' }],
  };
  f.setCommands([item]);
  const owner = f.create();
  const observed = await owner.read(read);
  expect(observed.entries[0]).toMatchObject({ editable: false, steerable: true });
  const request = {
    method: 'input.queue.steer' as const,
    generation: 1,
    observationId: observed.observationId,
    targetCommandId: 'first',
  };
  expect(decodeNativeRequest(request)).toEqual(request);
  expect(() => decodeNativeRequest({ ...request, content: 'forged' })).toThrow(
    'invalid_native_request',
  );
  const prepared = await owner.prepareSteer(request);
  expect(prepared).toMatchObject({
    sessionId: 'session',
    intent: {
      kind: 'input.steer',
      queuedInputCommandId: 'first',
      content: '完整\r\n雪🙂',
      targetRunId: 'run',
      contextSelectionId: 'context',
      files: item.request.files,
    },
  });
  expect(f.calls).toBe(0);
  await expect(owner.prepareSteer(request)).rejects.toThrow('input_queue_observation_unavailable');
  const later = await owner.read(read);
  f.setActive(false);
  await expect(
    owner.prepareSteer({ ...request, observationId: later.observationId }),
  ).rejects.toThrow('input_queue_target_unavailable');
  await owner.close();
});

test('closed queue IPC accepts only observed identities; renderer cannot forge content, Store, requests or operation IDs', () => {
  const original = {
    method: 'input.queue.withdraw' as const,
    generation: 1,
    observationId: 2,
    targetCommandId: 'first',
    purpose: 'edit' as const,
  };
  expect(decodeNativeRequest(original)).toEqual(original);
  for (const extra of [
    { content: 'forged' },
    { expectedStoreId: 'foreign' },
    { commandId: 'renderer-id' },
    { request: {} },
    { sessionId: 'foreign' },
  ])
    expect(() => decodeNativeRequest({ ...original, ...extra })).toThrow('invalid_native_request');
  for (const commandIds of [
    ['a', 'a'],
    ['a', 3],
    ['bad!'],
    Array.from({ length: 4097 }, (_, i) => `id-${i}`),
  ])
    expect(() =>
      decodeNativeRequest({
        method: 'input.queue.reorder',
        generation: 1,
        observationId: 2,
        commandIds,
      }),
    ).toThrow('invalid_native_request');
  expect(() => decodeNativeRequest({ ...read, viewSelection: -1 })).toThrow(
    'invalid_native_request',
  );
  expect(
    decodeNativeRequest({ method: 'input.queue.ack', generation: 1, commandId: 'original' }).method,
  ).toBe('input.queue.ack');
});

test('read freezes all pages to one revision, skips result.include and preserves attached input while prohibiting lossy edits', async () => {
  const f = fixture(),
    owner = f.create();
  const included = {
    ...pending('included'),
    kind: 'result.include',
    request: {
      kind: 'result.include',
      expectedContextSelectionId: 'context',
      executionId: 'tool',
      resultRevision: '1',
      targetRunId: null,
    },
  } as PendingInputQueue['commands'][number];
  const attached = pending('attached', {
    files: [{ name: 'original.txt', uri: 'file:///original' }],
  });
  f.client.getPendingInputQueue = async (_session, input) => {
    f.queries.push(input);
    return input.afterOrder
      ? { commands: [attached], orders: ['3'], nextAfterOrder: null, revision, snapshotCursor: '2' }
      : {
          commands: [pending('first'), included],
          orders: ['1', '2'],
          nextAfterOrder: '2',
          revision,
          snapshotCursor: '1',
        };
  };
  const observed = await owner.read(read);
  expect(observed.entries.map((row) => row.id)).toEqual(['first', 'attached']);
  expect(observed.entries.map((row) => row.editable)).toEqual([true, false]);
  expect(f.queries[1]).toEqual({
    storeId: 'store',
    limit: 200,
    afterOrder: '2',
    expectedRevision: revision,
  });
  await expect(
    owner.mutate({
      method: 'input.queue.withdraw',
      generation: 1,
      observationId: observed.observationId,
      targetCommandId: 'attached',
      purpose: 'edit',
    }),
  ).rejects.toThrow('input_queue_target_unavailable');
  expect(f.calls).toBe(0);
  const again = await owner.read(read);
  const deleted = await owner.mutate({
    method: 'input.queue.withdraw',
    generation: 1,
    observationId: again.observationId,
    targetCommandId: 'attached',
    purpose: 'delete',
  });
  expect(deleted.phase).toBe('applied');
  expect(deleted.text).toBeUndefined();
  expect(f.saved.get(deleted.commandId)?.kind).toBe('input.withdraw');
});

test('response loss persists the original request; cold lookup never retries POST and an edit remains recoverable until explicit ack', async () => {
  const f = fixture(),
    owner = f.create();
  f.setLose(true);
  const observed = await owner.read(read),
    text = observed.entries[0]!.text;
  const result = await owner.mutate({
    method: 'input.queue.withdraw',
    generation: 1,
    observationId: observed.observationId,
    targetCommandId: 'first',
    purpose: 'edit',
  });
  expect(result.phase).toBe('unknown');
  expect(result.text).toBeUndefined();
  expect(f.calls).toBe(1);
  const original = structuredClone(f.data.inputQueueRecords()[0]!.request);
  const cold = f.create();
  f.setLookupFail(true);
  const reread = await cold.read(read);
  expect(reread.entries.map((item) => item.id)).toEqual(['second']);
  expect(reread.submissions[0]?.commandId).toBe(result.commandId);
  expect(reread.submissions[0]?.text).toBeUndefined();
  expect((await cold.lookup(result.commandId)).phase).toBe('unknown');
  expect(f.calls).toBe(1);
  expect(f.lookups).toBe(1);
  expect(f.data.inputQueueRecords()[0]!.request).toEqual(original);
  await expect(
    cold.mutate({
      method: 'input.queue.reorder',
      generation: 1,
      observationId: reread.observationId,
      commandIds: ['second'],
    }),
  ).rejects.toThrow('input_queue_observation_unavailable');
  f.setLookupFail(false);
  f.setCorrupt(true);
  expect((await cold.lookup(result.commandId)).phase).toBe('unknown');
  f.setCorrupt(false);
  const recovered = await cold.lookup(result.commandId);
  expect(recovered.phase).toBe('applied');
  expect(recovered.text).toBe(text);
  const unacked = await f.create().read(read);
  expect(unacked.submissions[0]?.phase).toBe('applied');
  expect(unacked.submissions[0]?.text).toBeUndefined();
  cold.ack(result.commandId);
  expect((await f.create().read(read)).submissions).toEqual([]);
  expect((await cold.lookup(result.commandId)).text).toBeUndefined();
  expect(f.calls).toBe(1);
});

test('a changed selection or consumed input never returns withdrawn text or cancels an active Run', async () => {
  const f = fixture(),
    owner = f.create();
  let release!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>((r) => {
      entered = r;
    }),
    wait = new Promise<void>((r) => {
      release = r;
    });
  f.setBeforePost(async () => {
    entered();
    await wait;
  });
  const observed = await owner.read(read);
  const changing = owner.mutate({
    method: 'input.queue.withdraw',
    generation: 1,
    observationId: observed.observationId,
    targetCommandId: 'first',
    purpose: 'edit',
  });
  await enteredPromise;
  f.setScope({ sessionId: 'other', viewSelection: 4 });
  release();
  await expect(changing).rejects.toThrow('input_queue_observation_unavailable');
  expect(f.data.inputQueueRecords()[0]!.phase).toBe('applied');
  const commandId = f.data.inputQueueRecords()[0]!.request.commandId;
  await expect(owner.lookup(commandId)).rejects.toThrow('input_queue_intent_missing');
  f.setScope({ sessionId: 'session', viewSelection: 5 });
  expect((await owner.lookup(commandId)).text).toContain('原文');
  const g = fixture(),
    consumed = g.create();
  g.setFail('input_already_consumed');
  const before = await consumed.read(read);
  const rejected = await consumed.mutate({
    method: 'input.queue.withdraw',
    generation: 1,
    observationId: before.observationId,
    targetCommandId: 'first',
    purpose: 'edit',
  });
  expect(rejected.phase).toBe('rejected');
  expect(rejected.error).toBe('input_already_consumed');
  expect(rejected.text).toBeUndefined();
  expect(g.data.inputQueueRecords()[0]!.request.kind).toBe('input.withdraw');
});

test('reorder requires exactly the observed movable set and releases all previous read authority', async () => {
  const f = fixture(),
    owner = f.create();
  const observed = await owner.read(read);
  await expect(
    owner.mutate({
      method: 'input.queue.reorder',
      generation: 1,
      observationId: observed.observationId,
      commandIds: ['second', 'forged'],
    }),
  ).rejects.toThrow('input_queue_target_unavailable');
  expect(f.calls).toBe(0);
  const again = await owner.read(read);
  const reordered = await owner.mutate({
    method: 'input.queue.reorder',
    generation: 1,
    observationId: again.observationId,
    commandIds: ['second', 'first'],
  });
  expect(reordered.phase).toBe('applied');
  expect(f.data.inputQueueRecords()[0]!.request).toMatchObject({
    kind: 'input.reorder',
    commandIds: ['second', 'first'],
    expectedRevision: revision,
  });
  await expect(
    owner.mutate({
      method: 'input.queue.reorder',
      generation: 1,
      observationId: again.observationId,
      commandIds: ['first', 'second'],
    }),
  ).rejects.toThrow('input_queue_observation_unavailable');
  const fresh = await owner.read(read);
  owner.closeRead(fresh.readId);
  await expect(
    owner.mutate({
      method: 'input.queue.withdraw',
      generation: 1,
      observationId: fresh.observationId,
      targetCommandId: 'first',
      purpose: 'delete',
    }),
  ).rejects.toThrow('input_queue_observation_unavailable');
  expect(f.calls).toBe(1);
});

test('attachment-only inputs remain visible, deletable and movable without becoming editable text', async () => {
  const f = fixture(),
    owner = f.create();
  f.setCommands([
    pending('file-only', { content: '', files: [{ name: 'original.txt', uri: 'file:///exact' }] }),
    pending('image-only', {
      content: '',
      images: [{ name: 'image.png', reference: { id: 'exact' } }],
    }),
  ]);
  const observed = await owner.read(read);
  expect(observed.entries).toEqual([
    { id: 'file-only', text: '包含附件的消息', editable: false, steerable: false },
    { id: 'image-only', text: '包含附件的消息', editable: false, steerable: false },
  ]);
  const result = await owner.mutate({
    method: 'input.queue.reorder',
    generation: 1,
    observationId: observed.observationId,
    commandIds: ['image-only', 'file-only'],
  });
  expect(result.phase).toBe('applied');
  expect(f.data.inputQueueRecords()[0]!.request).toMatchObject({
    commandIds: ['image-only', 'file-only'],
  });
  const next = await owner.read(read);
  const deleted = await owner.mutate({
    method: 'input.queue.withdraw',
    generation: 1,
    observationId: next.observationId,
    targetCommandId: 'file-only',
    purpose: 'delete',
  });
  expect(deleted.phase).toBe('applied');
  expect(deleted.text).toBeUndefined();
});

test('changed paging revision, stale history, late reads, root identity and unavailable capability fail closed', async () => {
  const f = fixture(),
    owner = f.create();
  await expect(owner.read({ ...read, historyEpoch: 2 })).rejects.toThrow(
    'input_queue_observation_unavailable',
  );
  f.client.getPendingInputQueue = async (_session, input) =>
    input.afterOrder
      ? {
          commands: [pending('second')],
          orders: ['2'],
          nextAfterOrder: null,
          revision: 'b'.repeat(64),
          snapshotCursor: '0',
        }
      : {
          commands: [pending('first')],
          orders: ['1'],
          nextAfterOrder: '1',
          revision,
          snapshotCursor: '0',
        };
  await expect(owner.read(read)).rejects.toThrow('input_queue_observation_unavailable');
  let resolve!: (page: PendingInputQueue) => void, entered!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  f.client.getPendingInputQueue = async () => {
    entered();
    return await new Promise<PendingInputQueue>((r) => {
      resolve = r;
    });
  };
  const late = owner.read(read);
  await ready;
  owner.closeRead('queue');
  resolve({
    commands: [pending('first')],
    orders: ['1'],
    nextAfterOrder: null,
    revision,
    snapshotCursor: '0',
  });
  await expect(late).rejects.toThrow('input_queue_observation_unavailable');
  const g = fixture(),
    absent = g.create();
  g.client.serverInfo!.capabilities = [];
  await expect(absent.read(read)).rejects.toThrow('input_queue_observation_unavailable');
  expect(g.queries).toEqual([]);
  const h = fixture(),
    foreign = h.create();
  h.setScope({ storeId: 'other' });
  await expect(foreign.read(read)).rejects.toThrow('input_queue_observation_unavailable');
  expect(h.queries).toEqual([]);
});
