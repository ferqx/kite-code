import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime, type RuntimeOptions } from '../../../src';
import type { JobDefinition, JobEvent, ToolDefinition } from '../../../src/extensions';
import { createWorkspaceSerialLocks } from '../../../src/resources';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const calls: ModelEvent[] = [
  { type: 'tool_call', id: 'call', name: 'fixture.tool', arguments: '{}' },
  { ...finish, reason: 'tool_calls' },
];
const permissions = {
  async authorize() {
    return { allowed: true, revision: '1' };
  },
};
async function fixture(
  options: Omit<RuntimeOptions, 'store' | 'permissions'> &
    Partial<Pick<RuntimeOptions, 'permissions'>> = {},
  sharedRoot?: string,
) {
  const root = sharedRoot ?? mkdtempSync('/private/tmp/kite-runtime-lifecycle-');
  const original = await openSqliteStore({ dataRoot: root, profile: 'temporary' });
  const hooks = new Map<keyof Store, () => Promise<void>>();
  const afterHooks = new Map<keyof Store, () => Promise<void>>();
  let storeCloses = 0;
  const store = new Proxy(original, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        await hooks.get(property as keyof Store)?.();
        if (property === 'close') storeCloses++;
        const result = await value.apply(target, args);
        await afterHooks.get(property as keyof Store)?.();
        return result;
      };
    },
  });
  const model = createFixedModel([[finish]]);
  const runtime = createRuntime({ model, modelId: 'fixed', permissions, ...options, store });
  const expectedStoreId = (await original.getMetadata()).storeId;
  const sessionId = crypto.randomUUID();
  await runtime.createWorkspace({
    expectedStoreId,
    id: sessionId,
    rootUri: `file://${root}`,
    name: 'temporary',
  });
  await runtime.createSession({
    expectedStoreId,
    sessionId,
    workspaceId: sessionId,
    commandId: `create-${sessionId}`,
    subjectId: 'owner',
    title: 'temporary',
  });
  return {
    root,
    store,
    original,
    model,
    runtime,
    hooks,
    afterHooks,
    expectedStoreId,
    sessionId,
    storeCloses: () => storeCloses,
    submit: (commandId: string) =>
      runtime.submitCommand({
        expectedStoreId,
        sessionId,
        commandId,
        subjectId: 'owner',
        request: { kind: 'run.start', content: commandId },
      }),
    async close() {
      hooks.clear();
      afterHooks.clear();
      await runtime.close();
      if (!sharedRoot) rmSync(root, { recursive: true, force: true });
    },
  };
}

test('submit first Store await is busy before acceptance; cancel seals later submissions and repeated close shares completion', async () => {
  const f = await fixture();
  const entered = gate(),
    release = gate();
  try {
    f.hooks.set('getMetadata', async () => {
      entered.release();
      await release.promise;
    });
    const submit = f.submit('pending');
    await entered.promise;
    const idle = f.runtime.tryBeginShutdown('if_idle');
    expect(idle.accepted).toBe(false);
    expect(idle.state.reasons).toContain('admission');
    expect(f.runtime.getLifecycleState().state).toBe('accepting');
    const close = f.runtime.close();
    expect(f.runtime.close()).toBe(close);
    await expect(f.submit('late')).rejects.toMatchObject({ code: 'runtime_draining' });
    expect(f.storeCloses()).toBe(0);
    release.release();
    expect(await submit.catch((error: unknown) => error)).toMatchObject({
      code: 'runtime_draining',
    });
    await close;
    expect(f.model.requests).toHaveLength(0);
    expect(f.storeCloses()).toBe(1);
    expect(f.runtime.getLifecycleState()).toEqual({ state: 'closed', busy: false, reasons: [] });
  } finally {
    release.release();
    await f.close();
  }
});

test('pump waiting for original Session owner is busy although no active Run exists', async () => {
  const f = await fixture();
  const entered = gate(),
    release = gate();
  try {
    f.hooks.set('acquireSessionOwner', async () => {
      entered.release();
      await release.promise;
    });
    await f.submit('owner-wait');
    await entered.promise;
    expect(f.runtime.tryBeginShutdown('if_idle').accepted).toBe(false);
    expect(f.runtime.getLifecycleState().reasons).toContain('dispatch');
    expect(f.model.requests).toHaveLength(0);
    const close = f.runtime.close();
    expect(f.storeCloses()).toBe(0);
    release.release();
    await close;
    expect(f.model.requests).toHaveLength(0);
    expect(f.storeCloses()).toBe(1);
  } finally {
    release.release();
    await f.close();
  }
});

test('terminal Run slow binding disposal remains busy and completes before resource closure', async () => {
  const entered = gate(),
    release = gate();
  const fixed = createFixedModel([[finish]]);
  let disposals = 0;
  const f = await fixture({
    async resolveRunConfiguration() {
      return {
        model: fixed,
        modelId: 'bound',
        snapshot: {},
        async dispose() {
          disposals++;
          entered.release();
          await release.promise;
        },
      };
    },
  });
  try {
    await f.submit('dispose');
    await entered.promise;
    expect((await f.runtime.getView(f.sessionId)).runs[0]?.isActive).toBe(false);
    expect(f.runtime.tryBeginShutdown('if_idle').accepted).toBe(false);
    expect(f.runtime.getLifecycleState().reasons).toContain('cleanup');
    const close = f.runtime.close();
    expect(f.storeCloses()).toBe(0);
    release.release();
    await close;
    expect(disposals).toBe(1);
    expect(f.storeCloses()).toBe(1);
  } finally {
    release.release();
    await f.close();
  }
});

test('observations are idle but protect Store lifetime; host final seal callback is unique and awaited', async () => {
  const f = await fixture();
  const readEntered = gate(),
    readRelease = gate(),
    hostEntered = gate(),
    hostRelease = gate();
  let callbacks = 0;
  try {
    f.hooks.set('getMetadata', async () => {
      readEntered.release();
      await readRelease.promise;
    });
    const read = f.runtime.getMetadata();
    await readEntered.promise;
    expect(f.runtime.getLifecycleState().busy).toBe(false);
    const result = f.runtime.tryBeginShutdown('if_idle', {
      async beforeResourceClose() {
        callbacks++;
        hostEntered.release();
        await hostRelease.promise;
      },
    });
    if (!result.accepted) throw new Error('idle rejected');
    const repeated = f.runtime.tryBeginShutdown('cancel', {
      async beforeResourceClose() {
        throw new Error('replacement callback');
      },
    });
    if (!repeated.accepted) throw new Error('repeated rejected');
    expect(repeated.completion).toBe(result.completion);
    expect(f.runtime.close()).toBe(result.completion);
    await hostEntered.promise;
    expect((await f.runtime.getSession(f.sessionId))?.id).toBe(f.sessionId);
    expect(f.storeCloses()).toBe(0);
    hostRelease.release();
    await Promise.resolve();
    expect(f.storeCloses()).toBe(0);
    readRelease.release();
    await read;
    await result.completion;
    expect(callbacks).toBe(1);
    expect(f.storeCloses()).toBe(1);
    await expect(f.runtime.getMetadata()).rejects.toMatchObject({ code: 'runtime_draining' });
  } finally {
    readRelease.release();
    hostRelease.release();
    await f.close();
  }
});

test('host final drain failure retains Store and reports drain_failed without substituting callback', async () => {
  const f = await fixture();
  let callbacks = 0;
  const result = f.runtime.tryBeginShutdown('if_idle', {
    async beforeResourceClose() {
      callbacks++;
      throw new Error('held host resource');
    },
  });
  if (!result.accepted) throw new Error('idle rejected');
  try {
    await expect(result.completion).rejects.toThrow('held host resource');
    expect(f.runtime.getLifecycleState().state).toBe('drain_failed');
    expect(f.storeCloses()).toBe(0);
    expect((await f.runtime.getMetadata()).storeId).toBe(f.expectedStoreId);
    expect(f.runtime.close()).toBe(result.completion);
    await expect(f.runtime.close()).rejects.toThrow('held host resource');
    expect(callbacks).toBe(1);
  } finally {
    await f.original.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('long command observation is idle and terminates on shutdown without waiting for closed resources', async () => {
  const f = await fixture();
  const entered = gate(),
    release = gate();
  try {
    f.hooks.set('getCommand', async () => {
      entered.release();
      await release.promise;
    });
    const waiting = f.runtime.waitForCommand(`create-${f.sessionId}`, { timeoutMs: 300000 });
    await entered.promise;
    expect(f.runtime.getLifecycleState().busy).toBe(false);
    const shutdown = f.runtime.tryBeginShutdown('if_idle');
    if (!shutdown.accepted) throw new Error('observation made idle busy');
    expect(f.storeCloses()).toBe(0);
    release.release();
    expect(await waiting.catch((error: unknown) => error)).toMatchObject({
      code: 'runtime_draining',
    });
    await shutdown.completion;
    expect(f.storeCloses()).toBe(1);
  } finally {
    release.release();
    await f.close();
  }
});

test('cancellation control first await is busy and remains admitted during host drain', async () => {
  const f = await fixture();
  const entered = gate(),
    release = gate(),
    hostEntered = gate(),
    hostRelease = gate();
  try {
    f.hooks.set('cancelCommand', async () => {
      entered.release();
      await release.promise;
    });
    const control = f.runtime.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      sessionId: f.sessionId,
      commandId: 'cancel-old',
      targetCommandId: `create-${f.sessionId}`,
    });
    await entered.promise;
    expect(f.runtime.tryBeginShutdown('if_idle').accepted).toBe(false);
    expect(f.runtime.getLifecycleState().reasons).toContain('admission');
    const shutdown = f.runtime.tryBeginShutdown('cancel', {
      async beforeResourceClose() {
        hostEntered.release();
        await hostRelease.promise;
      },
    });
    if (!shutdown.accepted) throw new Error('cancel rejected');
    release.release();
    await control;
    await hostEntered.promise;
    await f.runtime.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      sessionId: f.sessionId,
      commandId: 'cancel-late',
      targetCommandId: `create-${f.sessionId}`,
    });
    expect(f.storeCloses()).toBe(0);
    hostRelease.release();
    await shutdown.completion;
    expect(f.storeCloses()).toBe(1);
  } finally {
    release.release();
    hostRelease.release();
    await f.close();
  }
});

test('two Runtime instances on one profile cancel only their own live group', async () => {
  const root = mkdtempSync('/private/tmp/kite-runtime-lifecycle-peers-');
  const entered = [gate(), gate()];
  const aborts = [0, 0];
  const fixtures = [];
  try {
    for (let index = 0; index < 2; index++) {
      const tool: ToolDefinition = {
        id: 'fixture.tool',
        version: '1',
        description: 'held local tool',
        inputSchema: { type: 'object' },
        async execute(_input, context) {
          entered[index]!.release();
          await new Promise<void>((resolve) =>
            context.signal.addEventListener(
              'abort',
              () => {
                aborts[index]!++;
                resolve();
              },
              { once: true },
            ),
          );
          return { outcome: 'cancelled', content: 'stopped' };
        },
      };
      const f = await fixture(
        {
          model: createFixedModel([calls, [finish]]),
          permissions,
          extensions: [{ id: 'fixture', version: '1', apiMajor: 1, tools: [tool] }],
        },
        root,
      );
      fixtures.push(f);
      await f.submit(`peer-${index}`);
      await entered[index]!.promise;
    }
    await fixtures[0]!.runtime.close();
    expect(aborts).toEqual([1, 0]);
    expect(fixtures[1]!.runtime.getLifecycleState().state).toBe('accepting');
    expect((await fixtures[1]!.runtime.getView(fixtures[1]!.sessionId)).runs[0]?.isActive).toBe(
      true,
    );
    expect(fixtures[1]!.storeCloses()).toBe(0);
    await fixtures[1]!.runtime.close();
    expect(aborts).toEqual([1, 1]);
  } finally {
    for (const f of fixtures) await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('durable acceptance on closing observer Runtime does not cancel the surviving original owner', async () => {
  const root = mkdtempSync('/private/tmp/kite-runtime-lifecycle-handover-');
  const entered = gate(),
    release = gate(),
    accepted = gate(),
    response = gate();
  const tool: ToolDefinition = {
    id: 'fixture.tool',
    version: '1',
    description: 'original owner holds first work',
    inputSchema: { type: 'object' },
    async execute() {
      entered.release();
      await release.promise;
      return { outcome: 'succeeded', content: 'released' };
    },
  };
  const fixed = createFixedModel([calls, [finish], [finish]]);
  const a = await fixture(
    {
      model: fixed,
      permissions,
      extensions: [{ id: 'fixture', version: '1', apiMajor: 1, tools: [tool] }],
    },
    root,
  );
  const b = await fixture({}, root);
  try {
    await a.submit('original');
    await entered.promise;
    b.afterHooks.set('acceptCommand', async () => {
      accepted.release();
      await response.promise;
    });
    const submission = b.runtime.submitCommand({
      expectedStoreId: b.expectedStoreId,
      sessionId: a.sessionId,
      subjectId: 'owner',
      commandId: 'durable',
      request: { kind: 'run.start', content: 'survives observer' },
    });
    await accepted.promise;
    const close = b.runtime.close();
    expect(b.storeCloses()).toBe(0);
    release.release();
    await a.runtime.waitForCommand('durable');
    const command = await a.runtime.getCommand('durable');
    expect(command?.status).toBe('applied');
    expect(command?.cancelRequestedAt).toBeNull();
    expect(fixed.requests).toHaveLength(3);
    response.release();
    expect((await submission).id).toBe('durable');
    await close;
    expect((await a.runtime.getCommand('durable'))?.cancelRequestedAt).toBeNull();
    expect(a.runtime.getLifecycleState().state).toBe('accepting');
    expect(b.model.requests).toHaveLength(0);
    expect(b.runtime.getLifecycleState()).toEqual({ state: 'closed', busy: false, reasons: [] });
  } finally {
    release.release();
    response.release();
    await b.close();
    await a.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed terminal binding disposal keeps cleanup busy and retains Store on shutdown failure', async () => {
  const entered = gate();
  const f = await fixture({
    async resolveRunConfiguration() {
      return {
        model: createFixedModel([[finish]]),
        modelId: 'fixed',
        snapshot: {},
        async dispose() {
          entered.release();
          throw new Error('retained binding');
        },
      };
    },
  });
  try {
    await f.submit('failed-dispose');
    await entered.promise;
    expect(f.runtime.tryBeginShutdown('if_idle').accepted).toBe(false);
    expect(f.runtime.getLifecycleState().reasons).toContain('cleanup');
    expect(await f.runtime.close().catch((error: unknown) => error)).toMatchObject({
      code: 'shutdown_cleanup_unconfirmed',
    });
    expect(f.runtime.getLifecycleState().state).toBe('drain_failed');
    expect(f.storeCloses()).toBe(0);
    expect((await f.runtime.getMetadata()).storeId).toBe(f.expectedStoreId);
  } finally {
    await f.original.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

async function backgroundFixture(unconfirmed: boolean, failDisposal = false) {
  const started = gate(),
    settled = gate(),
    bindingDisposed = gate();
  let cancels = 0,
    disposals = 0,
    bindingDisposals = 0;
  const job: JobDefinition = {
    id: 'fixture.job',
    version: '1',
    description: 'local retained Job',
    inputSchema: { type: 'object' },
    resources: { slot: 'process' },
    async start() {
      started.release();
      return { reference: { original: true } };
    },
    async *observe(): AsyncIterable<JobEvent> {
      await settled.promise;
      yield {
        type: 'terminal',
        result: { outcome: 'succeeded', content: 'done' },
        supervision: unconfirmed ? 'unknown' : 'ended',
      };
    },
    async cancel() {
      cancels++;
      settled.release();
      return { status: unconfirmed ? 'unknown' : 'stopped' };
    },
    async dispose() {
      disposals++;
      if (failDisposal) throw new Error('retained original Job handle');
    },
  };
  const tool: ToolDefinition = {
    id: 'fixture.tool',
    version: '1',
    description: 'start detached Job',
    inputSchema: { type: 'object' },
    async execute(_input, context) {
      await context.operations.ensure({
        key: 'background',
        cancellation: 'detached',
        request: { kind: 'job', definitionId: job.id, definitionVersion: job.version, input: {} },
      });
      await started.promise;
      return { outcome: 'succeeded', content: 'started' };
    },
  };
  const f = await fixture({
    permissions,
    async resolveRunConfiguration() {
      return {
        model: createFixedModel([calls, [finish]]),
        modelId: 'fixed',
        extensions: [{ id: 'fixture', version: '1', apiMajor: 1, tools: [tool], jobs: [job] }],
        snapshot: {},
        async dispose() {
          bindingDisposals++;
          bindingDisposed.release();
        },
      };
    },
  });
  return {
    ...f,
    started,
    settled,
    bindingDisposed,
    cancels: () => cancels,
    disposals: () => disposals,
    bindingDisposals: () => bindingDisposals,
  };
}

test('detached Job outlives completed parent and remains busy until its actual cancellation/disposal', async () => {
  const f = await backgroundFixture(false);
  try {
    await f.submit('background');
    await f.started.promise;
    await f.runtime.waitForCommand('background');
    expect((await f.runtime.getView(f.sessionId)).runs[0]?.isActive).toBe(false);
    expect(f.runtime.tryBeginShutdown('if_idle').accepted).toBe(false);
    expect(f.runtime.getLifecycleState().reasons).toContain('background');
    await f.runtime.close();
    expect(f.cancels()).toBe(1);
    expect(f.disposals()).toBe(1);
    expect(f.bindingDisposals()).toBe(1);
    expect(f.storeCloses()).toBe(1);
  } finally {
    f.settled.release();
    await f.close();
  }
});

test('unconfirmed detached Job retains its real handle/permit and Store; shutdown cannot report success', async () => {
  const f = await backgroundFixture(true);
  try {
    await f.submit('unconfirmed');
    await f.started.promise;
    await f.runtime.waitForCommand('unconfirmed');
    f.settled.release();
    expect(f.bindingDisposals()).toBe(0);
    expect(f.runtime.tryBeginShutdown('if_idle').accepted).toBe(false);
    expect(f.runtime.getLifecycleState().reasons).toContain('background');
    expect(await f.runtime.close().catch((error: unknown) => error)).toMatchObject({
      code: 'shutdown_cleanup_unconfirmed',
    });
    expect(f.runtime.getLifecycleState().state).toBe('drain_failed');
    expect(f.cancels()).toBe(2);
    expect(f.disposals()).toBe(0);
    expect(f.bindingDisposals()).toBe(0);
    expect(f.storeCloses()).toBe(0);
    expect((await f.runtime.getMetadata()).storeId).toBe(f.expectedStoreId);
  } finally {
    f.settled.release();
    await f.original.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('confirmed stop with failed original Job disposal still retains its handle and Store', async () => {
  const f = await backgroundFixture(false, true);
  try {
    await f.submit('failed-job-disposal');
    await f.started.promise;
    await f.runtime.waitForCommand('failed-job-disposal');
    expect(await f.runtime.close().catch((error: unknown) => error)).toMatchObject({
      code: 'shutdown_cleanup_unconfirmed',
    });
    expect(f.runtime.getLifecycleState().state).toBe('drain_failed');
    expect(f.disposals()).toBe(2);
    expect(f.bindingDisposals()).toBe(0);
    expect(f.cancels()).toBe(2);
    expect(f.storeCloses()).toBe(0);
    expect((await f.runtime.getMetadata()).storeId).toBe(f.expectedStoreId);
  } finally {
    f.settled.release();
    await f.original.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('unconfirmed Job retains binding until real stop/dispose and releases its OS permit before permit-dependent disposer', async () => {
  const root = mkdtempSync('/private/tmp/kite-runtime-lifecycle-permit-');
  const coordinator = createWorkspaceSerialLocks({ dataRoot: root, profile: 'temporary' });
  const started = gate(),
    settled = gate(),
    stopEntered = gate(),
    confirmStop = gate();
  const events: string[] = [];
  let cancels = 0,
    bindingDisposals = 0;
  const handle = { reference: { original: true } };
  const job: JobDefinition = {
    id: 'fixture.job',
    version: '1',
    description: 'original OS permit owner',
    inputSchema: { type: 'object' },
    resources: { serial: { scope: 'workspace', key: 'original-job' }, slot: 'process' },
    async start() {
      started.release();
      return handle;
    },
    async *observe() {
      await settled.promise;
      yield {
        type: 'terminal',
        result: { outcome: 'outcome_unknown', content: 'unconfirmed stop' },
        supervision: 'unknown',
      } as const;
    },
    async cancel(original) {
      expect(original).toBe(handle);
      if (++cancels === 1) return { status: 'unknown' };
      stopEntered.release();
      await confirmStop.promise;
      events.push('handle-stopped');
      return { status: 'stopped' };
    },
    async dispose(original) {
      expect(original).toBe(handle);
      events.push('handle-disposed');
    },
  };
  const tool: ToolDefinition = {
    id: 'fixture.tool',
    version: '1',
    description: 'detach original handle',
    inputSchema: { type: 'object' },
    async execute(_input, context) {
      await context.operations.ensure({
        key: 'original',
        cancellation: 'detached',
        request: { kind: 'job', definitionId: job.id, definitionVersion: job.version, input: {} },
      });
      await started.promise;
      return { outcome: 'succeeded', content: 'detached' };
    },
  };
  const f = await fixture(
    {
      workspaceSerialLocks: {
        async acquire(input, signal) {
          const release = await coordinator.acquire(input, signal);
          events.push('permit-acquired');
          return () => {
            release();
            events.push('permit-released');
          };
        },
      },
      async resolveRunConfiguration() {
        return {
          model: createFixedModel([calls, [finish]]),
          modelId: 'fixed',
          extensions: [{ id: 'fixture', version: '1', apiMajor: 1, tools: [tool], jobs: [job] }],
          snapshot: {},
          async dispose() {
            bindingDisposals++;
            events.push('binding-dispose');
            await coordinator.close();
          },
        };
      },
    },
    root,
  );
  try {
    await f.submit('permit-dependent');
    await started.promise;
    await f.runtime.waitForCommand('permit-dependent');
    settled.release();
    const close = f.runtime.close();
    await stopEntered.promise;
    expect(bindingDisposals).toBe(0);
    expect(events).toEqual(['permit-acquired']);
    expect(f.storeCloses()).toBe(0);
    confirmStop.release();
    await close;
    expect(events).toEqual([
      'permit-acquired',
      'handle-stopped',
      'handle-disposed',
      'permit-released',
      'binding-dispose',
    ]);
    expect(bindingDisposals).toBe(1);
    expect(f.storeCloses()).toBe(1);
  } finally {
    settled.release();
    confirmStop.release();
    await f.close();
    await coordinator.close();
    rmSync(root, { recursive: true, force: true });
  }
});
