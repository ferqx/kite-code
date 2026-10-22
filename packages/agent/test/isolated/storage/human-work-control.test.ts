import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { semanticDigest } from '../../../src/json';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage';
import type { DispatchInput } from '../../../src/storage/port';
import {
  assertHumanWorkDispatch,
  beginHumanInputProcessing,
  decideHumanInput,
  type HumanInputProposal,
  readHumanWorkState,
  readWorkEligibility,
  registerHumanCommand,
  registerHumanInput,
} from '../../../src/storage/sqlite/human-work-control';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';

async function fixture() {
  const dataRoot = temporaryDirectory('kite-human-work-');
  chmodSync(dataRoot, 0o700);
  const store = await openSqliteStore({ dataRoot, profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({ expectedStoreId, id: 'w', rootUri: 'file:///fixture', name: 'w' });
  await store.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    subjectId: 'user',
    workspaceId: 'w',
    title: 's',
  });
  const scope = { expectedStoreId, sessionId: 's', subjectId: 'user' };
  const contextSelectionId = (await store.getSession('s'))!.contextSelectionId;
  await store.acceptCommand({
    ...scope,
    commandId: 'A',
    request: { kind: 'run.start', content: 'A' },
  });
  const owner = (await store.acquireSessionOwner('s', 'host'))!;
  const run = await store.startRun({
    expectedStoreId,
    owner,
    commandId: 'A',
    configuration: { modelId: 'A-model' },
  });
  const database = new Database(join(dataRoot, 'test', 'core.db'));
  const db = new SqliteOperations(database, false);
  const register = (commandId: string, content: string, extra = {}) =>
    registerHumanInput(db, {
      ...scope,
      commandId,
      content,
      contextSelectionId,
      observedRunId: run.id,
      ...extra,
    });
  const decide = (
    inputId: string,
    proposal: Omit<HumanInputProposal, 'basis'>,
    decisionId = `decision-${inputId}`,
  ) => {
    const original = db.row('SELECT * FROM command WHERE id=?', inputId)!;
    return decideHumanInput(db, {
      ...scope,
      inputCommandId: inputId,
      inputDigest: String(original.request_digest),
      decisionId,
      expectedControlRevision: readHumanWorkState(db, scope).controlRevision,
      proposal: {
        ...proposal,
        basis: {
          kind: 'explicit_target',
          instruction: JSON.parse(String(original.request_json)).content,
        },
      },
    });
  };
  const eligibility = () =>
    readWorkEligibility(db, {
      sessionId: 's',
      rootWorkCommandId: 'A',
      rootWorkSeq: run.rootWorkSeq,
    });
  return {
    store,
    db,
    scope,
    run,
    owner,
    contextSelectionId,
    register,
    decide,
    eligibility,
    cleanup: async () => {
      db.releaseStatements();
      database.close();
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

test('raw registration wins notification priority and retry preserves exact original observation', async () => {
  const f = await fixture();
  try {
    const original = f.register('input', '请告诉我 A 的进度');
    expect(original.kind).toBe('human.input');
    expect(f.eligibility().reason).toBe('input_unresolved');
    expect(f.register('input', '请告诉我 A 的进度')).toEqual(original);
    expect(() => f.register('input', 'different')).toThrow('command_conflict');
    const result = f.decide('input', {
      relation: 'same_work',
      purpose: 'progress',
      targetRootWorkCommandId: 'A',
      selectionEffect: 'keep',
    });
    expect(result.businessCommand).toBeNull();
    expect(f.eligibility().state).toBe('eligible');
    expect(readHumanWorkState(f.db, f.scope).selectedWork?.rootWorkCommandId).toBe('A');
  } finally {
    await f.cleanup();
  }
});

test('foreign-origin history remains readable without becoming current human control', async () => {
  const f = await fixture();
  try {
    f.register('historical-input', '原工作尚待澄清');
    const originalWork = f.db.row('SELECT request_json FROM command WHERE id=?', 'A')!;
    const originalInput = f.db.row(
      'SELECT request_json FROM command WHERE id=?',
      'historical-input',
    )!;
    f.db.run(
      "UPDATE command SET origin_store_id='historical-store' WHERE id IN ('A','historical-input')",
    );
    const before = await f.store.getMetadata();
    const historical = readHumanWorkState(f.db, f.scope);
    expect(historical.selectedWork).toBeNull();
    expect(historical.pendingInputIds).toEqual([]);
    expect(historical.latestInputCommandId).toBeNull();
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before.lastChangeCursor);
    expect((await f.store.getCommand('A'))!.request).toEqual(
      JSON.parse(String(originalWork.request_json)),
    );
    expect((await f.store.getCommand('historical-input'))!.request).toEqual(
      JSON.parse(String(originalInput.request_json)),
    );
    const current = f.register('current-input', '新任务：当前Store的独立工作', {
      observedRunId: null,
    });
    expect(current.originStoreId).toBe(f.scope.expectedStoreId);
    expect(current.receipt).toMatchObject({
      originalSelection: null,
      candidateWorkCommandIds: [],
    });
    const state = readHumanWorkState(f.db, f.scope);
    expect(state.pendingInputIds).toEqual(['current-input']);
    expect(state.latestInputCommandId).toBe('current-input');
    expect(state.selectedWork).toBeNull();
  } finally {
    await f.cleanup();
  }
});

test('independent B is queued atomically, survives its cancellation as a selection boundary, and never steers A', async () => {
  const f = await fixture();
  try {
    f.register('B', '现在另做 B');
    const decision = f.decide('B', {
      relation: 'independent_work',
      purpose: 'work',
      targetRootWorkCommandId: null,
      selectionEffect: 'select_work',
    });
    expect(decision.businessCommand?.kind).toBe('input.follow_up');
    expect(decision.businessCommand?.rootWorkCommandId).toBe('B');
    expect(decision.businessCommand?.receipt).toMatchObject({
      runId: null,
      outcome: 'human_business_queued',
    });
    expect(f.eligibility().reason).toBe('work_not_selected');
    await f.store.cancelCommand({
      ...f.scope,
      commandId: 'cancel-B',
      targetCommandId: decision.businessCommand!.id,
    });
    expect(readHumanWorkState(f.db, f.scope).selectedWork?.rootWorkCommandId).toBe('B');
    expect(f.eligibility().reason).toBe('work_not_selected');
    f.register('progress-A', 'A 的进度如何');
    f.decide('progress-A', {
      relation: 'same_work',
      purpose: 'progress',
      targetRootWorkCommandId: 'A',
      selectionEffect: 'keep',
    });
    expect(readHumanWorkState(f.db, f.scope).selectedWork?.rootWorkCommandId).toBe('B');
  } finally {
    await f.cleanup();
  }
});

test('stale proposal cannot commit and decision response loss returns the exact same queued command', async () => {
  const f = await fixture();
  try {
    const input = f.register('more-A', '继续完善 A');
    const expectedControlRevision = readHumanWorkState(f.db, f.scope).controlRevision;
    f.register('other-input', '请澄清 A');
    const request = {
      ...f.scope,
      inputCommandId: input.id,
      inputDigest: input.requestDigest,
      decisionId: 'decision',
      expectedControlRevision,
      proposal: {
        relation: 'same_work',
        purpose: 'work',
        targetRootWorkCommandId: 'A',
        selectionEffect: 'keep',
        basis: { kind: 'explicit_target', instruction: '继续完善 A' },
      } as HumanInputProposal,
    };
    expect(() => decideHumanInput(f.db, request)).toThrow('human_control_changed');
    request.expectedControlRevision = readHumanWorkState(f.db, f.scope).controlRevision;
    const first = decideHumanInput(f.db, request);
    expect(first.businessCommand?.kind).toBe('input.steer');
    expect(first.businessCommand?.rootWorkCommandId).toBe('A');
    expect(decideHumanInput(f.db, request)).toEqual(first);
    expect(
      f.db.row("SELECT COUNT(*) AS n FROM command WHERE target_command_id='decision'")!.n,
    ).toBe(1n);
  } finally {
    await f.cleanup();
  }
});

test('unresolved input blocks only its recorded work and a new clarification resolves without rewriting original text', async () => {
  const f = await fixture();
  try {
    const raw = f.register('unclear', '先别做这个');
    const unresolved = f.decide('unclear', {
      relation: 'unresolved',
      purpose: 'clarify',
      targetRootWorkCommandId: null,
      selectionEffect: 'keep',
    });
    expect(unresolved.requiresReadOnlyProcessing).toBe(true);
    expect(unresolved.businessCommand).toBeNull();
    expect(f.eligibility().reason).toBe('input_unresolved');
    f.register('clarification', '我说暂停 A', { clarifiesInputId: 'unclear' });
    f.decide('clarification', {
      relation: 'same_work',
      purpose: 'pause',
      targetRootWorkCommandId: 'A',
      selectionEffect: 'keep',
    });
    expect(f.eligibility().reason).toBe('work_paused');
    const after = await f.store.getCommand('unclear');
    expect(after?.request).toEqual(raw.request);
    expect(after?.receipt).toMatchObject({
      state: 'clarified',
      clarifyingInputId: 'clarification',
    });
  } finally {
    await f.cleanup();
  }
});

test('pause and explicit continue bind original work without a future result; stop cannot be revived', async () => {
  const f = await fixture();
  try {
    f.register('pause', '暂停 A');
    f.decide('pause', {
      relation: 'same_work',
      purpose: 'pause',
      targetRootWorkCommandId: 'A',
      selectionEffect: 'keep',
    });
    expect(f.eligibility().reason).toBe('work_paused');
    f.register('resume', '继续 A');
    const resumed = f.decide('resume', {
      relation: 'same_work',
      purpose: 'continue',
      targetRootWorkCommandId: 'A',
      selectionEffect: 'select_work',
    });
    expect(resumed.businessCommand?.rootWorkCommandId).toBe('A');
    expect(f.eligibility().state).toBe('eligible');
    f.register('stop', '停止 A');
    f.decide('stop', {
      relation: 'same_work',
      purpose: 'stop',
      targetRootWorkCommandId: 'A',
      selectionEffect: 'keep',
    });
    f.register('bad-resume', '继续 A');
    const rejected = f.decide('bad-resume', {
      relation: 'same_work',
      purpose: 'continue',
      targetRootWorkCommandId: 'A',
      selectionEffect: 'select_work',
    });
    expect(rejected.businessCommand).toBeNull();
    expect(rejected.decision.status).toBe('rejected');
    expect(rejected.input.receipt).toMatchObject({
      state: 'decided',
      applicationState: 'rejected',
      businessCommandId: null,
    });
    expect(rejected.decision.receipt).toMatchObject({
      outcome: 'human_input_rejected',
      reason: 'work_resume_unavailable',
      revocationReason: 'work_stopped',
      selectionEffect: 'keep',
    });
    expect(f.eligibility().reason).toBe('work_stopped');
  } finally {
    await f.cleanup();
  }
});

test('decision and queued admission roll back together on actual SQLite insertion failure', async () => {
  const f = await fixture();
  try {
    f.register('B', '独立 B');
    const before = readHumanWorkState(f.db, f.scope);
    f.db.db.run(
      "CREATE TRIGGER fail_business BEFORE INSERT ON command WHEN NEW.kind='input.follow_up' BEGIN SELECT RAISE(ABORT,'injected business failure'); END",
    );
    expect(() =>
      f.decide('B', {
        relation: 'independent_work',
        purpose: 'work',
        targetRootWorkCommandId: null,
        selectionEffect: 'select_work',
      }),
    ).toThrow('injected business failure');
    expect(readHumanWorkState(f.db, f.scope)).toEqual(before);
    expect(f.db.row("SELECT id FROM command WHERE id='decision-B'")).toBeNull();
    expect((await f.store.getCommand('B'))?.receipt).toMatchObject({ state: 'pending' });
  } finally {
    await f.cleanup();
  }
});

test('wrong subject, Store and target scope never save partial input or decision', async () => {
  const f = await fixture();
  try {
    const request = {
      ...f.scope,
      commandId: 'raw',
      content: 'input',
      observedRunId: f.run.id,
      contextSelectionId: f.contextSelectionId,
    };
    expect(() => registerHumanInput(f.db, { ...request, subjectId: 'other' })).toThrow(
      'permission_denied',
    );
    expect(() => registerHumanInput(f.db, { ...request, expectedStoreId: 'other' })).toThrow(
      'store_identity_mismatch',
    );
    expect(() =>
      registerHumanInput(f.db, { ...request, candidateWorkCommandIds: ['missing'] }),
    ).toThrow('work_scope_unverifiable');
    expect(await f.store.getCommand('raw')).toBeNull();
  } finally {
    await f.cleanup();
  }
});

test('same-work idle continuation preserves A configuration while serializing after independent B', async () => {
  const f = await fixture();
  try {
    await f.store.finishRun({
      expectedStoreId: f.scope.expectedStoreId,
      owner: f.owner,
      runId: f.run.id,
      status: 'completed',
      requirements: [],
    });
    await f.store.acceptCommand({
      ...f.scope,
      commandId: 'B',
      request: { kind: 'run.start', content: 'B' },
    });
    const b = await f.store.startRun({
      expectedStoreId: f.scope.expectedStoreId,
      owner: f.owner,
      commandId: 'B',
      configuration: { modelId: 'B-model' },
    });
    await f.store.finishRun({
      expectedStoreId: f.scope.expectedStoreId,
      owner: f.owner,
      runId: b.id,
      status: 'completed',
      requirements: [],
    });
    const continuation = registerHumanCommand(f.db, {
      ...f.scope,
      commandId: 'resume-A',
      request: {
        kind: 'input.follow_up',
        content: '明确继续 A',
        afterRunId: b.id,
        contextSelectionId: f.contextSelectionId,
      },
    });
    const inputId = (continuation.receipt as { humanInputCommandId: string }).humanInputCommandId;
    const decision = f.decide(inputId, {
      relation: 'same_work',
      purpose: 'continue',
      targetRootWorkCommandId: 'A',
      selectionEffect: 'select_work',
    });
    expect(decision.configuration).toEqual({ modelId: 'A-model' });
    expect(decision.businessCommand?.request).toMatchObject({ afterRunId: b.id });
    const apply = (configuration: { modelId: string }) =>
      f.store.applyInput({
        expectedStoreId: f.scope.expectedStoreId,
        owner: f.owner,
        commandId: decision.businessCommand!.id,
        kind: 'follow_up',
        configuration,
      });
    f.db.releaseStatements();
    let rejected: unknown;
    try {
      await apply({ modelId: 'B-model' });
    } catch (error) {
      rejected = error;
    }
    expect((rejected as { code?: string })?.code).toBe('work_configuration_changed');
    const applied = await apply({ modelId: 'A-model' });
    expect(applied.run.rootWorkCommandId).toBe('A');
    expect(applied.run.configuration).toEqual({ modelId: 'A-model' });
    expect((await f.store.getCommand(continuation.id))!.receipt).toMatchObject({
      humanInputCommandId: inputId,
      businessCommandId: decision.businessCommand!.id,
      runId: applied.run.id,
    });
    expect((await apply({ modelId: 'B-model' })).run.id).toBe(applied.run.id);
  } finally {
    await f.cleanup();
  }
});

test('idle interpretation uses one ordinary Run with its own cause and sealed read-only dispatch boundary', async () => {
  const f = await fixture();
  try {
    await f.store.finishRun({
      expectedStoreId: f.scope.expectedStoreId,
      owner: f.owner,
      runId: f.run.id,
      status: 'completed',
      requirements: [],
    });
    const input = f.register('ambiguous', '先别做这个');
    const processingInput = {
      ...f.scope,
      inputCommandId: input.id,
      inputDigest: input.requestDigest,
      readOnlyTools: [{ id: 'status', version: '1' }],
    };
    const processing = beginHumanInputProcessing(f.db, processingInput);
    expect(readHumanWorkState(f.db, f.scope).selectedWork?.rootWorkCommandId).toBe('A');
    const run = await f.store.startRun({
      expectedStoreId: f.scope.expectedStoreId,
      owner: f.owner,
      commandId: processing.id,
      configuration: { modelId: 'fixed' },
    });
    expect(run.rootWorkCommandId).toBe(processing.id);
    expect(beginHumanInputProcessing(f.db, processingInput).id).toBe(processing.id);
    const execution = {
      session_id: 's',
      run_id: run.id,
      root_work_command_id: processing.id,
      root_work_seq: run.rootWorkSeq,
      kind: 'model',
      adapter_id: 'fixed',
      definition_version: '1',
    };
    expect(() => assertHumanWorkDispatch(f.db, execution)).not.toThrow();
    expect(() =>
      assertHumanWorkDispatch(f.db, { ...execution, kind: 'tool', adapter_id: 'status' }),
    ).not.toThrow();
    expect(() =>
      assertHumanWorkDispatch(f.db, { ...execution, kind: 'tool', adapter_id: 'write' }),
    ).toThrow('input_processing_read_only');
    expect(() =>
      assertHumanWorkDispatch(f.db, { ...execution, kind: 'job', adapter_id: 'status' }),
    ).toThrow('input_processing_read_only');
    await f.store.finishRun({
      expectedStoreId: f.scope.expectedStoreId,
      owner: f.owner,
      runId: run.id,
      status: 'completed',
      requirements: [],
    });
    expect(f.eligibility().reason).toBe('input_unresolved');
  } finally {
    await f.cleanup();
  }
});

test('public command bridge keeps exact invocation identity and atomically links the actual business Run', async () => {
  const f = await fixture();
  try {
    const request = {
      kind: 'input.follow_up' as const,
      content: '独立 B',
      afterRunId: f.run.id,
      contextSelectionId: f.contextSelectionId,
      modelId: 'B-model',
    };
    const original = registerHumanCommand(f.db, { ...f.scope, commandId: 'public-B', request });
    expect(original.kind).toBe('input.follow_up');
    expect(original.request).toEqual(request);
    expect(original.status).toBe('accepted');
    expect(original.receipt).toMatchObject({ outcome: 'human_input_pending', runId: null });
    expect(
      (await f.store.listAcceptedCommands('s', 100)).map((command) => command.id),
    ).not.toContain(original.id);
    expect((await f.store.listPendingInputs({ ...f.scope })).commands).toHaveLength(0);
    const inputId = (original.receipt as { humanInputCommandId: string }).humanInputCommandId;
    const decision = f.decide(inputId, {
      relation: 'independent_work',
      purpose: 'work',
      targetRootWorkCommandId: null,
      selectionEffect: 'select_work',
    });
    expect(decision.businessCommand!.rootWorkCommandId).toBe('public-B');
    expect(decision.businessCommand!.request).toMatchObject({ modelId: 'B-model' });
    await f.store.finishRun({
      expectedStoreId: f.scope.expectedStoreId,
      owner: f.owner,
      runId: f.run.id,
      status: 'completed',
      requirements: [],
    });
    const applied = await f.store.applyInput({
      expectedStoreId: f.scope.expectedStoreId,
      owner: f.owner,
      commandId: decision.businessCommand!.id,
      kind: 'follow_up',
      configuration: { modelId: 'B-model' },
    });
    const after = await f.store.getCommand(original.id);
    expect(after!.id).toBe(original.id);
    expect(after!.request).toEqual(original.request);
    expect(after!.requestDigest).toBe(original.requestDigest);
    expect(after!.receipt).toMatchObject({
      outcome: 'human_input_applied',
      runId: applied.run.id,
      businessCommandId: applied.command.id,
      sourceCommandId: applied.command.id,
    });
    expect(applied.run.originCommandId).toBe(applied.command.id);
    expect(applied.message.humanInput).toEqual({
      inputCommandId: inputId,
      publicCommandId: original.id,
    });
    expect(registerHumanCommand(f.db, { ...f.scope, commandId: 'public-B', request })).toEqual(
      after!,
    );
  } finally {
    await f.cleanup();
  }
});

for (const guarded of [false, true]) {
  test(`Continue seals actual ${guarded ? 'guarded group fence' : 'unknown original effect'} without removing its safety evidence`, async () => {
    const f = await fixture();
    try {
      const id = 'uncertain-effect';
      let source: Json;
      if (guarded) {
        await f.store.finishRun({
          expectedStoreId: f.scope.expectedStoreId,
          owner: f.owner,
          runId: f.run.id,
          status: 'completed',
          requirements: [],
        });
        await f.store.acceptCommand({
          ...f.scope,
          commandId: 'guard-action',
          request: {
            kind: 'extension.invoke',
            extensionId: 'fixture',
            actionId: 'effect',
            definitionVersion: '1',
            input: {},
          },
        });
        const safety = await f.store.readExecutionGroupSafety({
          ...f.scope,
          boundaryCommandId: 'guard-action',
        });
        source = {
          kind: 'action_decision',
          commandId: 'guard-action',
          extensionId: 'fixture',
          actionId: 'effect',
          definitionVersion: '1',
          preparedDigest: await semanticDigest({}),
          recordReads: [],
          recordListReads: [],
          contextRevision: safety.contextRevision,
          guard: {
            kind: 'execution_group_quiescence',
            version: 1,
            rootSessionId: 's',
            originCommandId: 'guard-action',
          },
        };
        await f.store.planAction({
          expectedStoreId: f.scope.expectedStoreId,
          owner: f.owner,
          commandId: 'guard-action',
          executionId: id,
          extensionId: 'fixture',
          definitionId: 'fixture/effect',
          definitionVersion: '1',
          input: {},
          decisionSource: source,
        });
      } else {
        source = { kind: 'model_decision', modelExecutionId: 'original-model' };
        await f.store.planExecution({
          expectedStoreId: f.scope.expectedStoreId,
          owner: f.owner,
          executionId: id,
          sessionId: 's',
          runId: f.run.id,
          originCommandId: 'A',
          stepId: 'step',
          callId: 'call',
          kind: 'tool',
          definitionId: 'fixture/effect',
          definitionVersion: '1',
          input: {},
          decisionSource: source,
        });
      }
      const dispatch: DispatchInput = {
        expectedStoreId: f.scope.expectedStoreId,
        owner: f.owner,
        executionId: id,
        authorization: {
          allowed: true,
          revision: 'trusted',
          definitionVersion: '1',
          inputDigest: await semanticDigest({}),
        },
        requirements: [],
        freshness: { checked: true, source },
        readSet: { records: [], recordLists: [] },
      };
      if (guarded) {
        const safety = await f.store.readExecutionGroupSafety({
          ...f.scope,
          boundaryCommandId: 'guard-action',
          excludeExecutionId: id,
        });
        dispatch.readSet!.executionGroup = {
          rootSessionId: 's',
          executionId: id,
          revision: safety.revision,
          contextRevision: safety.contextRevision,
          quiescent: true,
        };
      }
      await f.store.markDispatching(dispatch);
      await f.store.finishExecution({
        expectedStoreId: f.scope.expectedStoreId,
        owner: f.owner,
        executionId: id,
        status: 'outcome_unknown',
        result: { outcome: 'unknown', content: 'actual adapter stop unconfirmed' },
      });
      const before = await f.store.getExecution(id);
      f.register('resume-unknown', '继续 A');
      const revision = readHumanWorkState(f.db, f.scope).controlRevision;
      const result = f.decide('resume-unknown', {
        relation: 'same_work',
        purpose: 'continue',
        targetRootWorkCommandId: 'A',
        selectionEffect: 'select_work',
      });
      expect(result.decision.status).toBe('rejected');
      expect(result.decision.receipt).toMatchObject({
        reason: guarded ? 'execution_group_fenced' : 'work_resume_outcome_unknown',
        selectionEffect: 'keep',
        businessCommandId: null,
      });
      expect(result.input.receipt).toMatchObject({
        state: 'decided',
        applicationState: 'rejected',
      });
      expect(result.businessCommand).toBeNull();
      expect(readHumanWorkState(f.db, f.scope).controlRevision).toBe(revision);
      expect(readHumanWorkState(f.db, f.scope).pendingInputIds).not.toContain('resume-unknown');
      expect(await f.store.getExecution(id)).toEqual(before);
    } finally {
      await f.cleanup();
    }
  });
}

test('rejected Continue cannot hide the applied replacement or select its old work', async () => {
  const f = await fixture();
  try {
    f.register('replace-A', '替换 A 为新的工作');
    f.decide('replace-A', {
      relation: 'independent_work',
      purpose: 'replace',
      targetRootWorkCommandId: 'A',
      selectionEffect: 'select_work',
    });
    const before = readHumanWorkState(f.db, f.scope);
    expect(f.eligibility().reason).toBe('work_replaced');
    f.register('old-A-again', '继续 A');
    const revision = readHumanWorkState(f.db, f.scope).controlRevision;
    const result = f.decide('old-A-again', {
      relation: 'same_work',
      purpose: 'continue',
      targetRootWorkCommandId: 'A',
      selectionEffect: 'select_work',
    });
    expect(result.decision.status).toBe('rejected');
    expect(result.decision.receipt).toMatchObject({
      reason: 'work_resume_unavailable',
      revocationReason: 'work_replaced',
      selectionEffect: 'keep',
    });
    expect(result.businessCommand).toBeNull();
    expect(f.eligibility().reason).toBe('work_replaced');
    expect(readHumanWorkState(f.db, f.scope).selectedWork).toEqual(before.selectedWork);
    expect(readHumanWorkState(f.db, f.scope).controlRevision).toBe(revision);
  } finally {
    await f.cleanup();
  }
});

test.each([
  'steer',
  'follow_up',
] as const)('withdrawing decided human %s atomically settles its public invocation without cancelling active work', async (kind) => {
  const f = await fixture();
  const runtime = createRuntime({
    store: f.store,
    permissions: {
      async authorize() {
        throw new Error('No Tool authorization permitted');
      },
    },
  });
  try {
    const request =
      kind === 'steer'
        ? {
            kind: 'input.steer' as const,
            content: 'More A',
            targetRunId: f.run.id,
            contextSelectionId: f.contextSelectionId,
          }
        : {
            kind: 'input.follow_up' as const,
            content: 'Independent B',
            afterRunId: f.run.id,
            contextSelectionId: f.contextSelectionId,
          };
    const original = registerHumanCommand(f.db, {
      ...f.scope,
      commandId: 'public-queued',
      request,
    });
    const inputId = (original.receipt as { humanInputCommandId: string }).humanInputCommandId;
    const decision = f.decide(
      inputId,
      kind === 'steer'
        ? {
            relation: 'same_work',
            purpose: 'work',
            targetRootWorkCommandId: 'A',
            selectionEffect: 'keep',
          }
        : {
            relation: 'independent_work',
            purpose: 'work',
            targetRootWorkCommandId: null,
            selectionEffect: 'select_work',
          },
    );
    const business = decision.businessCommand!;
    const humanState = await f.store.readHumanWorkState(f.scope);
    const activeRun = await f.store.getRun(f.run.id);
    const queue = await f.store.getPendingInputQueue(f.scope);
    expect(queue.commands.map((command) => command.id)).toEqual([business.id]);
    const operation = {
      ...f.scope,
      kind: 'input.withdraw' as const,
      commandId: 'withdraw-business',
      targetCommandId: business.id,
      expectedRevision: queue.revision,
    };
    const queuedPublic = await f.store.getCommand(original.id);
    const queuedHuman = await f.store.getCommand(inputId);
    f.db.run(
      "CREATE TRIGGER fail_queue_public_settlement BEFORE UPDATE OF status ON command WHEN NEW.id='public-queued' AND NEW.status='rejected' BEGIN SELECT RAISE(ABORT,'queue_settlement_fault'); END",
    );
    let failure: unknown;
    try {
      await f.store.withdrawPendingInput(operation);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(await f.store.getCommand(original.id)).toEqual(queuedPublic);
    expect(await f.store.getCommand(inputId)).toEqual(queuedHuman);
    expect(await f.store.getCommand(business.id)).toEqual(business);
    expect(await f.store.getCommand(operation.commandId)).toBeNull();
    expect(await f.store.getPendingInputQueue(f.scope)).toEqual(queue);
    f.db.run('DROP TRIGGER fail_queue_public_settlement');
    const withdrawn = await f.store.withdrawPendingInput(operation);
    expect(withdrawn).toMatchObject({
      status: 'applied',
      receipt: { outcome: 'input_withdrawn', targetCommandId: business.id },
    });
    expect(await f.store.getCommand(business.id)).toMatchObject({
      status: 'rejected',
      receipt: { outcome: 'withdrawn_before_apply' },
    });
    expect(await runtime.waitForCommand(original.id, { timeoutMs: 100 })).toMatchObject({
      status: 'rejected',
      receipt: {
        outcome: 'human_input_rejected',
        reason: 'withdrawn_before_apply',
        businessCommandId: business.id,
        runId: null,
      },
    });
    expect(await f.store.getCommand(inputId)).toMatchObject({
      receipt: {
        applicationState: 'rejected',
        rejection: { reason: 'withdrawn_before_apply', businessCommandId: business.id },
      },
    });
    expect(await f.store.getCommand(decision.decision.id)).toEqual(decision.decision);
    expect(await f.store.readHumanWorkState(f.scope)).toEqual(humanState);
    expect(await f.store.getRun(f.run.id)).toEqual(activeRun);
    expect((await f.store.getPendingInputQueue(f.scope)).commands).toEqual([]);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    expect(await f.store.withdrawPendingInput(operation)).toEqual(withdrawn);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(await f.store.getCommand(original.id)).toMatchObject({
      request: original.request,
      requestDigest: original.requestDigest,
    });
  } finally {
    await runtime.close();
    await f.cleanup();
  }
});

async function displayInput(f: Awaited<ReturnType<typeof fixture>>, publicId: string) {
  const original = registerHumanCommand(f.db, {
    ...f.scope,
    commandId: publicId,
    request: { kind: 'run.start', content: 'same original input' },
  });
  const inputId = (original.receipt as { humanInputCommandId: string }).humanInputCommandId;
  const raw = (await f.store.getCommand(inputId))!;
  const processing = beginHumanInputProcessing(f.db, {
    ...f.scope,
    inputCommandId: inputId,
    inputDigest: raw.requestDigest,
    readOnlyTools: [],
  });
  const run = await f.store.startRun({
    expectedStoreId: f.scope.expectedStoreId,
    owner: f.owner,
    commandId: processing.id,
    configuration: { modelId: 'fixture' },
  });
  const before = (await f.store.listMessages('s')).find((message) => message.runId === run.id)!;
  expect(before.humanInput).toEqual({ inputCommandId: inputId, publicCommandId: publicId });
  const originalSource = f.db.row(
    'SELECT source_json FROM message WHERE id=?',
    before.id,
  )!.source_json;
  return { inputId, run, before, processing, originalSource };
}

async function finishDisplayRun(f: Awaited<ReturnType<typeof fixture>>, runId: string) {
  await f.store.finishRun({
    expectedStoreId: f.scope.expectedStoreId,
    owner: f.owner,
    runId,
    status: 'completed',
    requirements: [],
  });
}

test('SQL presentation proves one original input across processing and business without removing history or merging equal new inputs', async () => {
  const f = await fixture();
  try {
    await finishDisplayRun(f, f.run.id);
    const identities: string[] = [];
    for (const publicId of ['public-first', 'public-second']) {
      const input = await displayInput(f, publicId);
      identities.push(input.inputId);
      const decision = f.decide(input.inputId, {
        relation: 'independent_work',
        purpose: 'work',
        targetRootWorkCommandId: null,
        selectionEffect: 'select_work',
      });
      expect(
        (await f.store.listMessages('s')).find((message) => message.id === input.before.id)
          ?.humanInput,
      ).toEqual({ inputCommandId: input.inputId, publicCommandId: publicId });
      await finishDisplayRun(f, input.run.id);
      const applied = await f.store.applyInput({
        expectedStoreId: f.scope.expectedStoreId,
        owner: f.owner,
        commandId: decision.businessCommand!.id,
        kind: 'follow_up',
        configuration: { modelId: 'fixture' },
      });
      const all = await f.store.listMessages('s');
      const processing = all.find((message) => message.id === input.before.id)!;
      const business = all.find((message) => message.id === applied.message.id)!;
      expect(processing.humanInput).toEqual({
        inputCommandId: input.inputId,
        publicCommandId: publicId,
        duplicateOfMessageId: business.id,
      });
      expect(business.humanInput).toEqual({
        inputCommandId: input.inputId,
        publicCommandId: publicId,
      });
      expect(processing.content).toBe(business.content);
      expect(processing.id).not.toBe(business.id);
      expect(
        f.db.row('SELECT source_json FROM message WHERE id=?', processing.id)?.source_json,
      ).toBe(input.originalSource);
      const page = await f.store.listMessages('s', { afterSeq: input.before.seq, limit: 1 });
      expect(page).toHaveLength(1);
      expect(page[0]!.id).toBe(business.id);
      expect((await f.store.listMessages('s', { upperSeq: input.before.seq })).at(-1)?.id).toBe(
        input.before.id,
      );
      await finishDisplayRun(f, applied.run.id);
    }
    expect(new Set(identities).size).toBe(2);
    const rows = (await f.store.listMessages('s')).filter(
      (message) => message.content === 'same original input',
    );
    expect(rows).toHaveLength(4);
    expect(rows.filter((message) => !message.humanInput?.duplicateOfMessageId)).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
});

test('unresolved processing keeps its original user message and ignores source-authored presentation authority', async () => {
  const f = await fixture();
  try {
    await finishDisplayRun(f, f.run.id);
    const input = await displayInput(f, 'public-unresolved');
    f.decide(input.inputId, {
      relation: 'unresolved',
      purpose: 'clarify',
      targetRootWorkCommandId: null,
      selectionEffect: 'keep',
    });
    const original = f.db.row('SELECT * FROM message WHERE id=?', input.before.id)!;
    const source = JSON.parse(String(original.source_json));
    f.db.run(
      'UPDATE message SET source_json=? WHERE id=?',
      JSON.stringify({
        ...source,
        humanInput: { inputCommandId: 'forged', duplicateOfMessageId: 'discard-me' },
      }),
      input.before.id,
    );
    const projected = (await f.store.listMessages('s')).find(
      (message) => message.id === input.before.id,
    )!;
    expect(projected.humanInput).toEqual({
      inputCommandId: input.inputId,
      publicCommandId: 'public-unresolved',
    });
    expect(projected.content).toBe('same original input');
    f.db.run('UPDATE command SET subject_id=? WHERE id=?', 'foreign', input.processing.id);
    expect(
      (await f.store.listMessages('s')).find((message) => message.id === input.before.id)
        ?.humanInput,
    ).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

for (const broken of [
  'digest',
  'business_receipt',
  'raw_receipt',
  'decision',
  'message',
  'store',
  'public',
] as const)
  test(`broken ${broken} chain cannot hide an original processing message`, async () => {
    const f = await fixture();
    try {
      await finishDisplayRun(f, f.run.id);
      const input = await displayInput(f, 'public-input');
      const decision = f.decide(input.inputId, {
        relation: 'independent_work',
        purpose: 'work',
        targetRootWorkCommandId: null,
        selectionEffect: 'select_work',
      });
      await finishDisplayRun(f, input.run.id);
      const applied = await f.store.applyInput({
        expectedStoreId: f.scope.expectedStoreId,
        owner: f.owner,
        commandId: decision.businessCommand!.id,
        kind: 'follow_up',
        configuration: { modelId: 'fixture' },
      });
      const baseline = (await f.store.listMessages('s')).find(
        (message) => message.id === input.before.id,
      )!;
      expect(baseline.humanInput?.duplicateOfMessageId).toBe(applied.message.id);
      if (broken === 'digest')
        f.db.run('UPDATE command SET request_digest=? WHERE id=?', 'forged', input.inputId);
      if (broken === 'business_receipt')
        f.db.run(
          "UPDATE command SET receipt_json=json_set(receipt_json,'$.messageId','foreign') WHERE id=?",
          applied.command.id,
        );
      if (broken === 'raw_receipt')
        f.db.run(
          "UPDATE command SET receipt_json=json_set(receipt_json,'$.applicationState','queued') WHERE id=?",
          input.inputId,
        );
      if (broken === 'decision')
        f.db.run('UPDATE command SET subject_id=? WHERE id=?', 'foreign', decision.decision.id);
      if (broken === 'message') f.db.run('DELETE FROM message WHERE id=?', applied.message.id);
      if (broken === 'store')
        f.db.run('UPDATE command SET origin_store_id=? WHERE id=?', 'foreign', applied.command.id);
      if (broken === 'public')
        f.db.run(
          "UPDATE command SET receipt_json=json_set(receipt_json,'$.runId','foreign') WHERE id=?",
          'public-input',
        );
      const projected = (await f.store.listMessages('s')).find(
        (message) => message.id === input.before.id,
      )!;
      expect(projected.humanInput?.duplicateOfMessageId).toBeUndefined();
      expect(projected.content).toBe(input.before.content);
    } finally {
      await f.cleanup();
    }
  });

async function forkDisplay(
  f: Awaited<ReturnType<typeof fixture>>,
  newSessionId: string,
  sourceSessionId = 's',
) {
  return f.store.forkSession({
    expectedStoreId: f.scope.expectedStoreId,
    subjectId: f.scope.subjectId,
    commandId: `create-${newSessionId}`,
    sourceSessionId,
    newSessionId,
    title: newSessionId,
    expectedContextSelectionId: (await f.store.getSession(sourceSessionId))!.contextSelectionId,
  });
}

test('sealed Fork and second Fork map processing duplicates to their own copied business messages without changing bytes', async () => {
  const f = await fixture();
  try {
    await finishDisplayRun(f, f.run.id);
    const input = await displayInput(f, 'public-fork-input');
    const decision = f.decide(input.inputId, {
      relation: 'independent_work',
      purpose: 'work',
      targetRootWorkCommandId: null,
      selectionEffect: 'select_work',
    });
    await finishDisplayRun(f, input.run.id);
    const applied = await f.store.applyInput({
      expectedStoreId: f.scope.expectedStoreId,
      owner: f.owner,
      commandId: decision.businessCommand!.id,
      kind: 'follow_up',
      configuration: { modelId: 'fixture' },
    });
    await finishDisplayRun(f, applied.run.id);
    const secondInput = await displayInput(f, 'public-fork-second-input');
    const secondDecision = f.decide(secondInput.inputId, {
      relation: 'independent_work',
      purpose: 'work',
      targetRootWorkCommandId: null,
      selectionEffect: 'select_work',
    });
    await finishDisplayRun(f, secondInput.run.id);
    const secondApplied = await f.store.applyInput({
      expectedStoreId: f.scope.expectedStoreId,
      owner: f.owner,
      commandId: secondDecision.businessCommand!.id,
      kind: 'follow_up',
      configuration: { modelId: 'fixture' },
    });
    await finishDisplayRun(f, secondApplied.run.id);
    const originalRows = f.db.rows('SELECT * FROM message WHERE session_id=? ORDER BY seq', 's');
    const originalParts = f.db.rows('SELECT * FROM message_part ORDER BY message_id,ordinal');
    await forkDisplay(f, 'first-fork');
    await forkDisplay(f, 'second-fork', 'first-fork');
    const beforeRows = f.db.rows('SELECT * FROM message ORDER BY session_id,seq');
    const beforeParts = f.db.rows('SELECT * FROM message_part ORDER BY message_id,ordinal');
    for (const sessionId of ['first-fork', 'second-fork']) {
      const messages = await f.store.listMessages(sessionId);
      const sameText = messages.filter((message) => message.content === 'same original input');
      expect(sameText).toHaveLength(4);
      expect(sameText.filter((message) => !message.humanInput?.duplicateOfMessageId)).toHaveLength(
        2,
      );
      expect(new Set(sameText.map((message) => message.humanInput?.inputCommandId)).size).toBe(2);
      const sameInput = messages.filter(
        (message) => message.humanInput?.inputCommandId === input.inputId,
      );
      expect(sameInput).toHaveLength(2);
      const processing = sameInput.find((message) => message.humanInput?.duplicateOfMessageId)!;
      const business = sameInput.find((message) => !message.humanInput?.duplicateOfMessageId)!;
      expect(processing.runId).toBeNull();
      expect(business.runId).toBeNull();
      expect(processing.humanInput).toEqual({
        inputCommandId: input.inputId,
        publicCommandId: 'public-fork-input',
        duplicateOfMessageId: business.id,
      });
      expect(processing.humanInput!.duplicateOfMessageId).not.toBe(applied.message.id);
      expect(
        (await f.store.getView(sessionId)).messages.find((message) => message.id === processing.id)
          ?.humanInput,
      ).toEqual(processing.humanInput);
      const page = await f.store.listMessages(sessionId, { upperSeq: processing.seq });
      expect(page.at(-1)?.id).toBe(processing.id);
    }
    expect(f.db.rows('SELECT * FROM message ORDER BY session_id,seq')).toEqual(beforeRows);
    expect(f.db.rows('SELECT * FROM message_part ORDER BY message_id,ordinal')).toEqual(
      beforeParts,
    );
    expect(f.db.rows('SELECT * FROM message WHERE session_id=? ORDER BY seq', 's')).toEqual(
      originalRows,
    );
    expect(
      f.db.rows(
        "SELECT p.* FROM message_part p JOIN message m ON m.id=p.message_id WHERE m.session_id='s' ORDER BY p.message_id,p.ordinal",
      ),
    ).toEqual(originalParts);
    const forkRows = await f.store.listMessages('first-fork');
    const processing = forkRows.find((message) => message.humanInput?.duplicateOfMessageId)!;
    const businessId = processing.humanInput!.duplicateOfMessageId!;
    f.db.run('UPDATE message_part SET revision=revision+1 WHERE message_id=?', businessId);
    expect(
      (await f.store.listMessages('first-fork')).find((message) => message.id === processing.id)
        ?.humanInput,
    ).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

test('Fork containing only a processing snapshot keeps its input when the source business is applied later', async () => {
  const f = await fixture();
  try {
    await finishDisplayRun(f, f.run.id);
    const input = await displayInput(f, 'public-later-input');
    await finishDisplayRun(f, input.run.id);
    await forkDisplay(f, 'early-fork');
    const before = await f.store.listMessages('early-fork');
    const original = before.find(
      (message) => message.humanInput?.inputCommandId === input.inputId,
    )!;
    expect(original.humanInput).toEqual({
      inputCommandId: input.inputId,
      publicCommandId: 'public-later-input',
    });
    const decision = f.decide(input.inputId, {
      relation: 'independent_work',
      purpose: 'work',
      targetRootWorkCommandId: null,
      selectionEffect: 'select_work',
    });
    const applied = await f.store.applyInput({
      expectedStoreId: f.scope.expectedStoreId,
      owner: f.owner,
      commandId: decision.businessCommand!.id,
      kind: 'follow_up',
      configuration: { modelId: 'fixture' },
    });
    expect(
      (await f.store.listMessages('s')).find((message) => message.id === input.before.id)
        ?.humanInput?.duplicateOfMessageId,
    ).toBe(applied.message.id);
    expect(await f.store.listMessages('early-fork')).toEqual(before);
    expect(
      f.db.row('SELECT source_json FROM message WHERE id=?', input.before.id)?.source_json,
    ).toBe(input.originalSource);
    const originalPart = f.db.rows(
      'SELECT ordinal,kind,content_version,revision,json FROM message_part WHERE message_id=?',
      input.before.id,
    );
    expect(
      f.db.rows(
        'SELECT ordinal,kind,content_version,revision,json FROM message_part WHERE message_id=?',
        original.id,
      ),
    ).toEqual(originalPart);
  } finally {
    await f.cleanup();
  }
});
