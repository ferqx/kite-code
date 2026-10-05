import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../../src/artifacts';
import type { Extension } from '../../../../src/extensions';
import { createTaskExtension } from '../../../../src/extensions/task';
import { semanticDigest } from '../../../../src/json';
import { createRuntime } from '../../../../src/runtime';
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
for (const mode of [
  'report',
  'failed',
  'unknown',
  'human_before',
  'rewind',
  'cancel',
  'cold_read',
  'policy_deny',
  'missing_policy',
  'report_first',
  'apply_fault',
  'dual',
] as const) {
  test(`actual after_turn ${mode}: one sealed cause, independent authorization, no untrusted automatic replay`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-task-after-turn-'))),
      profile = { dataRoot: join(directory, 'data'), profile: 'test' };
    const store = await openSqliteStore(profile),
      storeId = (await store.getMetadata()).storeId,
      artifacts = createArtifactStore({ profile, store });
    const childGate = gate(),
      applyReady = gate(),
      applyGate = gate(),
      reportReady = gate(),
      reportGate = gate();
    const requests: ModelRequest[] = [],
      childRequests: ModelRequest[] = [];
    let disposals = 0,
      authorizations = 0;
    const effect: Extension = {
      id: 'fixture',
      version: '1',
      apiMajor: 1,
      tools: [
        {
          id: 'effect',
          version: '1',
          description: 'harmless actual failed or unknown fact',
          inputSchema: { type: 'object' },
          async execute() {
            return {
              outcome: mode === 'unknown' ? 'outcome_unknown' : 'failed',
              content: mode === 'unknown' ? 'unknown harmless effect' : 'known child failure',
            };
          },
        },
      ],
    };
    const parent: ModelAdapter = {
      async *stream(request) {
        requests.push(structuredClone(request));
        if (requests.length === 1) {
          yield {
            type: 'tool_call',
            id: 'task-call',
            name: 'task',
            arguments: JSON.stringify({
              key: 'report-task',
              role: 'reader',
              resultDisposition: 'after_turn',
              cancellation: 'detached',
              input: { content: 'exact original child' },
            }),
          };
          if (mode === 'dual')
            yield {
              type: 'tool_call',
              id: 'second-task-call',
              name: 'task',
              arguments: JSON.stringify({
                key: 'second-task',
                role: 'reader',
                resultDisposition: 'after_turn',
                cancellation: 'detached',
                input: { content: 'second exact child' },
              }),
            };
          yield { ...finish, reason: 'tool_calls' };
        } else {
          if (mode === 'report_first' && requests.length === 3) {
            reportReady.release();
            await reportGate.promise;
          }
          yield {
            type: 'text_delta',
            text: request.messages.some((message) =>
              message.sourceIds?.some((id) => id.startsWith('result-')),
            )
              ? 'report accurate child fact'
              : 'normal parent response',
          };
          yield finish;
        }
      },
    };
    const child: ModelAdapter = {
      async *stream(request) {
        childRequests.push(structuredClone(request));
        await childGate.promise;
        if (mode === 'failed' && request.messages.some((message) => message.role === 'tool'))
          throw new Error('fixed model failure after known Tool result');
        if (mode === 'failed' || mode === 'unknown') {
          yield { type: 'tool_call', id: 'effect-call', name: 'effect', arguments: '{}' };
          yield { ...finish, reason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'actual child result' };
          yield finish;
        }
      },
    };
    const task = createTaskExtension({
      roles: [{ id: 'reader', configurationId: 'child', description: 'trusted' }],
      afterTurn: { enabled: true },
    });
    const runtime = createRuntime({
      store,
      artifacts,
      modelId: 'root',
      permissions: {
        async authorize() {
          return { allowed: true, revision: '1' };
        },
      },
      extensions: [task, effect],
      modelConcurrency: 2,
      childConfigurations: [
        {
          id: 'child',
          version: '1',
          model: child,
          modelId: 'child',
          toolIds: ['effect'],
          snapshot: {},
        },
      ],
      resolveRunConfiguration: async () => ({
        model: parent,
        modelId: 'root',
        snapshot: { captured: 'original' },
        extensions: [],
        afterTurn:
          mode === 'missing_policy'
            ? undefined
            : {
                async authorize(input) {
                  authorizations++;
                  expect(input.execution.definitionId).toBe('task');
                  expect(input.execution.kind).toBe('tool');
                  expect(input.run.sessionId).toBe('root');
                  expect(input.configuration.id).toBe('child');
                  if (
                    input.phase === 'apply' &&
                    (mode === 'human_before' ||
                      mode === 'rewind' ||
                      mode === 'cold_read' ||
                      mode === 'dual')
                  ) {
                    applyReady.release();
                    await applyGate.promise;
                  }
                  return { allowed: mode !== 'policy_deny', revision: 'policy-1' };
                },
              },
        dispose: async () => {
          disposals++;
        },
      }),
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
        title: 'after turn',
      });
      await runtime.submitCommand({
        expectedStoreId: storeId,
        sessionId: 'root',
        subjectId: 'owner',
        commandId: 'work',
        request: { kind: 'run.start', content: 'delegate with independently authorized report' },
      });
      await runtime.waitForCommand('work', { timeoutMs: 6000 });
      expect(requests).toHaveLength(2);
      if (mode === 'policy_deny' || mode === 'missing_policy') {
        const denied = await store.getView('root');
        expect(denied.executions.filter((execution) => execution.childSessionId)).toHaveLength(0);
        expect(childRequests).toHaveLength(0);
        expect(
          denied.executions.find((execution) => execution.definitionId === 'task')!.result,
        ).toMatchObject({ outcome: 'failed' });
        await runtime.close();
        expect(disposals).toBe(1);
        return;
      }
      expect(disposals).toBe(0);
      const before = await store.getView('root'),
        carrier = before.executions.find((execution) => execution.childSessionId)!;
      expect(carrier.afterTurn).not.toBeNull();
      if (mode === 'apply_fault') {
        const database = new Database(join(directory, 'data', 'test', 'core.db'));
        try {
          database.run(
            "CREATE TRIGGER report_apply_fault BEFORE INSERT ON run WHEN (SELECT kind FROM command WHERE id=NEW.origin_command_id)='job.report' BEGIN SELECT RAISE(ABORT,'report transaction rollback'); END",
          );
        } finally {
          database.close();
        }
      }
      expect(before.runs).toHaveLength(1);
      if (mode === 'cancel')
        await runtime.cancelSession({
          expectedStoreId: storeId,
          sessionId: 'root',
          subjectId: 'owner',
          commandId: 'stop',
          includeBackground: true,
        });
      childGate.release();
      await runtime.waitForCommand(carrier.originCommandId, { timeoutMs: 6000 });
      const fact = (await store.getExecution(carrier.id))!,
        reportId = `report-${await semanticDigest([storeId, fact.id, fact.resultRevision])}`;
      if (mode === 'human_before') {
        await applyReady.promise;
        await runtime.submitCommand({
          expectedStoreId: storeId,
          sessionId: 'root',
          subjectId: 'owner',
          commandId: 'human',
          request: { kind: 'run.start', content: 'human preferred' },
        });
        applyGate.release();
        await runtime.waitForCommand('human', { timeoutMs: 6000 });
      }
      if (mode === 'rewind') {
        await applyReady.promise;
        const selected = await runtime.selectContext({
          expectedStoreId: storeId,
          commandId: 'rewind',
          sessionId: 'root',
          subjectId: 'owner',
          expectedContextSelectionId: before.session.contextSelectionId,
          boundary: null,
        });
        expect(selected.selection.id).not.toBe(before.session.contextSelectionId);
        applyGate.release();
      }
      if (mode === 'dual') {
        for (const other of before.executions.filter(
          (execution) => execution.childSessionId && execution.id !== carrier.id,
        ))
          await runtime.waitForCommand(other.originCommandId, { timeoutMs: 6000 });
        await applyReady.promise;
        const page = await store.listPendingJobReports({
          expectedStoreId: storeId,
          sessionId: 'root',
          limit: 1,
        });
        expect(page.commands).toHaveLength(1);
        expect(page.nextAfterSeq).not.toBeNull();
        const next = await store.listPendingJobReports({
          expectedStoreId: storeId,
          sessionId: 'root',
          limit: 1,
          afterSeq: page.nextAfterSeq!,
          upperSeq: page.upperSeq,
        });
        expect(next.commands).toHaveLength(1);
        expect(next.nextAfterSeq).toBeNull();
        expect(next.commands[0]!.id).not.toBe(page.commands[0]!.id);
        applyGate.release();
        for (const pending of [...page.commands, ...next.commands])
          await runtime.waitForCommand(pending.id, { timeoutMs: 6000 });
      }
      if (mode === 'cold_read') {
        await applyReady.promise;
        const readonly = await openSqliteStore({ ...profile, mode: 'readonly' });
        try {
          const cursor = (await readonly.getMetadata()).lastChangeCursor;
          expect((await readonly.getCommand(reportId))!.status).toBe('accepted');
          expect(
            (
              await readonly.listPendingJobReports({
                expectedStoreId: storeId,
                sessionId: 'root',
                limit: 1,
              })
            ).commands.map((command) => command.id),
          ).toEqual([reportId]);
          expect((await readonly.getMetadata()).lastChangeCursor).toBe(cursor);
          expect(requests).toHaveLength(2);
        } finally {
          await readonly.close();
        }
        applyGate.release();
      }
      if (mode === 'report_first') {
        await reportReady.promise;
        const activeReport = (await store.getRun(
          ((await store.getCommand(reportId))!.receipt as { runId: string }).runId,
        ))!;
        expect(activeReport.isActive).toBe(true);
        await runtime.submitCommand({
          expectedStoreId: storeId,
          sessionId: 'root',
          subjectId: 'owner',
          commandId: 'later-human',
          request: { kind: 'run.start', content: 'later human stays separate' },
        });
        expect((await store.getRun(activeReport.id))!.isActive).toBe(true);
        reportGate.release();
        await runtime.waitForCommand('later-human', { timeoutMs: 6000 });
      }
      await runtime.waitForCommand(reportId, { timeoutMs: 6000 });
      const report = (await store.getCommand(reportId))!,
        view = await store.getView('root');
      if (mode === 'apply_fault') {
        expect(report.status).toBe('needs_review');
        expect(view.runs).toHaveLength(1);
        expect(requests).toHaveLength(2);
        expect((await store.getExecution(carrier.id))!.status).toBe('succeeded');
        expect((await store.getExecution(carrier.id))!.resultAcceptance).toBeNull();
        expect(
          (await store.getSelectedContext({ expectedStoreId: storeId, sessionId: 'root' }))
            .resultSources,
        ).toHaveLength(0);
      } else if (
        mode === 'report' ||
        mode === 'failed' ||
        mode === 'cold_read' ||
        mode === 'report_first' ||
        mode === 'dual'
      ) {
        expect(report.status).toBe('applied');
        expect(requests).toHaveLength(mode === 'report_first' || mode === 'dual' ? 4 : 3);
        expect(authorizations).toBe(mode === 'dual' ? 4 : 2);
        const source = (
          await store.getSelectedContext({ expectedStoreId: storeId, sessionId: 'root' })
        ).resultSources.find((source) => source.executionId === carrier.id)!;
        expect(source).toBeDefined();
        const containing = requests
          .slice(2)
          .filter((request) =>
            request.messages.some((message) => message.sourceIds?.includes(source.id)),
          );
        expect(containing.length).toBeGreaterThanOrEqual(1);
        for (const request of containing)
          expect(
            request.messages.filter((message) => message.sourceIds?.includes(source.id)),
          ).toHaveLength(1);
        if (mode === 'dual') {
          const selected = await store.getSelectedContext({
            expectedStoreId: storeId,
            sessionId: 'root',
          });
          expect(selected.resultSources).toHaveLength(2);
          expect(new Set(selected.resultSources.map((source) => source.id)).size).toBe(2);
        }
        expect(view.runs).toHaveLength(mode === 'report_first' || mode === 'dual' ? 3 : 2);
        expect(view.runs.every((run) => run.status === 'completed')).toBe(true);
        expect((await store.getExecution(carrier.id))!.status).toBe(
          mode === 'failed' ? 'failed' : 'succeeded',
        );
        const cursor = (await store.getMetadata()).lastChangeCursor,
          ownerSession = (await store.getSession('root'))!;
        if (ownerSession.ownerInstanceId) {
          const owner = {
            sessionId: 'root',
            instanceId: ownerSession.ownerInstanceId,
            generation: ownerSession.ownerGeneration,
          };
          const retry = await store.applyJobReport({
            expectedStoreId: storeId,
            owner,
            commandId: reportId,
            authorization: { revision: 'policy-1' },
          });
          expect(retry.run!.id).toBe((report.receipt as { runId: string }).runId);
          expect((await store.getMetadata()).lastChangeCursor).toBe(cursor);
        }
      } else {
        expect(report.status).toBe('rejected');
        expect(report.receipt).toMatchObject({
          outcome: 'suppressed',
          reason:
            mode === 'unknown'
              ? 'outcome_unknown'
              : mode === 'human_before'
                ? 'human_start_preferred'
                : mode === 'rewind'
                  ? 'context_rewound'
                  : 'cancelled',
        });
        expect(requests).toHaveLength(mode === 'human_before' ? 3 : 2);
        expect(
          requests
            .at(-1)!
            .messages.some((message) => message.sourceIds?.some((id) => id.startsWith('result-'))),
        ).toBe(false);
      }
      if (mode === 'apply_fault') {
        const database = new Database(join(directory, 'data', 'test', 'core.db'));
        try {
          database.run('DROP TRIGGER report_apply_fault');
        } finally {
          database.close();
        }
      }
      await runtime.close();
      expect(disposals).toBe(mode === 'human_before' || mode === 'report_first' ? 2 : 1);
      const readonly = await openSqliteStore({ ...profile, mode: 'readonly' });
      try {
        const cursor = (await readonly.getMetadata()).lastChangeCursor;
        expect(await readonly.getCommand(reportId)).toEqual(
          await store.getCommand(reportId).catch(() => report),
        );
        expect(
          (await readonly.listPendingJobReports({ expectedStoreId: storeId, sessionId: 'root' }))
            .commands,
        ).toHaveLength(0);
        expect((await readonly.getMetadata()).lastChangeCursor).toBe(cursor);
      } finally {
        await readonly.close();
      }
    } finally {
      childGate.release();
      applyGate.release();
      reportGate.release();
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 12000);
}
