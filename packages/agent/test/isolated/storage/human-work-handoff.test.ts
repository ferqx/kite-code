import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json, RequirementRef } from '../../../src/storage/types';

async function failure(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return null;
  } catch (error) {
    return error;
  }
}

async function fixture() {
  const dataRoot = temporaryDirectory('kite-human-handoff-');
  const store = await openSqliteStore({ dataRoot, profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const scope = { expectedStoreId, sessionId: 's', subjectId: 'user' };
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: 'file:///fixture',
    name: 'fixture',
  });
  await store.createSession({ ...scope, commandId: 'create', workspaceId: 'w', title: 's' });
  await store.acceptCommand({
    ...scope,
    commandId: 'A',
    request: { kind: 'run.start', content: 'Original A' },
  });
  const owner = (await store.acquireSessionOwner('s', 'fixture'))!;
  const owned = { expectedStoreId, owner };
  const run = await store.startRun({
    ...owned,
    commandId: 'A',
    configuration: {
      modelId: 'fixture',
      tools: [{ id: 'fixture.effect', version: '1', extensionId: 'fixture' }],
    },
  });
  const selection = (await store.getSession('s'))!.contextSelectionId;
  const database = new Database(join(dataRoot, 'test', 'core.db'));
  const plan = (
    id: string,
    kind: 'model' | 'tool' = 'tool',
    source: Json = { kind: 'model_decision', modelExecutionId: 'model' },
  ) =>
    store.planExecution({
      ...owned,
      executionId: id,
      sessionId: 's',
      runId: run.id,
      originCommandId: 'A',
      stepId: 'step',
      callId: id,
      kind,
      definitionId: kind === 'model' ? 'fixture-model' : 'fixture.effect',
      definitionVersion: '1',
      input: {},
      decisionSource: source,
    });
  const dispatch = (
    id: string,
    source: Json = { kind: 'model_decision', modelExecutionId: 'model' },
  ) =>
    store.markDispatching({
      ...owned,
      executionId: id,
      authorization: {
        allowed: true,
        revision: 'policy',
        definitionVersion: '1',
        inputDigest: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
      },
      requirements: [],
      freshness: { checked: true, source },
    });
  const register = (id = 'B', content = 'Do independent B') =>
    store.registerHumanInput({
      ...scope,
      commandId: id,
      content,
      contextSelectionId: selection,
      observedRunId: run.id,
    });
  const input = async (inputCommandId = 'B') => ({
    ...owned,
    runId: run.id,
    inputCommandId,
    expectedControlRevision: (await store.readHumanWorkState(scope)).controlRevision,
    requirements: [],
  });
  return {
    store,
    database,
    scope,
    owned,
    owner,
    run,
    selection,
    plan,
    dispatch,
    register,
    input,
    async close() {
      for (const execution of await store.listExecutions('s'))
        if (['planned', 'dispatching', 'running'].includes(execution.status))
          await store.finishExecution({
            ...owned,
            executionId: execution.id,
            status: 'cancelled',
            result: { content: 'isolated fixture cleanup' },
          });
      if ((await store.getRun(run.id))?.isActive)
        await store.finishRun({ ...owned, runId: run.id, status: 'cancelled', requirements: [] });
      database.close();
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

test('real raw independent input safely closes only A technical Run, retires planned Tool with its paired result and keeps the raw decision queued', async () => {
  const f = await fixture();
  try {
    const modelSource = { kind: 'model_request', requestId: 'model' };
    await f.plan('model', 'model', modelSource);
    await f.dispatch('model', modelSource);
    await f.store.finishExecution({
      ...f.owned,
      executionId: 'model',
      status: 'succeeded',
      result: { content: '' },
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'effect', name: 'fixture.effect', arguments: '{}' }],
        sourceIds: ['model'],
      },
    });
    await f.plan('effect');
    const card = await f.store.requestInteraction({
      ...f.owned,
      interactionId: 'approval-effect',
      executionId: 'effect',
      attempt: 1,
      kind: 'approval',
      definitionId: 'fixture.effect',
      definitionVersion: '1',
      inputDigest: await semanticDigest({}),
      policyRevision: 'policy',
      requiredRefs: [],
      source: { kind: 'model_decision', modelExecutionId: 'model' },
      request: { grants: ['approve_once'] },
    });
    const raw = await f.register();
    const decision = await f.store.decideHumanInput({
      ...f.scope,
      inputCommandId: raw.id,
      inputDigest: raw.requestDigest,
      decisionId: 'decision-B',
      expectedControlRevision: (await f.store.readHumanWorkState(f.scope)).controlRevision,
      proposal: {
        relation: 'independent_work',
        purpose: 'work',
        targetRootWorkCommandId: null,
        selectionEffect: 'select_work',
        basis: { kind: 'explicit_text', instruction: 'Do independent B' },
      },
    });
    const handoff = await f.store.handoffHumanRun(await f.input());
    expect(handoff).toMatchObject({
      handedOff: true,
      reason: 'human_work_deferred',
      run: { isActive: false, status: 'completed', reason: 'human_work_deferred' },
    });
    expect(await f.store.getExecution('effect')).toMatchObject({
      status: 'cancelled',
      result: {
        content: 'human_work_deferred',
        details: { adapterAttempted: false, inputCommandId: 'B' },
      },
    });
    expect(
      await f.store.getInteraction({
        expectedStoreId: f.scope.expectedStoreId,
        sessionId: 's',
        interactionId: card.id,
      }),
    ).toMatchObject({ state: 'cancelled', answer: null });
    expect((await f.store.getCommand(decision.businessCommand!.id))?.status).toBe('accepted');
    expect(
      f.database.query("SELECT COUNT(*) AS count FROM run WHERE session_id='s'").get(),
    ).toMatchObject({ count: 1 });
    const view = await f.store.getView('s');
    expect(
      view.messages.filter((message) => message.role === 'tool' && message.toolCallId === 'effect'),
    ).toHaveLength(1);
    expect((await f.store.getCommand('B'))?.request).toEqual(raw.request);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    expect(await f.store.handoffHumanRun(await f.input())).toEqual(handoff);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await f.close();
  }
});

test('only a real raw input and current control revision can hand off; stale attempts and a forged finish exception leave A untouched', async () => {
  const f = await fixture();
  try {
    await f.plan('planned-model', 'model');
    expect(await failure(f.store.handoffHumanRun(await f.input('A')))).toMatchObject({
      code: 'input_handoff_scope_unverifiable',
    });
    await f.register();
    const current = await f.input();
    expect(
      await f.store.handoffHumanRun({ ...current, expectedControlRevision: '0' }),
    ).toMatchObject({ handedOff: false, reason: 'human_control_changed', run: { isActive: true } });
    expect((await f.store.getCommand('B'))?.receipt).toMatchObject({
      handoff: { state: 'queued', reason: 'human_control_changed' },
    });
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await f.store.handoffHumanRun({ ...current, expectedControlRevision: '0' });
    expect(
      await failure(
        f.store.finishRun({
          ...f.owned,
          runId: f.run.id,
          status: 'completed',
          requirements: [],
          inputHandoffCommandId: 'B',
        }),
      ),
    ).toMatchObject({ code: 'input_handoff_unverifiable' });
    expect((await f.store.getExecution('planned-model'))?.status).toBe('planned');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect((await f.store.handoffHumanRun(current)).handedOff).toBe(true);
    expect((await f.store.getExecution('planned-model'))?.status).toBe('cancelled');
  } finally {
    await f.close();
  }
});

test('already dispatched or unknown actions keep A active and raw B durable without a second Run', async () => {
  for (const outcome of ['dispatching', 'outcome_unknown'] as const) {
    const f = await fixture();
    try {
      await f.plan('effect');
      await f.dispatch('effect');
      if (outcome === 'outcome_unknown')
        await f.store.finishExecution({
          ...f.owned,
          executionId: 'effect',
          status: 'outcome_unknown',
          result: { outcome: 'outcome_unknown', content: 'real unknown boundary' },
        });
      await f.register();
      expect(await f.store.handoffHumanRun(await f.input())).toMatchObject({
        handedOff: false,
        reason: outcome === 'outcome_unknown' ? 'outcome_unknown' : 'execution_unsettled',
        run: { isActive: true },
      });
      const before = (await f.store.getMetadata()).lastChangeCursor;
      await f.store.handoffHumanRun(await f.input());
      expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
      expect((await f.store.getCommand('B'))?.receipt).toMatchObject({
        state: 'pending',
        handoff: {
          state: 'queued',
          reason: outcome === 'outcome_unknown' ? 'outcome_unknown' : 'execution_unsettled',
        },
      });
      expect(
        f.database.query("SELECT COUNT(*) AS count FROM run WHERE session_id='s'").get(),
      ).toMatchObject({ count: 1 });
    } finally {
      await f.close();
    }
  }
});

test('necessary completion conditions and required result waits remain hard gates before any retirement', async () => {
  for (const blocker of ['requirement', 'required_result'] as const) {
    const f = await fixture();
    try {
      await f.plan('effect');
      await f.register();
      // Isolated Store guard fixture: declare exact unfulfilled completion facts, never an execution proof.
      if (blocker === 'requirement') {
        const requirement: RequirementRef = {
          extensionId: 'fixture',
          definitionVersion: '1',
          requirementId: 'required',
          revision: '1',
          phase: 'completion',
          sessionId: 's',
          runId: f.run.id,
          recordKey: 'missing',
          originStoreId: f.scope.expectedStoreId,
        };
        f.database
          .query('UPDATE run SET requirements_json=? WHERE id=?')
          .run(JSON.stringify([requirement]), f.run.id);
      } else
        f.database
          .query('UPDATE run SET waiting_results_json=? WHERE id=?')
          .run(JSON.stringify(['required-child']), f.run.id);
      expect(await f.store.handoffHumanRun(await f.input())).toMatchObject({
        handedOff: false,
        reason:
          blocker === 'requirement' ? 'requirement_not_satisfied' : 'required_results_pending',
        run: { isActive: true },
      });
      expect((await f.store.getExecution('effect'))?.status).toBe('planned');
      const cursor = (await f.store.getMetadata()).lastChangeCursor;
      await f.store.handoffHumanRun(await f.input());
      expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    } finally {
      await f.close();
    }
  }
});

test('technical handoff preserves an actually activated independent child and its exact original carrier', async () => {
  const f = await fixture();
  try {
    await f.plan('delegate');
    await f.dispatch('delegate');
    const childInput = { content: 'Child keeps its original work' };
    const configuration = { modelId: 'child', tools: [], extensions: [] };
    const ref = await f.store.ensureOperation({
      ...f.owned,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'A',
      parentExecutionId: 'delegate',
      operationKey: 'child',
      request: { kind: 'agent', configurationId: 'worker', input: childInput },
      childConfiguration: { id: 'worker', version: '1', snapshot: configuration },
      cancellation: 'detached',
    });
    const source = { kind: 'model_decision', modelExecutionId: 'model' };
    await f.store.planExecution({
      ...f.owned,
      executionId: ref.executionId!,
      sessionId: 's',
      runId: null,
      originCommandId: ref.commandId,
      stepId: `operation-${ref.commandId}`,
      callId: ref.commandId,
      kind: 'job',
      parentExecutionId: 'delegate',
      cancelWithParent: false,
      definitionId: 'agent/worker',
      definitionVersion: '1',
      input: childInput,
      decisionSource: source,
    });
    await f.store.markDispatching({
      ...f.owned,
      executionId: ref.executionId!,
      authorization: {
        allowed: true,
        revision: 'policy',
        definitionVersion: '1',
        inputDigest: await semanticDigest(childInput),
      },
      requirements: [],
      freshness: { checked: true, source },
    });
    const child = await f.store.activateChildRun({
      ...f.owned,
      executionId: ref.executionId!,
      configuration,
      requirementEvaluations: [],
      freshness: { checked: true, source },
    });
    await f.store.finishExecution({
      ...f.owned,
      executionId: 'delegate',
      status: 'succeeded',
      result: { content: 'spawn accepted' },
    });
    await f.register();
    expect((await f.store.handoffHumanRun(await f.input())).handedOff).toBe(true);
    expect((await f.store.getRun(child.run.id))?.isActive).toBe(true);
    expect((await f.store.getExecution(ref.executionId!))?.cancelRequestedAt).toBeNull();
    expect((await f.store.getExecution(ref.executionId!))?.childSessionId).toBe(ref.childSessionId);
    // No process or Provider exists in this Store fixture; accurately settle its child for cleanup.
    await f.store.finishRun({
      ...f.owned,
      runId: child.run.id,
      status: 'cancelled',
      requirements: [],
    });
  } finally {
    await f.close();
  }
});

test('actual SQL failure rolls planned retirement and handoff cause back together; an exact retry commits only once', async () => {
  const f = await fixture();
  try {
    await f.plan('effect');
    await f.register();
    const input = await f.input(),
      cursor = (await f.store.getMetadata()).lastChangeCursor;
    f.database.run(
      "CREATE TRIGGER reject_human_handoff BEFORE INSERT ON command WHEN NEW.kind='human.handoff' BEGIN SELECT RAISE(ABORT,'isolated_handoff_failure'); END",
    );
    expect(await failure(f.store.handoffHumanRun(input))).toBeInstanceOf(Error);
    expect((await f.store.getExecution('effect'))?.status).toBe('planned');
    expect((await f.store.getRun(f.run.id))?.isActive).toBe(true);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(
      f.database.query("SELECT COUNT(*) AS count FROM command WHERE kind='human.handoff'").get(),
    ).toMatchObject({ count: 0 });
    f.database.run('DROP TRIGGER reject_human_handoff');
    const committed = await f.store.handoffHumanRun(input);
    const committedCursor = (await f.store.getMetadata()).lastChangeCursor;
    expect(await f.store.handoffHumanRun(input)).toEqual(committed);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(committedCursor);
    expect(
      f.database.query("SELECT COUNT(*) AS count FROM command WHERE kind='human.handoff'").get(),
    ).toMatchObject({ count: 1 });
  } finally {
    await f.close();
  }
});

async function cancelledSelection(
  f: Awaited<ReturnType<typeof fixture>>,
  relation: 'independent_work' | 'same_work' | 'undecided' = 'independent_work',
) {
  const publicCommand = await f.store.registerHumanCommand({
    ...f.scope,
    commandId: 'public-B',
    request: {
      kind: 'run.start',
      content: relation === 'same_work' ? 'Supplement original A' : 'Do independent B',
    },
  });
  const rawId = (publicCommand.receipt as { humanInputCommandId: string }).humanInputCommandId;
  const raw = (await f.store.getCommand(rawId))!;
  const decision =
    relation === 'undecided'
      ? undefined
      : await f.store.decideHumanInput({
          ...f.scope,
          inputCommandId: raw.id,
          inputDigest: raw.requestDigest,
          decisionId: 'decision-B',
          expectedControlRevision: (await f.store.readHumanWorkState(f.scope)).controlRevision,
          proposal: {
            relation,
            purpose: 'work',
            targetRootWorkCommandId: relation === 'same_work' ? 'A' : null,
            selectionEffect: relation === 'same_work' ? 'keep' : 'select_work',
            basis: {
              kind: 'explicit_text',
              instruction: relation === 'same_work' ? 'Supplement original A' : 'Do independent B',
            },
          },
        });
  await f.store.cancelCommand({ ...f.scope, commandId: 'cancel-B', targetCommandId: 'public-B' });
  expect((await f.store.getCommand(raw.id))?.cancelRequestedAt).not.toBeNull();
  if (decision?.businessCommand)
    expect(await f.store.getCommand(decision.businessCommand.id)).toMatchObject({
      status: 'rejected',
      receipt: { outcome: 'cancelled_before_apply' },
    });
  if (relation === 'independent_work') {
    expect(await f.store.getCommand(raw.id)).toMatchObject({
      status: 'applied',
      receipt: {
        state: 'cancelled',
        applicationState: 'queued',
        decisionCommandId: decision!.decision.id,
        businessCommandId: decision!.businessCommand!.id,
      },
    });
    expect((await f.store.readHumanWorkState(f.scope)).selectedWork).toEqual({
      rootWorkCommandId: decision!.decision.rootWorkCommandId,
      rootWorkSeq: decision!.decision.rootWorkSeq,
    });
  }
  return { rawId, decision, businessId: decision?.businessCommand?.id };
}
async function assertNoCancelledBusinessRun(
  f: Awaited<ReturnType<typeof fixture>>,
  businessId: string | undefined,
) {
  if (businessId) {
    expect(
      await failure(
        f.store.startRun({
          ...f.owned,
          commandId: businessId,
          configuration: { modelId: 'fixture', tools: [] },
        }),
      ),
    ).toBeInstanceOf(Error);
    expect(
      f.database
        .query('SELECT COUNT(*) AS count FROM run WHERE origin_command_id=?')
        .get(businessId),
    ).toMatchObject({ count: 0 });
    expect(
      f.database
        .query(
          'SELECT COUNT(*) AS count FROM execution WHERE origin_command_id=? AND dispatched<>0',
        )
        .get(businessId),
    ).toMatchObject({ count: 0 });
  }
  expect(
    f.database.query("SELECT COUNT(*) AS count FROM command WHERE kind='human.handoff'").get(),
  ).toMatchObject({ count: 0 });
}

test('cancelling raw B before any decision cannot use the cancelled-selection handoff exception', async () => {
  const f = await fixture();
  try {
    await f.plan('effect');
    const cancelled = await cancelledSelection(f, 'undecided');
    expect((await f.store.getCommand(cancelled.rawId))?.receipt).not.toHaveProperty(
      'decisionCommandId',
    );
    expect(await f.store.handoffHumanRun(await f.input(cancelled.rawId))).toMatchObject({
      handedOff: false,
      reason: 'input_or_work_cancelled',
      run: { isActive: true },
    });
    expect((await f.store.getExecution('effect'))?.status).toBe('planned');
    await assertNoCancelledBusinessRun(f, undefined);
    expect(
      f.database.query("SELECT COUNT(*) AS count FROM run WHERE session_id='s'").get(),
    ).toMatchObject({ count: 1 });
  } finally {
    await f.close();
  }
});

test('a cancelled same-work keep decision is not proof of an independent queued selection', async () => {
  const f = await fixture();
  try {
    await f.plan('effect');
    const cancelled = await cancelledSelection(f, 'same_work');
    expect(cancelled.decision?.decision.request).toMatchObject({
      proposal: { relation: 'same_work', selectionEffect: 'keep' },
    });
    expect(await f.store.handoffHumanRun(await f.input(cancelled.rawId))).toMatchObject({
      handedOff: false,
      reason: 'input_or_work_cancelled',
      run: { isActive: true },
    });
    expect((await f.store.getExecution('effect'))?.status).toBe('planned');
    await assertNoCancelledBusinessRun(f, cancelled.businessId);
  } finally {
    await f.close();
  }
});

test('a later real independent C selection prevents an old cancelled B from handing off A', async () => {
  const f = await fixture();
  try {
    await f.plan('effect');
    const cancelled = await cancelledSelection(f);
    const c = await f.register('C', 'Do independent C');
    const selected = await f.store.decideHumanInput({
      ...f.scope,
      inputCommandId: c.id,
      inputDigest: c.requestDigest,
      decisionId: 'decision-C',
      expectedControlRevision: (await f.store.readHumanWorkState(f.scope)).controlRevision,
      proposal: {
        relation: 'independent_work',
        purpose: 'work',
        targetRootWorkCommandId: null,
        selectionEffect: 'select_work',
        basis: { kind: 'explicit_text', instruction: 'Do independent C' },
      },
    });
    const before = await f.store.readHumanWorkState(f.scope);
    expect(before.latestInputCommandId).toBe('C');
    expect(before.selectedWork?.rootWorkCommandId).toBe(selected.decision.rootWorkCommandId);
    expect(await f.store.handoffHumanRun(await f.input(cancelled.rawId))).toMatchObject({
      handedOff: false,
      reason: 'input_or_work_cancelled',
      run: { isActive: true },
    });
    expect((await f.store.readHumanWorkState(f.scope)).selectedWork).toEqual(before.selectedWork);
    expect((await f.store.getExecution('effect'))?.status).toBe('planned');
    await assertNoCancelledBusinessRun(f, cancelled.businessId);
  } finally {
    await f.close();
  }
});

test('cancelled B cannot hand off A across its actual cancellation, root stop, or context selection drift', async () => {
  for (const control of ['cancel-A', 'root-stop', 'selection-drift'] as const) {
    const f = await fixture();
    try {
      const cancelled = await cancelledSelection(f);
      if (control === 'cancel-A')
        await f.store.cancelCommand({ ...f.scope, commandId: 'cancel-A', targetCommandId: 'A' });
      else if (control === 'root-stop')
        await f.store.cancelWork({
          ...f.scope,
          commandId: 'stop',
          kind: 'session.cancel',
          includeBackground: true,
        });
      else {
        // Negative persisted-scope fixture: a different current selection is never a recovery grant.
        f.database
          .query('UPDATE session SET context_selection_id=? WHERE id=?')
          .run('different-selection', 's');
      }
      const rejected = await failure(f.store.handoffHumanRun(await f.input(cancelled.rawId)));
      if (control === 'selection-drift')
        expect(rejected).toMatchObject({ code: 'input_handoff_scope_unverifiable' });
      else {
        expect(rejected).toBeNull();
        expect((await f.store.getRun(f.run.id))?.isActive).toBe(true);
        expect((await f.store.getCommand(cancelled.rawId))?.receipt).toMatchObject({
          handoff: { reason: 'input_or_work_cancelled', state: 'queued' },
        });
      }
      expect((await f.store.getRun(f.run.id))?.reason).not.toBe('human_work_deferred');
      await assertNoCancelledBusinessRun(f, cancelled.businessId);
    } finally {
      await f.close();
    }
  }
});

test('missing or mismatched cancelled-business seals cannot be used as technical handoff authority', async () => {
  for (const corruption of ['missing-business', 'wrong-decision', 'wrong-outcome'] as const) {
    const f = await fixture();
    try {
      await f.plan('effect');
      const cancelled = await cancelledSelection(f);
      expect(cancelled.businessId).toBeString();
      // Deliberately damage only the owned guard fixture, never create an execution proof.
      if (corruption === 'missing-business')
        f.database
          .query(
            "UPDATE command SET receipt_json=json_set(receipt_json,'$.businessCommandId',NULL) WHERE id=?",
          )
          .run(cancelled.rawId);
      else if (corruption === 'wrong-decision')
        f.database
          .query('UPDATE command SET target_command_id=? WHERE id=?')
          .run('A', cancelled.businessId!);
      else
        f.database
          .query(
            "UPDATE command SET receipt_json=json_set(receipt_json,'$.outcome','not_cancelled') WHERE id=?",
          )
          .run(cancelled.businessId!);
      expect(await f.store.handoffHumanRun(await f.input(cancelled.rawId))).toMatchObject({
        handedOff: false,
        reason: 'input_or_work_cancelled',
        run: { isActive: true },
      });
      expect((await f.store.getExecution('effect'))?.status).toBe('planned');
      await assertNoCancelledBusinessRun(f, cancelled.businessId);
    } finally {
      await f.close();
    }
  }
});
