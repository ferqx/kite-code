import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PrivateImmutableArtifactRef,
  PrivateImmutableArtifactStorageBackend,
} from '@kite-ai/builtin-runtime/model';
import { SubagentResultArtifactStore } from '@kite-ai/builtin-runtime/subagent';
import { executeTestRuntimeTool } from '../../../tests/helpers/runtime-model';
import {
  BackgroundSubagentRuntime,
  backgroundSubagentOwnerKey,
} from '../src/bootstrap/runtime/subagent/background-runtime';
import type { SubAgentResult } from '../src/bootstrap/runtime/subagent/types';

const roots: string[] = [];
const ORIGIN = {
  originRunId: 'origin-run',
  originTurnId: 'origin-turn',
  originToolCallId: 'origin-tool-call',
  attempt: 1,
} as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtime(): BackgroundSubagentRuntime {
  const root = mkdtempSync(join(tmpdir(), 'kite-background-subagent-'));
  roots.push(root);
  return new BackgroundSubagentRuntime(
    new SubagentResultArtifactStore({ root: join(root, 'subagent-tasks') }),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function terminal(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
  return {
    ok: true,
    summary: 'checked the target',
    toolCallCount: 2,
    durationMs: 15,
    terminalStatus: 'completed',
    ...overrides,
  };
}

describe('BackgroundSubagentRuntime', () => {
  test('reports settlement failure without letting callback failure hide the task error', async () => {
    const owner = runtime();
    const ownerKey = backgroundSubagentOwnerKey('failed', 'recovery');
    const failures: unknown[] = [];
    owner.adopt({
      taskId: 'failed-observe',
      ownerKey,
      ...ORIGIN,
      observe: async () => {
        throw new Error('observer lost');
      },
      cancel: async () => {},
      onSettlementFailed: async (error) => {
        failures.push(error);
        throw new Error('release callback failed');
      },
    });
    while (failures.length < 3) await Bun.sleep(0);
    expect(failures).toHaveLength(3);
    expect(await owner.readTask(ownerKey, 'failed-observe')).toMatchObject({
      status: 'unknown',
      error: 'observer lost',
    });
  });

  test('admits more than the live capacity across serial durable completions', async () => {
    const owner = runtime();
    const ownerKey = backgroundSubagentOwnerKey('serial', 'recovery');
    for (let index = 0; index < 257; index += 1) {
      const taskId = `serial-${index}`;
      owner.adopt({
        taskId,
        ownerKey,
        ...ORIGIN,
        observe: async () => terminal({ summary: taskId }),
        cancel: async () => {},
      });
      while (owner.hasLiveTask(taskId)) await Bun.sleep(0);
    }
    expect(await owner.readTask(ownerKey, 'serial-0')).toMatchObject({
      status: 'completed',
      result: { summary: 'serial-0' },
    });
    expect(await owner.readTask(ownerKey, 'serial-256')).toMatchObject({
      status: 'completed',
      result: { summary: 'serial-256' },
    });
  });
  test('reads and lists a durable terminal result after owner reconstruction', async () => {
    type Ref = PrivateImmutableArtifactRef<'subagent_task'>;
    const rows = new Map<
      string,
      { ref: Ref; payload: Uint8Array; ownerKey: string; taskId: string }
    >();
    const backend: PrivateImmutableArtifactStorageBackend<'subagent_task'> = {
      write(ref, payload) {
        const value = JSON.parse(new TextDecoder().decode(payload)) as {
          ownerKey: string;
          taskId: string;
        };
        rows.set(ref.artifactId, { ref, payload, ...value });
      },
      read: (ref) => rows.get(ref.artifactId)!.payload,
      findByOwnerTask: (ownerKey, taskId) =>
        [...rows.values()].find((row) => row.ownerKey === ownerKey && row.taskId === taskId)?.ref,
      listByOwner: (ownerKey) =>
        [...rows.values()].filter((row) => row.ownerKey === ownerKey).map((row) => row.ref),
      collectGarbage: () => ({
        scannedEntries: rows.size,
        retainedArtifacts: rows.size,
        deletedArtifacts: 0,
        deletedTemporaryFiles: 0,
      }),
    };
    const ownerKey = backgroundSubagentOwnerKey('session-reopen', 'recovery-reopen');
    const first = new BackgroundSubagentRuntime(new SubagentResultArtifactStore({ backend }));
    first.adopt({
      taskId: 'task-reopen',
      ownerKey,
      originRunId: 'run-1',
      originTurnId: 'turn-1',
      originToolCallId: 'tool-1',
      attempt: 1,
      observe: async () => terminal(),
      cancel: async () => {},
    });
    await Bun.sleep(5);
    first.adopt({
      taskId: 'task-unsettled',
      ownerKey,
      originRunId: 'run-1',
      originTurnId: 'turn-1',
      originToolCallId: 'tool-2',
      attempt: 1,
      observe: async () => terminal({ summary: 'artifact without settlement' }),
      cancel: async () => {},
      onResultPersisted: async () => {
        throw new Error('notification store unavailable');
      },
    });
    while (first.hasLiveTask('task-unsettled')) await Bun.sleep(0);
    await first.disposeOwner(ownerKey);
    const rebuilt = new BackgroundSubagentRuntime(new SubagentResultArtifactStore({ backend }));
    expect(await rebuilt.readTask(ownerKey, 'task-reopen')).toMatchObject({
      status: 'completed',
      result: { summary: 'checked the target' },
    });
    expect(rebuilt.listSnapshot('session-reopen', ownerKey).executions).toEqual([
      expect.objectContaining({
        executionId: 'task-reopen',
        status: 'completed',
        cleanupConfirmed: true,
      }),
      expect.objectContaining({
        executionId: 'task-unsettled',
        status: 'unavailable',
        cleanupConfirmed: true,
      }),
    ]);
    expect(await rebuilt.readTask(ownerKey, 'task-unsettled')).toMatchObject({
      ok: false,
      status: 'unknown',
      cleanup_confirmed: true,
      error: 'Background sub-agent settlement requires recovery.',
      result: { summary: 'artifact without settlement' },
    });
    expect(
      (await rebuilt.readTask(backgroundSubagentOwnerKey('other', 'other'), 'task-reopen')).status,
    ).toBe('not_found');
  });
  test('disposeOwner cancels only its children and removes live records after cleanup', async () => {
    const owner = runtime();
    const completion = deferred<Readonly<SubAgentResult>>();
    const ownerKey = backgroundSubagentOwnerKey('dispose', 'recovery');
    let cancelled = 0;
    owner.adopt({
      taskId: 'dispose-task',
      ownerKey,
      ...ORIGIN,
      observe: () => completion.promise,
      cancel: async () => {
        cancelled += 1;
        completion.resolve(terminal({ ok: false, terminalStatus: 'cancelled' }));
      },
    });
    await owner.disposeOwner(ownerKey);
    expect(cancelled).toBe(1);
    expect(owner.listSnapshot('dispose', ownerKey).executions).toEqual([]);
  });
  test('disposeOwner returns at its bound and retains unresolved cleanup for recovery', async () => {
    const owner = runtime();
    const ownerKey = backgroundSubagentOwnerKey('dispose-timeout', 'recovery');
    owner.adopt({
      taskId: 'hung-provider',
      ownerKey,
      ...ORIGIN,
      observe: () => new Promise(() => {}),
      cancel: async () => {},
    });
    const startedAt = performance.now();
    await owner.disposeOwner(ownerKey, 'test_shutdown', 5);
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(await owner.readTask(ownerKey, 'hung-provider')).toMatchObject({
      ok: false,
      status: 'unknown',
      cleanup_confirmed: false,
      error: 'Background sub-agent cleanup requires recovery.',
    });
  });

  test('disposeOwner bounds cancellation itself and starts sibling cancellations concurrently', async () => {
    const owner = runtime();
    const ownerKey = backgroundSubagentOwnerKey('dispose-cancel-timeout', 'recovery');
    let siblingCancelled = false;
    for (const [taskId, cancel] of [
      ['hung-cancel', () => new Promise<void>(() => {})],
      [
        'sibling-cancel',
        async () => {
          siblingCancelled = true;
        },
      ],
    ] as const) {
      owner.adopt({
        taskId,
        ownerKey,
        ...ORIGIN,
        observe: () => new Promise(() => {}),
        cancel,
      });
    }
    const startedAt = performance.now();
    await owner.disposeOwner(ownerKey, 'test_shutdown', 5);
    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(siblingCancelled).toBe(true);
  });

  test('wakes a precise stop waiter when Provider cancellation rejects', async () => {
    const owner = runtime();
    const ownerKey = backgroundSubagentOwnerKey('cancel-rejected', 'recovery');
    let terminalWake = 0;
    owner.adopt({
      taskId: 'cancel-rejected-task',
      ownerKey,
      ...ORIGIN,
      observe: () => new Promise(() => {}),
      cancel: async () => {
        throw new Error('cancel transport failed');
      },
    });
    expect(
      owner.requestCancel(ownerKey, 'cancel-rejected-task', () => {
        terminalWake += 1;
      }),
    ).toBe(true);
    while (terminalWake === 0) await Bun.sleep(0);
    expect(terminalWake).toBe(1);
    expect(await owner.readTask(ownerKey, 'cancel-rejected-task')).toMatchObject({
      status: 'unknown',
      cleanup_confirmed: false,
    });
  });
  test('owns the sole destructive observer and serves repeatable terminal Artifact reads', async () => {
    const owner = runtime();
    const completion = deferred<Readonly<SubAgentResult>>();
    const ownerKey = backgroundSubagentOwnerKey('session-a', 'recovery-a');
    let observeCalls = 0;
    owner.adopt({
      taskId: 'subagent-one',
      displayName: 'Inspect background ownership',
      ownerKey,
      ...ORIGIN,
      observe: () => {
        observeCalls += 1;
        return completion.promise;
      },
      cancel: async () => {},
    });

    expect(await owner.readTask(ownerKey, 'subagent-one')).toMatchObject({
      ok: true,
      task_id: 'subagent-one',
      status: 'running',
      cleanup_confirmed: false,
    });
    expect(observeCalls).toBe(1);
    const runningSnapshot = owner.listSnapshot('session-a', ownerKey);
    expect(runningSnapshot).toMatchObject({
      sessionId: 'session-a',
      executions: [
        {
          executionId: 'subagent-one',
          displayName: 'Inspect background ownership',
          kind: 'subagent',
          status: 'running',
          cleanupConfirmed: false,
        },
      ],
    });

    completion.resolve(terminal());
    await Bun.sleep(0);
    const first = await owner.readTask(ownerKey, 'subagent-one');
    const second = await owner.readTask(ownerKey, 'subagent-one');
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      task_id: 'subagent-one',
      status: 'completed',
      cleanup_confirmed: true,
      result: { summary: 'checked the target', terminalStatus: 'completed' },
      artifact: { kind: 'subagent_task' },
    });
    expect(observeCalls).toBe(1);
    const terminalSnapshot = owner.listSnapshot('session-a', ownerKey);
    expect(terminalSnapshot.watermark).toBeGreaterThan(runningSnapshot.watermark);
    expect(terminalSnapshot.executions[0]).toMatchObject({
      displayName: 'Inspect background ownership',
      status: 'completed',
      cleanupConfirmed: true,
    });
    expect(
      owner.listSnapshot('other', backgroundSubagentOwnerKey('other', 'other')).executions,
    ).toEqual([]);
  });

  test('publishes one stable low-privilege notification only after the result is durable', async () => {
    const owner = runtime();
    const ownerKey = backgroundSubagentOwnerKey('session-notify', 'recovery-notify');
    const completion = deferred<Readonly<SubAgentResult>>();
    const notifications: unknown[] = [];
    let startReceiptReturned = false;
    owner.adopt({
      taskId: 'subagent-notify',
      ownerKey,
      ...ORIGIN,
      observe: () => completion.promise,
      cancel: async () => {},
      onResultPersisted: async (notification) => {
        expect(startReceiptReturned).toBe(true);
        expect(await owner.readTask(ownerKey, notification.taskId)).toMatchObject({
          status: 'completed',
          result: { summary: 'short persisted report' },
        });
        notifications.push(notification);
      },
    });
    startReceiptReturned = true;
    completion.resolve(terminal({ summary: 'short persisted report' }));
    await Bun.sleep(5);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      source: 'subagent',
      modelRole: 'user',
      taskId: 'subagent-notify',
      shortReport: 'short persisted report',
    });
    expect((notifications[0] as { notificationId: string }).notificationId).toMatch(
      /^subagent:subagent-notify:sha256:/,
    );
  });

  test('reports a durable-result notification failure for admission release', async () => {
    const owner = runtime();
    const ownerKey = backgroundSubagentOwnerKey('notify-failed', 'recovery');
    const failures: unknown[] = [];
    owner.adopt({
      taskId: 'notify-failed',
      ownerKey,
      ...ORIGIN,
      observe: async () => terminal(),
      cancel: async () => {},
      onResultPersisted: async () => {
        throw new Error('notification persistence failed');
      },
      onSettlementFailed: (error) => {
        failures.push(error);
      },
    });
    while (failures.length === 0) await Bun.sleep(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ message: 'notification persistence failed' });
  });

  test('durably exposes an after-turn release after all immediate release attempts fail', async () => {
    type Ref = PrivateImmutableArtifactRef<'subagent_task'>;
    const rows = new Map<
      string,
      { ref: Ref; payload: Uint8Array; ownerKey: string; taskId: string }
    >();
    const backend: PrivateImmutableArtifactStorageBackend<'subagent_task'> = {
      write(ref, payload) {
        const value = JSON.parse(new TextDecoder().decode(payload)) as {
          ownerKey: string;
          taskId: string;
        };
        rows.set(ref.artifactId, { ref, payload, ...value });
      },
      read: (ref) => rows.get(ref.artifactId)!.payload,
      findByOwnerTask: (ownerKey, taskId) =>
        [...rows.values()].find((row) => row.ownerKey === ownerKey && row.taskId === taskId)?.ref,
      listByOwner: (ownerKey) =>
        [...rows.values()].filter((row) => row.ownerKey === ownerKey).map((row) => row.ref),
      collectGarbage: () => ({
        scannedEntries: rows.size,
        retainedArtifacts: rows.size,
        deletedArtifacts: 0,
        deletedTemporaryFiles: 0,
      }),
    };
    const owner = new BackgroundSubagentRuntime(new SubagentResultArtifactStore({ backend }));
    const ownerKey = backgroundSubagentOwnerKey('release-recovery', 'recovery');
    let releaseAttempts = 0;
    owner.adopt({
      taskId: 'release-recovery-task',
      ownerKey,
      ...ORIGIN,
      observe: async () => terminal(),
      cancel: async () => {},
      settlementRecoveryReservationId: 'reservation-release-recovery',
      onResultPersisted: async () => {
        throw new Error('wake scheduling failed');
      },
      onSettlementFailed: async () => {
        releaseAttempts += 1;
        throw new Error('reservation persistence unavailable');
      },
    });
    while (releaseAttempts < 3) await Bun.sleep(0);
    await owner.disposeOwner(ownerKey, 'test_settlement_recovery', 50);
    const rebuilt = new BackgroundSubagentRuntime(new SubagentResultArtifactStore({ backend }));
    expect(rebuilt.settlementRecoveryReservations(ownerKey)).toEqual([
      'reservation-release-recovery',
    ]);
    expect(rebuilt.listSnapshot('release-recovery', ownerKey).executions).toEqual([
      expect.objectContaining({
        executionId: 'release-recovery-task',
        status: 'unavailable',
        cleanupConfirmed: true,
      }),
    ]);
  });

  test('does not release a scheduled reservation when only settlement proof storage fails', async () => {
    type Ref = PrivateImmutableArtifactRef<'subagent_task'>;
    const rows = new Map<
      string,
      { ref: Ref; payload: Uint8Array; ownerKey: string; taskId: string }
    >();
    const backend: PrivateImmutableArtifactStorageBackend<'subagent_task'> = {
      write(ref, payload) {
        const value = JSON.parse(new TextDecoder().decode(payload)) as {
          ownerKey: string;
          taskId: string;
        };
        if (value.taskId.startsWith('settlement-')) throw new Error('proof store unavailable');
        rows.set(ref.artifactId, { ref, payload, ...value });
      },
      read: (ref) => rows.get(ref.artifactId)!.payload,
      findByOwnerTask: (ownerKey, taskId) =>
        [...rows.values()].find((row) => row.ownerKey === ownerKey && row.taskId === taskId)?.ref,
      listByOwner: (ownerKey) =>
        [...rows.values()].filter((row) => row.ownerKey === ownerKey).map((row) => row.ref),
      collectGarbage: () => ({
        scannedEntries: rows.size,
        retainedArtifacts: rows.size,
        deletedArtifacts: 0,
        deletedTemporaryFiles: 0,
      }),
    };
    const owner = new BackgroundSubagentRuntime(new SubagentResultArtifactStore({ backend }));
    const ownerKey = backgroundSubagentOwnerKey('proof-failure', 'recovery');
    let callbackCompleted = false;
    let releases = 0;
    owner.adopt({
      taskId: 'proof-failure-task',
      ownerKey,
      ...ORIGIN,
      observe: async () => terminal(),
      cancel: async () => {},
      settlementRecoveryReservationId: 'scheduled-reservation',
      onResultPersisted: async () => {
        callbackCompleted = true;
      },
      onSettlementFailed: async () => {
        releases += 1;
      },
    });
    while (!callbackCompleted) await Bun.sleep(0);
    await Bun.sleep(0);
    expect(releases).toBe(0);
    expect(owner.settlementRecoveryReservations(ownerKey)).toEqual([]);
    expect(owner.listSnapshot('proof-failure', ownerKey).executions).toEqual([
      expect.objectContaining({
        executionId: 'proof-failure-task',
        status: 'unavailable',
        cleanupConfirmed: true,
      }),
    ]);
  });

  test('cancels only the exact owned child and waits for its watcher cleanup', async () => {
    const owner = runtime();
    const ownerKey = backgroundSubagentOwnerKey('session-a', 'recovery-a');
    const first = deferred<Readonly<SubAgentResult>>();
    const second = deferred<Readonly<SubAgentResult>>();
    let firstCancels = 0;
    let secondCancels = 0;
    owner.adopt({
      taskId: 'subagent-first',
      ownerKey,
      ...ORIGIN,
      observe: () => first.promise,
      cancel: async () => {
        firstCancels += 1;
        first.resolve(
          terminal({
            ok: false,
            summary: 'cancelled',
            terminalStatus: 'cancelled',
          }),
        );
      },
    });
    owner.adopt({
      taskId: 'subagent-second',
      ownerKey,
      ...ORIGIN,
      observe: () => second.promise,
      cancel: async () => {
        secondCancels += 1;
      },
    });

    const cancelled = await owner.cancelTask(ownerKey, 'subagent-first');
    expect(cancelled).toMatchObject({
      ok: true,
      task_id: 'subagent-first',
      status: 'cancelled',
      cancel_requested: true,
      cleanup_confirmed: true,
    });
    expect(firstCancels).toBe(1);
    expect(secondCancels).toBe(0);
    expect(await owner.readTask(ownerKey, 'subagent-second')).toMatchObject({
      status: 'running',
      cleanup_confirmed: false,
    });
    expect(await owner.cancelTask(ownerKey, 'subagent-first')).toEqual(cancelled);
    expect(firstCancels).toBe(1);

    const foreign = await owner.readTask(
      backgroundSubagentOwnerKey('session-b', 'recovery-b'),
      'subagent-second',
    );
    expect(foreign).toMatchObject({ ok: false, status: 'not_found' });
    second.resolve(terminal());
  });

  test('routes task_read through the ordinary Host pipeline without opening subagent dispatch', async () => {
    const owner = runtime();
    const recoveryIdentityKey = 'a'.repeat(64);
    const ownerKey = backgroundSubagentOwnerKey('session-control', recoveryIdentityKey);
    owner.adopt({
      taskId: 'subagent-control',
      ownerKey,
      ...ORIGIN,
      observe: async () => terminal({ summary: 'durable control report' }),
      cancel: async () => {},
    });
    await Bun.sleep(0);

    const execution = await executeTestRuntimeTool({
      workspace: process.cwd(),
      toolName: 'task_read',
      args: { task_id: 'subagent-control' },
      state: {
        threadId: 'session-control',
        userId: 'test-user',
        recoveryIdentityKey,
      },
      execution: { backgroundSubagentRuntime: owner },
    });
    expect(execution.terminal).toMatchObject({
      type: 'tool.finished',
      toolCallId: 'test-tool:task_read',
    });
    expect(execution.result?.stdout).toContain('durable control report');
    expect(execution.result?.stdout).toContain('subagent-control');
  });

  test('routes task_cancel to the same owner and returns only after target cleanup', async () => {
    const owner = runtime();
    const recoveryIdentityKey = 'b'.repeat(64);
    const ownerKey = backgroundSubagentOwnerKey('session-cancel', recoveryIdentityKey);
    const completion = deferred<Readonly<SubAgentResult>>();
    let cancels = 0;
    owner.adopt({
      taskId: 'subagent-cancel-control',
      ownerKey,
      ...ORIGIN,
      observe: () => completion.promise,
      cancel: async () => {
        cancels += 1;
        completion.resolve(
          terminal({ ok: false, summary: 'stopped by control', terminalStatus: 'cancelled' }),
        );
      },
    });

    const execution = await executeTestRuntimeTool({
      workspace: process.cwd(),
      toolName: 'task_cancel',
      args: { task_id: 'subagent-cancel-control' },
      state: {
        threadId: 'session-cancel',
        userId: 'test-user',
        recoveryIdentityKey,
      },
      execution: { backgroundSubagentRuntime: owner },
    });
    expect(cancels).toBe(1);
    expect(execution.terminal).toMatchObject({
      type: 'tool.finished',
      toolCallId: 'test-tool:task_cancel',
    });
    expect(execution.result?.stdout).toContain('"status":"cancelled"');
    expect(execution.result?.stdout).toContain('"cleanup_confirmed":true');
  });
});
