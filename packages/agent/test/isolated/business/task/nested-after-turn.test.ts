import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../../src/artifacts';
import { createTaskExtension } from '../../../../src/extensions/task';
import { semanticDigest } from '../../../../src/json';
import { type AfterTurnPolicy, createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
for (const mode of ['report', 'apply_fault', 'early_result', 'followup_before'] as const) {
  test(`nested after_turn ${mode} in the original child Session retains exact deadline, source and binding without reviving its carrier`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-nested-report-')));
    const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
    const store = await openSqliteStore(profile),
      storeId = (await store.getMetadata()).storeId;
    const grandchildGate = gate(),
      parentReady = gate(),
      parentGate = gate(),
      applyReady = gate(),
      applyGate = gate();
    const rootRequests: ModelRequest[] = [],
      childRequests: ModelRequest[] = [],
      grandchildRequests: ModelRequest[] = [];
    let childDisposals = 0,
      followupRun = '',
      followupSelection = '';
    const task = createTaskExtension({
      roles: [
        { id: 'child', configurationId: 'child', description: 'trusted child' },
        { id: 'grandchild', configurationId: 'grandchild', description: 'trusted descendant' },
      ],
      afterTurn: { enabled: true },
    });
    const root: ModelAdapter = {
      async *stream(request) {
        rootRequests.push(structuredClone(request));
        if (rootRequests.length === 1) {
          yield {
            type: 'tool_call',
            id: 'root-task',
            name: 'task',
            arguments: JSON.stringify({
              key: 'child',
              role: 'child',
              resultDisposition: 'background',
              cancellation: 'detached',
              input: { content: 'create nested report' },
            }),
          };
          yield { ...finish, reason: 'tool_calls' };
        } else if (mode === 'followup_before' && rootRequests.length === 3) {
          yield {
            type: 'tool_call',
            id: 'human-followup',
            name: 'followup_task',
            arguments: JSON.stringify({
              taskId: 'child',
              key: 'next-child',
              afterRunId: followupRun,
              contextSelectionId: followupSelection,
              content: 'explicit preferred child work',
              resultDisposition: 'background',
            }),
          };
          yield { ...finish, reason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'root complete' };
          yield finish;
        }
      },
    };
    const child: ModelAdapter = {
      async *stream(request) {
        childRequests.push(structuredClone(request));
        if (mode === 'early_result' && childRequests.length === 2) {
          parentReady.release();
          await parentGate.promise;
        }
        if (childRequests.length === 1) {
          yield {
            type: 'tool_call',
            id: 'nested-task',
            name: 'task',
            arguments: JSON.stringify({
              key: 'grandchild',
              role: 'grandchild',
              resultDisposition: 'after_turn',
              cancellation: 'detached',
              input: { content: 'exact nested result' },
            }),
          };
          yield { ...finish, reason: 'tool_calls' };
        } else {
          yield {
            type: 'text_delta',
            text:
              childRequests.length === 2
                ? 'child initial complete'
                : 'child reports exact descendant result',
          };
          yield finish;
        }
      },
    };
    const grandchild: ModelAdapter = {
      async *stream(request) {
        grandchildRequests.push(structuredClone(request));
        await grandchildGate.promise;
        yield { type: 'text_delta', text: 'grandchild original result' };
        yield finish;
      },
    };
    const nestedPolicy: AfterTurnPolicy = {
      async authorize(input) {
        expect(input.execution.definitionId).toBe('task');
        expect(input.run.sessionId).not.toBe('root');
        if (mode === 'followup_before' && input.phase === 'apply') {
          applyReady.release();
          await applyGate.promise;
        }
        return { allowed: true, revision: 'nested-policy-1' };
      },
    };
    const runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      model: root,
      modelId: 'root',
      extensions: [task],
      afterTurn: mode === 'early_result' ? nestedPolicy : undefined,
      modelConcurrency: mode === 'early_result' ? 2 : 1,
      permissions: {
        async authorize() {
          return { allowed: true, revision: '1' };
        },
      },
      childConfigurations: [
        {
          id: 'child',
          version: '1',
          model: child,
          modelId: 'child',
          toolIds: ['task'],
          snapshot: {},
          afterTurn: mode === 'early_result' ? undefined : nestedPolicy,
          dispose: async () => {
            childDisposals++;
          },
        },
        {
          id: 'grandchild',
          version: '1',
          model: grandchild,
          modelId: 'grandchild',
          toolIds: [],
          snapshot: {},
        },
      ],
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        name: 'private',
        rootUri: `file://${directory}`,
      });
      await runtime.createSession({
        expectedStoreId: storeId,
        sessionId: 'root',
        workspaceId: 'w',
        subjectId: 'owner',
        commandId: 'create',
        title: 'nested',
      });
      await runtime.submitCommand({
        expectedStoreId: storeId,
        sessionId: 'root',
        subjectId: 'owner',
        commandId: 'work',
        request: { kind: 'run.start', content: 'delegate' },
      });
      await runtime.waitForCommand('work', { timeoutMs: 6000 });
      const outer = (await store.getView('root')).executions.find((e) => e.childSessionId)!;
      if (mode === 'early_result') await parentReady.promise;
      else await runtime.waitForCommand(outer.originCommandId, { timeoutMs: 6000 });
      const childBefore = await store.getView(outer.childSessionId!);
      const nested = childBefore.executions.find((e) => e.childSessionId)!;
      followupRun = childBefore.runs[0]!.id;
      followupSelection = childBefore.session.contextSelectionId;
      expect(childRequests).toHaveLength(2);
      expect(nested.afterTurn).not.toBeNull();
      expect((await store.getExecution(outer.id))!.status).toBe(
        mode === 'early_result' ? 'running' : 'succeeded',
      );
      expect(childDisposals).toBe(0);
      if (mode === 'apply_fault') {
        const database = new Database(join(directory, 'data', 'test', 'core.db'));
        try {
          database.run(
            "CREATE TRIGGER nested_report_fault BEFORE INSERT ON run WHEN (SELECT kind FROM command WHERE id=NEW.origin_command_id)='job.report' BEGIN SELECT RAISE(ABORT,'nested report rollback'); END",
          );
        } finally {
          database.close();
        }
      }
      grandchildGate.release();
      await runtime.waitForCommand(nested.originCommandId, { timeoutMs: 6000 });
      const settled = (await store.getExecution(nested.id))!;
      const reportId = `report-${await semanticDigest([storeId, settled.id, settled.resultRevision])}`;
      if (mode === 'early_result') {
        expect((await store.getCommand(reportId))!.status).toBe('accepted');
        expect((await store.getRun(childBefore.runs[0]!.id))!.isActive).toBe(true);
        expect(childRequests).toHaveLength(2);
        parentGate.release();
        await runtime.waitForCommand(outer.originCommandId, { timeoutMs: 6000 });
      }
      if (mode === 'followup_before') {
        await applyReady.promise;
        await runtime.submitCommand({
          expectedStoreId: storeId,
          sessionId: 'root',
          subjectId: 'owner',
          commandId: 'preferred',
          request: {
            kind: 'run.start',
            content: 'explicit new child work before report admission',
          },
        });
        await runtime.waitForCommand('preferred', { timeoutMs: 6000 });
        const nextCarrier = (await store.getView('root')).executions.find(
          (e) => e.childSessionId === outer.childSessionId && e.id !== outer.id,
        )!;
        await runtime.waitForCommand(nextCarrier.originCommandId, { timeoutMs: 6000 });
        applyGate.release();
      }
      await runtime.waitForCommand(reportId, { timeoutMs: 6000 });
      if (mode === 'followup_before') {
        expect((await store.getCommand(reportId))!.receipt).toMatchObject({
          outcome: 'suppressed',
          reason: 'human_start_preferred',
        });
        expect((await store.getView(outer.childSessionId!)).runs).toHaveLength(2);
        expect(childRequests).toHaveLength(3);
        expect(
          childRequests[2]!.messages
            .flatMap((m) => m.sourceIds ?? [])
            .filter((id) => id.startsWith('result-')),
        ).toHaveLength(0);
        expect((await store.getExecution(nested.id))!.delivery).toBe('suppressed');
        expect((await store.getExecution(nested.id))!.resultAcceptance).toBeNull();
        return;
      }
      if (mode === 'apply_fault') {
        expect((await store.getCommand(reportId))!.status).toBe('needs_review');
        expect((await store.getView(outer.childSessionId!)).runs).toHaveLength(1);
        expect((await store.getExecution(nested.id))!.delivery).toBe('pending');
        expect((await store.getExecution(nested.id))!.resultAcceptance).toBeNull();
        expect(childRequests).toHaveLength(2);
        expect((await store.getExecution(outer.id))!.status).toBe('succeeded');
        return;
      }
      expect((await store.getCommand(reportId))!.receipt).toMatchObject({
        outcome: 'report_started',
      });
      const childAfter = await store.getView(outer.childSessionId!);
      expect(childAfter.runs).toHaveLength(2);
      expect(childAfter.runs.every((r) => r.status === 'completed')).toBe(true);
      expect(childAfter.runs[1]!.deadlineAt).toBe(childAfter.runs[0]!.deadlineAt);
      expect(childRequests).toHaveLength(3);
      const sources = childRequests[2]!.messages.filter((m) =>
        m.sourceIds?.some((id) => id.startsWith('result-')),
      );
      expect(sources).toHaveLength(1);
      expect(JSON.stringify(sources)).toContain('grandchild original result');
      expect((await store.getExecution(outer.id))!.status).toBe('succeeded');
      expect(rootRequests).toHaveLength(2);
      expect(grandchildRequests).toHaveLength(1);
      await runtime.close();
      expect(childDisposals).toBe(1);
    } finally {
      grandchildGate.release();
      parentGate.release();
      applyGate.release();
      await runtime.close();
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20000);
}

test('explicit followup_task after_turn binds the new carrier and sender Run, reports once without reopening predecessor', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-followup-report-')));
  const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile),
    storeId = (await store.getMetadata()).storeId;
  const secondChildGate = gate();
  const requests: ModelRequest[] = [],
    childRequests: ModelRequest[] = [];
  let afterRunId = '',
    selectionId = '',
    policyCalls = 0;
  const task = createTaskExtension({
    roles: [{ id: 'reader', configurationId: 'child', description: 'trusted' }],
    afterTurn: { enabled: true },
  });
  const root: ModelAdapter = {
    async *stream(request) {
      requests.push(structuredClone(request));
      if (requests.length === 1) {
        yield {
          type: 'tool_call',
          id: 'first',
          name: 'task',
          arguments: JSON.stringify({
            key: 'first',
            role: 'reader',
            resultDisposition: 'background',
            cancellation: 'detached',
            input: { content: 'initial child' },
          }),
        };
        yield { ...finish, reason: 'tool_calls' };
      } else if (requests.length === 3) {
        yield {
          type: 'tool_call',
          id: 'followup',
          name: 'followup_task',
          arguments: JSON.stringify({
            taskId: 'first',
            key: 'second',
            afterRunId,
            contextSelectionId: selectionId,
            content: 'explicit new child work',
            resultDisposition: 'after_turn',
          }),
        };
        yield { ...finish, reason: 'tool_calls' };
      } else {
        yield { type: 'text_delta', text: 'root response' };
        yield finish;
      }
    },
  };
  const child: ModelAdapter = {
    async *stream(request) {
      childRequests.push(structuredClone(request));
      if (childRequests.length === 2) await secondChildGate.promise;
      yield {
        type: 'text_delta',
        text: childRequests.length === 1 ? 'predecessor original result' : 'new followup result',
      };
      yield finish;
    },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model: root,
    modelId: 'root',
    extensions: [task],
    modelConcurrency: 1,
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    afterTurn: {
      async authorize(input) {
        policyCalls++;
        expect(input.execution.definitionId).toBe('followup_task');
        expect(input.command.id).toBe('followup-work');
        return { allowed: true, revision: 'followup-policy-1' };
      },
    },
    childConfigurations: [
      { id: 'child', version: '1', model: child, modelId: 'child', toolIds: [], snapshot: {} },
    ],
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'private',
      rootUri: `file://${directory}`,
    });
    await runtime.createSession({
      expectedStoreId: storeId,
      sessionId: 'root',
      workspaceId: 'w',
      subjectId: 'owner',
      commandId: 'create',
      title: 'followup',
    });
    await runtime.submitCommand({
      expectedStoreId: storeId,
      sessionId: 'root',
      subjectId: 'owner',
      commandId: 'first-work',
      request: { kind: 'run.start', content: 'initial background work' },
    });
    await runtime.waitForCommand('first-work', { timeoutMs: 6000 });
    const first = (await store.getView('root')).executions.find((e) => e.childSessionId)!;
    await runtime.waitForCommand(first.originCommandId, { timeoutMs: 6000 });
    const initial = await store.getView(first.childSessionId!);
    afterRunId = initial.runs[0]!.id;
    selectionId = initial.session.contextSelectionId;
    await runtime.submitCommand({
      expectedStoreId: storeId,
      sessionId: 'root',
      subjectId: 'owner',
      commandId: 'followup-work',
      request: {
        kind: 'run.start',
        content: 'explicit new followup with independent report authorization',
      },
    });
    await runtime.waitForCommand('followup-work', { timeoutMs: 6000 });
    const second = (await store.getView('root')).executions.find(
      (e) => e.childSessionId && e.id !== first.id,
    )!;
    expect(second.childSessionId).toBe(first.childSessionId);
    expect(second.afterTurn).toMatchObject({
      parentRunId: (await store.getView('root')).runs[1]!.id,
      definitionId: 'followup_task',
    });
    expect(requests).toHaveLength(4);
    secondChildGate.release();
    await runtime.waitForCommand(second.originCommandId, { timeoutMs: 6000 });
    const settled = (await store.getExecution(second.id))!;
    const reportId = `report-${await semanticDigest([storeId, settled.id, settled.resultRevision])}`;
    await runtime.waitForCommand(reportId, { timeoutMs: 6000 });
    expect((await store.getCommand(reportId))!.receipt).toMatchObject({
      outcome: 'report_started',
    });
    expect(requests).toHaveLength(5);
    expect(JSON.stringify(requests[4]!.messages)).toContain('new followup result');
    const actualSource = requests[4]!.messages
      .flatMap((m) => m.sourceIds ?? [])
      .filter((id) => id.startsWith('result-'));
    expect(new Set(actualSource).size).toBe(actualSource.length);
    expect(childRequests).toHaveLength(2);
    const after = await store.getView(first.childSessionId!);
    expect(after.runs).toHaveLength(2);
    expect(after.runs[0]!.id).toBe(afterRunId);
    expect(after.runs.every((r) => r.status === 'completed')).toBe(true);
    expect((await store.getExecution(first.id))!.status).toBe('succeeded');
    expect(policyCalls).toBe(2);
  } finally {
    secondChildGate.release();
    await runtime.close();
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
