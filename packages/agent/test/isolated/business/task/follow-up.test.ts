import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createRuntime } from '../../../../src';
import { createTaskExtension } from '../../../../src/extensions/task';
import { createProfileBackup } from '../../../../src/maintenance';
import { openSqliteStore } from '../../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
function call(name: string, input: unknown): ModelEvent[] {
  return [
    { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
    { ...finish, reason: 'tool_calls' },
  ];
}
test.each([
  'completed',
  'active',
  'root-stop',
  'root-delete',
  'dual',
  'old-cancel',
  'concurrent',
])('predecessor boundary=%s: follow-up creates a new carrier and deadline Run in the exact child Session without changing original lineage or replaying reads', async (mode) => {
  const active =
    mode === 'active' || mode === 'root-stop' || mode === 'root-delete' || mode === 'dual';
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-task-follow-up-')));
  const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const originalStoreClose = store.close.bind(store);
  let storeCloses = 0,
    childBindingCloses = 0,
    childStreams = 0;
  store.close = async () => {
    storeCloses++;
    await originalStoreClose();
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let releaseNext!: () => void;
  const nextGate = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  let nextReady!: () => void;
  const nextStarted = new Promise<void>((resolve) => {
    nextReady = resolve;
  });
  const requests: ModelRequest[] = [];
  let maxForeground = 0;
  const child: ModelAdapter = {
    async *stream(request) {
      childStreams++;
      try {
        requests.push(structuredClone(request));
        if (requests.length > 1)
          maxForeground = Math.max(
            maxForeground,
            (await store.getView(old.childSessionId)).runs.filter((r) => r.isActive).length,
          );
        if (requests.length === 2 && mode === 'old-cancel') {
          nextReady();
          await nextGate;
        }
        if (requests.length === 1) {
          ready();
          if (active) await gate;
        }
        yield { type: 'text_delta', text: `child answer ${requests.length}` };
        yield finish;
      } finally {
        childStreams--;
      }
    },
  };
  let calls = 0;
  let old!: {
    childSessionId: string;
    contextSelectionId: string;
    run: { id: string; deadlineAt: number };
  };
  const parent: ModelAdapter = {
    async *stream(request) {
      calls++;
      let events: ModelEvent[];
      if (calls === 1)
        events = call('task', {
          key: 'first',
          role: 'reader',
          input: { content: 'first work' },
          cancellation: 'detached',
        });
      else if (calls === 2) {
        await started;
        events = active
          ? call('task_read', { taskId: 'first' })
          : call('task_wait', { taskId: 'first', timeoutMs: 4000 });
      } else if (calls === 3) events = call('task_read', { taskId: 'first' });
      else if (calls === 4) {
        old = JSON.parse(request.messages.filter((m) => m.role === 'tool').at(-1)!.content).agent;
        events = call('followup_task', {
          taskId: 'first',
          ...(mode === 'concurrent' ? { resultDisposition: 'background' } : {}),
          key: 'second',
          afterRunId: old.run.id,
          contextSelectionId: old.contextSelectionId,
          content: 'new explicit work',
        });
      } else if (calls === 5 && mode === 'old-cancel')
        events = call('task_read', { taskId: 'second' });
      else if (calls === 6 && mode === 'old-cancel') {
        await nextStarted;
        events = call('task_cancel', { taskId: 'first', commandId: 'cancel-only-old' });
      } else if (calls === 7 && mode === 'old-cancel') {
        releaseNext();
        events = call('task_wait', { taskId: 'second', timeoutMs: 4000 });
      } else if (calls === 8 && mode === 'old-cancel')
        events = call('task_read', { taskId: 'second' });
      else if (calls === 5 && mode === 'dual')
        events = call('followup_task', {
          taskId: 'first',
          key: 'third',
          afterRunId: old.run.id,
          contextSelectionId: old.contextSelectionId,
          content: 'second explicit successor',
        });
      else if (calls === 6 && mode === 'dual') {
        release();
        events = call('task_wait', { taskId: 'second', timeoutMs: 4000 });
      } else if (calls === 7 && mode === 'dual')
        events = call('task_wait', { taskId: 'third', timeoutMs: 4000 });
      else if (calls === 5) {
        if (active) expect(requests).toHaveLength(1);
        if (mode === 'root-stop')
          await runtime.cancelSession({
            expectedStoreId: (await store.getMetadata()).storeId,
            sessionId: 'root',
            subjectId: 'owner',
            commandId: 'stop-before-activation',
            includeBackground: true,
          });
        if (mode === 'root-delete') {
          const Database = (await import('bun:sqlite')).Database;
          const db = new Database(join(directory, 'data', 'test', 'core.db'));
          try {
            db.run("UPDATE session SET delete_requested=1 WHERE id='root'");
          } finally {
            db.close();
          }
        }
        release();
        events = call('task_wait', { taskId: 'second', timeoutMs: 4000 });
      } else if (calls === 6) events = call('task_read', { taskId: 'second' });
      else events = [finish];
      for (const event of events) yield event;
    },
  };
  const taskExtension = createTaskExtension({
    roles: [{ id: 'reader', configurationId: 'child', description: 'trusted child' }],
  });
  const follow = taskExtension.tools!.find((tool) => tool.id === 'followup_task')!;
  const execute = follow.execute;
  follow.execute = async (input, context) => {
    if (mode === 'concurrent') {
      const args = input as Record<string, string>;
      const record = await context.records.get(`task/${args.taskId}`);
      const ref = (
        record!.value as unknown as { ref: import('../../../../src/extensions').OperationRef }
      ).ref;
      const request = {
        mode: 'follow_up' as const,
        key: args.key!,
        afterRunId: args.afterRunId!,
        contextSelectionId: args.contextSelectionId!,
        content: args.content!,
      };
      const [one, two] = await Promise.all([
        context.operations.sendAgentInput(ref, request),
        context.operations.sendAgentInput(ref, structuredClone(request)),
      ]);
      expect(one).toEqual(two);
    }
    const first = await execute(input, context);
    const repeat = await execute(structuredClone(input), context);
    expect(repeat).toEqual(first);
    const args = input as Record<string, string>;
    const record = await context.records.get(`task/${args.taskId}`);
    const ref = (
      record!.value as unknown as { ref: import('../../../../src/extensions').OperationRef }
    ).ref;
    let error: unknown;
    try {
      await context.operations.sendAgentInput(ref, {
        mode: 'follow_up',
        key: args.key!,
        afterRunId: 'wrong-run',
        contextSelectionId: args.contextSelectionId!,
        content: args.content!,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'input_target_changed' });
    try {
      await context.operations.readAgent({ ...ref, originStoreId: 'foreign' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'store_identity_mismatch' });
    return first;
  };
  const runtime = createRuntime({
    store,
    model: parent,
    modelId: 'parent',
    modelConcurrency: 2,
    extensions: [taskExtension],
    childConfigurations: [
      {
        id: 'child',
        version: '1',
        model: child,
        modelId: 'child',
        toolIds: [],
        snapshot: {},
        async dispose() {
          childBindingCloses++;
        },
      },
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'private',
      rootUri: `file://${directory}`,
    });
    await runtime.createSession({
      expectedStoreId,
      sessionId: 'root',
      workspaceId: 'w',
      subjectId: 'owner',
      commandId: 'create',
      title: 'follow-up',
    });
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 'root',
      subjectId: 'owner',
      commandId: 'work',
      request: { kind: 'run.start', content: 'delegate twice' },
    });
    await runtime.waitForCommand('work', { timeoutMs: 8000 });
    const root = await store.getView('root');
    if (mode === 'root-delete') {
      expect(requests).toHaveLength(1);
      expect((await store.getView(old.childSessionId)).runs).toHaveLength(1);
      expect(root.executions.filter((e) => e.childSessionId)).toHaveLength(2);
      expect(root.executions.filter((e) => e.childSessionId).at(-1)?.status).not.toBe('succeeded');
      return;
    }
    if (mode === 'root-stop') {
      expect(requests).toHaveLength(1);
      expect((await store.getView(old.childSessionId)).runs).toHaveLength(1);
      const stopped = await store.getCommand('stop-before-activation');
      expect(stopped?.receipt).toMatchObject({ outcome: 'cancel_requested' });
      const carriers = root.executions.filter((e) => e.childSessionId);
      expect(carriers).toHaveLength(2);
      expect(carriers.every((e) => e.cancelRequestedAt !== null)).toBe(true);
      return;
    }
    if (mode === 'dual') {
      expect(root.executions.filter((e) => e.childSessionId)).toHaveLength(3);
      expect(maxForeground).toBe(1);
      const childView = await store.getView(old.childSessionId);
      expect(childView.runs.filter((r) => r.isActive)).toHaveLength(0);
      expect(childView.runs.length).toBeGreaterThanOrEqual(2);
      expect(childView.runs.length).toBeLessThanOrEqual(3);
      expect(requests.length).toBe(childView.runs.length);
      return;
    }
    const tools = root.executions.filter((e) => e.kind === 'tool');
    expect(tools.filter((e) => e.status === 'failed').map((e) => e.result)).toEqual([]);
    expect(requests).toHaveLength(2);
    const carriers = root.executions.filter((e) => e.childSessionId);
    expect(carriers).toHaveLength(2);
    expect(
      carriers.every((e) => e.childSessionId === old.childSessionId && e.status === 'succeeded'),
    ).toBe(true);
    const view = await store.getView(old.childSessionId);
    expect(view.runs).toHaveLength(2);
    expect(
      view.runs.every((r) => r.status === 'completed' && r.deadlineAt === r.createdAt + 1800000),
    ).toBe(true);
    expect(view.runs.map((r) => r.id)).toContain(old.run.id);
    expect(new Set(view.runs.map((r) => r.originCommandId)).size).toBe(2);
    expect(requests[1]!.messages.some((m) => m.content.includes('child answer 1'))).toBe(true);
    expect(
      requests[1]!.messages.filter((m) => m.content.includes('new explicit work')),
    ).toHaveLength(1);
    const creator = await store.getCommand(`child-create-${carriers[0]!.id}`);
    expect(creator?.request).toMatchObject({ originExecutionId: carriers[0]!.id });
    const cursor = (await store.getMetadata()).lastChangeCursor;
    await store.getView(old.childSessionId);
    await store.getView('root');
    expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(requests).toHaveLength(2);
  } finally {
    release();
    releaseNext();
    const retained =
      mode === 'dual'
        ? (await store.getView('root')).executions.filter(
            (e) => e.childSessionId && e.status === 'outcome_unknown',
          )
        : [];
    if (retained.length) {
      expect(retained).toHaveLength(1);
      expect(retained[0]!.result).toMatchObject({
        outcome: 'outcome_unknown',
        details: { adapterAttempted: true, stopConfirmation: null },
      });
      // activateChildRun applies the same ordered admission: an already active
      // successor rejects session_busy; an earlier accepted successor rejects
      // input_order_conflict. Neither refusal creates a confirmed Job handle.
      expect(['session_busy', 'input_order_conflict']).toContain(
        (retained[0]!.result as { content: string }).content,
      );
      const requestsBeforeClose = requests.length;
      const storeId = (await store.getMetadata()).storeId;
      expect(await runtime.close().catch((error: unknown) => error)).toMatchObject({
        code: 'shutdown_cleanup_unconfirmed',
      });
      expect(runtime.getLifecycleState().state).toBe('drain_failed');
      expect(runtime.getLifecycleState().reasons).toContain('cleanup');
      expect(storeCloses).toBe(0);
      expect(childBindingCloses).toBe(0);
      expect((await store.getMetadata()).storeId).toBe(storeId);
      expect(childStreams).toBe(0);
      expect(requests).toHaveLength(requestsBeforeClose);
      expect((await store.getView(old.childSessionId)).runs.every((run) => !run.isActive)).toBe(
        true,
      );
      await expect(
        createProfileBackup({ profile, destinationRoot: join(directory, 'backups') }),
      ).rejects.toMatchObject({ code: 'owner_busy' });
      // This fixture has only in-memory fake models and no child tools or external processes.
      // Explicit test Store cleanup does not promote the unknown carrier or failed drain to success.
      await store.close();
      expect(storeCloses).toBe(1);
    } else {
      await runtime.close();
      expect(storeCloses).toBe(1);
      expect(childBindingCloses).toBe(1);
    }
    rmSync(directory, { recursive: true, force: true });
  }
}, 12000);
