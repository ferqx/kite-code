import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { createRuntime, type RuntimeOptions } from '../../../src';
import type { ArtifactContentStore } from '../../../src/artifact-port';
import { createArtifactStore } from '../../../src/artifacts';
import { artifactPath } from '../../../src/artifacts-files';
import type { ModelBodyReference } from '../../../src/model-body';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage/types';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: '{}' },
  { ...finish, type: 'finish', reason: 'tool_calls' },
];
async function code(work: Promise<unknown>, expected: string) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string })?.code).toBe(expected);
}
async function setup(model: ModelAdapter, options: Partial<RuntimeOptions> = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-model-input-')));
  const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const artifacts = createArtifactStore({ profile, store });
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    modelConcurrency: 1,
    artifacts,
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    ...options,
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'private',
    rootUri: `file://${directory}`,
  });
  await runtime.createSession({
    expectedStoreId,
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'owner',
    commandId: 'create',
    title: 'inspector',
  });
  const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  return {
    directory,
    profile,
    store,
    artifacts,
    runtime,
    scope,
    async start(commandId = 'work') {
      await runtime.submitCommand({
        ...scope,
        commandId,
        request: { kind: 'run.start', content: 'original input' },
      });
    },
    async done(commandId = 'work') {
      await runtime.waitForCommand(commandId, { timeoutMs: 25000 });
    },
    async close() {
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('exact small Model input survives later steer and source changes; read authority, cloning and cold readonly reads do not execute', async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let version = 1,
    captures = 0;
  const model = createFixedModel([call('hold'), [finish]]);
  const f = await setup(model, {
    sources: {
      async capture() {
        captures++;
        return [
          {
            id: 'host',
            kind: 'fixture',
            scope: 's',
            digest: String(version),
            content: `original source ${version}`,
          },
        ];
      },
    },
    extensions: [
      {
        id: 'fixture',
        apiMajor: 1,
        version: '1',
        tools: [
          {
            id: 'hold',
            version: '1',
            description: 'finite barrier',
            inputSchema: { type: 'object' },
            async execute() {
              entered();
              await gate;
              return { outcome: 'succeeded', content: 'real effect' };
            },
          },
        ],
      },
    ],
  });
  try {
    await f.start();
    await started;
    const page = await f.runtime.listModelInputs(f.scope);
    expect(page.items).toHaveLength(1);
    const target = { ...f.scope, executionId: page.items[0]!.executionId };
    const saved = await f.runtime.readModelInput(target);
    expect(saved.confirmation).toBe('succeeded');
    expect(saved.request).toEqual(model.requests[0]!);
    expect(BigInt(saved.bodyBytes)).toBeLessThanOrEqual(65536n);
    const before = (await f.store.getMetadata()).lastChangeCursor,
      reads = captures;
    (saved.request.messages as unknown as { content: string }[])[0]!.content = 'caller rewrite';
    expect((await f.runtime.readModelInput(target)).request).toEqual(model.requests[0]!);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
    expect(captures).toBe(reads);
    const run = (await f.store.getView('s')).runs[0]!;
    await f.runtime.submitCommand({
      ...f.scope,
      commandId: 'steer',
      request: {
        kind: 'input.steer',
        targetRunId: run.id,
        contextSelectionId: (await f.store.getSession('s'))!.contextSelectionId,
        content: 'later guide',
      },
    });
    version = 2;
    release();
    await f.done();
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]!.messages.some((message) => message.content === 'later guide')).toBe(
      true,
    );
    expect((await f.runtime.readModelInput(target)).request).toEqual(model.requests[0]!);
    await code(
      f.runtime.readModelInput({ ...target, expectedStoreId: 'foreign' }),
      'store_identity_mismatch',
    );
    await code(
      f.runtime.readModelInput({ ...target, subjectId: 'intruder' }),
      'model_input_scope_denied',
    );
    const tool = (await f.store.listExecutions('s')).find(
      (execution) => execution.kind === 'tool',
    )!;
    await code(
      f.runtime.readModelInput({ ...target, executionId: tool.id }),
      'model_input_unavailable',
    );
    await f.runtime.createSession({
      ...f.scope,
      sessionId: 'other',
      commandId: 'other-create',
      workspaceId: 'w',
      title: 'other',
    });
    await code(
      f.runtime.readModelInput({ ...target, sessionId: 'other' }),
      'model_input_scope_denied',
    );
    await code(
      f.runtime.listModelInputs({ ...f.scope, subjectId: 'intruder' }),
      'model_input_scope_denied',
    );
    await f.runtime.close();
    const readonly = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    let calls = 0;
    const cold = createRuntime({
      store: readonly,
      modelId: 'unavailable',
      permissions: {
        async authorize() {
          throw new Error('read authorized execution');
        },
      },
      model: {
        async *stream() {
          calls++;
          yield finish;
        },
      },
      sources: {
        async capture() {
          throw new Error('read captured sources');
        },
      },
    });
    try {
      expect((await cold.readModelInput(target)).request).toEqual(model.requests[0]!);
      expect((await cold.listModelInputs(f.scope)).items).toHaveLength(2);
      expect((await readonly.getSession('s'))!.ownerInstanceId).toBeNull();
      expect(calls).toBe(0);
    } finally {
      await cold.close();
    }
  } finally {
    release();
    await f.close();
  }
}, 15000);

test('complete seventeen MiB input is verified without a body cap; cancelled reads, corruption, future format and receipt mismatch never return a prefix', async () => {
  const content = `start\n${'x'.repeat(17 * 1024 * 1024)}\nend`;
  const model = createFixedModel([[finish]]);
  const f = await setup(model, {
    sources: {
      async capture() {
        return [{ id: 'large', kind: 'fixture', scope: 's', digest: '1', content }];
      },
    },
  });
  let release!: () => void;
  let observer: ReturnType<typeof createRuntime> | undefined;
  try {
    await f.start();
    await f.done();
    const page = await f.runtime.listModelInputs(f.scope),
      executionId = page.items[0]!.executionId;
    const target = { ...f.scope, executionId };
    const saved = await f.runtime.readModelInput(target);
    expect(saved.request).toEqual(model.requests[0]!);
    expect(BigInt(saved.bodyBytes)).toBeGreaterThan(17n * 1024n * 1024n);
    expect(saved.request.messages.some((message) => message.content === content)).toBe(true);
    const execution = (await f.store.getExecution(executionId))!;
    const body = (execution.input as Record<string, Json>).body as unknown as ModelBodyReference;
    expect(saved.bodyHash).toBe(body.reference.hash);
    expect((execution.result as Record<string, Json>).modelInputBodyHash).toBe(saved.bodyHash);
    const bytes = await f.artifacts.read({
      ...f.scope,
      refId: body.reference.id,
      scope: body.reference.scope,
    });
    const path = artifactPath(join(f.profile.dataRoot, f.profile.profile), body.reference.hash);
    chmodSync(path, 0o600);
    writeFileSync(path, Buffer.from('corrupt'));
    let corruption: unknown;
    try {
      await f.runtime.readModelInput(target);
    } catch (error) {
      corruption = error;
    }
    expect(corruption).toBeDefined();
    writeFileSync(path, bytes);
    chmodSync(path, 0o400);
    const database = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
    try {
      const invalid = structuredClone(execution.input) as Record<string, Json>;
      (invalid.body as Record<string, Json>).version = 2;
      database
        .query('UPDATE execution SET intent_json=? WHERE id=?')
        .run(JSON.stringify(invalid), executionId);
      await code(f.runtime.readModelInput(target), 'model_body_invalid');
      database
        .query('UPDATE execution SET intent_json=?,result_json=? WHERE id=?')
        .run(
          JSON.stringify(execution.input),
          JSON.stringify({ modelInputBodyHash: '0'.repeat(64) }),
          executionId,
        );
      await code(f.runtime.readModelInput(target), 'model_body_receipt_invalid');
      database
        .query('UPDATE execution SET result_json=? WHERE id=?')
        .run(JSON.stringify(execution.result), executionId);
    } finally {
      database.close();
    }
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const port: ArtifactContentStore = {
      publish: (input) => f.artifacts.publish(input),
      close: async () => {},
      async read(input) {
        const complete = await f.artifacts.read(input);
        entered();
        await gate;
        return complete;
      },
    };
    observer = createRuntime({
      store: f.store,
      artifacts: port,
      modelId: 'unused',
      permissions: {
        async authorize() {
          throw new Error('read authorized execution');
        },
      },
      model: {
        stream() {
          throw new Error('Inspector called Provider');
        },
      },
    });
    const controller = new AbortController();
    const reading = observer.readModelInput({ ...target, signal: controller.signal });
    const caught = reading.then(
      () => false,
      () => true,
    );
    await started;
    controller.abort(new Error('inspector closed'));
    release();
    expect(await caught).toBe(true);
    expect(model.requests).toHaveLength(1);
    const aborted = new AbortController();
    aborted.abort(new Error('already closed'));
    expect(
      await f.runtime.readModelInput({ ...target, signal: aborted.signal }).then(
        () => false,
        () => true,
      ),
    ).toBe(true);
    await f.runtime.close();
    const readonly = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    const coldArtifacts = createArtifactStore({ profile: f.profile, store: readonly });
    const cold = createRuntime({
      store: readonly,
      artifacts: coldArtifacts,
      modelId: 'unused',
      permissions: {
        async authorize() {
          throw new Error('read authorized execution');
        },
      },
      model: {
        stream() {
          throw new Error('cold Inspector called Provider');
        },
      },
    });
    try {
      expect((await cold.readModelInput(target)).request).toEqual(model.requests[0]!);
    } finally {
      await cold.close();
    }
  } finally {
    release?.();
    await observer?.close();
    await f.close();
  }
}, 20000);

test('directory navigates more than two hundred real Store Model intents with a frozen upper and lossless Decimal64 cursors', async () => {
  let calls = 0;
  const model: ModelAdapter = {
    async *stream() {
      calls++;
      yield finish;
    },
  };
  const f = await setup(model, {
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'step',
            version: '1',
            description: 'harmless counted step',
            inputSchema: { type: 'object' },
            async execute() {
              return { outcome: 'succeeded', content: 'ok' };
            },
          },
        ],
      },
    ],
  });
  try {
    await f.start();
    await f.done();
    expect(calls).toBe(1);
    let owner = await f.store.acquireSessionOwner('s', 'directory-fixture');
    const until = Date.now() + 5000;
    while (!owner) {
      if (Date.now() > until) throw new Error('actual owner handoff missing');
      await Bun.sleep(5);
      owner = await f.store.acquireSessionOwner('s', 'directory-fixture');
    }
    await f.store.acceptCommand({
      ...f.scope,
      commandId: 'directory-work',
      request: { kind: 'run.start', content: 'prepare directory fixture requests' },
    });
    const write = { expectedStoreId: f.scope.expectedStoreId, owner };
    const run = await f.store.startRun({
      ...write,
      commandId: 'directory-work',
      configuration: { tools: [] },
    });
    for (let i = 0; i < 205; i++) {
      const executionId = `directory-${i}`;
      await f.store.planExecution({
        ...write,
        executionId,
        sessionId: 's',
        runId: run.id,
        originCommandId: 'directory-work',
        kind: 'model',
        stepId: executionId,
        callId: executionId,
        definitionId: 'fixed',
        definitionVersion: '1',
        input: {
          modelId: 'fixed',
          requestId: executionId,
          messages: [{ role: 'user', content: 'fixture planned request' }],
          tools: [],
        },
        decisionSource: {
          kind: 'model_request',
          requestId: executionId,
          sources: [],
          sourceIds: [],
          toolBindings: [],
        },
      });
    }
    const first = await f.runtime.listModelInputs({ ...f.scope, limit: 200 });
    expect(first.items).toHaveLength(200);
    expect(first.nextAfterSeq).not.toBeNull();
    expect(
      first.items.every(
        (item) => !('input' in item) && !('request' in item) && !('reference' in item),
      ),
    ).toBe(true);
    const prepared = await f.runtime.readModelInput({ ...f.scope, executionId: 'directory-204' });
    expect(prepared.confirmation).toBe('unconfirmed');
    expect(prepared.status).toBe('planned');
    expect(calls).toBe(1);
    await f.store.cancelWork({
      ...f.scope,
      commandId: 'cancel-fixture',
      kind: 'run.cancel',
      runId: run.id,
    });
    for (let i = 0; i < 205; i++) {
      await f.store.finishExecution({
        ...write,
        executionId: `directory-${i}`,
        status: 'cancelled',
        result: { outcome: 'cancelled', content: 'never dispatched fixture request' },
      });
    }
    await f.store.finishRun({
      ...write,
      runId: run.id,
      status: 'cancelled',
      reason: 'fixture_done',
      requirements: [],
    });
    expect(await f.store.releaseSessionOwner(owner)).toBe(true);
    await f.start('later');
    await f.done('later');
    const second = await f.runtime.listModelInputs({
      ...f.scope,
      afterSeq: first.nextAfterSeq!,
      upperSeq: first.upperSeq,
      limit: 200,
    });
    expect(second.items).toHaveLength(6);
    expect(second.nextAfterSeq).toBeNull();
    expect(second.upperSeq).toBe(first.upperSeq);
    expect(BigInt(second.highWaterSeq)).toBeGreaterThan(BigInt(first.highWaterSeq));
    expect(new Set([...first.items, ...second.items].map((item) => item.executionId)).size).toBe(
      206,
    );
    const database = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
    const final = (await f.runtime.listModelInputs({ ...f.scope, afterSeq: second.upperSeq }))
      .items[0]!;
    try {
      database
        .query('UPDATE execution SET rowid=? WHERE id=?')
        .run(9007199254741007n, final.executionId);
    } finally {
      database.close();
    }
    const edge = await f.runtime.listModelInputs({
      ...f.scope,
      afterSeq: '9007199254741006',
      upperSeq: '9007199254741007',
    });
    expect(edge.highWaterSeq).toBe('9007199254741007');
    expect(edge.items[0]?.seq).toBe('9007199254741007');
    expect(edge.items[0]?.executionId).toBe(final.executionId);
    for (const afterSeq of ['01', '-1', '9223372036854775808'])
      await code(f.runtime.listModelInputs({ ...f.scope, afterSeq }), 'invalid_model_input_cursor');
    await code(
      f.runtime.listModelInputs({ ...f.scope, upperSeq: '9007199254741008' }),
      'cursor_ahead',
    );
    expect(calls).toBe(2);
  } finally {
    await f.close();
  }
}, 30000);

test('child Model input is readable only under its exact original child identity; failed input is unconfirmed', async () => {
  const child = createFixedModel([[finish]]);
  const parent = createFixedModel([call('delegate'), [finish]]);
  const f = await setup(parent, {
    childConfigurations: [
      { id: 'child', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
    ],
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'delegate',
            version: '1',
            description: 'controlled child',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              const ref = await context.operations.ensure({
                key: 'child',
                request: { kind: 'agent', configurationId: 'child', input: { content: 'child' } },
              });
              await context.operations.wait(ref);
              return { outcome: 'succeeded', content: 'child done' };
            },
          },
        ],
      },
    ],
  });
  let failing: ReturnType<typeof createRuntime> | undefined;
  try {
    await f.start();
    await f.done();
    const carrier = (await f.store.listExecutions('s')).find(
      (execution) => execution.childSessionId,
    )!;
    const scope = { ...f.scope, sessionId: carrier.childSessionId! };
    const page = await f.runtime.listModelInputs(scope);
    expect(page.rootSessionId).toBe('s');
    expect(page.items).toHaveLength(1);
    const saved = await f.runtime.readModelInput({
      ...scope,
      executionId: page.items[0]!.executionId,
    });
    expect(saved.request).toEqual(child.requests[0]!);
    expect(saved.request.modelId).toBe('child');
    await code(
      f.runtime.readModelInput({ ...f.scope, executionId: saved.executionId }),
      'model_input_scope_denied',
    );
    await code(
      f.runtime.listModelInputs({ ...scope, subjectId: 'intruder' }),
      'model_input_scope_denied',
    );
    expect(parent.requests).toHaveLength(2);
    expect(child.requests).toHaveLength(1);
    failing = createRuntime({
      store: f.store,
      modelId: 'failure',
      permissions: {
        async authorize() {
          return { allowed: true, revision: '1' };
        },
      },
      model: {
        stream() {
          throw new Error('actual Provider error');
        },
      },
    });
    await failing.submitCommand({
      ...f.scope,
      commandId: 'failure',
      request: { kind: 'run.start', content: 'attempt failure' },
    });
    await failing.waitForCommand('failure', { timeoutMs: 5000 });
    const failed = (await failing.listModelInputs(f.scope)).items.find(
      (item) => item.modelId === 'failure',
    )!;
    expect(failed.status).toBe('failed');
    expect(
      (await failing.readModelInput({ ...f.scope, executionId: failed.executionId })).confirmation,
    ).toBe('unconfirmed');
  } finally {
    await failing?.close();
    await f.close();
  }
}, 15000);
