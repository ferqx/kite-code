import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  PrivateImmutableArtifactRef,
  PrivateImmutableArtifactStorageBackend,
} from '@kite-ai/builtin-runtime/model';
import { aiMessage, humanMessage } from '@kite-ai/builtin-runtime/model';
import {
  SubagentCheckpointArtifactStore,
  SubagentResultArtifactStore,
} from '@kite-ai/builtin-runtime/subagent';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { executeTestRuntimeTool } from '../../../tests/helpers/runtime-model';
import {
  BackgroundSettlementAdmissionError,
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
  test('reads the exact owner-bound result Artifact before settlement callback completes', async () => {
    const owner = runtime();
    const ownerKey = backgroundSubagentOwnerKey('result-readback', 'recovery');
    const readback = deferred<void>();
    let readbackError: unknown;
    owner.adopt({
      taskId: 'result-readback-task',
      ownerKey,
      ...ORIGIN,
      observe: async () => terminal(),
      cancel: async () => {},
      onResultPersisted: (notification) => {
        try {
          expect(
            owner.readResultArtifact(ownerKey, notification.taskId, notification.resultArtifact),
          ).toMatchObject({ ok: true, terminalStatus: 'completed' });
          expect(() =>
            owner.readResultArtifact(
              'foreign-owner',
              notification.taskId,
              notification.resultArtifact,
            ),
          ).toThrow('owner or reference is unavailable');
          expect(() =>
            owner.readResultArtifact(ownerKey, notification.taskId, {
              ...notification.resultArtifact,
              byteLength: notification.resultArtifact.byteLength + 1,
            }),
          ).toThrow('owner or reference is unavailable');
        } catch (error) {
          readbackError = error;
        } finally {
          readback.resolve();
        }
      },
    });
    await readback.promise;
    if (readbackError) throw readbackError;
  });

  test('wakes only the exact owner when its background watermark advances', async () => {
    const owner = runtime();
    const firstOwner = backgroundSubagentOwnerKey('first', 'recovery');
    const secondOwner = backgroundSubagentOwnerKey('second', 'recovery');
    const firstResult = deferred<SubAgentResult>();
    const firstWatermark = owner.ownerWatermark(firstOwner);
    const secondWatermark = owner.ownerWatermark(secondOwner);
    let firstWoke = false;
    let secondWoke = false;
    const firstWake = owner.waitForOwnerChange(firstOwner, firstWatermark).then(() => {
      firstWoke = true;
    });
    void owner.waitForOwnerChange(secondOwner, secondWatermark).then(() => {
      secondWoke = true;
    });

    owner.adopt({
      taskId: 'first-task',
      ownerKey: firstOwner,
      ...ORIGIN,
      observe: () => firstResult.promise,
      cancel: async () => {},
    });
    await firstWake;
    expect(firstWoke).toBe(true);
    expect(secondWoke).toBe(false);
    expect(owner.ownerWatermark(firstOwner)).toBeGreaterThan(firstWatermark);
    expect(owner.ownerWatermark(secondOwner)).toBe(secondWatermark);
    firstResult.resolve(terminal());
  });

  test('waits for the first actionable target without cancelling still-running siblings', async () => {
    const owner = runtime();
    const ownerKey = backgroundSubagentOwnerKey('wait-any', 'recovery');
    const first = deferred<SubAgentResult>();
    const second = deferred<SubAgentResult>();
    owner.adopt({
      taskId: 'wait-first',
      ownerKey,
      ...ORIGIN,
      observe: () => first.promise,
      cancel: async () => {},
    });
    owner.adopt({
      taskId: 'wait-second',
      ownerKey,
      ...ORIGIN,
      observe: () => second.promise,
      cancel: async () => {},
    });

    const waiting = owner.waitTasks(ownerKey, ['wait-first', 'wait-second'], 1_000);
    first.resolve(terminal({ summary: 'first finished' }));
    await expect(waiting).resolves.toMatchObject({
      ok: true,
      status: 'completed',
      tasks: [{ task_id: 'wait-first', status: 'completed' }, { status: 'running' }],
    });
    expect(await owner.readTask(ownerKey, 'wait-second')).toMatchObject({ status: 'running' });
    second.resolve(terminal());
  });

  test('returns a successful timeout snapshot and leaves the child running', async () => {
    const owner = runtime();
    const ownerKey = backgroundSubagentOwnerKey('wait-timeout', 'recovery');
    const completion = deferred<SubAgentResult>();
    owner.adopt({
      taskId: 'wait-timeout-task',
      ownerKey,
      ...ORIGIN,
      observe: () => completion.promise,
      cancel: async () => {},
    });

    await expect(owner.waitTasks(ownerKey, ['wait-timeout-task'], 1)).resolves.toMatchObject({
      ok: true,
      status: 'timeout',
      tasks: [{ task_id: 'wait-timeout-task', status: 'running' }],
    });
    expect(owner.hasLiveTask('wait-timeout-task')).toBe(true);
    completion.resolve(terminal());
  });

  test('returns not_found immediately and maps run abort without cancelling the child', async () => {
    const owner = runtime();
    const ownerKey = backgroundSubagentOwnerKey('wait-abort', 'recovery');
    await expect(owner.waitTasks(ownerKey, ['missing'], 1_000)).resolves.toMatchObject({
      ok: false,
      status: 'not_found',
    });

    const completion = deferred<SubAgentResult>();
    owner.adopt({
      taskId: 'wait-abort-task',
      ownerKey,
      ...ORIGIN,
      observe: () => completion.promise,
      cancel: async () => {},
    });
    const controller = new AbortController();
    const waiting = owner.waitTasks(ownerKey, ['wait-abort-task'], 1_000, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toMatchObject({
      ok: false,
      status: 'cancelled',
      reason: 'run_cancelled',
      tasks: [{ status: 'running' }],
    });
    expect(owner.hasLiveTask('wait-abort-task')).toBe(true);
    completion.resolve(terminal());
  });

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
  test('tracks more than 256 simultaneously live children without a second owner cap', async () => {
    const owner = runtime();
    const ownerKey = backgroundSubagentOwnerKey('concurrent', 'recovery');
    const completion = deferred<SubAgentResult>();
    for (let index = 0; index < 257; index += 1) {
      owner.adopt({
        taskId: `concurrent-${index}`,
        ownerKey,
        ...ORIGIN,
        observe: () => completion.promise,
        cancel: async () => {},
      });
    }
    expect(owner.hasLiveTask('concurrent-256')).toBe(true);
    completion.resolve(terminal());
    while (owner.hasLiveTask('concurrent-256')) await Bun.sleep(0);
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
    });
    expect(await rebuilt.readTask(ownerKey, 'task-unsettled')).not.toHaveProperty('artifact');
    expect(await rebuilt.readTask(ownerKey, 'task-unsettled')).not.toHaveProperty('result');
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

  test('cancelOrigin cancels only children owned by the exact parent Run', async () => {
    const owner = runtime();
    const ownerKey = backgroundSubagentOwnerKey('cancel-origin', 'recovery');
    const first = deferred<Readonly<SubAgentResult>>();
    const second = deferred<Readonly<SubAgentResult>>();
    const cancelled: string[] = [];
    for (const [taskId, originRunId, completion] of [
      ['first-origin-task', 'run-first', first],
      ['second-origin-task', 'run-second', second],
    ] as const) {
      owner.adopt({
        taskId,
        ownerKey,
        ...ORIGIN,
        originRunId,
        observe: () => completion.promise,
        cancel: async () => {
          cancelled.push(taskId);
          completion.resolve(terminal({ ok: false, terminalStatus: 'cancelled' }));
        },
      });
    }

    await owner.cancelOrigin(ownerKey, 'run-first');

    expect(cancelled).toEqual(['first-origin-task']);
    expect(owner.hasLiveTask('first-origin-task')).toBe(false);
    expect(owner.hasLiveTask('second-origin-task')).toBe(true);
    second.resolve(terminal());
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
          status: 'running',
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
    expect(await owner.readTask(ownerKey, 'subagent-notify')).toMatchObject({
      status: 'completed',
      result: { summary: 'short persisted report' },
    });
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

  test('does not publish a suspended terminal before its settlement callback finishes', async () => {
    const owner = runtime();
    const ownerKey = backgroundSubagentOwnerKey('delayed-suspended-settlement', 'recovery');
    const callbackStarted = deferred<void>();
    const callback = deferred<void>();
    owner.adopt({
      taskId: 'delayed-suspended-task',
      ownerKey,
      ...ORIGIN,
      observe: async () => terminal({ ok: false, terminalStatus: 'suspended' }),
      cancel: async () => {},
      onResultPersisted: () => {
        callbackStarted.resolve();
        return callback.promise;
      },
    });

    const admittedWatermark = owner.ownerWatermark(ownerKey);
    let woke = false;
    const wake = owner.waitForOwnerChange(ownerKey, admittedWatermark).then(() => {
      woke = true;
    });
    await callbackStarted.promise;
    expect(woke).toBe(false);
    expect(owner.ownerWatermark(ownerKey)).toBe(admittedWatermark);

    callback.resolve();
    await wake;
    expect(owner.listSnapshot('delayed-suspended-settlement', ownerKey).executions).toEqual([
      expect.objectContaining({
        executionId: 'delayed-suspended-task',
        status: 'unavailable',
      }),
    ]);
  });

  test('binds a private checkpoint to the unique terminal proof without exposing it in task reads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-background-checkpoint-'));
    roots.push(root);
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
    const results = new SubagentResultArtifactStore({ backend });
    const checkpoints = new SubagentCheckpointArtifactStore({
      root: join(root, 'subagent-checkpoints'),
    });
    const owner = new BackgroundSubagentRuntime(results, checkpoints);
    const ownerKey = backgroundSubagentOwnerKey('checkpoint-session', 'recovery');
    const taskId = 'checkpoint-child';
    const ref = checkpoints.write({
      ownerKey,
      taskId,
      modelInvocationOrdinal: 2,
      messages: [humanMessage('inspect'), aiMessage({ content: 'done' })],
    });
    const callbackEntered = deferred<void>();
    const admit = deferred<void>();
    owner.adopt({
      taskId,
      ownerKey,
      ...ORIGIN,
      observe: async () => terminal({ checkpointRef: ref }),
      cancel: async () => {},
      onResultPersisted: async () => {
        callbackEntered.resolve();
        await admit.promise;
      },
    });
    await callbackEntered.promise;
    expect(owner.checkpointRefForTask(ownerKey, taskId)).toBeNull();
    admit.resolve();
    while (owner.hasLiveTask(taskId)) await Bun.sleep(0);
    expect(owner.checkpointRefForTask(ownerKey, taskId)).toEqual(ref);
    const taskRead = await owner.readTask(ownerKey, taskId);
    expect(taskRead).toMatchObject({ status: 'completed' });
    expect(JSON.stringify(taskRead)).not.toContain('checkpointRef');
    expect(JSON.stringify(taskRead)).not.toContain('inspect');

    const rebuilt = new BackgroundSubagentRuntime(results, checkpoints);
    expect(rebuilt.checkpointRefForTask(ownerKey, taskId)).toEqual(ref);
    // An exact terminal callback retry cannot replace the immutable proof
    // with an absent checkpoint pointer.
    owner.adopt({
      taskId,
      ownerKey,
      ...ORIGIN,
      observe: async () => terminal(),
      cancel: async () => {},
      onResultPersisted: async () => {},
    });
    while (owner.hasLiveTask(taskId)) await Bun.sleep(0);
    expect(owner.checkpointRefForTask(ownerKey, taskId)).toEqual(ref);

    owner.adopt({
      taskId: 'checkpoint-child-other',
      ownerKey,
      ...ORIGIN,
      observe: async () => terminal({ checkpointRef: ref }),
      cancel: async () => {},
    });
    while (owner.hasLiveTask('checkpoint-child-other')) await Bun.sleep(0);
    expect(owner.checkpointRefForTask(ownerKey, 'checkpoint-child-other')).toBeNull();
    expect(await owner.readTask(ownerKey, 'checkpoint-child-other')).toMatchObject({
      status: 'completed',
    });

    const laterRef = checkpoints.write({
      ownerKey,
      taskId: 'checkpoint-child-other',
      modelInvocationOrdinal: 1,
      messages: [humanMessage('later'), aiMessage({ content: 'later done' })],
    });
    owner.adopt({
      taskId: 'checkpoint-child-other',
      ownerKey,
      ...ORIGIN,
      observe: async () => terminal({ checkpointRef: laterRef }),
      cancel: async () => {},
    });
    while (owner.hasLiveTask('checkpoint-child-other')) await Bun.sleep(0);
    expect(owner.checkpointRefForTask(ownerKey, 'checkpoint-child-other')).toBeNull();
  });

  test('rebuilds a missing proof only from the exact admitted result and checkpoint identity', async () => {
    type Ref = PrivateImmutableArtifactRef<'subagent_task'>;
    const rows = new Map<
      string,
      { ref: Ref; payload: Uint8Array; ownerKey: string; taskId: string }
    >();
    let failProof = true;
    const backend: PrivateImmutableArtifactStorageBackend<'subagent_task'> = {
      write(ref, payload) {
        const value = JSON.parse(new TextDecoder().decode(payload)) as {
          ownerKey: string;
          taskId: string;
        };
        if (failProof && value.taskId.startsWith('settlement-'))
          throw new Error('crash before proof');
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
    const results = new SubagentResultArtifactStore({ backend });
    const root = mkdtempSync(join(tmpdir(), 'kite-checkpoint-repair-'));
    roots.push(root);
    const checkpoints = new SubagentCheckpointArtifactStore({
      root: join(root, 'subagent-checkpoints'),
    });
    const ownerKey = backgroundSubagentOwnerKey('checkpoint-repair-session', 'recovery');
    const taskId = 'checkpoint-repair-task';
    const checkpoint = checkpoints.write({
      ownerKey,
      taskId,
      modelInvocationOrdinal: 2,
      messages: [humanMessage('private instruction'), aiMessage({ content: 'private answer' })],
    });
    let state = createRuntimeHostStateInitialState({
      threadId: 'checkpoint-repair-session',
      userId: 'user',
      workspace: '/workspace',
      recoveryIdentityKey: 'a'.repeat(64),
    });
    const origin = {
      originRunId: 'checkpoint-repair-run',
      originTurnId: state.turn.turnId,
      originToolCallId: 'checkpoint-repair-tool',
      attempt: 1,
    };
    state.tools.calls[origin.originToolCallId] = {
      toolCallId: origin.originToolCallId,
      modelMessageId: 'checkpoint-repair-model',
      name: 'task',
      args: { background: true },
      status: 'succeeded',
      createdAtTurnId: origin.originTurnId,
    };
    state.capabilities.invocations[taskId] = {
      invocationId: taskId,
      toolCallId: origin.originToolCallId,
      capabilityId: 'builtin:task',
      capabilityRevision: 'v1',
      argumentsDigest: 'arguments',
      authorizationDigest: 'authorization',
      admissionDigest: 'admission',
      effectiveEffectsDigest: 'effects',
      receiptRequirement: 'observation_receipt',
      attemptsStarted: 1,
      status: 'succeeded',
      reconciliation: 'confirmed_success',
      recordedAt: '2026-09-20T00:00:00.000Z',
      subagentProviderLifecycle: {
        attempt: 1,
        purpose: 'start',
        childInvocationId: taskId,
        taskArtifact: {
          artifactId: `pa_${'1'.repeat(64)}`,
          kind: 'subagent_task',
          integrityIdentifier: `sha256:${'2'.repeat(64)}`,
          byteLength: 1,
        },
        dispatchIntentDigest: `sha256:${'3'.repeat(64)}`,
        status: 'cleanup_completed',
        recordedAt: '2026-09-20T00:00:00.000Z',
        cleanupAttempt: 1,
        cleanupKind: 'undispatched',
        cleanupStartedAt: '2026-09-20T00:00:00.000Z',
        cleanupConfirmed: true,
        cleanupCompletedAt: '2026-09-20T00:00:00.000Z',
      },
    };
    const owner = new BackgroundSubagentRuntime(results, checkpoints);
    owner.adopt({
      taskId,
      ownerKey,
      ...origin,
      observe: async () => terminal({ checkpointRef: checkpoint }),
      cancel: async () => {},
      onResultPersisted: async (notification) => {
        expect(notification.checkpointRef).toEqual(checkpoint);
        state = reduceRuntimeState(state, {
          type: 'subagent.background_result_persisted',
          taskId: notification.taskId,
          notificationId: notification.notificationId,
          artifactIntegrityIdentifier: notification.resultArtifact.integrityIdentifier,
          checkpointRef: notification.checkpointRef,
          shortReport: notification.shortReport,
          source: 'subagent',
          modelRole: 'user',
          originRunId: notification.originRunId,
          originTurnId: notification.originTurnId,
          originToolCallId: notification.originToolCallId,
          attempt: notification.attempt,
        });
        expect(
          state.capabilities.invocations[taskId]?.subagentProviderLifecycle?.backgroundResult,
        ).toEqual(expect.objectContaining({ checkpointRef: checkpoint }));
      },
    });
    while (owner.hasLiveTask(taskId)) await Bun.sleep(0);
    expect(
      state.capabilities.invocations[taskId]?.subagentProviderLifecycle?.backgroundResult
        ?.checkpointRef,
    ).toEqual(checkpoint);
    expect(owner.checkpointRefForTask(ownerKey, taskId)).toBeNull();
    const rebuilt = new BackgroundSubagentRuntime(results, checkpoints);
    expect(await rebuilt.readTask(ownerKey, taskId)).not.toHaveProperty('result');
    failProof = false;
    rebuilt.repairSettlementProofs(ownerKey, state);
    rebuilt.repairSettlementProofs(ownerKey, state);
    expect(rebuilt.checkpointRefForTask(ownerKey, taskId)).toEqual(checkpoint);
    const taskRead = await rebuilt.readTask(ownerKey, taskId);
    expect(taskRead).toMatchObject({
      status: 'completed',
      result: { summary: 'checked the target' },
    });
    expect(JSON.stringify(taskRead)).not.toContain('checkpointRef');
    expect(JSON.stringify(taskRead)).not.toContain('private instruction');

    // A checkpoint that became unreadable after canonical admission does not
    // roll back the already settled task result or create a fake continuation.
    for (const [artifactId, row] of rows)
      if (row.taskId.startsWith('settlement-')) rows.delete(artifactId);
    const withoutCheckpoint = new BackgroundSubagentRuntime(results, {
      read: () => {
        throw new Error('checkpoint corrupt');
      },
    });
    withoutCheckpoint.repairSettlementProofs(ownerKey, state);
    expect(await withoutCheckpoint.readTask(ownerKey, taskId)).toMatchObject({
      status: 'completed',
      result: { summary: 'checked the target' },
    });
    expect(withoutCheckpoint.checkpointRefForTask(ownerKey, taskId)).toBeNull();

    const unacceptedTaskId = 'checkpoint-not-admitted';
    owner.adopt({
      taskId: unacceptedTaskId,
      ownerKey,
      ...origin,
      observe: async () => terminal({ summary: 'unaccepted result' }),
      cancel: async () => {},
      onResultPersisted: async () => {
        throw new Error('canonical event not committed');
      },
    });
    while (owner.hasLiveTask(unacceptedTaskId)) await Bun.sleep(0);
    withoutCheckpoint.repairSettlementProofs(ownerKey, state);
    const unknown = await rebuilt.readTask(ownerKey, unacceptedTaskId);
    expect(unknown).toMatchObject({ status: 'unknown' });
    expect(unknown).not.toHaveProperty('artifact');
    expect(unknown).not.toHaveProperty('result');
  });

  for (const terminalStatus of ['completed', 'failed', 'suspended'] as const) {
    test(`holds a ${terminalStatus} result behind Kernel settlement proof`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'kite-background-settlement-gate-'));
      roots.push(root);
      const results = new SubagentResultArtifactStore({ root: join(root, 'subagent-tasks') });
      const owner = new BackgroundSubagentRuntime(results);
      const ownerKey = backgroundSubagentOwnerKey(`settlement-gate-${terminalStatus}`, 'recovery');
      const taskId = `settlement-gate-${terminalStatus}`;
      const callbackStarted = deferred<void>();
      const allowSettlement = deferred<void>();
      let durableArtifactRead = false;
      owner.adopt({
        taskId,
        ownerKey,
        ...ORIGIN,
        observe: async () =>
          terminal({
            ok: terminalStatus === 'completed',
            terminalStatus,
            summary: `${terminalStatus} result`,
          }),
        cancel: async () => {},
        onResultPersisted: async (notification) => {
          expect(results.read(notification.resultArtifact, taskId)).toMatchObject({
            summary: `${terminalStatus} result`,
          });
          durableArtifactRead = true;
          callbackStarted.resolve();
          await allowSettlement.promise;
        },
      });
      const admittedWatermark = owner.ownerWatermark(ownerKey);
      await callbackStarted.promise;
      expect(durableArtifactRead).toBe(true);
      expect(owner.ownerWatermark(ownerKey)).toBe(admittedWatermark);
      expect(owner.listSnapshot('settlement-gate', ownerKey).executions).toEqual([
        expect.objectContaining({ executionId: taskId, status: 'running' }),
      ]);
      expect(await owner.readTask(ownerKey, taskId)).toMatchObject({
        task_id: taskId,
        status: 'running',
      });
      expect(await owner.readTask(ownerKey, taskId)).not.toHaveProperty('result');
      expect(await owner.waitTasks(ownerKey, [taskId], 0)).toMatchObject({
        status: 'timeout',
        tasks: [{ task_id: taskId, status: 'running' }],
      });

      const settled = owner.waitForOwnerChange(ownerKey, admittedWatermark);
      allowSettlement.resolve();
      await settled;
      expect(owner.ownerWatermark(ownerKey)).toBeGreaterThan(admittedWatermark);
      expect(await owner.readTask(ownerKey, taskId)).toMatchObject({
        task_id: taskId,
        status: terminalStatus,
        result: { summary: `${terminalStatus} result` },
      });
      expect(owner.listSnapshot('settlement-gate', ownerKey).executions).toEqual([
        expect.objectContaining({
          executionId: taskId,
          status: terminalStatus === 'suspended' ? 'unavailable' : terminalStatus,
        }),
      ]);
    });
  }

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
        throw new BackgroundSettlementAdmissionError({
          type: 'subagent.background_result_persisted',
          taskId: 'release-recovery-task',
          notificationId: 'recovered-notification',
        });
      },
      onSettlementFailed: async () => {
        releaseAttempts += 1;
        throw new Error('reservation persistence unavailable');
      },
    });
    const watermark = owner.ownerWatermark(ownerKey);
    await owner.waitForOwnerChange(ownerKey, watermark);
    expect(owner.listSnapshot('release-recovery', ownerKey).executions).toEqual([
      expect.objectContaining({
        executionId: 'release-recovery-task',
        status: 'unavailable',
      }),
    ]);
    expect(owner.settlementRecoveryEvents(ownerKey)).toEqual([
      {
        type: 'subagent.background_result_persisted',
        taskId: 'release-recovery-task',
        notificationId: 'recovered-notification',
      },
    ]);
    expect(releaseAttempts).toBeGreaterThan(0);
    await owner.disposeOwner(ownerKey, 'test_settlement_recovery', 50);
    const rebuilt = new BackgroundSubagentRuntime(new SubagentResultArtifactStore({ backend }));
    expect(rebuilt.settlementRecoveryReservations(ownerKey)).toEqual([
      'reservation-release-recovery',
    ]);
    expect(rebuilt.settlementRecoveryEvents(ownerKey)).toEqual([
      {
        type: 'subagent.background_result_persisted',
        taskId: 'release-recovery-task',
        notificationId: 'recovered-notification',
      },
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
    const unknownRead = await owner.readTask(ownerKey, 'proof-failure-task');
    expect(unknownRead).toMatchObject({ status: 'unknown', ok: false });
    expect(unknownRead).not.toHaveProperty('artifact');
    expect(unknownRead).not.toHaveProperty('result');
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

  test('routes task_wait through the ordinary Host pipeline with a bounded timeout', async () => {
    const owner = runtime();
    const recoveryIdentityKey = 'c'.repeat(64);
    const ownerKey = backgroundSubagentOwnerKey('session-wait-control', recoveryIdentityKey);
    const completion = deferred<SubAgentResult>();
    owner.adopt({
      taskId: 'subagent-wait-control',
      ownerKey,
      ...ORIGIN,
      observe: () => completion.promise,
      cancel: async () => {},
    });

    const execution = await executeTestRuntimeTool({
      workspace: process.cwd(),
      toolName: 'task_wait',
      args: { task_ids: ['subagent-wait-control'], timeout_ms: 0 },
      state: {
        threadId: 'session-wait-control',
        userId: 'test-user',
        recoveryIdentityKey,
      },
      execution: { backgroundSubagentRuntime: owner },
    });
    expect(execution.terminal).toMatchObject({
      type: 'tool.finished',
      toolCallId: 'test-tool:task_wait',
    });
    expect(execution.result?.stdout).toContain('"status":"timeout"');
    expect(execution.result?.stdout).toContain('subagent-wait-control');
    expect(owner.hasLiveTask('subagent-wait-control')).toBe(true);
    completion.resolve(terminal());
  });

  test('returns a terminal task when user input and task completion race', async () => {
    const sessionId = 'session-wait-user-race';
    const recoveryIdentityKey = 'd'.repeat(64);
    const initialState = createRuntimeHostStateInitialState({
      threadId: sessionId,
      userId: 'test-user',
      recoveryIdentityKey,
      workspace: process.cwd(),
    });
    let currentState = initialState;
    const waiterReady = deferred<void>();
    const stateChanged = deferred<void>();
    let waitCalls = 0;
    const backgroundSubagentRuntime = {
      waitTasks: async (_ownerKey: string, _taskIds: readonly string[], timeoutMs: number) => {
        waitCalls += 1;
        if (timeoutMs > 0) return await new Promise<Readonly<Record<string, unknown>>>(() => {});
        return {
          ok: true,
          status: 'completed',
          tasks: [{ ok: true, task_id: 'subagent-wait-race', status: 'completed' }],
        };
      },
    } as unknown as BackgroundSubagentRuntime;

    const execution = executeTestRuntimeTool({
      workspace: process.cwd(),
      toolName: 'task_wait',
      args: { task_ids: ['subagent-wait-race'], timeout_ms: 30_000 },
      state: initialState,
      execution: {
        backgroundSubagentRuntime,
        getRuntimeState: () => currentState,
        waitForStateRevisionChange: async () => {
          waiterReady.resolve();
          await stateChanged.promise;
        },
      },
    });
    await waiterReady.promise;
    currentState = {
      ...currentState,
      revision: currentState.revision + 1,
      transcript: {
        ...currentState.transcript,
        messages: [
          ...currentState.transcript.messages,
          {
            kind: 'user',
            turnId: currentState.turn.turnId,
            messageId: 'steer-wait-race',
            ordinal: currentState.transcript.messages.length,
            createdAt: new Date().toISOString(),
            content: 'Use the new constraint.',
          },
        ],
      },
    };
    stateChanged.resolve();

    const result = await execution;
    expect(result.terminal).toMatchObject({
      type: 'tool.finished',
      toolCallId: 'test-tool:task_wait',
    });
    expect(result.result?.stdout).toContain('"status":"completed"');
    expect(result.result?.stdout).not.toContain('"reason":"user_input"');
    expect(waitCalls).toBe(2);
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
