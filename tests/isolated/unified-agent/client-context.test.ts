import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { startService } from '../../../apps/service/src';
import { createClient } from '../../../packages/client/src';

async function code(work: Promise<unknown>, expected: string) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string })?.code).toBe(expected);
}

test('actual HTTP context selection is idle CAS with original durable receipt and lossless bounded snapshot; historical messages are preserved', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-client-context-')));
  const selected = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(selected);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const model = createFixedModel([
    [
      { type: 'text_delta', text: 'old assistant' },
      { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
    [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
    [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
  ]);
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile: selected, store }),
    model,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  const profile = {
    dataRoot: realpathSync(selected.dataRoot),
    name: selected.profile,
    accessKey: resolveProfile(selected).profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile,
    buildId: 'context-fixture',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: { profile, apiMajor: 1, requiredCapabilities: ['context'] },
    bootstrap: service.bootstrap,
  });
  try {
    await client.connect();
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'temporary',
      rootUri: `file://${root}`,
    });
    await client.createSession({
      expectedStoreId,
      sessionId: 's',
      workspaceId: 'w',
      commandId: 'create',
      title: 'root',
    });
    const initial = await client.getContext('s', { storeId: expectedStoreId });
    expect(initial.messages).toHaveLength(0);
    await client.startRun('s', {
      expectedStoreId,
      commandId: 'run',
      kind: 'run.start',
      content: 'old user',
    });
    await runtime.waitForCommand('run', { timeoutMs: 5000 });
    expect((await client.getView('s')).runs[0]!.status).toBe('completed');
    const history = await client.listMessages('s');
    expect(history.map((message) => message.content)).toEqual(['old user', 'old assistant']);
    const snapshot = await client.getContext('s', { storeId: expectedStoreId, messageLimit: 1 });
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.nextAfterSeq).toBe(snapshot.messages[0]!.seq);
    const tail = await client.getContext('s', {
      storeId: expectedStoreId,
      contextSelectionId: snapshot.selection.id,
      afterSeq: snapshot.nextAfterSeq!,
      upperSeq: snapshot.highWaterSeq,
      messageLimit: 1,
    });
    expect(tail.messages).toHaveLength(1);
    expect(tail.highWaterSeq).toBe(snapshot.highWaterSeq);
    expect(tail.messages[0]!.id).toBe(history[1]!.id);
    const intent = {
      expectedStoreId,
      commandId: 'rewind',
      expectedContextSelectionId: initial.selection.id,
      boundary: null,
    };
    const before = await client.getView('s');
    await code(
      client.rewind('s', { ...intent, expectedStoreId: 'wrong-store' }),
      'store_identity_mismatch',
    );
    await code(
      client.rewind('s', {
        ...intent,
        boundary: { messageId: history[0]!.id, seq: history[1]!.seq },
      }),
      'context_boundary_invalid',
    );
    expect(await client.getView('s')).toEqual(before);
    const selectedContext = await client.rewind('s', intent);
    expect(selectedContext.command.status).toBe('applied');
    expect(selectedContext.selection.previousSelectionId).toBe(initial.selection.id);
    expect(selectedContext.selection.id).not.toBe(initial.selection.id);
    expect(await client.rewind('s', intent)).toEqual(selectedContext);
    await code(client.rewind('s', { ...intent, commandId: 'stale' }), 'context_selection_changed');
    await code(
      client.getContext('s', {
        storeId: expectedStoreId,
        contextSelectionId: initial.selection.id,
      }),
      'context_selection_changed',
    );
    const current = await client.getContext('s', { storeId: expectedStoreId });
    expect(current.messages).toHaveLength(0);
    expect(current.resultSources).toHaveLength(0);
    expect(current.selection).toEqual(selectedContext.selection);
    expect(await client.listMessages('s')).toEqual(history);
    expect(model.requests).toHaveLength(1);
    expect(client.lastAppliedCursor).toBeUndefined();
    const response = await fetch(
      `${service.endpoint}/v1/sessions/s/context?storeId=${expectedStoreId}&sourceLimit=101`,
      { headers: { Authorization: `Bearer ${service.bootstrap.token}` } },
    );
    expect(response.status).toBe(400);
    expect(await client.getContext('s', { storeId: expectedStoreId })).toEqual(current);
    await client.startRun('s', {
      expectedStoreId,
      commandId: 'new-run',
      kind: 'run.start',
      content: 'fresh selected input',
    });
    await runtime.waitForCommand('new-run', { timeoutMs: 5000 });
    expect((await client.getView('s')).runs.at(-1)!.status).toBe('completed');
    expect(model.requests).toHaveLength(2);
    expect(
      model.requests[1]!.messages.some(
        (message) =>
          message.content.includes('old user') || message.content.includes('old assistant'),
      ),
    ).toBe(false);
    expect(model.requests[1]!.messages).toContainEqual({
      role: 'user',
      content: 'fresh selected input',
      sourceIds: ['new-run'],
    });
    const fullContent = '\0'.repeat(1048576);
    const predecessor = (await client.getView('s')).runs.find(
      (run) => run.originCommandId === 'new-run',
    )!;
    await client.followUp('s', {
      expectedStoreId,
      commandId: 'full-context',
      kind: 'input.follow_up',
      content: fullContent,
      afterRunId: predecessor.id,
      contextSelectionId: selectedContext.selection.id,
    });
    await runtime.waitForCommand('full-context', { timeoutMs: 5000 });
    expect((await client.getView('s')).runs.at(-1)!.status).toBe('completed');
    expect(
      model.requests[2]!.messages.some(
        (message) => message.content === fullContent && message.sourceIds?.includes('full-context'),
      ),
    ).toBe(true);
    const fullPage = await client.getContext('s', { storeId: expectedStoreId, byteLimit: 8388608 });
    expect(
      fullPage.messages.find((message) => message.sourceIds?.includes('full-context'))?.content,
    ).toBe(fullContent);
    await code(
      client.getContext('s', { storeId: expectedStoreId, byteLimit: 4194304 }),
      'context_item_too_large',
    );
  } finally {
    client.disposeNetwork();
    try {
      await service.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 15000);

async function until<T>(read: () => Promise<T>, valid: (value: T) => boolean) {
  const deadline = Date.now() + 5000;
  while (true) {
    const value = await read();
    if (valid(value)) return value;
    if (Date.now() > deadline) throw new Error(`Context deadline: ${JSON.stringify(value)}`);
    await Bun.sleep(10);
  }
}

test('real detached Job blocks live rewind, terminal result is suppressed by idle rewind and explicit include preserves exact source without replay', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-result-context-')));
  const selected = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(selected);
  const expectedStoreId = (await store.getMetadata()).storeId;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let starts = 0;
  let executionId = '';
  const model = createFixedModel([
    [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
  ]);
  let releaseModel!: () => void;
  const modelGate = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  const blockedModel: import('@kite-ai/ai').ModelAdapter = {
    async *stream(request, options) {
      for await (const event of model.stream(request, options)) {
        await modelGate;
        options.signal.throwIfAborted();
        yield event;
      }
    },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile: selected, store }),
    model: blockedModel,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        actions: [
          {
            id: 'fixture.launch',
            version: '1',
            description: 'Explicit counted Job',
            inputSchema: { type: 'object' },
            async prepare(input) {
              return input;
            },
            async execute(_input, context) {
              const ref = await context.operations.ensure({
                key: 'job',
                cancellation: 'detached',
                request: {
                  kind: 'job',
                  definitionId: 'fixture.job',
                  definitionVersion: '1',
                  input: {},
                },
              });
              executionId = ref.executionId!;
              return { outcome: 'succeeded', content: 'launched' };
            },
          },
        ],
        jobs: [
          {
            id: 'fixture.job',
            version: '1',
            description: 'Finite harmless result',
            inputSchema: { type: 'object' },
            async start() {
              starts++;
              return { reference: { id: 'explicit-job' } };
            },
            async *observe() {
              await gate;
              yield {
                type: 'terminal',
                result: { outcome: 'succeeded', content: 'saved result context' },
                supervision: 'ended',
              };
            },
            async cancel() {
              release();
              return { status: 'stopped' };
            },
            async dispose() {},
          },
        ],
      },
    ],
  });
  const profile = {
    dataRoot: realpathSync(selected.dataRoot),
    name: selected.profile,
    accessKey: resolveProfile(selected).profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile,
    buildId: 'result-context',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: { profile, apiMajor: 1, requiredCapabilities: ['context'] },
    bootstrap: service.bootstrap,
  });
  try {
    await client.connect();
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'temporary',
      rootUri: `file://${root}`,
    });
    await client.createSession({
      expectedStoreId,
      sessionId: 's',
      workspaceId: 'w',
      commandId: 'create',
      title: 'root',
    });
    const initial = await client.getContext('s', { storeId: expectedStoreId });
    await client.invokeExtension('s', {
      expectedStoreId,
      commandId: 'launch',
      kind: 'extension.invoke',
      extensionId: 'fixture',
      actionId: 'fixture.launch',
      definitionVersion: '1',
      input: {},
    });
    await runtime.waitForCommand('launch', { timeoutMs: 5000 });
    await until(
      async () => starts,
      (value) => value === 1,
    );
    const rewind = {
      expectedStoreId,
      commandId: 'rewind-result',
      expectedContextSelectionId: initial.selection.id,
      boundary: null,
    };
    await code(client.rewind('s', rewind), 'context_execution_unsettled');
    release();
    const job = await until(
      () => client.getExecution(executionId),
      (value) => value.status === 'succeeded',
    );
    expect(job.delivery).toBe('pending');
    expect(job.originStoreId).toBe(expectedStoreId);
    expect('subjectId' in job || 'ownerGeneration' in job || 'decisionSource' in job).toBe(false);
    const next = await client.rewind('s', rewind);
    expect((await client.getExecution(executionId)).delivery).toBe('suppressed');
    expect((await client.getContext('s', { storeId: expectedStoreId })).resultSources).toHaveLength(
      0,
    );
    const include = {
      expectedStoreId,
      commandId: 'include-result',
      expectedContextSelectionId: next.selection.id,
      resultRevision: job.resultRevision,
    };
    await code(
      client.includeResult('s', executionId, { ...include, resultRevision: '0' }),
      'result_revision_conflict',
    );
    await code(
      client.includeResult('s', executionId, {
        ...include,
        expectedContextSelectionId: initial.selection.id,
      }),
      'context_selection_changed',
    );
    await code(
      client.includeResult('s', executionId, { ...include, expectedStoreId: 'wrong-store' }),
      'store_identity_mismatch',
    );
    await code(
      client.includeResult('s', 'unknown-execution', include),
      'context_result_scope_denied',
    );
    await client.createSession({
      expectedStoreId,
      sessionId: 'unrelated',
      workspaceId: 'w',
      commandId: 'create-unrelated',
      title: 'unrelated',
    });
    const unrelated = await client.getContext('unrelated', { storeId: expectedStoreId });
    await code(
      client.includeResult('unrelated', executionId, {
        ...include,
        expectedContextSelectionId: unrelated.selection.id,
      }),
      'context_result_scope_denied',
    );
    expect(await store.getCommand(include.commandId)).toBeNull();
    const included = await client.includeResult('s', executionId, include);
    expect(included.source).toMatchObject({
      executionId,
      resultRevision: job.resultRevision,
      originStoreId: expectedStoreId,
      createdSelectionId: next.selection.id,
      inclusion: 'explicit',
      result: { content: 'saved result context' },
    });
    expect(await client.includeResult('s', executionId, include)).toEqual(included);
    const current = await client.getContext('s', {
      storeId: expectedStoreId,
      contextSelectionId: next.selection.id,
    });
    expect(current.resultSources).toEqual([included.source]);
    expect((await client.getExecution(executionId)).delivery).toBe('suppressed');
    expect(starts).toBe(1);
    expect(model.requests).toHaveLength(0);
    expect(client.lastAppliedCursor).toBeUndefined();
    await client.startRun('s', {
      expectedStoreId,
      commandId: 'use-included-result',
      kind: 'run.start',
      content: 'use the explicitly included result',
    });
    await until(
      async () => model.requests.length,
      (value) => value === 1,
    );
    await code(
      client.includeResult('s', executionId, { ...include, commandId: 'busy-include' }),
      'input_target_changed',
    );
    expect(await store.getCommand('busy-include')).toBeNull();
    expect(starts).toBe(1);
    releaseModel();
    await runtime.waitForCommand('use-included-result', { timeoutMs: 5000 });
    expect((await client.getView('s')).runs.at(-1)!.status).toBe('completed');
    expect(model.requests).toHaveLength(1);
    const saved = model.requests[0]!.messages.filter((message) =>
      message.sourceIds?.includes(included.source.id),
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]!.role).toBe('user');
    expect(saved[0]!.content).toContain('saved result context');
    expect(saved[0]!.sourceIds).toEqual([included.source.id]);
    expect(JSON.parse(saved[0]!.content.slice(saved[0]!.content.indexOf('\n') + 1))).toEqual({
      kind: 'job_result',
      origin: { executionId, resultRevision: job.resultRevision, storeId: expectedStoreId },
      inclusion: 'explicit',
      result: included.source.result,
    });

    expect(starts).toBe(1);
    expect((await client.getExecution(executionId)).delivery).toBe('suppressed');
  } finally {
    release();
    releaseModel();
    client.disposeNetwork();
    try {
      await service.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 15000);
