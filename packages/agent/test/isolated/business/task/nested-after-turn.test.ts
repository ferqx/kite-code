import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../../src/artifacts';
import { semanticDigest } from '../../../../src/json';
import { type AfterTurnPolicy, createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';
import {
  applyJobReport as applySnapshotJobReport,
  childReportCarrier,
} from '../../../../src/storage/sqlite/job-report-operations';
import { SqliteOperations } from '../../../../src/storage/sqlite/operations';
import { AgentError } from '../../../../src/storage/types';
import { createLegacyTaskFixture as createTaskExtension } from '../../../fixtures/legacy-task-surface';

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
async function expectHumanBusiness(
  runtime: ReturnType<typeof createRuntime>,
  store: Awaited<ReturnType<typeof openSqliteStore>>,
  storeId: string,
  commandId: string,
  content: string,
) {
  const command = (await store.getCommand(commandId))!;
  expect(command).toMatchObject({
    status: 'applied',
    request: { kind: 'run.start', content },
  });
  const receipt = command.receipt as {
    businessCommandId: string;
    humanInputCommandId: string;
    runId: string;
  };
  expect(receipt.businessCommandId).toBeString();
  expect(receipt.businessCommandId).not.toBe(commandId);
  expect(await store.getCommand(receipt.humanInputCommandId)).toMatchObject({
    kind: 'human.input',
    request: { publicCommandId: commandId, content, originalRequest: command.request },
  });
  expect(await store.getCommand(receipt.businessCommandId)).toMatchObject({
    status: 'applied',
    request: { content },
    receipt: { runId: receipt.runId },
  });
  expect(await store.getRun(receipt.runId)).toMatchObject({
    status: 'completed',
    rootWorkCommandId: commandId,
    originCommandId: receipt.businessCommandId,
  });
  const models = (await store.listExecutions('root')).filter(
    (execution) => execution.runId === receipt.runId && execution.kind === 'model',
  );
  expect(models.length).toBeGreaterThan(0);
  expect(models[0]!.status).toBe('succeeded');
  const inspected = await runtime.readModelInput({
    expectedStoreId: storeId,
    sessionId: 'root',
    subjectId: 'owner',
    executionId: models[0]!.id,
  });
  expect(inspected.confirmation).toBe('succeeded');
  expect(
    inspected.request.messages.find((message) => message.content === content)?.sourceIds,
  ).toEqual([receipt.businessCommandId]);
}

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
      applyGate = gate(),
      carrierSettlementReady = gate(),
      carrierSettlementGate = gate();
    const rootRequests: ModelRequest[] = [],
      childRequests: ModelRequest[] = [],
      grandchildRequests: ModelRequest[] = [];
    let childDisposals = 0,
      followupRun = '',
      followupSelection = '',
      outerCarrierId = '',
      carrierSettlementWaiting = false,
      reportObservedCompletedRunBeforeCarrier = false,
      carrierDeferredHits = 0;
    let carrierProofFailure: unknown;
    if (mode === 'early_result') {
      const finishExecution = store.finishExecution.bind(store);
      const applyJobReport = store.applyJobReport.bind(store);
      store.finishExecution = async (input) => {
        if (input.executionId === outerCarrierId && input.status === 'succeeded') {
          // Hold only the genuine carrier commit, after its child Run has completed.
          // A report attempted here must defer and retain its original binding.
          carrierSettlementWaiting = true;
          carrierSettlementReady.release();
          await carrierSettlementGate.promise;
          carrierSettlementWaiting = false;
        }
        return finishExecution(input);
      };
      store.applyJobReport = async (input) => {
        await carrierSettlementReady.promise;
        const beforeCarrierCommit = carrierSettlementWaiting;
        if (beforeCarrierCommit) {
          const carrier = (await store.getExecution(outerCarrierId))!;
          const childRun = (await store.getView(carrier.childSessionId!)).runs[0]!;
          const report = (await store.getCommand(input.commandId))!;
          reportObservedCompletedRunBeforeCarrier =
            report.kind === 'job.report' &&
            report.sessionId === carrier.childSessionId &&
            (report.request as { parentRunId: string }).parentRunId === childRun.id &&
            childRun.status === 'completed' &&
            !childRun.isActive &&
            carrier.status === 'running';
        }
        try {
          const applied = await applyJobReport(input);
          if (beforeCarrierCommit) {
            expect(applied).toMatchObject({
              started: false,
              run: null,
              command: {
                status: 'accepted',
                receipt: { outcome: 'report_deferred', reason: 'report_carrier_active' },
              },
            });
            const report = (await store.getCommand(input.commandId))!;
            expect(report).toMatchObject({
              status: 'accepted',
              receipt: { outcome: 'report_deferred', reason: 'report_carrier_active' },
            });
            const carrier = (await store.getExecution(outerCarrierId))!;
            const childView = await store.getView(carrier.childSessionId!);
            expect(childView.runs).toHaveLength(1);
            const childModels = childView.executions.filter(
              (execution) => execution.kind === 'model',
            );
            expect(childModels).toHaveLength(2);
            expect(childModels.every((execution) => execution.status === 'succeeded')).toBe(true);
            expect(childRequests).toHaveLength(2);
            const nested = (await store.getExecution(
              (report.request as { executionId: string }).executionId,
            ))!;
            expect(nested.resultAcceptance).toBeNull();
            expect(nested.delivery).toBe('pending');
            expect(
              (
                await store.getSelectedContext({
                  expectedStoreId: storeId,
                  sessionId: carrier.childSessionId!,
                })
              ).resultSources,
            ).toHaveLength(0);
            const reader = new Database(join(directory, 'data', 'test', 'core.db'), {
              readonly: true,
            });
            let snapshot: Buffer;
            try {
              snapshot = reader.serialize();
            } finally {
              reader.close();
            }
            // deserialize owns a private in-memory database; its header cannot retain
            // the live file's WAL journal mode, which requires filesystem sidecars.
            snapshot[18] = 1;
            snapshot[19] = 1;
            const mutations = [
              null,
              (db: SqliteOperations) =>
                db.run('UPDATE execution SET cancel_requested=1 WHERE id=?', outerCarrierId),
              (db: SqliteOperations) =>
                db.run("UPDATE execution SET state='outcome_unknown' WHERE id=?", outerCarrierId),
              (db: SqliteOperations) =>
                db.run('UPDATE execution SET child_session_id=NULL WHERE id=?', outerCarrierId),
              (db: SqliteOperations) =>
                db.run(
                  'UPDATE command SET subject_id=? WHERE id=?',
                  'other-owner',
                  childView.runs[0]!.originCommandId,
                ),
              (db: SqliteOperations) =>
                db.run(
                  'UPDATE execution SET root_work_seq=root_work_seq+1 WHERE id=?',
                  outerCarrierId,
                ),
              (db: SqliteOperations) =>
                db.run(
                  "UPDATE command SET request_json=json_set(request_json,'$.parentExecutionId',?) WHERE id=?",
                  nested.id,
                  childView.runs[0]!.originCommandId,
                ),
              (db: SqliteOperations) =>
                db.run(
                  "UPDATE command SET request_json=json_set(request_json,'$.resultRevision','invalid-revision') WHERE id=?",
                  input.commandId,
                ),
            ];
            for (const mutate of mutations) {
              const clone = Database.deserialize(snapshot);
              try {
                const db = new SqliteOperations(clone, false);
                const watermarks = () => ({
                  runs: db.row('SELECT COUNT(*) AS count FROM run')!.count,
                  sources: db.row(
                    "SELECT COUNT(*) AS count FROM context_snapshot WHERE kind='result_ref'",
                  )!.count,
                });
                const before = watermarks();
                mutate?.(db);
                const clonedReport = db.row('SELECT * FROM command WHERE id=?', input.commandId)!;
                if (!mutate) {
                  expect(() => childReportCarrier(db, clonedReport)).toThrow('report_unverifiable');
                  expect(applySnapshotJobReport(db, input)).toMatchObject({
                    started: false,
                    run: null,
                    command: {
                      status: 'accepted',
                      receipt: { outcome: 'report_deferred', reason: 'report_carrier_active' },
                    },
                  });
                } else {
                  try {
                    const rejected = applySnapshotJobReport(db, input);
                    expect(rejected).toMatchObject({
                      started: false,
                      run: null,
                      command: {
                        status: 'rejected',
                        receipt: { outcome: 'suppressed', reason: 'source_unverifiable' },
                      },
                    });
                  } catch (error) {
                    expect(error).toBeInstanceOf(AgentError);
                    expect((error as AgentError).code).toBe('report_unverifiable');
                  }
                }
                expect(watermarks()).toEqual(before);
                const clonedNested = db.execution(
                  db.row('SELECT * FROM execution WHERE id=?', nested.id)!,
                );
                expect(clonedNested.resultAcceptance).toBeNull();
                expect(
                  clonedNested.delivery === 'pending' || clonedNested.delivery === 'suppressed',
                ).toBe(true);
              } finally {
                clone.close();
              }
            }
            for (const originKind of ['child.start', 'job.report', 'job.report.continue']) {
              const clone = Database.deserialize(snapshot);
              try {
                const db = new SqliteOperations(clone, false);
                if (originKind !== 'child.start')
                  db.run(
                    "UPDATE command SET kind=?,request_json=json_set(request_json,'$.kind',?,'$.parentExecutionId',?),receipt_json=json_set(receipt_json,'$.runId','mismatched-parent-run') WHERE id=?",
                    originKind,
                    originKind,
                    outerCarrierId,
                    childView.runs[0]!.originCommandId,
                  );
                const clonedReport = db.row('SELECT * FROM command WHERE id=?', input.commandId)!;
                const watermarks = () => ({
                  runs: db.row('SELECT COUNT(*) AS count FROM run')!.count,
                  sources: db.row(
                    "SELECT COUNT(*) AS count FROM context_snapshot WHERE kind='result_ref'",
                  )!.count,
                });
                const before = watermarks();
                expect(() => childReportCarrier(db, clonedReport)).toThrow('report_unverifiable');
                if (originKind === 'child.start')
                  expect(applySnapshotJobReport(db, input)).toMatchObject({
                    started: false,
                    run: null,
                    command: {
                      status: 'accepted',
                      receipt: { outcome: 'report_deferred', reason: 'report_carrier_active' },
                    },
                  });
                else expect(() => applySnapshotJobReport(db, input)).toThrow('report_unverifiable');
                expect(watermarks()).toEqual(before);
                expect(
                  db.execution(db.row('SELECT * FROM execution WHERE id=?', nested.id)!)
                    .resultAcceptance,
                ).toBeNull();
                db.run("UPDATE execution SET state='succeeded' WHERE id=?", outerCarrierId);
                if (originKind === 'child.start')
                  expect(childReportCarrier(db, clonedReport).id).toBe(outerCarrierId);
                else
                  expect(() => childReportCarrier(db, clonedReport)).toThrow('report_unverifiable');
              } finally {
                clone.close();
              }
            }
            carrierDeferredHits++;
          }
          return applied;
        } catch (error) {
          carrierProofFailure = error;
          throw error;
        } finally {
          if (beforeCarrierCommit) carrierSettlementGate.release();
        }
      };
    }
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
            name: 'spawn_agent',
            arguments: JSON.stringify({
              key: 'child',
              role: 'child',
              result_disposition: 'background',
              cancellation: 'detached',
              input: { content: 'create nested report' },
            }),
          };
          yield { ...finish, reason: 'tool_calls' };
        } else if (mode === 'followup_before' && rootRequests.length === 3) {
          yield {
            type: 'tool_call',
            id: 'human-followup',
            name: 'followup_agent',
            arguments: JSON.stringify({
              task_id: 'child',
              key: 'next-child',
              after_run_id: followupRun,
              context_selection_id: followupSelection,
              content: 'explicit preferred child work',
              result_disposition: 'background',
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
            name: 'spawn_agent',
            arguments: JSON.stringify({
              key: 'grandchild',
              role: 'grandchild',
              result_disposition: 'after_turn',
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
        rootUri: pathToFileURL(directory).href,
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
      outerCarrierId = outer.id;
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
          database.run('PRAGMA busy_timeout=1000');
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
        if (carrierProofFailure) throw carrierProofFailure;
        expect(reportObservedCompletedRunBeforeCarrier).toBe(true);
        expect(carrierDeferredHits).toBeGreaterThan(0);
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
            content: 'New task: explicit new child work before report admission',
          },
        });
        await runtime.waitForCommand('preferred', { timeoutMs: 6000 });
        await expectHumanBusiness(
          runtime,
          store,
          storeId,
          'preferred',
          'New task: explicit new child work before report admission',
        );
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
      if (mode === 'early_result') {
        const resultSources = (
          await store.getSelectedContext({
            expectedStoreId: storeId,
            sessionId: outer.childSessionId!,
          })
        ).resultSources;
        expect(resultSources).toHaveLength(1);
        expect(resultSources[0]!.executionId).toBe(nested.id);
        expect((await store.getCommand(reportId))!.receipt).toMatchObject({
          sourceId: resultSources[0]!.id,
        });
        expect(sources[0]!.sourceIds).toContain(resultSources[0]!.id);
      }
      expect((await store.getExecution(outer.id))!.status).toBe('succeeded');
      expect(rootRequests).toHaveLength(2);
      expect(grandchildRequests).toHaveLength(1);
      await runtime.close();
      expect(childDisposals).toBe(1);
    } finally {
      grandchildGate.release();
      parentGate.release();
      applyGate.release();
      carrierSettlementReady.release();
      carrierSettlementGate.release();
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
          name: 'spawn_agent',
          arguments: JSON.stringify({
            key: 'first',
            role: 'reader',
            result_disposition: 'background',
            cancellation: 'detached',
            input: { content: 'initial child' },
          }),
        };
        yield { ...finish, reason: 'tool_calls' };
      } else if (requests.length === 3) {
        yield {
          type: 'tool_call',
          id: 'followup',
          name: 'followup_agent',
          arguments: JSON.stringify({
            task_id: 'first',
            key: 'second',
            after_run_id: afterRunId,
            context_selection_id: selectionId,
            content: 'explicit new child work',
            result_disposition: 'after_turn',
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
        expect(input.command.rootWorkCommandId).toBe('followup-work');
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
      rootUri: pathToFileURL(directory).href,
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
        content: 'New task: explicit new followup with independent report authorization',
      },
    });
    await runtime.waitForCommand('followup-work', { timeoutMs: 6000 });
    await expectHumanBusiness(
      runtime,
      store,
      storeId,
      'followup-work',
      'New task: explicit new followup with independent report authorization',
    );
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
