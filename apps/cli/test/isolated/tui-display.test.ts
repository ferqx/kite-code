import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createConfigurationSnapshot,
  readConfigurationFile,
  resolveConfiguration,
} from '@kite-ai/agent/config';
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
  snapshot.executions[0]!.originStoreId = 'foreign';
  expect(
    tuiRecordedUsage(snapshot, [
      {
        ...message,
        originMessage: { storeId: 'foreign', sessionId: 'session', messageId: 'old', runId: 'run' },
      },
    ]),
  ).toBeUndefined();
});

test('Context estimates use the exact saved request and frozen explicit capabilities, and never follow another Model source', async () => {
  const snapshot = view();
  snapshot.executions[0]!.result = { content: 'complete' };
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-display-capacity-')));
  try {
    const path = join(root, 'config.jsonc');
    writeFileSync(
      path,
      JSON.stringify({
        modelId: 'actual',
        models: [
          {
            id: 'actual',
            provider: 'compatible',
            model: 'actual-remote',
            modelCapabilities: { contextWindowTokens: 10000, maxOutputTokens: 2000 },
            options: { maxOutputTokens: 1000 },
          },
        ],
      }),
      { mode: 0o600 },
    );
    const bytes = readFileSync(path);
    // This is the actual default Service's configuration loader/sealer, not a
    // hand-written capacity object that could bypass the projection whitelist.
    const frozen = createConfigurationSnapshot(
      resolveConfiguration({
        defaults: {},
        user: readConfigurationFile({ path }).value,
      }),
    );
    // Public Run DTOs carry the JSON serialization of this exact sealed value.
    snapshot.runs[0]!.configuration = JSON.parse(JSON.stringify(frozen));
    expect(readFileSync(path)).toEqual(bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const calls: string[] = [];
  let foreign = false;
  const reader = createTuiDisplayReader(
    {
      getModelInput: async (_session, executionId) => {
        calls.push(executionId);
        return {
          storeId: foreign ? 'foreign' : 'store',
          sessionId: 'session',
          rootSessionId: 'session',
          executionId,
          runId: 'run',
          originCommandId: 'command',
          bodyHash: 'a'.repeat(64),
          request: {
            modelId: 'actual',
            requestId: executionId,
            messages: [
              { role: 'system', content: '实际系统' },
              { role: 'user', content: `完整输入🙂${executionId}` },
            ],
            tools: [{ id: 'files.read', definitionVersion: '1', inputSchema: { type: 'object' } }],
          },
          metadata: { adapter: { availability: 'available', settings: { maxOutputTokens: 1000 } } },
        } as unknown as ModelInputSnapshot;
      },
      listSessionLogs: async () => {
        throw Error('no timings');
      },
    },
    'store',
  );
  const signal = new AbortController().signal;
  const first = await reader(snapshot, [], signal);
  expect(first.context).toMatchObject({
    source: 'model_input',
    storeId: 'store',
    sessionId: 'session',
    runId: 'run',
    executionId: 'model',
    modelId: 'actual',
    bodyHash: 'a'.repeat(64),
    usableInputTokens: 7976,
    reservedOutputTokens: 1000,
  });
  expect(first.context!.estimate.toolSchemaTokens).toBeGreaterThan(0);
  expect(first.context!.utilization).toBe(first.context!.estimate.totalInputTokens / 7976);
  expect((await reader(snapshot, [], signal)).context).toEqual(first.context);
  expect(calls).toEqual(['model']);
  snapshot.executions.push({ ...snapshot.executions[0]!, id: 'next-model' });
  foreign = true;
  expect((await reader(snapshot, [], signal)).context).toBeUndefined();
  foreign = false;
  const next = await reader(snapshot, [], signal);
  expect(next.context?.executionId).toBe('next-model');
  const other = { ...snapshot, session: { ...snapshot.session, id: 'other' } };
  expect((await reader(other, [], signal)).context).toBeUndefined();
  expect(calls).toEqual(['model', 'next-model', 'next-model']);
});

test('dynamic forecast and complete cumulative statistics update independently of cached last input', async () => {
  const snapshot = view();
  let bodies = 0,
    projections = 0,
    foreign = false,
    stable = false;
  const reader = createTuiDisplayReader(
    {
      async getModelInput() {
        bodies++;
        return {
          storeId: 'store',
          sessionId: 'session',
          rootSessionId: 'session',
          executionId: 'model',
          runId: 'run',
          originCommandId: 'command',
          bodyHash: 'a'.repeat(64),
          request: {
            modelId: 'custom',
            requestId: 'model',
            messages: [{ role: 'user', content: 'Original' }],
            tools: [],
          },
          metadata: { adapter: { availability: 'unavailable' } },
        } as unknown as ModelInputSnapshot;
      },
      async listSessionLogs() {
        throw Error('no logs');
      },
      async getContextEstimate() {
        projections++;
        return {
          storeId: 'store',
          sessionId: foreign ? 'foreign' : 'session',
          runId: 'run',
          modelId: 'custom',
          modelInputExecutionId: 'model',
          contextSelectionId: 'selection',
          highWaterSeq: String(10 + projections),
          snapshotCursor: stable ? snapshot.snapshotCursor : String(10 + projections),
          source: 'reported_baseline',
          measuredInputTokens: 100,
          estimatedInputTokens: projections * 10,
          totalInputTokens: 100 + projections * 10,
          baselineExecutionId: 'model',
          cumulativeUsage: {
            inputTokens: 99999,
            outputTokens: 100,
            executionCount: 300,
            missingInputCount: 2,
            missingOutputCount: 0,
          },
        };
      },
    },
    'store',
  );
  const first = await reader(snapshot, [], new AbortController().signal);
  const second = await reader(snapshot, [], new AbortController().signal);
  expect(first.context?.reportedInputTokens).toBe(100);
  expect(first.nextContext?.totalInputTokens).toBe(110);
  expect(second.nextContext?.totalInputTokens).toBe(120);
  expect(second.usage).toMatchObject({ scope: 'session', inputTokens: 99999, executionCount: 300 });
  expect(bodies).toBe(1);
  foreign = true;
  const unavailable = await reader(snapshot, [], new AbortController().signal);
  expect(unavailable.nextContext).toBeUndefined();
  expect(unavailable.usage).toMatchObject({ scope: 'observed', inputTokens: 100 });
  foreign = false;
  stable = true;
  await reader(snapshot, [], new AbortController().signal);
  const before = projections;
  await reader(snapshot, [], new AbortController().signal);
  expect(projections).toBe(before);
  snapshot.snapshotCursor = '20';
  await reader(snapshot, [], new AbortController().signal);
  expect(projections).toBe(before + 1);
});

test('Context follows actual input usage after a cached streaming read, retaining per-request fallback and zero', async () => {
  const snapshot = view();
  snapshot.runs[0]!.configuration = {
    version: 1,
    configuration: {
      modelId: 'actual',
      models: [
        { id: 'actual', modelCapabilities: { contextWindowTokens: 10000, maxOutputTokens: 1000 } },
      ],
    },
  };
  const model = snapshot.executions[0]!;
  model.status = 'running';
  model.result = null;
  const calls: string[] = [];
  const reader = createTuiDisplayReader(
    {
      async getModelInput(_session, executionId) {
        calls.push(executionId);
        return {
          storeId: 'store',
          sessionId: 'session',
          rootSessionId: 'session',
          executionId,
          runId: 'run',
          originCommandId: 'command',
          bodyHash: 'a'.repeat(64),
          request: {
            modelId: 'actual',
            requestId: executionId,
            messages: [{ role: 'user', content: 'Original full input.' }],
            tools: [],
          },
          metadata: { adapter: { availability: 'unavailable' } },
        } as unknown as ModelInputSnapshot;
      },
      async listSessionLogs() {
        throw Error('no timings');
      },
    },
    'store',
  );
  const signal = new AbortController().signal;
  const initial = (await reader(snapshot, [], signal)).context!;
  expect(initial.reportedInputTokens).toBeUndefined();
  expect(initial.utilization).toBe(initial.estimate.totalInputTokens / 7976);
  for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
    model.status = status;
    model.result = { usage: { inputTokens: 2345, outputTokens: 17 } };
    const current = (await reader(snapshot, [], signal)).context!;
    expect(current.reportedInputTokens).toBe(2345);
    expect(current.utilization).toBe(2345 / 7976);
    expect(current.estimate).toEqual(initial.estimate);
  }
  model.result = { usage: { inputTokens: 0 } };
  expect((await reader(snapshot, [], signal)).context).toMatchObject({
    reportedInputTokens: 0,
    utilization: 0,
  });
  for (const missing of [null, -1, 1.5]) {
    model.result = { usage: { inputTokens: missing } };
    const fallback = (await reader(snapshot, [], signal)).context!;
    expect(fallback.reportedInputTokens).toBeUndefined();
    expect(fallback.utilization).toBe(initial.utilization);
  }
  expect(calls).toEqual(['model']);
  model.result = { usage: { inputTokens: 2345 } };
  snapshot.executions.push({ ...model, id: 'next-model', status: 'running', result: null });
  const next = (await reader(snapshot, [], signal)).context!;
  expect(next.executionId).toBe('next-model');
  expect(next.reportedInputTokens).toBeUndefined();
  expect(calls).toEqual(['model', 'next-model']);
});

test('recorded usage includes exact failed and cancelled attempts once without requiring a completed message', () => {
  const snapshot = view();
  snapshot.executions.push(
    {
      ...snapshot.executions[0]!,
      id: 'failed',
      status: 'failed',
      result: { usage: { inputTokens: 30, outputTokens: 7, cachedInputTokens: 10 } },
    },
    {
      ...snapshot.executions[0]!,
      id: 'cancelled',
      status: 'cancelled',
      result: { usage: { inputTokens: 20, outputTokens: 3, cachedInputTokens: 0 } },
    },
    {
      ...snapshot.executions[0]!,
      id: 'unknown-usage',
      status: 'failed',
      result: { usage: { inputTokens: null, outputTokens: null } },
    },
    { ...snapshot.executions[0]!, id: 'foreign', originStoreId: 'foreign' },
  );
  expect(tuiRecordedUsage(snapshot, [])).toEqual({
    inputTokens: 150,
    outputTokens: 30,
    cachedInputTokens: 50,
    executionCount: 3,
  });
  const message = {
    id: 'answer',
    sessionId: 'session',
    runId: 'run',
    role: 'assistant',
    status: 'complete',
    content: 'complete',
    sourceIds: ['model'],
  } as Message;
  expect(tuiRecordedUsage(snapshot, [message, { ...message, id: 'duplicate' }])).toEqual(
    tuiRecordedUsage(snapshot, []),
  );
});

test('model display uses verified remote identity or the exact frozen route, preserving logical-ID fallback', async () => {
  const snapshot = view();
  snapshot.runs[0]!.configuration = {
    version: 1,
    configuration: {
      modelId: 'config-uuid',
      models: [{ id: 'config-uuid', model: 'frozen-route-model' }],
    },
  };
  const read = (available: boolean) =>
    createTuiDisplayReader(
      {
        getModelInput: async () =>
          ({
            storeId: 'store',
            sessionId: 'session',
            rootSessionId: 'session',
            executionId: 'model',
            runId: 'run',
            originCommandId: 'command',
            request: { modelId: 'config-uuid' },
            metadata: {
              adapter: available
                ? {
                    availability: 'available',
                    provider: {
                      availability: 'available',
                      family: 'compatible',
                      modelId: 'actual-remote-model',
                    },
                    settings: {},
                  }
                : { availability: 'unavailable', reason: 'adapter_opaque' },
            },
          }) as unknown as ModelInputSnapshot,
        listSessionLogs: async () => {
          throw Error('no timings');
        },
      },
      'store',
    )(snapshot, [], new AbortController().signal);
  expect((await read(true)).runtimeModel?.modelName).toBe('actual-remote-model');
  expect((await read(false)).runtimeModel?.modelName).toBe('frozen-route-model');
  snapshot.runs[0]!.configuration = {
    version: 1,
    configuration: {
      modelId: 'config-uuid',
      models: [{ id: 'later-default', model: 'unrelated-model' }],
    },
  };
  expect((await read(false)).runtimeModel?.modelName).toBe('config-uuid');
});
