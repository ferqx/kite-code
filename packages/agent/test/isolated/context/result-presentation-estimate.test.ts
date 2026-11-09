import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import type { Extension, ToolDefinition } from '../../../src/extensions';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} as const;

for (const mode of ['run', 'step'] as const)
  test(`context forecast uses the captured ${mode} result presentation or explicitly declines, including cold reads`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-presentation-estimate-')));
    const profile = { dataRoot: join(root, 'data'), profile: 'test' };
    let store = await openSqliteStore(profile);
    const scope = {
      expectedStoreId: (await store.getMetadata()).storeId,
      sessionId: 's',
      subjectId: 'owner',
    };
    let calls = 0,
      resolutions = 0,
      capabilityReads = 0;
    const requests: ModelRequest[] = [];
    let releaseModel!: () => void;
    const modelRelease = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    let modelEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      modelEntered = resolve;
    });
    const tool: ToolDefinition = {
      id: 'source',
      version: '1',
      description: 'source',
      inputSchema: { type: 'object' },
      model: { name: 'source', resultVersion: '1' },
      formatModelResult: () => 'SHORT',
      async execute() {
        calls++;
        return { outcome: 'succeeded', content: 'x'.repeat(200000) };
      },
    };
    const extension: Extension = { id: 'owned', version: '1', apiMajor: 1, tools: [tool] };
    let runtime: ReturnType<typeof createRuntime>;
    const model: ModelAdapter = {
      async *stream(request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          yield { type: 'tool_call', id: 'read', name: 'source', arguments: '{}' };
          yield { ...finish, reason: 'tool_calls' };
          return;
        }
        expect(request.messages.find((message) => message.role === 'tool')?.content).toBe('SHORT');
        modelEntered();
        await modelRelease;
        yield { type: 'text_delta', text: 'done' };
        yield finish;
      },
    };
    const permissions = { authorize: async () => ({ allowed: true, revision: 'owned' }) };
    runtime = createRuntime({
      store,
      model,
      modelId: 'fixed',
      permissions,
      resolveRunConfiguration: async () => {
        resolutions++;
        return {
          model,
          modelId: 'fixed',
          snapshot: {},
          extensions: mode === 'run' ? [extension] : [],
          ...(mode === 'step'
            ? {
                readStepCapabilities: async () => {
                  capabilityReads++;
                  return { extensions: [extension], snapshot: { catalogue: 'selected' } };
                },
              }
            : {}),
        };
      },
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId: scope.expectedStoreId,
        id: 'w',
        name: 'w',
        rootUri: pathToFileURL(root).href,
      });
      await runtime.createSession({ ...scope, commandId: 'create', workspaceId: 'w', title: 't' });
      await runtime.submitCommand({
        ...scope,
        commandId: 'start',
        request: { kind: 'run.start', content: 'Read once.' },
      });
      await entered;
      const liveInput = { ...scope, executionId: requests[1]!.requestId };
      const beforeLive = { resolutions, capabilityReads, calls };
      if (mode === 'run')
        expect((await runtime.readContextEstimate(liveInput)).totalInputTokens).toBeLessThan(1000);
      expect({ resolutions, capabilityReads, calls }).toEqual(beforeLive);
      releaseModel();
      const applied = await runtime.waitForCommand('start', { timeoutMs: 10000 });
      expect((await store.getRun((applied.receipt as { runId: string }).runId))?.status).toBe(
        'completed',
      );
      expect(calls).toBe(1);
      expect(requests).toHaveLength(2);
      const input = { ...scope, executionId: requests[1]!.requestId };
      if (mode === 'step')
        expect(
          await runtime.readContextEstimate({ ...input, executionId: requests[0]!.requestId }).then(
            () => null,
            (error: { code: string }) => error.code,
          ),
        ).toBe('context_estimate_unavailable');
      const expected = await runtime.readContextEstimate(input);
      await runtime.close();
      store = await openSqliteStore(profile);
      runtime = createRuntime({ store, model, modelId: 'fixed', permissions });
      const before = { resolutions, capabilityReads, calls, models: requests.length };
      expect((await runtime.readContextEstimate(input)).totalInputTokens).toBe(
        expected.totalInputTokens,
      );
      expect((await runtime.readModelInput(input)).request).toEqual(requests[1]!);
      const unchangedSnapshot = await store.getModelInputSnapshot(input);
      expect(Object.keys(unchangedSnapshot.metadata as object).sort()).toEqual([
        'adapter',
        'assembly',
        'context',
        'version',
      ]);
      expect({ resolutions, capabilityReads, calls, models: requests.length }).toEqual(before);
      const toolId = requests[1]!.messages.find((message) => message.role === 'tool')!
        .sourceIds![0]!;
      const readExecution = store.getExecution.bind(store);
      for (const fault of ['result', 'running', 'scope'] as const) {
        store.getExecution = async (id) => {
          const value = await readExecution(id);
          if (value?.id !== toolId) return value;
          return fault === 'result'
            ? {
                ...value,
                result: { ...(value.result as object), content: 'changed original result' },
              }
            : fault === 'running'
              ? { ...value, status: 'running' }
              : { ...value, sessionId: 'foreign' };
        };
        expect(
          await runtime.readContextEstimate(input).then(
            () => null,
            (error: { code: string }) => error.code,
          ),
        ).toBe('context_estimate_unavailable');
      }
      store.getExecution = readExecution;
      await runtime.close();
      store = await openSqliteStore(profile);
      // New formatter code must not reinterpret a sealed historical presentation.
      runtime = createRuntime({
        store,
        model,
        modelId: 'fixed',
        permissions,
        extensions: [
          {
            ...extension,
            tools: [
              {
                ...tool,
                model: { ...tool.model!, resultVersion: '2' },
                formatModelResult: () => {
                  throw Error('historical formatter must not run');
                },
              },
            ],
          },
        ],
      });
      expect((await runtime.readContextEstimate(input)).totalInputTokens).toBe(
        expected.totalInputTokens,
      );
      expect({ resolutions, capabilityReads, calls, models: requests.length }).toEqual(before);
    } finally {
      releaseModel();
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);

test('a completed plain reply remains estimable when an unused captured formatter is no longer registered', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-unused-presentation-estimate-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  let store = await openSqliteStore(profile);
  const scope = {
    expectedStoreId: (await store.getMetadata()).storeId,
    sessionId: 's',
    subjectId: 'owner',
  };
  let modelCalls = 0,
    toolCalls = 0,
    resolutions = 0;
  let requestId = '';
  const model: ModelAdapter = {
    async *stream(request) {
      modelCalls++;
      requestId = request.requestId;
      yield { type: 'text_delta', text: 'Hello.' };
      yield finish;
    },
  };
  const tool: ToolDefinition = {
    id: 'unused',
    version: '1',
    description: 'unused',
    inputSchema: { type: 'object' },
    model: { name: 'unused', resultVersion: '1' },
    formatModelResult: () => 'SHORT',
    async execute() {
      toolCalls++;
      return { outcome: 'succeeded', content: 'unused' };
    },
  };
  const permissions = { authorize: async () => ({ allowed: true, revision: 'owned' }) };
  let runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    permissions,
    resolveRunConfiguration: async () => {
      resolutions++;
      return {
        model,
        modelId: 'fixed',
        snapshot: {},
        extensions: [{ id: 'owned', version: '1', apiMajor: 1, tools: [tool] }],
      };
    },
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: scope.expectedStoreId,
      id: 'w',
      name: 'w',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      ...scope,
      commandId: 'create',
      workspaceId: 'w',
      title: 'greeting',
    });
    await runtime.submitCommand({
      ...scope,
      commandId: 'start',
      request: { kind: 'run.start', content: 'Hello.' },
    });
    await runtime.waitForCommand('start', { timeoutMs: 10000 });
    const before = { modelCalls, toolCalls, resolutions };
    expect(
      (await runtime.readContextEstimate({ ...scope, executionId: requestId })).totalInputTokens,
    ).toBeGreaterThan(0);
    expect({ modelCalls, toolCalls, resolutions }).toEqual(before);
    await runtime.close();
    store = await openSqliteStore(profile);
    runtime = createRuntime({ store, model, modelId: 'fixed', permissions });
    expect(
      (await runtime.readContextEstimate({ ...scope, executionId: requestId })).totalInputTokens,
    ).toBeGreaterThan(0);
    expect({ modelCalls, toolCalls, resolutions }).toEqual(before);
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
