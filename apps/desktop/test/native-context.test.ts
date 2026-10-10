import { expect, test } from 'bun:test';
import {
  type AgentClient,
  ClientError,
  type Command,
  type SelectedContextPage,
} from '@kite-ai/client';
import { NativeContext } from '../electron/context';
import { decodeNativeRequest } from '../electron/native-ipc';

const selection = {
  id: 'selection',
  sessionId: 's',
  previousSelectionId: null,
  boundaryMessageId: null,
  boundarySeq: '205',
  tailFromSeq: '206',
  ranges: [{ afterSeq: '0', throughSeq: '205' }],
};
const message = (seq: number) => ({
  id: `m-${seq}`,
  sessionId: 's',
  runId: null,
  seq: String(seq),
  status: 'complete' as const,
  role: 'user' as const,
  content: `message ${seq}`,
});
const source = (id: string) => ({
  id,
  seq: '1',
  sessionId: 's',
  createdSelectionId: 'selection',
  executionId: 'job',
  resultRevision: '1',
  originStoreId: 'store',
  inclusion: 'automatic' as const,
  result: { content: id },
});
const page = (
  messages: SelectedContextPage['messages'],
  resultSources: SelectedContextPage['resultSources'],
  nextAfterSeq: string | null = null,
  nextAfterSourceId: string | null = null,
): SelectedContextPage => ({
  selection,
  highWaterSeq: '205',
  messages,
  resultSources,
  nextAfterSeq,
  nextAfterSourceId,
  snapshotCursor: '205',
});
async function code(promise: Promise<unknown>) {
  try {
    await promise;
    return 'success';
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  }
}
test('Native context exhausts independent pinned cursors without duplicate first sources/messages or total boundary cap', async () => {
  const calls: unknown[] = [];
  let turn = 0;
  const client = {
    serverInfo: { capabilities: ['context'] },
    async getContext(_id: string, query: unknown) {
      calls.push(query);
      return turn++ === 0
        ? page(
            Array.from({ length: 200 }, (_, i) => message(i + 1)),
            [source('source-a')],
            '200',
          )
        : page(
            Array.from({ length: 5 }, (_, i) => message(i + 201)),
            [],
          );
    },
  } as unknown as AgentClient;
  const scope = { generation: 1, selection: 1, storeId: 'store', sessionId: 's', workspaceId: 'w' },
    host = new NativeContext(
      client,
      () => scope,
      () => {},
    );
  expect((await host.read('s')).page.messages).toHaveLength(200);
  expect((await host.read('s', true)).page.messages).toHaveLength(5);
  expect(calls[1]).toMatchObject({
    contextSelectionId: 'selection',
    upperSeq: '205',
    afterSeq: '200',
    afterSourceId: 'source-a',
  });
  expect(await code(host.read('s', true))).toBe('context_page_end');
  turn = 0;
  Object.assign(client, {
    async getContext(_id: string, query: unknown) {
      calls.push(query);
      return turn++ === 0
        ? page([message(1)], [source('a'), source('b')], null, 'b')
        : page([], [source('c')]);
    },
  });
  await host.read('s');
  await host.read('s', true);
  expect(calls.at(-1)).toMatchObject({ upperSeq: '205', afterSeq: '205', afterSourceId: 'b' });
});
test('Native context one original rewind shares dispatch; unknown lookup after switching only queries that command and failed fresh read removes authority', async () => {
  let scope = { generation: 1, selection: 1, storeId: 'store', sessionId: 's', workspaceId: 'w' },
    fail = false,
    posts = 0;
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  let original!: Parameters<AgentClient['rewind']>[1];
  const gets: string[] = [];
  const client = {
    serverInfo: { capabilities: ['context'] },
    async getContext() {
      if (fail) throw new ClientError('network_outcome_unknown');
      return page([message(1)], []);
    },
    async getView() {
      return {
        storeId: 'store',
        session: { id: 's', workspaceId: 'w', contextSelectionId: 'selection', deletedAt: null },
        runs: [],
        executions: [],
      };
    },
    async rewind(_id: string, intent: typeof original) {
      posts++;
      original = intent;
      enter();
      await barrier;
      throw new ClientError('network_outcome_unknown');
    },
    async getCommand(id: string) {
      gets.push(id);
      return {
        id,
        originStoreId: 'store',
        sessionId: 's',
        kind: 'context.select',
        status: 'applied',
        receipt: {},
      } as Command;
    },
  } as unknown as AgentClient;
  const host = new NativeContext(
      client,
      () => scope,
      () => {},
    ),
    facts = await host.read('s');
  const first = host.rewind(facts.observationId, { messageId: 'm-1', seq: '1' }),
    duplicate = host.rewind(facts.observationId, { messageId: 'm-1', seq: '1' });
  expect(first).toBe(duplicate);
  await entered;
  expect(posts).toBe(1);
  scope = { ...scope, selection: 2, sessionId: 'other' };
  host.release();
  release();
  expect(await code(first)).toBe('network_outcome_unknown');
  expect(host.submissions[0]).toMatchObject({ sessionId: 's', phase: 'unknown' });
  await host.lookup(original.commandId);
  expect(gets).toEqual([original.commandId]);
  expect(posts).toBe(1);
  scope = { ...scope, selection: 3, sessionId: 's' };
  const current = await host.read('s');
  fail = true;
  expect(await code(host.read('s'))).toBe('network_outcome_unknown');
  expect(await code(Promise.resolve().then(() => host.rewind(current.observationId, null)))).toBe(
    'context_observation_changed',
  );
});
test('Native active Include forwards exact UI scope and rejects missing/switched Run before HTTP; queued receipt is not applied', async () => {
  let target = 'active',
    posts = 0;
  const scope = { generation: 1, selection: 1, storeId: 'store', sessionId: 's', workspaceId: 'w' };
  const client = {
    serverInfo: { capabilities: ['context'] },
    getContext: async () => page([], []),
    async getView() {
      return {
        storeId: 'store',
        session: { id: 's', workspaceId: 'w', contextSelectionId: 'selection', deletedAt: null },
        runs: [{ id: target, sessionId: 's', isActive: true }],
        executions: [
          {
            id: 'job',
            kind: 'job',
            originStoreId: 'store',
            resultRevision: '1',
            delivery: 'suppressed',
            status: 'succeeded',
          },
        ],
      };
    },
    async includeResult(
      _session: string,
      _exec: string,
      input: Parameters<AgentClient['includeResult']>[2],
    ) {
      posts++;
      return {
        command: {
          id: input.commandId,
          originStoreId: 'store',
          sessionId: 's',
          kind: 'result.include',
          status: 'accepted',
          receipt: { outcome: 'result_queued', runId: 'active' },
        },
      };
    },
  } as unknown as AgentClient;
  const host = new NativeContext(
      client,
      () => scope,
      () => {},
    ),
    facts = await host.read('s');
  expect(
    await code(
      host.include(facts.observationId, 'job', '1', {
        storeId: 'store',
        sessionId: 's',
        contextSelectionId: 'selection',
      }),
    ),
  ).toBe('input_busy');
  expect(posts).toBe(0);
  await host.include(facts.observationId, 'job', '1', {
    storeId: 'store',
    sessionId: 's',
    contextSelectionId: 'selection',
    targetRunId: 'active',
  });
  expect(posts).toBe(1);
  expect(host.submissions.at(-1)?.phase).toBe('queued');
  target = 'new';
  const other = new NativeContext(
      client,
      () => scope,
      () => {},
    ),
    newFacts = await other.read('s');
  expect(
    await code(
      other.include(newFacts.observationId, 'job', '1', {
        storeId: 'store',
        sessionId: 's',
        contextSelectionId: 'selection',
        targetRunId: 'active',
      }),
    ),
  ).toBe('input_target_changed');
  expect(posts).toBe(1);
});

test('Native context retries an oversized page at the same frozen selection and cursors, and rejects one untransferable item without truncation', async () => {
  const scope = { generation: 1, selection: 1, storeId: 'store', sessionId: 's', workspaceId: 'w' };
  const calls: Parameters<AgentClient['getContext']>[1][] = [];
  let single = false;
  const client = {
    serverInfo: { capabilities: ['context'] },
    async getContext(_session: string, query: Parameters<AgentClient['getContext']>[1]) {
      calls.push(query);
      return page(
        [
          {
            ...message(1),
            content:
              single || query!.messageLimit! > 100 ? 'x'.repeat(4200000) : 'complete small page',
          },
        ],
        [],
        '1',
      );
    },
  } as unknown as AgentClient;
  const host = new NativeContext(
    client,
    () => scope,
    () => {},
  );
  const value = await host.read('s');
  expect(value.page.messages[0]?.content).toBe('complete small page');
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({
    contextSelectionId: 'selection',
    upperSeq: '205',
    messageLimit: 100,
    sourceLimit: 50,
  });
  expect(calls[1]?.afterSeq).toBeUndefined();
  single = true;
  expect(await code(host.read('s'))).toBe('context_page_too_large');
  expect(calls.at(-1)).toMatchObject({
    contextSelectionId: 'selection',
    upperSeq: '205',
    messageLimit: 1,
    sourceLimit: 1,
  });
  expect(await code(Promise.resolve().then(() => host.rewind(value.observationId, null)))).toBe(
    'context_observation_changed',
  );
});

test('Native context view close aborts only its GET and late old selection cannot publish a new observation', async () => {
  let scope = { generation: 1, selection: 1, storeId: 'store', sessionId: 's', workspaceId: 'w' };
  let finish!: (value: SelectedContextPage) => void, signal!: AbortSignal;
  const waiting = new Promise<SelectedContextPage>((resolve) => {
    finish = resolve;
  });
  const client = {
    serverInfo: { capabilities: ['context'] },
    getContext(_session: string, _query: unknown, options: { signal: AbortSignal }) {
      signal = options.signal;
      return waiting;
    },
  } as unknown as AgentClient;
  const host = new NativeContext(
    client,
    () => scope,
    () => {},
  );
  const reading = host.read('s', false, 'original-read');
  host.close('other-read');
  expect(signal.aborted).toBe(false);
  host.close('original-read');
  expect(signal.aborted).toBe(true);
  scope = { ...scope, selection: 2, sessionId: 'other' };
  finish(page([], []));
  expect(await code(reading)).not.toBe('success');
  expect(host.submissions).toHaveLength(0);
  expect(await code(Promise.resolve().then(() => host.rewind(1, null)))).toBe(
    'context_observation_changed',
  );
});

test('Native Context IPC closes nested scope/boundary and exact decimal revisions without accepting authority extras', () => {
  const include = {
    method: 'context.include' as const,
    generation: 1,
    observationId: 1,
    executionId: 'job',
    resultRevision: '9223372036854775807',
    scope: {
      storeId: 'store',
      sessionId: 's',
      contextSelectionId: 'selection',
      targetRunId: 'run',
    },
  };
  expect(decodeNativeRequest(include)).toEqual(include);
  for (const value of [
    { ...include, scope: { ...include.scope, subjectId: 'intruder' } },
    { ...include, resultRevision: '9223372036854775808' },
    { ...include, scope: { ...include.scope, targetRunId: '' } },
    {
      method: 'context.rewind',
      generation: 1,
      observationId: 1,
      boundary: { messageId: 'm', seq: '01' },
    },
    {
      method: 'context.rewind',
      generation: 1,
      observationId: 1,
      boundary: { messageId: 'm', seq: '1', storeId: 'other' },
    },
  ])
    expect(() => decodeNativeRequest(value)).toThrow('invalid_native_request');
});

test('Native restored suppressed Job Include binds current Store command and rejects missing origin, wrong revision and old Store scope before POST', async () => {
  const scope = {
    generation: 1,
    selection: 1,
    storeId: 'restored-B',
    sessionId: 's',
    workspaceId: 'w',
  };
  const envelope = { storeId: scope.storeId, sessionId: 's', contextSelectionId: 'selection' };
  let originStoreId: string | undefined = 'original-A';
  const posts: {
    sessionId: string;
    executionId: string;
    input: Parameters<AgentClient['includeResult']>[2];
  }[] = [];
  const client = {
    serverInfo: { capabilities: ['context'] },
    getContext: async () => page([], []),
    getView: async () => ({
      storeId: scope.storeId,
      session: { id: 's', workspaceId: 'w', contextSelectionId: 'selection', deletedAt: null },
      runs: [],
      executions: [
        {
          id: 'original-job',
          kind: 'job',
          originStoreId,
          resultRevision: '7',
          delivery: 'suppressed',
          status: 'succeeded',
        },
      ],
    }),
    async includeResult(
      sessionId: string,
      executionId: string,
      input: Parameters<AgentClient['includeResult']>[2],
    ) {
      posts.push({ sessionId, executionId, input });
      return {
        command: {
          id: input.commandId,
          originStoreId: scope.storeId,
          sessionId,
          kind: 'result.include',
          status: 'applied',
          receipt: { outcome: 'result_included' },
        },
      };
    },
  } as unknown as AgentClient;
  const host = () =>
    new NativeContext(
      client,
      () => scope,
      () => {},
    );
  const current = host(),
    facts = await current.read('s');
  const command = await current.include(facts.observationId, 'original-job', '7', envelope);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({
    sessionId: 's',
    executionId: 'original-job',
    input: {
      expectedStoreId: 'restored-B',
      expectedContextSelectionId: 'selection',
      resultRevision: '7',
    },
  });
  expect(posts[0]!.input.commandId).toBeTruthy();
  expect(command).toMatchObject({
    id: posts[0]!.input.commandId,
    originStoreId: 'restored-B',
    kind: 'result.include',
    status: 'applied',
  });
  expect(current.submissions.at(-1)?.phase).toBe('applied');
  posts.length = 0;
  originStoreId = undefined;
  const missing = host(),
    missingFacts = await missing.read('s');
  expect(
    await code(missing.include(missingFacts.observationId, 'original-job', '7', envelope)),
  ).toBe('historical_result_unavailable');
  expect(posts).toHaveLength(0);
  originStoreId = 'original-A';
  const wrong = host(),
    wrongFacts = await wrong.read('s');
  expect(await code(wrong.include(wrongFacts.observationId, 'original-job', '8', envelope))).toBe(
    'historical_result_unavailable',
  );
  expect(posts).toHaveLength(0);
  const old = host(),
    oldFacts = await old.read('s');
  expect(
    await code(
      Promise.resolve().then(() =>
        old.include(oldFacts.observationId, 'original-job', '7', {
          ...envelope,
          storeId: 'original-A',
        }),
      ),
    ),
  ).toBe('context_selection_changed');
  expect(posts).toHaveLength(0);
});
