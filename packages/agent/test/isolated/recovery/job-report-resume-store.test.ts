import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import type { Extension } from '../../../src/extensions';
import { createTaskExtension } from '../../../src/extensions/task';
import { semanticDigest } from '../../../src/json';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import type { JobReportRecovery } from '../../../src/storage/sqlite/job-report-operations';
import { AgentError, type Json } from '../../../src/storage/types';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
async function fixture(withRequirements = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-job-report-resume-'))),
    profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile),
    expectedStoreId = (await store.getMetadata()).storeId;
  const pendingStore = new Proxy(store, {
    get(target, key) {
      if (key === 'applyJobReport')
        return async () => {
          throw new AgentError('report_recovery_required');
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Store;
  const task = createTaskExtension({
    roles: [{ id: 'reader', configurationId: 'child', description: 'fixed role' }],
    afterTurn: { enabled: true },
  });
  const obligation: Extension = {
    id: 'fixture.report-obligation',
    version: '1',
    apiMajor: 1,
    records: [{ contentType: 'fixture.required', contentVersion: 1, schema: { type: 'object' } }],
    conditions: {
      async evaluate(refs, _phase, context) {
        return Promise.all(
          refs.map(async (ref) => {
            const read = await context!.forRequirement(ref);
            const policy = await read.records.get(ref.recordKey);
            const head = await read.records.get(`run/${ref.runId}/head`);
            return {
              requirement: ref,
              recordRevision: policy!.revision,
              outcome: head?.value ? ('satisfied' as const) : ('unsatisfied' as const),
              evidence: { originalRunId: ref.runId },
            };
          }),
        );
      },
    },
  };
  const model = createFixedModel([
    [
      {
        type: 'tool_call',
        id: 'delegate',
        name: 'task',
        arguments: JSON.stringify({
          key: 'child',
          role: 'reader',
          resultDisposition: 'after_turn',
          cancellation: 'detached',
          input: { content: 'original child' },
        }),
      },
      { ...finish, reason: 'tool_calls' },
    ],
    [{ type: 'text_delta', text: 'parent completed' }, finish],
  ]);
  const runtime = createRuntime({
    store: pendingStore,
    artifacts: createArtifactStore({ profile, store }),
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
    extensions: [task, ...(withRequirements ? [obligation] : [])],
    initializeRunRequirements: withRequirements
      ? async (input) => {
          if (input.command.kind === 'job.report') return [];
          const context = await input.forExtension(obligation.id);
          const key = `run/${input.run.id}/required`;
          const record = await context.records.create({
            key,
            contentType: 'fixture.required',
            contentVersion: 1,
            value: { original: true },
          });
          await context.records.create({
            key: `run/${input.run.id}/head`,
            contentType: 'fixture.required',
            contentVersion: 1,
            value: { accepted: true },
          });
          return [
            {
              evaluationProvider: 'extension' as const,
              extensionId: obligation.id,
              definitionVersion: '1',
              requirementId: 'original-policy',
              recordKey: key,
              revision: record.revision,
              phase: 'both' as const,
              sessionId: input.run.sessionId,
              runId: input.run.id,
            },
          ];
        }
      : undefined,
    modelConcurrency: 2,
    childConfigurations: [
      {
        id: 'child',
        version: '1',
        model: createFixedModel([
          [{ type: 'text_delta', text: 'actual original child result' }, finish],
        ]),
        modelId: 'child',
        toolIds: [],
        snapshot: { child: true },
      },
    ],
    resolveRunConfiguration: async () => ({
      model,
      modelId: 'fixed',
      snapshot: { manifest: 'original', nested: { b: 2, a: 1 } },
      extensions: [],
      afterTurn: {
        async authorize() {
          return { allowed: true, revision: 'sealed-report-policy' };
        },
      },
    }),
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: `file://${root}`,
      name: 'fixture',
    });
    await runtime.createSession({
      expectedStoreId,
      sessionId: 'root',
      subjectId: 'owner',
      workspaceId: 'w',
      commandId: 'create',
      title: 'root',
    });
    await runtime.submitCommand({
      expectedStoreId,
      sessionId: 'root',
      subjectId: 'owner',
      commandId: 'work',
      request: { kind: 'run.start', content: 'delegate original job' },
    });
    await runtime.waitForCommand('work', { timeoutMs: 5000 });
    const view = await store.getView('root'),
      carrier = view.executions.find((execution) => execution.childSessionId)!;
    await runtime.waitForCommand(carrier.originCommandId, { timeoutMs: 5000 });
    const execution = (await store.getExecution(carrier.id))!,
      reportId = `report-${await semanticDigest([expectedStoreId, execution.id, execution.resultRevision])}`;
    await runtime.waitForCommand(reportId, { timeoutMs: 5000 });
    expect((await store.getCommand(reportId))!.receipt).toEqual({
      reason: 'report_recovery_required',
    });
    const parent = (await store.getRun(
      (execution.afterTurn as { parentRunId: string }).parentRunId,
    ))!;
    expect(parent.status).toBe('completed');
    await runtime.close();
    const cold = await openSqliteStore(profile),
      owner = (await cold.acquireSessionOwner('root', 'explicit-recovery'))!;
    const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
    const base = {
      expectedStoreId,
      owner,
      commandId: reportId,
      authorization: { revision: 'sealed-report-policy' },
    };
    return {
      root,
      profile,
      store: cold,
      db,
      reportId,
      parent,
      execution,
      base,
      async apply(
        commandId = 'resume',
        expectedConfiguration: Json = parent.configuration,
        subjectId = 'owner',
      ) {
        const input: Parameters<Store['applyJobReport']>[0] & { recovery: JobReportRecovery } = {
          ...base,
          recovery: { commandId, subjectId, expectedConfiguration },
        };
        return cold.applyJobReport(input);
      },
      async close() {
        db.close();
        await cold.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
async function rejected(work: Promise<unknown>, code: string) {
  expect(((await work.catch((error) => error)) as { code?: string }).code).toBe(code);
}

test('cold explicit report resume preserves sealed parent and consumes original result atomically once', async () => {
  const f = await fixture();
  try {
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    const preflight = {
      expectedStoreId: f.base.expectedStoreId,
      sessionId: 'root',
      reportCommandId: f.reportId,
      recovery: {
        commandId: 'resume',
        subjectId: 'owner',
        expectedConfiguration: f.parent.configuration,
      },
    };
    await f.store.verifyJobReportRecovery(preflight);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(await f.store.getCommand('resume')).toBeNull();
    // The report subject may legitimately differ from the Session creator; preflight must reject it before host restore.
    f.db.run("UPDATE command SET subject_id='foreign' WHERE id=?", [f.reportId]);
    await rejected(
      f.store.verifyJobReportRecovery({
        ...preflight,
        recovery: { ...preflight.recovery, subjectId: 'foreign' },
      }),
      'permission_denied',
    );
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(await f.store.getCommand('resume')).toBeNull();
    f.db.run("UPDATE command SET subject_id='owner' WHERE id=?", [f.reportId]);
    const initial = await f.store.getView('root');
    const resumed = await f.apply();
    expect(resumed.started).toBe(true);
    expect(resumed.command.id).toBe(f.reportId);
    expect(resumed.command.status).toBe('applied');
    expect(resumed.run?.originCommandId).toBe(f.reportId);
    expect(resumed.run?.configuration).toEqual(f.parent.configuration);
    const receipt = await f.store.getCommand('resume');
    expect(receipt?.kind).toBe('job.report.resume');
    expect(receipt?.request).toEqual({
      kind: 'job.report.resume',
      originalReportCommandId: f.reportId,
      expectedConfiguration: f.parent.configuration,
    });
    expect(receipt?.receipt).toEqual({
      reportCommandId: f.reportId,
      runId: resumed.run!.id,
      outcome: 'report_resumed',
    });
    const context = await f.store.getSelectedContext({
      expectedStoreId: f.base.expectedStoreId,
      sessionId: 'root',
    });
    expect(context.resultSources).toHaveLength(1);
    expect(context.resultSources[0]!.executionId).toBe(f.execution.id);
    expect(context.resultSources[0]!.originStoreId).toBe(f.base.expectedStoreId);
    const repeated = await f.apply();
    expect(repeated.started).toBe(false);
    expect(repeated.run?.id).toBe(resumed.run!.id);
    expect((await f.apply('resume-second')).run?.id).toBe(resumed.run!.id);
    expect((await f.store.getView('root')).runs).toHaveLength(initial.runs.length + 1);
    await rejected(f.apply('resume', { different: true }), 'command_conflict');
    await rejected(f.apply('changed', { different: true }), 'report_configuration_mismatch');
    await rejected(f.apply('foreign', f.parent.configuration, 'foreign'), 'permission_denied');
    expect(await f.store.getCommand('changed')).toBeNull();
    expect(await f.store.getCommand('foreign')).toBeNull();
  } finally {
    await f.close();
  }
}, 12000);

test('resume transaction rolls back report Run consumption and recovery command on late SQL fault', async () => {
  const f = await fixture();
  try {
    f.db.run(
      "CREATE TRIGGER resume_commit_fault BEFORE INSERT ON change_event WHEN NEW.type='job.report_recovered' BEGIN SELECT RAISE(ABORT,'atomic report recovery fault'); END",
    );
    const error = await f.apply().catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((await f.store.getCommand(f.reportId))!.status).toBe('needs_review');
    expect(await f.store.getCommand('resume')).toBeNull();
    expect((await f.store.getView('root')).runs).toHaveLength(1);
    expect(
      (
        await f.store.getSelectedContext({
          expectedStoreId: f.base.expectedStoreId,
          sessionId: 'root',
        })
      ).resultSources,
    ).toHaveLength(0);
    expect((await f.store.getExecution(f.execution.id))!.delivery).toBe('pending');
    f.db.run('DROP TRIGGER resume_commit_fault');
    expect((await f.apply()).run).not.toBeNull();
  } finally {
    await f.close();
  }
}, 12000);

test('a cold report inherits the exact original obligations and rejects stale original read sets before dispatch', async () => {
  const f = await fixture(true);
  try {
    expect(f.parent.requirements).toHaveLength(1);
    const activated = await f.apply();
    const run = activated.run!;
    expect(run.requirements).toEqual(f.parent.requirements);
    const write = { expectedStoreId: f.base.expectedStoreId, owner: f.base.owner };
    await f.store.beginRunRequirementsInitialization({ ...write, runId: run.id });
    const initialized = await f.store.registerRunRequirements({
      ...write,
      runId: run.id,
      initialize: true,
      requirements: [],
    });
    expect(initialized.requirements).toEqual(f.parent.requirements);
    await rejected(
      f.store.registerRunRequirements({ ...write, runId: run.id, requirements: run.requirements }),
      'requirement_scope_mismatch',
    );
    const source = { kind: 'model_decision', modelExecutionId: 'fixed' };
    await f.store.planExecution({
      ...write,
      executionId: 'original-report-model',
      sessionId: 'root',
      runId: run.id,
      originCommandId: f.reportId,
      kind: 'model',
      stepId: 'report-step',
      callId: 'report-model',
      definitionId: 'fixed',
      definitionVersion: '1',
      input: {},
      decisionSource: source,
    });
    const reference = run.requirements[0]!;
    const headKey = `run/${f.parent.id}/head`;
    const inputDigest = await semanticDigest({});
    const dispatch = (requirements: Parameters<Store['markDispatching']>[0]['requirements']) =>
      f.store.markDispatching({
        ...write,
        executionId: 'original-report-model',
        authorization: {
          allowed: true,
          revision: 'current-independent-model-policy',
          definitionVersion: '1',
          inputDigest,
        },
        freshness: { checked: true, source },
        requirements,
      });
    const evaluation = {
      requirement: reference,
      recordRevision: reference.revision,
      outcome: 'satisfied' as const,
      evidence: { originalRunId: f.parent.id },
      recordReads: [{ key: headKey, revision: '1', originStoreId: f.base.expectedStoreId }],
    };
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await rejected(dispatch([]), 'requirement_not_satisfied');
    // Inject a last-transaction revision drift, without fabricating an obligation or approval.
    f.db.run('UPDATE extension_record SET revision=revision+1 WHERE key=?', [headKey]);
    await rejected(dispatch([evaluation]), 'requirement_not_satisfied');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect((await f.store.getExecution('original-report-model'))!.status).toBe('planned');
    f.db.run('UPDATE extension_record SET revision=revision-1 WHERE key=?', [headKey]);
    await dispatch([evaluation]);
    expect((await f.store.getExecution('original-report-model'))!.status).toBe('dispatching');
    expect((await f.store.getRun(run.id))!.requirements).toEqual(f.parent.requirements);
    expect((await f.apply()).run?.id).toBe(run.id);
  } finally {
    await f.close();
  }
}, 12000);

for (const mode of [
  'bad-marker',
  'cancelled',
  'rewound',
  'configuration',
  'authorization',
  'child-scope',
  'suppressed',
] as const) {
  test(`explicit report resume ${mode} never revives disallowed original effects`, async () => {
    const f = await fixture();
    try {
      if (mode === 'bad-marker') {
        f.db.run('UPDATE command SET receipt_json=? WHERE id=?', [
          JSON.stringify({ reason: 'report_preparation_failed' }),
          f.reportId,
        ]);
        await rejected(f.apply(), 'report_recovery_unavailable');
      } else if (mode === 'configuration') {
        await rejected(f.apply('resume', { newManifest: true }), 'report_configuration_mismatch');
      } else if (mode === 'child-scope') {
        f.db.run('UPDATE command SET session_id=? WHERE id=?', [
          f.execution.childSessionId!,
          f.reportId,
        ]);
        await rejected(f.apply(), 'group_root_required');
      } else if (mode === 'suppressed') {
        f.db.run("UPDATE command SET status='rejected',receipt_json=? WHERE id=?", [
          JSON.stringify({ outcome: 'suppressed', reason: 'cancelled' }),
          f.reportId,
        ]);
        await rejected(f.apply(), 'report_recovery_unavailable');
      } else {
        if (mode === 'cancelled')
          f.db.run('UPDATE execution SET cancel_requested=1 WHERE id=?', [f.execution.id]);
        if (mode === 'rewound')
          f.db.run("UPDATE session SET context_selection_id='foreign-selection' WHERE id='root'");
        const input: Parameters<Store['applyJobReport']>[0] & { recovery: JobReportRecovery } = {
          ...f.base,
          authorization:
            mode === 'authorization' ? { revision: 'changed-policy' } : f.base.authorization,
          recovery: {
            commandId: 'resume',
            subjectId: 'owner',
            expectedConfiguration: f.parent.configuration,
          },
        };
        const outcome = await f.store.applyJobReport(input);
        expect(outcome.run).toBeNull();
        expect(outcome.command.status).toBe('rejected');
        expect((await f.store.getCommand('resume'))?.receipt).toMatchObject({
          reportCommandId: f.reportId,
          runId: null,
          outcome: 'report_suppressed',
        });
      }
      expect((await f.store.getView('root')).runs).toHaveLength(1);
      expect(
        (
          await f.store
            .getSelectedContext({ expectedStoreId: f.base.expectedStoreId, sessionId: 'root' })
            .catch(() => ({ resultSources: [] }))
        ).resultSources,
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  }, 12000);
}

test('explicit report recovery accepts only an actual same-Store session.recover marker', async () => {
  const f = await fixture();
  try {
    // Inject the exact pending disk boundary after releasing the owner, then perform actual offline recovery.
    expect(await f.store.releaseSessionOwner(f.base.owner)).toBe(true);
    f.db.run("UPDATE command SET status='accepted',receipt_json=? WHERE id=?", [
      JSON.stringify({ executionId: f.execution.id, outcome: 'report_pending' }),
      f.reportId,
    ]);
    const session = (await f.store.getSession('root'))!;
    const recovered = await f.store.recoverSession({
      expectedStoreId: f.base.expectedStoreId,
      sessionId: 'root',
      subjectId: 'owner',
      commandId: 'recover-session',
      expectedOwnerGeneration: session.ownerGeneration,
      decision: 'interrupt',
    });
    expect(recovered.interruptedRunIds).toHaveLength(0);
    expect((await f.store.getCommand(f.reportId))!.receipt).toMatchObject({
      recoveryCommandId: 'recover-session',
    });
    f.base.owner = (await f.store.acquireSessionOwner('root', 'recovered-report-owner'))!;
    expect((await f.apply()).started).toBe(true);
    expect((await f.store.getView('root')).runs).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 12000);

test('a forged recovery command link is rejected without report consumption', async () => {
  const f = await fixture();
  try {
    f.db.run('UPDATE command SET receipt_json=? WHERE id=?', [
      JSON.stringify({ recoveryCommandId: 'create' }),
      f.reportId,
    ]);
    await rejected(f.apply(), 'report_recovery_unavailable');
    expect(await f.store.getCommand('resume')).toBeNull();
    expect((await f.store.getView('root')).runs).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 12000);
