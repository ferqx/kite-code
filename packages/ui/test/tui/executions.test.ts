import { expect, test } from 'bun:test';
import type { Execution } from '@kite-ai/client';
import {
  jobStopReceipt,
  readJobOutput,
  type TuiExecutionPort,
  type TuiJobStop,
} from '../../src/tui/executions';

const target = {
  storeId: 'store',
  originStoreId: 'store',
  sessionId: 'original',
  executionId: 'job-one',
  definitionId: 'one',
  definitionVersion: '1',
};
const job: Execution = {
  id: target.executionId,
  originStoreId: target.storeId,
  sessionId: target.sessionId,
  runId: null,
  kind: 'job',
  definitionId: 'one',
  definitionVersion: '1',
  status: 'running',
  result: null,
  resultRevision: '0',
  cancelRequestedAt: null,
  parentExecutionId: 'parent',
  childSessionId: null,
};
const unavailable = async (): Promise<never> => {
  throw Error('unused reader');
};
const port = (read: TuiExecutionPort['output']): TuiExecutionPort => ({
  getExecution: async () => job,
  output: read,
  getView: unavailable,
  getRun: unavailable,
  messages: unavailable,
  modelOutput: unavailable,
  stop: unavailable,
  getCommand: unavailable,
});
test('original output high water assembles every UTF8 page and retains overlapping per-stream gaps', async () => {
  const chunks = Array.from({ length: 220 }, (_, i) => ({
    executionId: target.executionId,
    seq: String(i + 1),
    throughSeq: String(i + 1),
    stream: i % 2 ? ('stderr' as const) : ('stdout' as const),
    content: `原UTF8 ${i} 🙂e\u0301\n`,
    droppedBytes: '0',
  }));
  const queries: unknown[] = [];
  const output = await readJobOutput(
    port(async (_id, query) => {
      queries.push(query);
      return query.afterSeq === '0'
        ? { items: chunks.slice(0, 200), highWaterSeq: '223' }
        : {
            items: [
              ...chunks.slice(200),
              {
                executionId: target.executionId,
                seq: '221',
                throughSeq: '223',
                stream: 'stderr',
                content: '',
                droppedBytes: null,
              },
              {
                executionId: target.executionId,
                seq: '222',
                throughSeq: '222',
                stream: 'stdout',
                content: 'retained after other stream gap',
                droppedBytes: '0',
              },
            ],
            highWaterSeq: '300',
          };
    }),
    target,
    new AbortController().signal,
  );
  expect(queries).toEqual([
    { afterSeq: '0', limit: 200 },
    { afterSeq: '200', upperSeq: '223', limit: 200 },
  ]);
  expect(output.highWaterSeq).toBe('223');
  expect(output.items).toHaveLength(222);
  expect(
    output.items
      .slice(0, 220)
      .map((item) => item.content)
      .join(''),
  ).toBe(chunks.map((item) => item.content).join(''));
  expect(output.items.at(-2)).toMatchObject({
    seq: '221',
    throughSeq: '223',
    droppedBytes: null,
    content: '',
  });
});
for (const mismatch of ['store', 'session', 'id', 'kind'] as const)
  test(`output ${mismatch} mismatch fails before any output GET`, async () => {
    let reads = 0;
    const reader = port(async () => {
      reads++;
      throw Error('must not read');
    });
    reader.getExecution = async () => ({
      ...job,
      ...(mismatch === 'store'
        ? { originStoreId: 'foreign' }
        : mismatch === 'session'
          ? { sessionId: 'other' }
          : mismatch === 'id'
            ? { id: 'other' }
            : { kind: 'tool' as const }),
    });
    await expect(readJobOutput(reader, target, new AbortController().signal)).rejects.toThrow(
      'tui_job_identity_mismatch',
    );
    expect(reads).toBe(0);
  });
test('cancel receipt must bind actual original Job ID as well as Command kind/Store/Session; applied is only request acceptance', () => {
  const intent: TuiJobStop = {
    target,
    request: {
      kind: 'execution.cancel',
      expectedStoreId: 'store',
      commandId: 'stop-once',
      executionId: 'job-one',
    },
    phase: 'unknown',
  };
  const command = {
    id: 'stop-once',
    sessionId: 'original',
    originStoreId: 'store',
    kind: 'execution.cancel',
    status: 'applied' as const,
    cancelRequestedAt: null,
    receipt: {
      kind: 'execution.cancel',
      executionId: 'job-one',
      outcome: 'cancel_requested',
      affectedCount: 1,
    },
  };
  expect(jobStopReceipt(intent, command)).toBe('applied');
  for (const changed of [
    { kind: 'run.cancel' },
    { originStoreId: 'other' },
    { sessionId: 'other' },
    { id: 'other' },
    { receipt: { ...command.receipt, executionId: 'job-two' } },
    { receipt: { ...command.receipt, outcome: 'succeeded' } },
  ])
    expect(jobStopReceipt(intent, { ...command, ...changed })).toBe('unknown');
});

const parentView = {
  storeId: 'store',
  snapshotCursor: '1',
  session: {
    id: 'original',
    workspaceId: 'w',
    parentSessionId: null,
    rootSessionId: 'original',
    title: 'original',
    controlRevision: '0',
    contextSelectionId: 'parent-selection',
    nextSeq: '0',
    deletedAt: null,
  },
  runs: [],
  executions: [],
  messages: [],
} as import('@kite-ai/client').SessionView;
for (const mismatch of ['parent', 'root', 'workspace', 'store'] as const)
  test(`child reader rejects actual ${mismatch} relation before any history or mutation`, async () => {
    const { readChildLog } = await import('../../src/tui/executions');
    let history = 0,
      mutations = 0;
    const reader = port(unavailable);
    reader.getExecution = async (id) =>
      id === job.id
        ? { ...job, childSessionId: 'child' }
        : { ...job, id: 'parent', kind: 'tool', parentExecutionId: null };
    reader.getView = async () => ({
      ...parentView,
      storeId: mismatch === 'store' ? 'other' : 'store',
      session: {
        ...parentView.session,
        id: 'child',
        parentSessionId: mismatch === 'parent' ? 'other' : 'original',
        rootSessionId: mismatch === 'root' ? 'other' : 'original',
        workspaceId: mismatch === 'workspace' ? 'other' : 'w',
      },
    });
    reader.messages = async () => {
      history++;
      return [];
    };
    reader.stop = async () => {
      mutations++;
      throw Error('reader must not mutate');
    };
    await expect(
      readChildLog(reader, target, parentView, new AbortController().signal),
    ).rejects.toThrow('tui_child_scope_mismatch');
    expect(history).toBe(0);
    expect(mutations).toBe(0);
  });
test('child selection or carrier changed during paged read cannot publish original history', async () => {
  const { readChildLog } = await import('../../src/tui/executions');
  for (const change of ['selection', 'carrier'] as const) {
    let views = 0,
      carriers = 0,
      mutations = 0;
    const reader = port(unavailable);
    reader.getExecution = async (id) =>
      id === job.id
        ? {
            ...job,
            childSessionId: ++carriers > 1 && change === 'carrier' ? 'replacement' : 'child',
          }
        : { ...job, id: 'parent', kind: 'tool', parentExecutionId: null };
    reader.getView = async () => ({
      ...parentView,
      session: {
        ...parentView.session,
        id: 'child',
        parentSessionId: 'original',
        contextSelectionId:
          ++views > 1 && change === 'selection' ? 'replacement' : 'child-selection',
      },
    });
    reader.messages = async () => [];
    reader.stop = async () => {
      mutations++;
      throw Error('reader must not mutate');
    };
    await expect(
      readChildLog(reader, target, parentView, new AbortController().signal),
    ).rejects.toThrow(
      change === 'selection' ? 'tui_child_scope_changed' : 'tui_child_binding_changed',
    );
    expect(mutations).toBe(0);
  }
});

test('restored Job output binds its original definition and origin while admitting the current Store', async () => {
  const restored = { ...target, storeId: 'restored-store' };
  const saved = {
    executionId: job.id,
    seq: '1',
    throughSeq: '1',
    stream: 'stdout' as const,
    content: '完整原输出 α\nEND',
    droppedBytes: '0',
  };
  const reader = port(async () => ({ items: [saved], highWaterSeq: '1' }));
  expect(await readJobOutput(reader, restored, new AbortController().signal)).toEqual({
    items: [saved],
    highWaterSeq: '1',
  });
  reader.getExecution = async () => ({ ...job, definitionVersion: 'replacement' });
  await expect(readJobOutput(reader, restored, new AbortController().signal)).rejects.toThrow(
    'tui_job_identity_mismatch',
  );
});

test('restored child Model history verifies original Execution and Run but reads the admitted Store snapshot', async () => {
  const { readChildLog } = await import('../../src/tui/executions');
  const restored = { ...target, storeId: 'restored-store' },
    parent = { ...parentView, storeId: restored.storeId },
    child = {
      ...parent,
      session: {
        ...parent.session,
        id: 'child',
        parentSessionId: target.sessionId,
        contextSelectionId: 'child-selection',
        nextSeq: '1',
      },
    },
    model = {
      ...job,
      id: 'model',
      kind: 'model' as const,
      sessionId: 'child',
      runId: 'child-run',
      parentExecutionId: null,
      childSessionId: null,
      status: 'succeeded' as const,
      resultRevision: '1',
    },
    run = {
      id: 'child-run',
      sessionId: 'child',
      originStoreId: target.originStoreId,
      originCommandId: 'original-model',
      status: 'completed',
      isActive: false,
      createdAt: 1,
      finishedAt: 2,
      reason: null,
    } as import('@kite-ai/client').Run,
    body = '完整原Model正文 🌿\nTAIL',
    output = {
      storeId: restored.storeId,
      sessionId: 'child',
      rootSessionId: target.sessionId,
      runId: run.id,
      executionId: model.id,
      originCommandId: 'original-model',
      rootWorkCommandId: 'original-model',
      rootWorkSeq: '1',
      attempt: 1,
      status: 'succeeded' as const,
      bodyHash: 'verified-by-host',
      bodyBytes: String(Buffer.byteLength(body)),
      contentBytes: String(Buffer.byteLength(body)),
      reasoningBytes: '0',
      snapshotCursor: '1',
      output: { content: body, reasoning: '', toolCalls: [], complete: true },
    };
  const reader = port(unavailable);
  reader.getExecution = async (id) =>
    id === model.id
      ? model
      : id === job.id
        ? { ...job, childSessionId: 'child' }
        : { ...job, id: 'parent', kind: 'tool', parentExecutionId: null };
  reader.getView = async () => child;
  reader.getRun = async () => run;
  reader.messages = async () => [
    {
      id: 'message',
      sessionId: 'child',
      runId: run.id,
      role: 'assistant',
      content: 'preview',
      seq: '1',
      createdAt: 1,
      status: 'complete',
      outputBody: {
        kind: 'model_output',
        executionId: model.id,
        complete: true,
        contentBytes: output.contentBytes,
        reasoningBytes: '0',
        toolCallCount: 0,
      },
    },
  ];
  reader.modelOutput = async () => output;
  const result = await readChildLog(reader, restored, parent, new AbortController().signal);
  expect(result.carrier.originStoreId).toBe(target.originStoreId);
  expect(result.view.storeId).toBe(restored.storeId);
  expect(result.modelOutputs.get('message')).toEqual(output);
  reader.getRun = async () => ({ ...run, originStoreId: 'foreign' });
  await expect(
    readChildLog(reader, restored, parent, new AbortController().signal),
  ).rejects.toThrow('tui_child_model_origin_mismatch');
});
