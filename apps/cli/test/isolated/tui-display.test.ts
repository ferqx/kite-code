import { expect, test } from 'bun:test';
import type {
  AgentClient,
  Message,
  ModelInputSnapshot,
  PendingInputPage,
  SessionView,
} from '@kite-ai/client';
import {
  createTuiDisplayReader,
  readTuiPendingInputs,
  tuiRecordedUsage,
} from '../../host/tui-display';

function view(): SessionView {
  return {
    storeId: 'store',
    snapshotCursor: '10',
    session: { id: 'session', rootSessionId: 'session' },
    runs: [
      {
        id: 'run',
        sessionId: 'session',
        originStoreId: 'store',
        originCommandId: 'command',
        isActive: true,
        configuration: {
          version: 1,
          configuration: {
            modelId: 'frozen',
            models: [{ id: 'frozen', options: { reasoningEffort: 'low' } }],
          },
        },
      },
    ],
    executions: [
      {
        id: 'model',
        sessionId: 'session',
        runId: 'run',
        originStoreId: 'store',
        kind: 'model',
        status: 'succeeded',
        resultRevision: '1',
        result: {
          content: 'complete',
          usage: {
            inputTokens: 100,
            cachedInputTokens: 40,
            outputTokens: 20,
          },
        },
      },
    ],
    messages: [],
  } as unknown as SessionView;
}
test('public pending-directory pagination is complete and identity-checked, with a changing observation kept unavailable', async () => {
  const queries: string[] = [];
  const item = (index: number): PendingInputPage['commands'][number] => ({
    id: `p-${index}`,
    sessionId: 'session',
    originStoreId: 'store',
    seq: String(index),
    status: 'accepted',
    cancelRequestedAt: null,
    receipt: {},
    kind: 'input.follow_up',
    request: {
      kind: 'input.follow_up',
      content: `whole ${index}\n中文`,
      afterRunId: 'run',
      contextSelectionId: 'selection',
    },
  });
  let changed = false;
  const client: Pick<AgentClient, 'listPendingInputs'> = {
    listPendingInputs: async (_id, query) => {
      queries.push(query.afterSeq!);
      return query.afterSeq === '0'
        ? {
            commands: Array.from({ length: 200 }, (_, i) => item(i + 1)),
            nextAfterSeq: '200',
            snapshotCursor: '10',
          }
        : { commands: [item(201)], nextAfterSeq: null, snapshotCursor: changed ? '11' : '10' };
    },
  };
  const records = await readTuiPendingInputs(
    client,
    'store',
    'session',
    new AbortController().signal,
  );
  expect(records).toHaveLength(201);
  expect(records.at(-1)?.request.content).toBe('whole 201\n中文');
  expect(queries).toEqual(['0', '200']);
  changed = true;
  await expect(
    readTuiPendingInputs(client, 'store', 'session', new AbortController().signal),
  ).rejects.toThrow('observation_changed');
});
test('display uses the immutable Run and actual saved Model input, caches only finite facts and never substitutes a later default', async () => {
  const snapshot = view();
  let reads = 0;
  const client = {
    getModelInput: async () => {
      reads++;
      return {
        storeId: 'store',
        sessionId: 'session',
        rootSessionId: 'session',
        executionId: 'model',
        runId: 'run',
        originCommandId: 'command',
        request: { modelId: 'actual' },
        metadata: { adapter: { availability: 'available', settings: { reasoningEffort: 'high' } } },
      } as unknown as ModelInputSnapshot;
    },
    listSessionLogs: async () => {
      throw Error('older metadata unavailable');
    },
  } satisfies Pick<AgentClient, 'getModelInput' | 'listSessionLogs'>;
  const read = createTuiDisplayReader(client, 'store');
  const first = await read(snapshot, [], new AbortController().signal);
  expect(first.runtimeModel).toMatchObject({
    active: true,
    modelName: 'actual',
    effort: 'high',
    source: 'model_input',
  });
  const next = await read(snapshot, [], new AbortController().signal);
  expect(next.runtimeModel).toEqual(first.runtimeModel);
  expect(reads).toBe(1);
  const fallback = createTuiDisplayReader(
    {
      ...client,
      getModelInput: async () => {
        throw Error('cannot read');
      },
    },
    'store',
  );
  expect((await fallback(snapshot, [], new AbortController().signal)).runtimeModel).toMatchObject({
    modelName: 'frozen',
    effort: 'low',
    source: 'run_configuration',
  });
});
test('Context result inclusion advances a mixed page cursor without becoming a fabricated queued prompt', async () => {
  const queries: string[] = [];
  const include: PendingInputPage['commands'][number] = {
    id: 'include',
    sessionId: 'session',
    originStoreId: 'store',
    kind: 'result.include',
    status: 'accepted',
    cancelRequestedAt: null,
    receipt: {},
    seq: '1',
    request: {
      kind: 'result.include',
      expectedContextSelectionId: 'selection',
      executionId: 'old-tool',
      resultRevision: '1',
      targetRunId: 'run',
    },
  };
  const text: PendingInputPage['commands'][number] = {
    ...include,
    id: 'follow',
    kind: 'input.follow_up',
    seq: '2',
    request: {
      kind: 'input.follow_up',
      afterRunId: 'run',
      contextSelectionId: 'selection',
      content: 'exact next task',
    },
  };
  const records = await readTuiPendingInputs(
    {
      listPendingInputs: async (_id, query) => {
        queries.push(query.afterSeq!);
        return query.afterSeq === '0'
          ? { commands: [include], nextAfterSeq: '1', snapshotCursor: '3' }
          : { commands: [text], nextAfterSeq: null, snapshotCursor: '3' };
      },
    },
    'store',
    'session',
    new AbortController().signal,
  );
  expect(queries).toEqual(['0', '1']);
  expect(records).toHaveLength(1);
  expect(records[0]?.request.content).toBe('exact next task');
});

test('usage counts each original successful Model once; absent cache or foreign origin stays unavailable', () => {
  const snapshot = view();
  const message = {
    id: 'answer',
    sessionId: 'session',
    runId: 'run',
    status: 'complete',
    role: 'assistant',
    content: 'complete',
    sourceIds: ['model'],
  } as Message;
  expect(tuiRecordedUsage(snapshot, [message, { ...message, id: 'duplicate' }])).toEqual({
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 40,
    executionCount: 1,
  });
  snapshot.executions[0]!.result = { content: 'complete', usage: { inputTokens: 100 } };
  expect(tuiRecordedUsage(snapshot, [message])).toEqual({ inputTokens: 100, executionCount: 1 });
  expect(
    tuiRecordedUsage(snapshot, [
      {
        ...message,
        originMessage: { storeId: 'foreign', sessionId: 'session', messageId: 'old', runId: 'run' },
      },
    ]),
  ).toBeUndefined();
});
