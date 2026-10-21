import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import type { OperationRef } from '../../../src/extensions';
import { openSqliteStore } from '../../../src/sqlite';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
type Kind = 'command' | 'run' | 'execution' | 'session';
async function fixture(mode: 'model' | 'tool') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cancel-writer-')));
  const store = await openSqliteStore({ dataRoot: root, profile: 'test' });
  const peer = new Database(join(root, 'test', 'core.db'));
  let held = false;
  let calls = 0;
  let toolCalls = 0;
  let effects = 0;
  let started = gate();
  let aborted = gate();
  let signal: AbortSignal | undefined;
  let runModelCalls = 0;
  const waiting = async (actual: AbortSignal) => {
    signal = actual;
    actual.addEventListener('abort', aborted.release, { once: true });
    started.release();
    if (actual.aborted) aborted.release();
    await aborted.promise;
    actual.throwIfAborted();
  };
  const model: ModelAdapter = {
    async *stream(_request, options) {
      calls++;
      runModelCalls++;
      if (runModelCalls > 1) {
        yield { type: 'text_delta', text: 'acknowledged exact cancellation' };
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      if (mode === 'model') await waiting(options.signal);
      else {
        yield { type: 'tool_call', id: `tool-${calls}`, name: 'fixture.wait', arguments: '{}' };
        yield { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } };
      }
    },
  };
  const runtime = createRuntime({
    store,
    model,
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
        tools: [
          {
            id: 'fixture.wait',
            version: '1',
            description: 'Wait for exact cancellation',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              toolCalls++;
              try {
                await waiting(context.signal);
              } catch (error) {
                if (!context.signal.aborted) throw error;
                return { outcome: 'cancelled', content: 'stopped before its only effect' };
              }
              effects++;
              return { outcome: 'succeeded', content: 'effect' };
            },
          },
        ],
      },
    ],
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: pathToFileURL(root).href,
    name: 'w',
  });
  for (const sessionId of ['s', 'other'])
    await runtime.createSession({
      expectedStoreId,
      commandId: `create-${sessionId}`,
      sessionId,
      workspaceId: 'w',
      subjectId: 'owner',
      title: sessionId,
    });
  let runId = '';
  let executionId = '';
  let commandId = '';
  return {
    store,
    peer,
    runtime,
    expectedStoreId,
    get signal() {
      return signal!;
    },
    get calls() {
      return calls;
    },
    get toolCalls() {
      return toolCalls;
    },
    get effects() {
      return effects;
    },
    get runId() {
      return runId;
    },
    get executionId() {
      return executionId;
    },
    get commandId() {
      return commandId;
    },
    async start(id: string, content = 'wait for cancellation') {
      commandId = id;
      runModelCalls = 0;
      started = gate();
      aborted = gate();
      await runtime.submitCommand({
        expectedStoreId,
        commandId: id,
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content },
      });
      await started.promise;
      const command = await store.getCommand(id);
      runId = (command!.receipt as { runId: string }).runId;
      const executions = await store.listExecutions('s');
      executionId = executions.find((item) => item.runId === runId && item.kind === mode)!.id;
    },
    lock() {
      peer.run('BEGIN IMMEDIATE');
      held = true;
    },
    unlock() {
      if (held) {
        peer.run('ROLLBACK');
        held = false;
      }
    },
    cancel(
      kind: Kind,
      id: string,
      override: {
        expectedStoreId?: string;
        sessionId?: string;
        subjectId?: string;
        target?: string;
      } = {},
    ) {
      const input = {
        expectedStoreId,
        commandId: id,
        sessionId: 's',
        subjectId: 'owner',
        ...override,
      };
      if (kind === 'command')
        return runtime.cancelCommand({ ...input, targetCommandId: override.target ?? commandId });
      if (kind === 'run') return runtime.cancelRun({ ...input, runId: override.target ?? runId });
      if (kind === 'execution')
        return runtime.cancelExecution({ ...input, executionId: override.target ?? executionId });
      return runtime.cancelSession({ ...input, includeBackground: false });
    },
    async waitAbort(ms: number) {
      return Promise.race([aborted.promise.then(() => true), Bun.sleep(ms).then(() => false)]);
    },
    async close() {
      if (held) {
        peer.run('ROLLBACK');
        held = false;
      }
      if (commandId && !signal?.aborted)
        await runtime.cancelCommand({
          expectedStoreId,
          commandId: `cleanup-${commandId}`,
          sessionId: 's',
          subjectId: 'owner',
          targetCommandId: commandId,
        });
      if (commandId) await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
      await runtime.close();
      peer.close(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const kind of ['command', 'run', 'execution', 'session'] as const) {
  for (const mode of ['model', 'tool'] as const) {
    test(`${kind} cancellation aborts its live ${mode} before the real writer wait commits`, async () => {
      const f = await fixture(mode);
      let cancellation: Promise<unknown> | undefined;
      try {
        await f.start('run');
        f.lock();
        let settled = false;
        cancellation = f.cancel(kind, 'cancel').finally(() => {
          settled = true;
        });
        expect(await f.waitAbort(400)).toBe(true);
        expect(f.signal.aborted).toBe(true);
        expect(f.signal.reason).toMatchObject({
          code: kind === 'execution' ? 'execution_cancel_requested' : 'cancel_requested',
        });
        expect(settled).toBe(false);
        expect(await f.store.getCommand('cancel')).toBeNull();
        expect((await f.store.getCommand('run'))?.cancelRequestedAt).toBeNull();
        if (kind === 'command' && mode === 'model') {
          await Bun.sleep(1150);
          expect(settled).toBe(false);
        }
        f.unlock();
        expect(await cancellation).toMatchObject({ status: 'applied' });
        await f.runtime.waitForCommand('run', { timeoutMs: 5000 });
        const terminal = await f.store.getRun(f.runId);
        expect(terminal?.isActive).toBe(false);
        if (kind !== 'execution') expect(terminal?.status).toBe('cancelled');
        else if (mode === 'tool') expect(terminal?.status).toBe('completed');
        expect((await f.store.getExecution(f.executionId))?.status).toBe('cancelled');
        expect(f.calls).toBe(kind === 'execution' && mode === 'tool' ? 2 : 1);
        expect(f.toolCalls).toBe(mode === 'tool' ? 1 : 0);
        expect(f.effects).toBe(0);
      } finally {
        f.unlock();
        await cancellation?.catch(() => {});
        await f.close();
      }
    }, 10000);
  }
}

for (const kind of ['command', 'run', 'execution', 'session'] as const) {
  for (const mismatch of [
    'store',
    'subject',
    'session',
    ...(kind === 'session' ? [] : ['target']),
  ]) {
    test(`${kind} cancellation with wrong ${mismatch} cannot abort a live handle while its write waits`, async () => {
      const f = await fixture('tool');
      let cancellation: Promise<unknown> | undefined;
      try {
        await f.start('run');
        f.lock();
        const override =
          mismatch === 'store'
            ? { expectedStoreId: 'foreign' }
            : mismatch === 'subject'
              ? { subjectId: 'intruder' }
              : mismatch === 'session'
                ? { sessionId: 'other' }
                : { target: 'absent' };
        cancellation = f.cancel(kind, 'invalid-cancel', override).then(
          (receipt) => receipt,
          (error: unknown) => error,
        );
        expect(await f.waitAbort(125)).toBe(false);
        expect(f.signal.aborted).toBe(false);
        expect(await f.store.getCommand('invalid-cancel')).toBeNull();
        f.unlock();
        await cancellation;
        expect(f.signal.aborted).toBe(false);
        expect((await f.store.getCommand('run'))?.cancelRequestedAt).toBeNull();
        expect(f.calls).toBe(1);
        expect(f.toolCalls).toBe(1);
        expect(f.effects).toBe(0);
      } finally {
        f.unlock();
        await cancellation;
        await f.close();
      }
    }, 10000);
  }
}

test('replaying a committed session.cancel command while a writer is held cannot stop a newer Run', async () => {
  const f = await fixture('model');
  let replay: Promise<unknown> | undefined;
  try {
    await f.start('first-run');
    const first = await f.cancel('session', 'old-session-cancel');
    await f.runtime.waitForCommand('first-run', { timeoutMs: 5000 });
    await f.start('second-run', 'New task: wait for cancellation');
    const second = (await f.store.getCommand('second-run'))!;
    expect(second).toMatchObject({
      status: 'applied',
      request: { kind: 'run.start', content: 'New task: wait for cancellation' },
    });
    const receipt = second.receipt as { businessCommandId: string; humanInputCommandId: string };
    expect(receipt.businessCommandId).toBeString();
    expect(receipt.businessCommandId).not.toBe(second.id);
    expect(await f.store.getCommand(receipt.humanInputCommandId)).toMatchObject({
      request: { publicCommandId: second.id, content: 'New task: wait for cancellation' },
    });
    expect(await f.store.getRun(f.runId)).toMatchObject({
      originCommandId: receipt.businessCommandId,
      rootWorkCommandId: second.id,
    });
    const input = await f.runtime.readModelInput({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      executionId: f.executionId,
    });
    expect(
      input.request.messages.find(
        (message) => message.content === 'New task: wait for cancellation',
      )?.sourceIds,
    ).toEqual([receipt.businessCommandId]);
    f.lock();
    replay = f.cancel('session', 'old-session-cancel');
    expect(await f.waitAbort(250)).toBe(false);
    expect(f.signal.aborted).toBe(false);
    expect((await f.store.getCommand('second-run'))?.cancelRequestedAt).toBeNull();
    f.unlock();
    expect(await replay).toEqual(first);
    expect(f.signal.aborted).toBe(false);
    expect(await f.store.getRun(f.runId)).toMatchObject({ status: 'running', isActive: true });
    expect(f.calls).toBe(2);
    expect(f.effects).toBe(0);
  } finally {
    f.unlock();
    await replay;
    await f.close();
  }
}, 10000);

for (const readFault of [false, true]) {
  test(`background subtree cancellation ${readFault ? 'skips one failed ancestry observation but still commits durable cancellation' : 'stops its activated child before writer ACK'} without stopping a same-subject foreign root`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cancel-child-writer-')));
    const store = await openSqliteStore({ dataRoot: root, profile: 'test' });
    const peer = new Database(join(root, 'test', 'core.db'));
    const signals = new Map<string, AbortSignal>();
    const started = { child: gate(), foreign: gate() };
    let held = false;
    let child: OperationRef | undefined;
    let effects = 0;
    let parentCalls = 0;
    let foreignCalls = 0;
    const finish: Extract<ModelEvent, { type: 'finish' }> = {
      type: 'finish',
      reason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const childModel = createFixedModel([
      [
        {
          type: 'tool_call',
          id: 'child-hold',
          name: 'fixture.hold',
          arguments: '{"label":"child"}',
        },
        { ...finish, reason: 'tool_calls' },
      ],
      [finish],
    ]);
    const model: ModelAdapter = {
      async *stream(request) {
        const foreign = request.messages.some(
          (message) => message.role === 'user' && message.content === 'foreign',
        );
        if (foreign) {
          foreignCalls++;
          yield {
            type: 'tool_call',
            id: 'foreign-hold',
            name: 'fixture.hold',
            arguments: '{"label":"foreign"}',
          };
          yield { ...finish, reason: 'tool_calls' };
        } else {
          parentCalls++;
          if (parentCalls === 1) {
            yield { type: 'tool_call', id: 'delegate', name: 'fixture.delegate', arguments: '{}' };
            yield { ...finish, reason: 'tool_calls' };
          } else yield finish;
        }
      },
    };
    const runtime = createRuntime({
      store,
      model,
      modelId: 'parent',
      permissions: {
        async authorize() {
          return { allowed: true, revision: '1' };
        },
      },
      childConfigurations: [
        {
          id: 'child',
          version: '1',
          model: childModel,
          modelId: 'child',
          toolIds: ['fixture.hold'],
          snapshot: { fixture: 'child' },
        },
      ],
      extensions: [
        {
          id: 'fixture',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'fixture.delegate',
              version: '1',
              description: 'Create one actual background child',
              inputSchema: { type: 'object' },
              async execute(_input, context) {
                child = await context.operations.ensure({
                  key: 'child',
                  cancellation: 'detached',
                  request: {
                    kind: 'agent',
                    configurationId: 'child',
                    input: { content: 'child work' },
                  },
                });
                return { outcome: 'succeeded', content: 'child activated' };
              },
            },
            {
              id: 'fixture.hold',
              version: '1',
              description: 'Cooperative harmless child wait',
              inputSchema: { type: 'object' },
              async execute(input, context) {
                const label = (input as { label: 'child' | 'foreign' }).label;
                signals.set(label, context.signal);
                started[label].release();
                await new Promise<void>((resolve) => {
                  context.signal.addEventListener('abort', () => resolve(), { once: true });
                  if (context.signal.aborted) resolve();
                });
                if (context.signal.aborted)
                  return { outcome: 'cancelled', content: 'stopped before effect' };
                effects++;
                return { outcome: 'succeeded', content: 'effect' };
              },
            },
          ],
        },
      ],
    });
    const expectedStoreId = (await store.getMetadata()).storeId;
    const getSession = store.getSession.bind(store);
    const cancelWork = store.cancelWork.bind(store);
    const readFailed = gate();
    let faultCount = 0;
    let cancelWrites = 0;
    let cancellation: Promise<unknown> | undefined;
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        rootUri: pathToFileURL(root).href,
        name: 'w',
      });
      for (const sessionId of ['s', 'foreign'])
        await runtime.createSession({
          expectedStoreId,
          commandId: `create-${sessionId}`,
          sessionId,
          workspaceId: 'w',
          subjectId: 'owner',
          title: sessionId,
        });
      await runtime.submitCommand({
        expectedStoreId,
        commandId: 'parent',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'delegate' },
      });
      await started.child.promise;
      await runtime.waitForCommand('parent', { timeoutMs: 5000 });
      await runtime.submitCommand({
        expectedStoreId,
        commandId: 'foreign-run',
        sessionId: 'foreign',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'foreign' },
      });
      await started.foreign.promise;
      expect(child?.childSessionId).toBeDefined();
      expect((await store.getExecution(child!.executionId!))?.status).toBe('running');
      peer.run('BEGIN IMMEDIATE');
      held = true;
      if (readFault)
        store.getSession = async (id) => {
          if (id === 's' && faultCount === 0) {
            faultCount++;
            readFailed.release();
            throw new Error('fixture_exact_ancestry_read_failed');
          }
          return getSession(id);
        };
      store.cancelWork = async (input) => {
        if (input.commandId === 'cancel-subtree') cancelWrites++;
        return cancelWork(input);
      };
      let settled = false;
      cancellation = runtime
        .cancelSession({
          expectedStoreId,
          commandId: 'cancel-subtree',
          sessionId: 's',
          subjectId: 'owner',
          includeBackground: true,
        })
        .finally(() => {
          settled = true;
        });
      if (readFault) await readFailed.promise;
      const deadline = Date.now() + 1000;
      while (!cancelWrites && Date.now() < deadline) await Bun.sleep(1);
      expect(cancelWrites).toBe(1);
      expect(settled).toBe(false);
      expect(await store.getCommand('cancel-subtree')).toBeNull();
      expect(signals.get('child')!.aborted).toBe(true);
      expect(signals.get('foreign')!.aborted).toBe(false);
      expect(faultCount).toBe(readFault ? 1 : 0);
      expect(childModel.requests).toHaveLength(1);
      expect(foreignCalls).toBe(1);
      peer.run('ROLLBACK');
      held = false;
      expect(await cancellation).toMatchObject({ status: 'applied' });
      const childCommand = `child-start-${child!.executionId!}`;
      await runtime.waitForCommand(childCommand, { timeoutMs: 5000 });
      expect(signals.get('child')!.aborted).toBe(true);
      expect(signals.get('foreign')!.aborted).toBe(false);
      expect((await store.getCommand('foreign-run'))?.cancelRequestedAt).toBeNull();
      expect((await store.getView(child!.childSessionId!)).runs[0]?.status).toBe('cancelled');
      expect(effects).toBe(0);
      expect(parentCalls).toBe(2);
    } finally {
      if (held) peer.run('ROLLBACK');
      store.getSession = getSession;
      store.cancelWork = cancelWork;
      await cancellation?.catch(() => {});
      await runtime.cancelSession({
        expectedStoreId,
        commandId: 'cleanup-foreign',
        sessionId: 'foreign',
        subjectId: 'owner',
        includeBackground: true,
      });
      await runtime.waitForCommand('foreign-run', { timeoutMs: 5000 });
      await runtime.close();
      peer.close(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
}
