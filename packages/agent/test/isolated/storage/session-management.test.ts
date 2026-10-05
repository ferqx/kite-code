import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelEvent } from '@kite-ai/ai';
import { semanticDigest } from '../../../src/json';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function gate() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('management_fixture_timeout')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function rejection(work: Promise<unknown>, code: string) {
  expect(((await work.catch((error) => error)) as { code?: string }).code).toBe(code);
}
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-session-management-'))),
    profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'w',
    rootUri: `file://${root}`,
  });
  await store.createSession({
    expectedStoreId: storeId,
    commandId: 'create',
    sessionId: 's',
    subjectId: 'owner',
    workspaceId: 'w',
    title: 'original',
  });
  return {
    root,
    profile,
    store,
    storeId,
    base: { expectedStoreId: storeId, sessionId: 's', subjectId: 'owner' },
  };
}

test('root management CAS across real Workers and immutable same-ID snapshots preserve tombstone history', async () => {
  const f = await fixture();
  const peer = await openSqliteStore(f.profile);
  try {
    const base = { ...f.base, ifRevision: '0' };
    await rejection(
      f.store.renameSession({
        ...base,
        commandId: 'wrong-store',
        title: 'x',
        expectedStoreId: 'foreign',
      }),
      'store_identity_mismatch',
    );
    await rejection(
      f.store.renameSession({ ...base, commandId: 'intruder', title: 'x', subjectId: 'intruder' }),
      'permission_denied',
    );
    const race = await Promise.all([
      f.store.renameSession({ ...base, commandId: 'a', title: 'a' }).catch((error) => error),
      peer.renameSession({ ...base, commandId: 'b', title: 'b' }).catch((error) => error),
    ]);
    const winner = race.find((value) => value.command)!,
      loser = race.find((value) => value.code)!;
    expect(loser.code).toBe('session_revision_changed');
    expect(winner.session.controlRevision).toBe('1');
    const winnerInput = { ...base, commandId: winner.command.id, title: winner.session.title };
    const water = (await f.store.getMetadata()).lastChangeCursor;
    expect(await peer.renameSession(winnerInput)).toEqual(winner);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(water);
    await rejection(
      f.store.renameSession({ ...winnerInput, title: 'changed' }),
      'command_conflict',
    );
    await rejection(
      f.store.deleteSession({ ...base, commandId: 'stale' }),
      'session_revision_changed',
    );
    const deleted = await f.store.deleteSession({
      ...f.base,
      commandId: 'delete',
      ifRevision: '1',
    });
    expect(deleted.session.controlRevision).toBe('2');
    expect(Number.isFinite(deleted.session.deletedAt)).toBe(true);
    expect(deleted.session.deletedAt).toBeGreaterThan(0);
    expect(deleted.command.receipt).toMatchObject({
      outcome: 'delete_requested',
      stopConfirmed: false,
    });
    expect(await f.store.listSessions()).toHaveLength(0);
    expect((await f.store.getSession('s'))!.title).toBe(winner.session.title);
    const terminalWater = (await f.store.getMetadata()).lastChangeCursor;
    expect(await peer.deleteSession({ ...f.base, commandId: 'delete', ifRevision: '1' })).toEqual(
      deleted,
    );
    expect(await peer.renameSession(winnerInput)).toEqual(winner);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(terminalWater);
    await rejection(
      f.store.renameSession({ ...f.base, commandId: 'late', ifRevision: '2', title: 'revive' }),
      'session_deleted',
    );
    await rejection(
      f.store.acceptCommand({
        ...f.base,
        commandId: 'new-work',
        request: { kind: 'run.start', content: 'late' },
      }),
      'session_not_found',
    );
    expect(await f.store.getCommand('new-work')).toBeNull();
    const readonly = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    let calls = 0;
    const reader = createRuntime({
      store: readonly,
      modelId: 'forbidden',
      permissions: {
        async authorize() {
          throw new Error('readonly policy must not run');
        },
      },
      model: {
        async *stream() {
          calls++;
          yield finish;
        },
      },
    });
    try {
      const snapshot = (await readonly.getMetadata()).lastChangeCursor;
      expect((await reader.getView('s')).session.deletedAt).toBe(deleted.session.deletedAt);
      expect(await reader.listSessions()).toHaveLength(0);
      expect((await readonly.getMetadata()).lastChangeCursor).toBe(snapshot);
      expect(calls).toBe(0);
      await rejection(
        readonly.renameSession({
          ...f.base,
          commandId: 'readonly',
          ifRevision: '2',
          title: 'no write',
        }),
        'read_only',
      );
    } finally {
      await reader.close();
      await readonly.close();
    }
  } finally {
    await peer.close();
    await f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('delete/rename real SQL commit faults and INT64 overflow roll back control, stop flags and command receipt', async () => {
  const f = await fixture();
  const physical = new Database(join(f.profile.dataRoot, f.profile.profile, 'core.db'));
  try {
    const water = (await f.store.getMetadata()).lastChangeCursor;
    physical.run(
      "CREATE TRIGGER fail_manage BEFORE INSERT ON command WHEN NEW.kind IN ('session.delete','session.rename') BEGIN SELECT RAISE(ABORT,'rollback management'); END",
    );
    await rejection(
      f.store.deleteSession({ ...f.base, commandId: 'delete', ifRevision: '0' }),
      'SQLITE_CONSTRAINT_TRIGGER',
    );
    expect(await f.store.getSession('s')).toMatchObject({
      controlRevision: '0',
      deletedAt: null,
      nextSeq: '1',
    });
    expect(await f.store.getCommand('delete')).toBeNull();
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(water);
    await rejection(
      f.store.renameSession({
        ...f.base,
        commandId: 'rename',
        ifRevision: '0',
        title: 'not committed',
      }),
      'SQLITE_CONSTRAINT_TRIGGER',
    );
    expect((await f.store.getSession('s'))!.title).toBe('original');
    physical.run('DROP TRIGGER fail_manage');
    physical.run("UPDATE session SET control_revision=9223372036854775807 WHERE id='s'");
    await rejection(
      f.store.deleteSession({
        ...f.base,
        commandId: 'overflow',
        ifRevision: '9223372036854775807',
      }),
      'sequence_exhausted',
    );
    expect(await f.store.getCommand('overflow')).toBeNull();
    expect((await f.store.getSession('s'))!.deletedAt).toBeNull();
  } finally {
    physical.close();
    await f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('actual root delete aborts owned Tool/detached Job, keeps unknown facts and blocks late creation while another Session continues', async () => {
  const f = await fixture();
  const remoteStore = await openSqliteStore(f.profile);
  let remoteProvider = 0;
  const remoteRuntime = createRuntime({
    store: remoteStore,
    modelId: 'never',
    model: {
      async *stream() {
        remoteProvider++;
        yield finish;
      },
    },
    permissions: {
      async authorize() {
        return { allowed: false, revision: '1' };
      },
    },
  });
  const jobStarted = gate(),
    toolStarted = gate(),
    jobEnd = gate(),
    otherStarted = gate(),
    otherEnd = gate();
  let starts = 0,
    stops = 0,
    effects = 0,
    otherCancelled = false,
    models = 0;
  const runtime = createRuntime({
    store: f.store,
    modelConcurrency: 2,
    modelId: 'fixed',
    model: {
      async *stream(request, { signal }) {
        models++;
        if (request.messages.some((message) => message.content === 'other')) {
          otherStarted.release();
          signal.addEventListener(
            'abort',
            () => {
              otherCancelled = true;
            },
            { once: true },
          );
          await otherEnd.waiting;
          signal.throwIfAborted();
          yield finish;
        } else {
          yield { type: 'tool_call', id: 'launch', name: 'launch', arguments: '{}' };
          yield { type: 'tool_call', id: 'hold', name: 'hold', arguments: '{}' };
          yield { ...finish, reason: 'tool_calls' };
        }
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'launch',
            version: '1',
            description: 'actual harmless Job',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              await context.operations.ensure({
                key: 'job',
                cancellation: 'detached',
                request: { kind: 'job', definitionId: 'job', definitionVersion: '1', input: {} },
              });
              await bounded(jobStarted.waiting);
              return { outcome: 'succeeded', content: 'registered actual Job' };
            },
          },
          {
            id: 'hold',
            version: '1',
            description: 'physical effect after release',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              toolStarted.release();
              await new Promise<never>((_, reject) => {
                context.signal.addEventListener('abort', () => reject(context.signal.reason), {
                  once: true,
                });
                if (context.signal.aborted) reject(context.signal.reason);
              });
              effects++;
              return { outcome: 'succeeded', content: 'unreachable' };
            },
          },
        ],
        jobs: [
          {
            id: 'job',
            version: '1',
            description: 'supervised unknown cleanup',
            inputSchema: { type: 'object' },
            resources: { slot: 'process' },
            async start() {
              starts++;
              jobStarted.release();
              return { reference: { own: true } };
            },
            async *observe() {
              await jobEnd.waiting;
              yield {
                type: 'terminal',
                supervision: 'unknown',
                result: { outcome: 'outcome_unknown', content: 'accurate unknown cleanup' },
              };
            },
            async cancel() {
              stops++;
              jobEnd.release();
              return { status: 'unknown' };
            },
            async dispose() {},
          },
        ],
      },
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  try {
    await runtime.createSession({
      expectedStoreId: f.storeId,
      sessionId: 'other',
      workspaceId: 'w',
      subjectId: 'owner',
      commandId: 'other-create',
      title: 'other',
    });
    await runtime.submitCommand({
      ...f.base,
      commandId: 'work',
      request: { kind: 'run.start', content: 'original' },
    });
    await bounded(toolStarted.waiting);
    await runtime.submitCommand({
      expectedStoreId: f.storeId,
      sessionId: 'other',
      subjectId: 'owner',
      commandId: 'other-work',
      request: { kind: 'run.start', content: 'other' },
    });
    await bounded(otherStarted.waiting);
    const parent = (await f.store.getView('s')).executions.find(
      (execution) => execution.definitionId === 'hold',
    )!;
    const liveSession = (await f.store.getSession('s'))!;
    const owner = {
      sessionId: 's',
      instanceId: liveSession.ownerInstanceId!,
      generation: liveSession.ownerGeneration,
    };
    const queued = await f.store.ensureOperation({
      expectedStoreId: f.storeId,
      owner,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'work',
      parentExecutionId: parent.id,
      operationKey: 'queued',
      cancellation: 'detached',
      request: { kind: 'job', definitionId: 'job', definitionVersion: '1', input: {} },
    });
    const child = await f.store.ensureOperation({
      expectedStoreId: f.storeId,
      owner,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'work',
      parentExecutionId: parent.id,
      operationKey: 'child',
      cancellation: 'detached',
      request: { kind: 'agent', configurationId: 'child', input: {} },
      childConfiguration: { id: 'child', version: '1', snapshot: { modelId: 'fixed', tools: [] } },
    });
    await rejection(
      runtime.renameSession({
        expectedStoreId: f.storeId,
        subjectId: 'owner',
        commandId: 'child-rename',
        sessionId: child.childSessionId!,
        ifRevision: '0',
        title: 'no root borrow',
      }),
      'group_root_required',
    );
    await rejection(
      runtime.deleteSession({
        expectedStoreId: f.storeId,
        subjectId: 'owner',
        commandId: 'child-delete',
        sessionId: child.childSessionId!,
        ifRevision: '0',
      }),
      'group_root_required',
    );
    const deleted = await remoteRuntime.deleteSession({
      ...f.base,
      commandId: 'delete',
      ifRevision: '0',
    });
    expect(deleted.command.receipt).toMatchObject({ stopConfirmed: false });
    expect(starts).toBe(1);
    expect((await f.store.getSession(child.childSessionId!))!.deletedAt).toBe(
      deleted.session.deletedAt,
    );
    expect((await f.store.getCommand(`child-start-${child.executionId}`))!.status).toBe('rejected');
    await runtime.waitForCommand('work', { timeoutMs: 5000 });
    await bounded(jobEnd.waiting);
    await rejection(
      f.store.ensureOperation({
        expectedStoreId: f.storeId,
        owner: {
          sessionId: 's',
          instanceId: (await f.store.getSession('s'))!.ownerInstanceId!,
          generation: (await f.store.getSession('s'))!.ownerGeneration,
        },
        sessionId: 's',
        extensionId: 'fixture',
        originCommandId: 'work',
        parentExecutionId: parent.id,
        operationKey: 'late',
        cancellation: 'detached',
        request: { kind: 'job', definitionId: 'job', definitionVersion: '1', input: {} },
      }),
      'invalid_extension_scope',
    );
    await rejection(
      f.store.markDispatching({
        expectedStoreId: f.storeId,
        owner,
        executionId: queued.executionId!,
        authorization: {
          allowed: true,
          revision: '1',
          definitionVersion: '1',
          inputDigest: await semanticDigest({}),
        },
        requirements: [],
        freshness: { checked: true, source: parent.decisionSource },
      }),
      'cancelled_before_dispatch',
    );
    otherEnd.release();
    await runtime.waitForCommand('other-work', { timeoutMs: 5000 });
    const deadline = Date.now() + 5000;
    let view = await f.store.getView('s');
    while (view.executions.find((e) => e.kind === 'job')!.status !== 'outcome_unknown') {
      if (Date.now() > deadline) throw new Error('terminal_unknown_missing');
      await Bun.sleep(5);
      view = await f.store.getView('s');
    }
    expect(view.runs[0]!.status).toBe('cancelled');
    expect(view.executions.find((e) => e.kind === 'job')!.status).toBe('outcome_unknown');
    expect(effects).toBe(0);
    expect(stops).toBe(1);
    expect(otherCancelled).toBe(false);
    expect((await f.store.getView('other')).runs[0]!.status).toBe('completed');
    expect(models).toBe(2);
    expect(remoteProvider).toBe(0);
    expect((await f.store.listSessions()).map((session) => session.id)).toEqual(['other']);
  } finally {
    otherEnd.release();
    jobEnd.release();
    await remoteRuntime.close();
    await remoteStore.close();
    expect(await runtime.close().catch((error: unknown) => error)).toMatchObject({
      code: 'shutdown_cleanup_unconfirmed',
    });
    expect(runtime.getLifecycleState().state).toBe('drain_failed');
    expect((await f.store.getMetadata()).storeId).toBe(f.storeId);
    // Only the test-owned in-memory Job has no external process to retain.
    await f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
