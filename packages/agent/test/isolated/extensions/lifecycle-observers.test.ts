import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createFixedModel,
  type ModelAdapter,
  ModelAttemptError,
  type ModelEvent,
} from '@kite-ai/ai';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { createRuntime, type RuntimeOptions } from '../../../src';
import type {
  Extension,
  ModelSettledEvent,
  ModelStartedEvent,
  RunSettledEvent,
  RunStartedEvent,
} from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { AgentError } from '../../../src/storage/types';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function until(read: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('lifecycle observation did not arrive');
}
const permissions = {
  async authorize() {
    return { allowed: true, revision: 'fixture' };
  },
};
const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: {
    inputTokens: 9,
    outputTokens: 2,
    cachedInputTokens: 3,
    raw: { private: 'provider detail' },
  },
};
const answer: ModelEvent[] = [{ type: 'text_delta', text: 'Private answer body' }, finish];

async function fixture(options: Omit<RuntimeOptions, 'store'>, wrap?: (store: Store) => Store) {
  const root = temporaryDirectory('kite-lifecycle-observers-');
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const runtime = createRuntime({ ...options, store: wrap?.(store) ?? store });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: pathToFileURL(root).href,
    name: 'fixture',
  });
  const createSession = (sessionId: string) =>
    runtime.createSession({
      expectedStoreId,
      sessionId,
      workspaceId: 'w',
      subjectId: 'owner',
      commandId: `create-${sessionId}`,
      title: '',
    });
  await createSession('s');
  const submit = (commandId = 'work', sessionId = 's') =>
    runtime.submitCommand({
      expectedStoreId,
      sessionId,
      subjectId: 'owner',
      commandId,
      request: { kind: 'run.start', content: 'Private task body' },
    });
  const done = (commandId = 'work') => runtime.waitForCommand(commandId, { timeoutMs: 4000 });
  return {
    root,
    profile,
    store,
    runtime,
    expectedStoreId,
    createSession,
    submit,
    done,
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test.each([
  'success',
  'failure',
  'cancelled',
  'denied',
] as const)('Model and Run observers receive frozen post-commit facts without private bodies: %s', async (mode) => {
  const models: ModelSettledEvent[] = [],
    runs: RunSettledEvent[] = [];
  const starts: (RunStartedEvent | ModelStartedEvent)[] = [];
  const observeStart = (event: RunStartedEvent | ModelStartedEvent) => {
    starts.push(event);
    expect(Object.isFrozen(event)).toBe(true);
  };
  const checked: Promise<void>[] = [];
  const entered = gate();
  const model: ModelAdapter = {
    async *stream(_request, { signal }) {
      yield { type: 'usage', usage: (finish as Extract<ModelEvent, { type: 'finish' }>).usage };
      entered.release();
      if (mode === 'failure') throw new AgentError('fixture_model_failure');
      if (mode === 'cancelled') {
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      }
      yield* answer;
    },
  };
  const extension: Extension = {
    id: 'observer.fixture',
    version: '1',
    apiMajor: 1,
    lifecycle: {
      onRunStart: observeStart,
      onModelStart: observeStart,
      onModelEnd(event) {
        models.push(event);
        checked.push(
          (async () => {
            const saved = await f.store.getExecution(event.executionId);
            expect(saved).toMatchObject({
              id: event.executionId,
              status: event.status,
              runId: event.runId,
              originStoreId: event.originStoreId,
              attempt: event.attempt,
              resultRevision: event.resultRevision,
              definitionId: event.definitionId,
              definitionVersion: event.definitionVersion,
            });
            expect(Object.isFrozen(event)).toBe(true);
            if (event.usage) expect(Object.isFrozen(event.usage)).toBe(true);
          })(),
        );
      },
      onRunEnd(event) {
        runs.push(event);
        checked.push(
          (async () => {
            expect(await f.store.getRun(event.runId)).toMatchObject({
              status: event.status,
              isActive: false,
              finishedAt: event.finishedAt,
              reason: event.reason,
            });
            expect(Object.isFrozen(event)).toBe(true);
          })(),
        );
      },
    },
  };
  const f = await fixture({
    model,
    modelId: 'fixture',
    extensions: [extension],
    permissions: {
      async authorize() {
        return { allowed: mode !== 'denied', revision: 'fixture' };
      },
    },
  });
  try {
    await f.submit();
    if (mode === 'cancelled') {
      await entered.promise;
      await f.runtime.cancelCommand({
        expectedStoreId: f.expectedStoreId,
        sessionId: 's',
        subjectId: 'owner',
        commandId: 'cancel-work',
        targetCommandId: 'work',
      });
    }
    await f.done();
    await until(() => models.length === 1 && runs.length === 1);
    await Promise.all(checked);
    expect(starts.map((event) => event.type)).toEqual(
      mode === 'denied' ? ['run.started'] : ['run.started', 'model.started'],
    );
    expect(starts[0]).toMatchObject({ runId: runs[0]!.runId, originCommandId: 'work' });
    if (mode !== 'denied')
      expect(starts[1]).toMatchObject({
        executionId: models[0]!.executionId,
        attempt: models[0]!.attempt,
        runId: models[0]!.runId,
      });
    expect(models[0]?.status).toBe(
      mode === 'success' ? 'succeeded' : mode === 'cancelled' ? 'cancelled' : 'failed',
    );
    expect(runs[0]?.status).toBe(
      mode === 'success' ? 'completed' : mode === 'cancelled' ? 'cancelled' : 'failed',
    );
    expect(models[0]?.usage).toEqual(
      mode === 'denied' ? null : { inputTokens: 9, outputTokens: 2, cachedInputTokens: 3 },
    );
    expect(JSON.stringify([...starts, ...models, ...runs])).not.toMatch(
      /Private|provider detail|ownerGeneration|requestDigest/,
    );
    expect(models[0]?.incomplete).toBe(mode !== 'success');
    const ids = [...models, ...runs].map((event) => event.eventId);
    expect(new Set(ids).size).toBe(2);
    await f.submit();
    await f.runtime.getView('s');
    expect([...models, ...runs].map((event) => event.eventId)).toEqual(ids);
    const startIds = starts.map((event) => event.eventId);
    expect(new Set([...ids, ...startIds]).size).toBe(ids.length + startIds.length);
    await f.runtime.close();
    const coldStore = await openSqliteStore(f.profile);
    const cold = createRuntime({
      store: coldStore,
      model,
      modelId: 'fixture',
      extensions: [extension],
      permissions,
    });
    try {
      await cold.getView('s');
      await cold.listMessages('s');
      expect([...models, ...runs].map((event) => event.eventId)).toEqual(ids);
      expect(starts.map((event) => event.eventId)).toEqual(startIds);
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
});

test('each retried Model attempt is observed once while the original Run settles once', async () => {
  const models: ModelSettledEvent[] = [],
    runs: RunSettledEvent[] = [];
  const modelStarts: ModelStartedEvent[] = [],
    runStarts: RunStartedEvent[] = [];
  const model = createFixedModel([[new ModelAttemptError('stream_incomplete')], answer]);
  const f = await fixture({
    model,
    modelId: 'fixture',
    permissions,
    extensions: [
      {
        id: 'retry.observer',
        version: '1',
        apiMajor: 1,
        lifecycle: {
          onRunStart(event) {
            runStarts.push(event);
          },
          onModelStart(event) {
            modelStarts.push(event);
          },
          onModelEnd(event) {
            models.push(event);
          },
          onRunEnd(event) {
            runs.push(event);
          },
        },
      },
    ],
  });
  try {
    await f.submit();
    await f.done();
    await until(() => models.length === 2 && runs.length === 1);
    expect(models.map((event) => event.status)).toEqual(['failed', 'succeeded']);
    expect(new Set(models.map((event) => event.executionId)).size).toBe(2);
    expect(new Set(models.map((event) => event.eventId)).size).toBe(2);
    expect(modelStarts.map((event) => event.executionId)).toEqual(
      models.map((event) => event.executionId),
    );
    expect(runStarts.map((event) => event.runId)).toEqual(runs.map((event) => event.runId));
    expect(runs[0]?.status).toBe('completed');
    expect(model.requests).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('observers stay bound to the original Run while another Session resolves a later version', async () => {
  const entered = gate(),
    release = gate();
  const observed: string[] = [];
  const extension = (version: string): Extension => ({
    id: 'version.observer',
    version,
    apiMajor: 1,
    lifecycle: {
      onModelEnd(event) {
        observed.push(`model:${version}:${event.sessionId}`);
      },
      onRunEnd(event) {
        observed.push(`run:${version}:${event.sessionId}`);
      },
    },
  });
  const original = extension('1');
  let selected = original;
  const f = await fixture({
    permissions,
    resolveRunConfiguration: async () => {
      const current = selected;
      return {
        modelId: 'fixture',
        snapshot: { version: current.version },
        extensions: [current],
        model: {
          async *stream() {
            if (current.version === '1') {
              entered.release();
              await release.promise;
            }
            yield* answer;
          },
        },
      };
    },
  });
  try {
    await f.submit('first');
    await entered.promise;
    original.lifecycle!.onModelEnd = () => {
      observed.push('mutated-model');
    };
    original.lifecycle!.onRunEnd = () => {
      observed.push('mutated-run');
    };
    selected = extension('2');
    await f.createSession('s2');
    await f.submit('second', 's2');
    await f.done('second');
    release.release();
    await f.done('first');
    await until(() => observed.length === 4);
    expect(observed.sort()).toEqual(['model:1:s', 'model:2:s2', 'run:1:s', 'run:2:s2']);
  } finally {
    release.release();
    await f.close();
  }
});

test('Model observers follow each frozen Step catalogue while Run observers keep the Run binding', async () => {
  let version = '1';
  const observed: string[] = [];
  const extension = (selected: string): Extension => ({
    id: 'step.observer',
    version: selected,
    apiMajor: 1,
    lifecycle: {
      onRunStart() {
        observed.push(`run-start:${selected}`);
      },
      onModelStart() {
        observed.push(`model-start:${selected}`);
      },
      onModelEnd() {
        observed.push(`model:${selected}`);
      },
      onRunEnd() {
        observed.push(`run:${selected}`);
      },
    },

    tools: [
      {
        id: 'advance',
        version: selected,
        description: 'Advance the fixture catalogue',
        inputSchema: { type: 'object' },
        async execute() {
          version = '2';
          return { outcome: 'succeeded', content: 'Catalogue advanced' };
        },
      },
    ],
  });
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'advance-call', name: 'advance', arguments: '{}' },
      { ...(finish as Extract<ModelEvent, { type: 'finish' }>), reason: 'tool_calls' },
    ],
    answer,
  ]);
  const f = await fixture({
    permissions,
    resolveRunConfiguration: async () => ({
      model,
      modelId: 'fixture',
      snapshot: {},
      extensions: [extension('1')],
      readStepCapabilities: async () => ({
        extensions: [extension(version)],
        snapshot: { version },
      }),
    }),
  });
  try {
    await f.submit();
    await f.done();
    await until(() => observed.length === 6);
    expect(observed).toEqual([
      'run-start:1',
      'model-start:1',
      'model:1',
      'model-start:2',
      'model:2',
      'run:1',
    ]);
    expect(model.requests.map((request) => request.tools[0]?.definitionVersion)).toEqual([
      '1',
      '2',
    ]);
  } finally {
    await f.close();
  }
});

test.each([
  'model',
  'run',
] as const)('Provider EOF does not publish %s settlement before its actual Store commit', async (boundary) => {
  const committing = gate(),
    release = gate();
  const models: ModelSettledEvent[] = [],
    runs: RunSettledEvent[] = [];
  const f = await fixture(
    {
      model: createFixedModel([answer]),
      modelId: 'fixture',
      permissions,
      extensions: [
        {
          id: 'barrier.observer',
          version: '1',
          apiMajor: 1,
          lifecycle: {
            onModelEnd(event) {
              models.push(event);
            },
            onRunEnd(event) {
              runs.push(event);
            },
          },
        },
      ],
    },
    (store) =>
      new Proxy(store, {
        get(target, key) {
          if (boundary === 'model' && key === 'finishExecution')
            return async (input: Parameters<Store['finishExecution']>[0]) => {
              committing.release();
              await release.promise;
              return target.finishExecution(input);
            };
          if (boundary === 'run' && key === 'finishRun')
            return async (input: Parameters<Store['finishRun']>[0]) => {
              committing.release();
              await release.promise;
              return target.finishRun(input);
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
  );
  try {
    await f.submit();
    await committing.promise;
    expect(runs).toHaveLength(0);
    if (boundary === 'model') expect(models).toHaveLength(0);
    else expect(models).toHaveLength(1);
    release.release();
    await f.done();
    await until(() => models.length === 1 && runs.length === 1);
  } finally {
    release.release();
    await f.close();
  }
});

test.each([
  'activation',
  'dispatch',
] as const)('start observation waits for the actual %s acknowledgement and never holds execution open', async (boundary) => {
  const committing = gate(),
    release = gate(),
    blockedObserver = gate();
  const starts: (RunStartedEvent | ModelStartedEvent)[] = [];
  const model = createFixedModel([answer]);
  const f = await fixture(
    {
      model,
      modelId: 'fixture',
      permissions,
      extensions: [
        {
          id: 'start.observer',
          version: '1',
          apiMajor: 1,
          lifecycle: {
            async onRunStart(event) {
              starts.push(event);
              await blockedObserver.promise;
            },
            async onModelStart(event) {
              starts.push(event);
              await blockedObserver.promise;
            },
          },
        },
      ],
    },
    (store) =>
      new Proxy(store, {
        get(target, key) {
          if (boundary === 'activation' && key === 'startRun')
            return async (input: Parameters<Store['startRun']>[0]) => {
              const run = await target.startRun(input);
              committing.release();
              await release.promise;
              return run;
            };
          if (boundary === 'dispatch' && key === 'markDispatching')
            return async (input: Parameters<Store['markDispatching']>[0]) => {
              const result = await target.markDispatching(input);
              committing.release();
              await release.promise;
              return result;
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
  );
  try {
    await f.submit();
    await committing.promise;
    expect(starts.map((event) => event.type)).toEqual(
      boundary === 'activation' ? [] : ['run.started'],
    );
    expect(model.requests).toHaveLength(0);
    release.release();
    await f.done();
    await until(() => starts.length === 2);
    expect(starts.map((event) => event.type)).toEqual(['run.started', 'model.started']);
    expect((await f.store.getView('s')).runs[0]?.status).toBe('completed');
    await f.runtime.close();
    expect(f.runtime.getLifecycleState().state).toBe('closed');
  } finally {
    release.release();
    blockedObserver.release();
    await f.close();
  }
});

test('lifecycle Actions run in registration order without reentering internal child Runs', async () => {
  const business: string[] = [];
  const runStarts: RunStartedEvent[] = [],
    runEnds: RunSettledEvent[] = [],
    modelStarts: ModelStartedEvent[] = [],
    modelEnds: ModelSettledEvent[] = [];
  const child = createFixedModel([answer, answer]);
  const model = createFixedModel([answer]);
  const extension = (id: string): Extension => {
    const select = (phase: string, event: import('../../../src/extensions').RunBoundaryEvent) => {
      business.push(`${phase}:${id}:${event.command.kind}`);
      if (event.command.id !== 'work') return null; // Expose accidental recursion without looping.
      return { actionId: 'prepare', definitionVersion: '1', input: { phase } };
    };
    return {
      id,
      version: '1',
      apiMajor: 1,
      lifecycle: {
        async beforeRun(event) {
          return select('before', event);
        },
        async beforeRunComplete(event) {
          return select('complete', event);
        },
        ...(id === 'first'
          ? {
              onRunStart: (event: RunStartedEvent) => {
                runStarts.push(event);
              },
              onRunEnd: (event: RunSettledEvent) => {
                runEnds.push(event);
              },
              onModelStart: (event: ModelStartedEvent) => {
                modelStarts.push(event);
              },
              onModelEnd: (event: ModelSettledEvent) => {
                modelEnds.push(event);
              },
            }
          : {}),
      },
      actions: [
        {
          id: 'prepare',
          version: '1',
          description: 'Perform a finite lifecycle Action',
          inputSchema: { type: 'object' },
          async prepare(input) {
            return input;
          },
          async execute(input, context) {
            const phase = (input as { phase: string }).phase;
            business.push(`action:${phase}:${id}`);
            if (id === 'first') {
              const ref = await context.operations.ensure({
                key: phase,
                resultDelivery: 'caller',
                request: { kind: 'agent', configurationId: 'worker', input: { content: phase } },
              });
              expect((await context.operations.wait(ref, { signal: context.signal })).status).toBe(
                'succeeded',
              );
            }
            return { outcome: 'succeeded', content: 'Finite Action complete' };
          },
        },
      ],
    };
  };
  const f = await fixture({
    model,
    modelId: 'fixture',
    permissions,
    extensions: [extension('first'), extension('second')],
    childConfigurations: [
      { id: 'worker', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
    ],
  });
  try {
    await f.submit();
    await f.done();
    await until(() => runEnds.length === 3);
    expect(business).toEqual([
      'before:first:run.start',
      'action:before:first',
      'before:second:run.start',
      'action:before:second',
      'complete:first:run.start',
      'action:complete:first',
      'complete:second:run.start',
      'action:complete:second',
    ]);
    expect(runStarts).toHaveLength(3);
    expect(modelStarts).toHaveLength(3);
    expect(modelEnds).toHaveLength(3);
    expect(new Set(runStarts.map((event) => event.runId))).toEqual(
      new Set(runEnds.map((event) => event.runId)),
    );
    expect(modelStarts.map((event) => event.executionId)).toEqual(
      modelEnds.map((event) => event.executionId),
    );
    expect(model.requests).toHaveLength(1);
    expect(child.requests).toHaveLength(2);
    expect((await f.store.getView('s')).runs[0]?.status).toBe('completed');
  } finally {
    await f.close();
  }
});

test('slow and failing observers cannot change outcomes, retain a Run binding or block Runtime close', async () => {
  const blocked = gate(),
    disposing = gate(),
    releaseDispose = gate();
  let failures = 0,
    successful = 0,
    slowRuns = 0;
  const extension: Extension = {
    id: 'slow.observer',
    version: '1',
    apiMajor: 1,
    lifecycle: {
      async onModelEnd() {
        failures++;
        throw new Error('observer failure');
      },
      async onRunEnd() {
        slowRuns++;
        await blocked.promise;
      },
    },
  };
  const f = await fixture({
    permissions,
    resolveRunConfiguration: async () => ({
      model: createFixedModel([answer]),
      modelId: 'fixture',
      snapshot: {},
      extensions: [
        extension,
        {
          id: 'good.observer',
          version: '1',
          apiMajor: 1,
          lifecycle: {
            onModelEnd() {
              successful++;
            },
          },
        },
      ],
      dispose: async () => {
        disposing.release();
        await releaseDispose.promise;
      },
    }),
  });
  try {
    await f.submit();
    await disposing.promise;
    await until(() => slowRuns === 1 && successful === 1);
    expect(failures).toBe(1);
    expect((await f.store.getView('s')).runs[0]?.status).toBe('completed');
    releaseDispose.release();
    await f.runtime.close();
    expect(f.runtime.getLifecycleState().state).toBe('closed');
    expect(slowRuns).toBe(1);
  } finally {
    releaseDispose.release();
    blocked.release();
    await f.close();
  }
});

test('failed terminal writes produce no invented settlement and original committed failure remains observable', async () => {
  const models: ModelSettledEvent[] = [],
    runs: RunSettledEvent[] = [];
  const f = await fixture(
    {
      model: createFixedModel([answer]),
      modelId: 'fixture',
      permissions,
      extensions: [
        {
          id: 'commit.observer',
          version: '1',
          apiMajor: 1,
          lifecycle: {
            onModelEnd(event) {
              models.push(event);
            },
            onRunEnd(event) {
              runs.push(event);
            },
          },
        },
      ],
    },
    (store) =>
      new Proxy(store, {
        get(target, key) {
          if (key === 'finishExecution')
            return async (input: Parameters<Store['finishExecution']>[0]) => {
              if (input.status === 'succeeded')
                throw new AgentError('fixture_model_commit_rejected');
              return target.finishExecution(input);
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
  );
  try {
    await f.submit();
    await f.done();
    await until(() => runs.length === 1);
    expect(models.map((event) => event.status)).toEqual(['failed']);
    expect(models[0]?.code).toBe('fixture_model_commit_rejected');
    expect(runs[0]?.status).toBe('failed');
  } finally {
    await f.close();
  }
});

test.each([
  'configuration_rejected',
  'completion_retry',
] as const)('Run notification is tied to actual activation and final completion: %s', async (mode) => {
  const models: ModelSettledEvent[] = [],
    runs: RunSettledEvent[] = [];
  const model = createFixedModel([answer]);
  let rejected = false;
  const f = await fixture(
    {
      model,
      modelId: 'fixture',
      permissions,
      ...(mode === 'configuration_rejected'
        ? {
            resolveRunConfiguration: async () => {
              throw new AgentError('fixture_configuration_rejected');
            },
          }
        : {}),
      extensions: [
        {
          id: 'activation.observer',
          version: '1',
          apiMajor: 1,
          lifecycle: {
            onModelEnd(event) {
              models.push(event);
            },
            onRunEnd(event) {
              runs.push(event);
            },
          },
        },
      ],
    },
    (store) =>
      new Proxy(store, {
        get(target, key) {
          if (key === 'finishRun')
            return async (input: Parameters<Store['finishRun']>[0]) => {
              if (input.status === 'completed' && !rejected) {
                rejected = true;
                throw new AgentError('input_pending');
              }
              return target.finishRun(input);
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
  );
  try {
    await f.submit();
    const command = await f.done();
    if (mode === 'configuration_rejected') {
      await f.runtime.close();
      expect(command.status).toBe('rejected');
      expect(models).toHaveLength(0);
      expect(runs).toHaveLength(0);
      expect(model.requests).toHaveLength(0);
    } else {
      await until(() => runs.length === 1);
      expect(rejected).toBe(true);
      expect(models).toHaveLength(1);
      expect(runs[0]?.status).toBe('completed');
      expect(model.requests).toHaveLength(1);
    }
  } finally {
    await f.close();
  }
});
