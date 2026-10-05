import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import {
  createFixedModel,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
} from '@kite-ai/ai';
import { createRuntime, type RunConfiguration, type RuntimeOptions } from '../../../src';
import type { ContextSources, SourceRequest } from '../../../src/context';
import type {
  Extension,
  JobDefinition,
  JobEvent,
  OperationRef,
  ToolDefinition,
} from '../../../src/extensions';
import { createWorkspaceSerialLocks } from '../../../src/resources';
import { openSqliteStore } from '../../../src/sqlite';
import type { CommandRequest, Json } from '../../../src/storage/types';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (value: Json = {}, name = 'fixture.tool'): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(value) },
  { ...finish, reason: 'tool_calls' },
];
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture(options: Omit<RuntimeOptions, 'store'>) {
  const dataRoot = mkdtempSync('/private/tmp/kite-run-bindings-');
  chmodSync(dataRoot, 0o700);
  const profile = { dataRoot, profile: 'test' };
  const store = await openSqliteStore(profile);
  const runtime = createRuntime({ ...options, store });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: `file://${dataRoot}`,
    name: 'temporary',
  });
  const create = (id: string) =>
    runtime.createSession({
      expectedStoreId,
      sessionId: id,
      workspaceId: 'w',
      commandId: `create-${id}`,
      subjectId: 'owner',
      title: id,
    });
  await create('s');
  const submit = (
    commandId: string,
    sessionId = 's',
    request: CommandRequest = { kind: 'run.start', content: commandId },
  ) =>
    runtime.submitCommand({ expectedStoreId, commandId, sessionId, subjectId: 'owner', request });
  const done = async (commandId: string) => {
    const command = await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
    const runId = (command.receipt as { runId?: string })?.runId;
    return { command, run: runId ? await store.getRun(runId) : null };
  };
  return {
    store,
    runtime,
    profile,
    expectedStoreId,
    create,
    submit,
    done,
    close: async () => {
      await runtime.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}
const permissions = {
  async authorize() {
    return { allowed: true, revision: '1' };
  },
};
function extension(tool: ToolDefinition, jobs: JobDefinition[] = []): Extension {
  return { id: 'fixture', version: tool.version, apiMajor: 1, tools: [tool], jobs };
}

test('actual model schemas and persisted manifest use per-Run clones: active v1 stays sealed while new v2 resolves independently', async () => {
  const entered = gate(),
    release = gate(),
    disposed1 = gate(),
    disposed2 = gate();
  const effects: string[] = [];
  const requests: ModelRequest[] = [];
  let disposals1 = 0,
    disposals2 = 0;
  const schema1 = {
    type: 'object',
    properties: { value: { enum: ['v1'] } },
    required: ['value'],
    additionalProperties: false,
  };
  const resources1 = {
    serial: { scope: 'workspace' as const, key: 'original-key' },
    slot: 'process' as const,
  };
  const tool1: ToolDefinition = {
    id: 'fixture.tool',
    version: '1',
    description: 'version one',
    inputSchema: schema1,
    resources: resources1,
    async execute() {
      effects.push('v1');
      return { outcome: 'succeeded', content: 'v1' };
    },
  };
  const tool2: ToolDefinition = {
    id: 'fixture.tool',
    version: '2',
    description: 'version two',
    inputSchema: {
      type: 'object',
      properties: { value: { enum: ['v2'] } },
      required: ['value'],
      additionalProperties: false,
    },
    async execute() {
      effects.push('v2');
      return { outcome: 'succeeded', content: 'v2' };
    },
  };
  const v1 = createFixedModel([call({ value: 'v1' }), [finish]]),
    v2 = createFixedModel([call({ value: 'v2' }), [finish]]);
  let first = true;
  const model1: ModelAdapter = {
    async *stream(request, options) {
      requests.push(structuredClone(request));
      if (first) {
        first = false;
        entered.release();
        await release.promise;
      }
      yield* v1.stream(request, options);
    },
  };
  let selected = 0;
  let locks: ReturnType<typeof createWorkspaceSerialLocks> | undefined;
  const acquired: string[] = [];
  const f = await fixture({
    permissions,
    modelConcurrency: 2,
    processConcurrency: 1,
    workspaceSerialLocks: {
      async acquire(input, signal) {
        acquired.push(input.key);
        return locks!.acquire(input, signal);
      },
    },
    async resolveRunConfiguration() {
      selected++;
      return selected === 1
        ? {
            model: model1,
            modelId: 'model-v1',
            extensions: [extension(tool1)],
            toolIds: ['fixture.tool'],
            snapshot: { version: 1 },
            async dispose() {
              disposals1++;
              disposed1.release();
            },
          }
        : {
            model: v2,
            modelId: 'model-v2',
            extensions: [extension(tool2)],
            toolIds: ['fixture.tool'],
            snapshot: { version: 2 },
            async dispose() {
              disposals2++;
              disposed2.release();
            },
          };
    },
  });
  locks = createWorkspaceSerialLocks(f.profile);
  try {
    await f.submit('old');
    await entered.promise;
    await f.create('s2');
    schema1.properties.value.enum[0] = 'tampered';
    resources1.serial.key = 'tampered-key';
    Object.assign(tool1, {
      description: 'tampered',
      version: '999',
      execute: async () => {
        effects.push('tampered');
        return { outcome: 'succeeded', content: 'tampered' };
      },
    });
    const active = await f.store.getCommand('old');
    const oldRun = await f.store.getRun((active!.receipt as { runId: string }).runId);
    expect(oldRun?.configuration).toMatchObject({
      modelId: 'model-v1',
      snapshot: { version: 1 },
      tools: [{ id: 'fixture.tool', version: '1', extensionId: 'fixture' }],
    });
    await f.submit('new', 's2');
    const newer = await f.done('new');
    await disposed2.promise;
    expect(newer.run?.status).toBe('completed');
    expect(newer.run?.configuration).toMatchObject({
      tools: [{ id: 'fixture.tool', version: '2', extensionId: 'fixture' }],
    });
    expect(disposals1).toBe(0);
    expect(v2.requests[0]?.tools).toEqual([
      {
        id: 'fixture.tool',
        definitionVersion: '2',
        description: 'version two',
        inputSchema: tool2.inputSchema,
      },
    ]);
    release.release();
    const older = await f.done('old');
    await disposed1.promise;
    expect(older.run?.status).toBe('completed');
    expect(requests[0]?.tools).toEqual([
      {
        id: 'fixture.tool',
        definitionVersion: '1',
        description: 'version one',
        inputSchema: {
          type: 'object',
          properties: { value: { enum: ['v1'] } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    ]);
    expect(effects).toEqual(['v2', 'v1']);
    expect(acquired).toEqual(['original-key']);
    expect(disposals1).toBe(1);
    expect(disposals2).toBe(1);
    const executions = await f.store.listExecutions('s', 100);
    expect(executions.filter((e) => e.kind === 'tool').map((e) => e.definitionVersion)).toEqual([
      '1',
    ]);
  } finally {
    release.release();
    await f.close();
    await locks?.close();
  }
  expect(disposals1).toBe(1);
  expect(disposals2).toBe(1);
});

test('unknown or duplicate host selections reject before any Model; failed admission disposes and public JSON cannot inject definitions', async () => {
  const model = createFixedModel([[finish]]);
  let disposed = 0;
  let resolution = 0;
  const tool: ToolDefinition = {
    id: 'fixture.tool',
    version: '1',
    description: 'host only',
    inputSchema: { type: 'object' },
    async execute() {
      throw new Error('not expected');
    },
  };
  const f = await fixture({
    permissions,
    async resolveRunConfiguration() {
      const toolIds = resolution++ === 0 ? ['unknown'] : ['fixture.tool', 'fixture.tool'];
      return {
        model,
        modelId: 'fixed',
        extensions: [extension(tool)],
        toolIds,
        snapshot: null,
        async dispose() {
          disposed++;
        },
      };
    },
  });
  try {
    for (const id of ['unknown', 'duplicate']) {
      await f.submit(id);
      const result = await f.done(id);
      expect(result.command.status).toBe('rejected');
      expect(result.run).toBeNull();
    }
    expect((await f.store.getCommand('unknown'))?.receipt).toEqual({ reason: 'tool_unavailable' });
    expect((await f.store.getCommand('duplicate'))?.receipt).toEqual({
      reason: 'invalid_tool_configuration',
    });
    expect(model.requests).toHaveLength(0);
    expect(disposed).toBe(2);
  } finally {
    await f.close();
  }
  expect(disposed).toBe(2);
  const safe = createFixedModel([call({}, 'public.injected'), [finish]]);
  let executed = 0;
  const g = await fixture({
    permissions,
    model: safe,
    modelId: 'fixed',
    extensions: [
      extension({
        ...tool,
        async execute() {
          executed++;
          return { outcome: 'succeeded', content: 'host' };
        },
      }),
    ],
  });
  try {
    const rejection = await g
      .submit('injection', 's', {
        kind: 'run.start',
        content: 'injection',
        extensions: [
          {
            id: 'evil',
            tools: [{ id: 'public.injected', version: '1', inputSchema: { type: 'object' } }],
          },
        ],
        toolIds: ['public.injected'],
      } as unknown as CommandRequest)
      .then(
        () => null,
        (error) => error,
      );
    expect(rejection).toMatchObject({ code: 'invalid_input_request' });
    expect(await g.store.getCommand('injection')).toBeNull();
    expect(safe.requests).toHaveLength(0);
    expect(executed).toBe(0);
    await g.submit('legal-request');
    const result = await g.done('legal-request');
    expect(result.run?.configuration).toMatchObject({
      tools: [{ id: 'fixture.tool', version: '1', extensionId: 'fixture' }],
    });
    expect(safe.requests[0]?.tools.map((t) => t.id)).toEqual(['fixture.tool']);
    expect(executed).toBe(0);
    const executions = await g.store.listExecutions('s', 100);
    expect(executions.find((e) => e.definitionId === 'public.injected')?.result).toMatchObject({
      content: 'tool_not_available',
    });
  } finally {
    await g.close();
  }
});

test('per-Run ContextSources reach actual Model and original Tool freshness; global fallback does not replace selected sources', async () => {
  const permissionEntered = gate(),
    permissionRelease = gate();
  let revision = 'one',
    effects = 0,
    fallback = 0;
  const captures: SourceRequest[] = [];
  const model = createFixedModel([call({ value: 'one' }), [finish]]);
  const sources: ContextSources = {
    async capture(request) {
      captures.push(structuredClone(request));
      return [
        {
          id: 'source',
          kind: 'fixture',
          scope: 'run-one',
          digest: revision,
          content: `selected ${revision}`,
        },
      ];
    },
  };
  const tool: ToolDefinition = {
    id: 'fixture.tool',
    version: '1',
    description: 'source sensitive',
    inputSchema: { type: 'object' },
    async execute() {
      effects++;
      return { outcome: 'succeeded', content: 'executed' };
    },
  };
  let held = false;
  const f = await fixture({
    sources: {
      async capture() {
        fallback++;
        return [];
      },
    },
    permissions: {
      async authorize(request) {
        if (request.kind === 'tool' && !held) {
          held = true;
          permissionEntered.release();
          await permissionRelease.promise;
        }
        return { allowed: true, revision: '1' };
      },
    },
    async resolveRunConfiguration() {
      return {
        model,
        modelId: 'per-run-model',
        extensions: [extension(tool)],
        sources,
        snapshot: { scope: 'one' },
      };
    },
  });
  try {
    await f.submit('source-work');
    await permissionEntered.promise;
    revision = 'two';
    permissionRelease.release();
    const result = await f.done('source-work');
    expect(result.run?.status).toBe('completed');
    expect(effects).toBe(0);
    expect(fallback).toBe(0);
    expect(
      model.requests[0]?.messages.filter((m) => m.role === 'system').map((m) => m.content),
    ).toEqual(['selected one']);
    expect(
      model.requests[1]?.messages.filter((m) => m.role === 'system').map((m) => m.content),
    ).toEqual(['selected two']);
    expect(captures.some((r) => r.definitionId === 'per-run-model')).toBe(true);
    expect(
      captures.some(
        (r) =>
          r.definitionId === 'fixture.tool' &&
          JSON.stringify(r.input) === JSON.stringify({ value: 'one' }),
      ),
    ).toBe(true);
    const executions = await f.store.listExecutions('s', 100);
    const failed = executions.find((e) => e.kind === 'tool');
    expect(failed?.status).toBe('failed');
    expect(failed?.result).toMatchObject({
      content: 'context_refresh_required',
      details: { adapterAttempted: false },
    });
    expect(failed?.decisionSource).toMatchObject({
      sources: [{ digest: 'one', scope: 'run-one' }],
    });
  } finally {
    permissionRelease.release();
    await f.close();
  }
});

test('ordinary background Job retains dynamic Run binding beyond parent completion and releases exactly at terminal or Runtime close', async () => {
  const settled = [gate(), gate()],
    started = [gate(), gate()],
    disposed = [gate(), gate()];
  const refs: OperationRef[] = [];
  const starts = [0, 0],
    jobDisposals = [0, 0],
    bindingDisposals = [0, 0],
    cancels = [0, 0];
  let selected = 0;
  function configuration(index: number): RunConfiguration {
    const version = String(index + 1);
    const job: JobDefinition = {
      id: 'fixture.job',
      version,
      description: `job ${version}`,
      inputSchema: { type: 'object' },
      async start() {
        starts[index]!++;
        started[index]!.release();
        return { reference: { version } };
      },
      async *observe(): AsyncIterable<JobEvent> {
        await settled[index]!.promise;
        yield {
          type: 'terminal',
          result: { outcome: 'succeeded', content: `version ${version}` },
          supervision: 'ended',
        };
      },
      async cancel() {
        cancels[index]!++;
        settled[index]!.release();
        return { status: 'stopped' };
      },
      async dispose() {
        jobDisposals[index]!++;
      },
    };
    const tool: ToolDefinition = {
      id: 'fixture.tool',
      version,
      description: 'start background',
      inputSchema: { type: 'object' },
      async execute(_input, context) {
        refs[index] = await context.operations.ensure({
          key: `background-${version}`,
          cancellation: 'detached',
          request: {
            kind: 'job',
            definitionId: 'fixture.job',
            definitionVersion: version,
            input: {},
          },
        });
        await started[index]!.promise;
        return { outcome: 'succeeded', content: 'background created' };
      },
    };
    return {
      model: createFixedModel([call(), [finish]]),
      modelId: `model-${version}`,
      extensions: [extension(tool, [job])],
      snapshot: { version },
      async dispose() {
        bindingDisposals[index]!++;
        disposed[index]!.release();
      },
    };
  }
  const f = await fixture({
    permissions,
    async resolveRunConfiguration() {
      return configuration(selected++);
    },
  });
  try {
    await f.submit('first');
    await started[0]!.promise;
    expect((await f.done('first')).run?.status).toBe('completed');
    expect(bindingDisposals).toEqual([0, 0]);
    expect(jobDisposals).toEqual([0, 0]);
    expect((await f.store.getExecution(refs[0]!.executionId!))?.definitionVersion).toBe('1');
    await f.submit('second');
    await started[1]!.promise;
    expect((await f.done('second')).run?.status).toBe('completed');
    expect(bindingDisposals).toEqual([0, 0]);
    expect(starts).toEqual([1, 1]);
    expect((await f.store.getExecution(refs[1]!.executionId!))?.definitionVersion).toBe('2');
    settled[0]!.release();
    await disposed[0]!.promise;
    expect(bindingDisposals).toEqual([1, 0]);
    expect(jobDisposals).toEqual([1, 0]);
    expect((await f.store.getExecution(refs[0]!.executionId!))?.status).toBe('succeeded');
    expect((await f.store.getExecution(refs[1]!.executionId!))?.status).toBe('running');
    await f.runtime.close();
    await disposed[1]!.promise;
    expect(bindingDisposals).toEqual([1, 1]);
    expect(jobDisposals).toEqual([1, 1]);
    expect(cancels).toEqual([0, 1]);
  } finally {
    for (const g of settled) g.release();
    await f.close();
  }
  expect(bindingDisposals).toEqual([1, 1]);
  expect(jobDisposals).toEqual([1, 1]);
});
