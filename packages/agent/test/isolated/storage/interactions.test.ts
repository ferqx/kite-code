import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import type { InteractionAnswer } from '../../../src/storage/types';

async function rejected(work: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string })?.code).toBe(code);
}
async function fixture() {
  const dataRoot = mkdtempSync('/private/tmp/kite-interactions-');
  chmodSync(dataRoot, 0o700);
  const profile = { dataRoot, profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({ expectedStoreId, id: 'w', rootUri: 'file:///fixture', name: 'w' });
  await store.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    subjectId: 'user',
    title: 's',
  });
  await store.acceptCommand({
    expectedStoreId,
    commandId: 'work',
    sessionId: 's',
    subjectId: 'user',
    request: { kind: 'run.start', content: 'work' },
  });
  const owner = (await store.acquireSessionOwner('s', 'host'))!;
  const write = { expectedStoreId, owner };
  const configuration = { tools: [{ id: 'tool', version: '1', extensionId: 'fixture' }] };
  const run = await store.startRun({ ...write, commandId: 'work', configuration });
  const source = { kind: 'model_decision', modelExecutionId: 'fixed' };
  const input = { path: 'exact', content: 'full parameters' };
  const inputDigest = await semanticDigest(input);
  async function plan(id: string, sessionId = 's', runId = run.id, commandId = 'work') {
    return store.planExecution({
      ...write,
      executionId: id,
      sessionId,
      runId,
      originCommandId: commandId,
      kind: 'tool',
      stepId: id,
      callId: id,
      definitionId: 'tool',
      definitionVersion: '1',
      input,
      decisionSource: source,
    });
  }
  const request = (
    id: string,
    executionId = id,
    kind: 'approval' | 'question' | 'plan_review' = 'approval',
  ) => ({
    ...write,
    interactionId: id,
    executionId,
    attempt: 1,
    kind,
    definitionId: 'tool',
    definitionVersion: '1',
    inputDigest,
    policyRevision: 'policy-1',
    requiredRefs: [],
    source,
    request: { title: 'exact request' },
  });
  const answer = (
    id: string,
    commandId = `answer-${id}`,
    value: InteractionAnswer = { kind: 'approval', decision: 'approve' },
    presentationSessionId = 's',
  ) => ({
    expectedStoreId,
    commandId,
    presentationSessionId,
    interactionId: id,
    expectedRevision: '1',
    subjectId: 'user',
    answer: value,
  });
  const accept = (id: string, executionId = id) => ({
    ...write,
    interactionId: id,
    executionId,
    attempt: 1,
    decisionRevision: '2',
    definitionId: 'tool',
    definitionVersion: '1',
    inputDigest,
    policyRevision: 'policy-1',
    requirements: [],
    freshness: { checked: true, source },
  });
  const dispatch = (
    executionId: string,
    interactionId?: string,
    decisionRevision?: string,
    revision = 'policy-1',
  ) =>
    store.markDispatching({
      ...write,
      executionId,
      authorization: {
        allowed: true,
        revision,
        definitionVersion: '1',
        inputDigest,
        ...(interactionId ? { interactionId, decisionRevision } : {}),
      },
      requirements: [],
      freshness: { checked: true, source },
    });
  const db = new Database(join(dataRoot, 'test', 'core.db'));
  return {
    profile,
    store,
    db,
    expectedStoreId,
    owner,
    write,
    run,
    configuration,
    source,
    input,
    inputDigest,
    plan,
    request,
    answer,
    accept,
    dispatch,
    cleanup: async () => {
      db.close();
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}
test('two authoritative cards retain exact decisions, public CAS and accepted references; allowed true cannot bypass approval', async () => {
  const f = await fixture();
  try {
    for (const id of ['a', 'b']) {
      await f.plan(id);
      await f.store.requestInteraction(f.request(id));
    }
    expect((await f.store.getRun(f.run.id))?.status).toBe('waiting_interaction');
    const first = await f.store.listInteractions({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      limit: 1,
    });
    expect(first.interactions.map((x) => x.id)).toEqual(['a']);
    expect(first.nextAfterId).toBe('a');
    expect(
      (
        await f.store.listInteractions({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          afterId: first.nextAfterId!,
        })
      ).interactions.map((x) => x.id),
    ).toEqual(['b']);
    await rejected(f.dispatch('a'), 'interaction_decision_required');
    const receipt = await f.store.answerInteraction(f.answer('a'));
    expect(await f.store.answerInteraction(f.answer('a'))).toEqual(receipt);
    await rejected(
      f.store.answerInteraction(
        f.answer('a', 'other-answer', { kind: 'approval', decision: 'deny' }),
      ),
      'interaction_answer_conflict',
    );
    await rejected(f.dispatch('a', 'a', '2'), 'interaction_decision_required');
    await f.store.acceptInteractionDecision(f.accept('a'));
    expect((await f.store.getRun(f.run.id))?.status).toBe('waiting_interaction');
    await rejected(f.dispatch('a', 'a', '2', 'changed-policy'), 'interaction_decision_required');
    await f.dispatch('a', 'a', '2');
    expect((await f.store.getExecution('a'))?.interactionBinding).toEqual({
      interactionId: 'a',
      decisionRevision: '2',
    });
    await f.store.answerInteraction(
      f.answer('b', 'answer-b', { kind: 'approval', decision: 'deny' }),
    );
    await f.store.acceptInteractionDecision(f.accept('b'));
    expect((await f.store.getRun(f.run.id))?.status).toBe('running');
    await rejected(f.dispatch('b', 'b', '2'), 'permission_denied');
  } finally {
    await f.cleanup();
  }
});
test('request/answer rollback, late cancellation history, generation and wrong Store never grant execution', async () => {
  const f = await fixture();
  try {
    await f.plan('a');
    f.db.exec(
      "CREATE TRIGGER request_fault BEFORE INSERT ON change_event WHEN NEW.kind='interaction.requested' BEGIN SELECT RAISE(ABORT,'fault'); END",
    );
    let failed = false;
    try {
      await f.store.requestInteraction(f.request('a'));
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(
      await f.store.getInteraction({
        expectedStoreId: f.expectedStoreId,
        sessionId: 's',
        interactionId: 'a',
      }),
    ).toBeNull();
    expect((await f.store.getExecution('a'))?.interactionBinding).toBeNull();
    expect((await f.store.getRun(f.run.id))?.status).toBe('running');
    f.db.exec('DROP TRIGGER request_fault');
    await f.store.requestInteraction(f.request('a'));
    f.db.exec(
      "CREATE TRIGGER answer_fault BEFORE INSERT ON command WHEN NEW.kind='interaction.answer' BEGIN SELECT RAISE(ABORT,'fault'); END",
    );
    failed = false;
    try {
      await f.store.answerInteraction(f.answer('a'));
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(
      (
        await f.store.getInteraction({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          interactionId: 'a',
        })
      )?.state,
    ).toBe('pending');
    f.db.exec('DROP TRIGGER answer_fault');
    await f.store.cancelWork({
      expectedStoreId: f.expectedStoreId,
      commandId: 'cancel',
      sessionId: 's',
      subjectId: 'user',
      kind: 'execution.cancel',
      executionId: 'a',
    });
    const receipt = await f.store.answerInteraction(f.answer('a'));
    expect(receipt.receipt).toMatchObject({ outcome: 'answer_saved', cancelled: true });
    expect(
      (
        await f.store.getInteraction({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          interactionId: 'a',
        })
      )?.answer,
    ).toEqual({ kind: 'approval', decision: 'approve' });
    await rejected(f.store.acceptInteractionDecision(f.accept('a')), 'cancelled_before_dispatch');
    await rejected(
      f.store.answerInteraction({ ...f.answer('a'), expectedStoreId: 'other' }),
      'store_identity_mismatch',
    );
    await rejected(
      f.store.answerInteraction({ ...f.answer('a', 'intruder'), subjectId: 'intruder' }),
      'interaction_scope_denied',
    );
    await rejected(
      f.store.acceptInteractionDecision({
        ...f.accept('a'),
        owner: { ...f.owner, generation: '999' },
      }),
      'owner_changed',
    );
    expect((await f.store.getExecution('a'))?.status).toBe('planned');
  } finally {
    await f.cleanup();
  }
});
test('saved answer survives Worker loss, exact acceptance rejects changed params/source/plan and fences prior owner', async () => {
  const f = await fixture();
  let reopened: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    const modelInput = { messages: [], modelId: 'fixed' };
    const modelSource = { kind: 'fixture' };
    await f.store.planExecution({
      ...f.write,
      executionId: 'fixed',
      sessionId: 's',
      runId: f.run.id,
      originCommandId: 'work',
      stepId: 'model-step',
      callId: 'model-call',
      kind: 'model',
      definitionId: 'fixed',
      definitionVersion: '1',
      input: modelInput,
      decisionSource: modelSource,
    });
    await f.store.markDispatching({
      ...f.write,
      executionId: 'fixed',
      authorization: {
        allowed: true,
        revision: '1',
        definitionVersion: '1',
        inputDigest: await semanticDigest(modelInput),
      },
      requirements: [],
      freshness: { checked: true, source: modelSource },
    });
    const toolCalls = [{ id: 'a', name: 'tool', arguments: JSON.stringify(f.input) }];
    await f.store.finishExecution({
      ...f.write,
      executionId: 'fixed',
      status: 'succeeded',
      result: { content: '', toolCalls, finishReason: 'tool_calls' },
      message: { role: 'assistant', content: '', toolCalls, sourceIds: ['fixed'] },
    });
    await f.plan('a');
    await f.store.requestInteraction(f.request('a'));
    await f.store.answerInteraction(f.answer('a'));
    expect(await f.store.getExecution('a')).toMatchObject({
      status: 'planned',
      callId: 'a',
      input: f.input,
      decisionSource: f.source,
    });
    expect(f.db.query("SELECT dispatched FROM execution WHERE id='a'").get()).toEqual({
      dispatched: 0,
    });
    expect(await f.store.getExecution('fixed')).toMatchObject({
      status: 'succeeded',
      sessionId: 's',
      runId: f.run.id,
      originStoreId: f.expectedStoreId,
      originCommandId: 'work',
      result: { content: '', toolCalls, finishReason: 'tool_calls' },
    });
    expect(
      (await f.store.listMessages('s')).filter((message) => message.role === 'assistant'),
    ).toMatchObject([
      { sessionId: 's', runId: f.run.id, content: '', toolCalls, sourceIds: ['fixed'] },
    ]);
    await f.store.close();
    reopened = await openSqliteStore(f.profile);
    const persisted = await reopened.getInteraction({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      interactionId: 'a',
    });
    expect(persisted?.state).toBe('answered');
    expect(persisted?.acceptedDecisionRevision).toBeNull();
    const owner = await reopened.acquireSessionOwner('s', 'replacement').catch((error) => {
      expect(error.code).toBe('recovery_required');
      return null;
    });
    expect(owner).toBeNull();
    const history = await reopened.readRecoveryToolHistory({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      subjectId: 'user',
      expectedOwnerGeneration: f.owner.generation,
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      executionId: 'a',
      sessionId: 's',
      runId: f.run.id,
      modelExecutionId: 'fixed',
      callId: 'a',
      definitionId: 'tool',
      inputDigest: f.inputDigest,
      modelOutput: null,
    });
    const report = await reopened.recoverSession({
      expectedStoreId: f.expectedStoreId,
      commandId: 'recover',
      sessionId: 's',
      subjectId: 'user',
      expectedOwnerGeneration: f.owner.generation,
      decision: 'interrupt',
    });
    expect(report.generation).not.toBe(f.owner.generation);
    expect(report.cancelledExecutionIds).toEqual(['a']);
    expect(report.unknownExecutionIds).toEqual([]);
    expect((await reopened.getExecution('fixed'))?.status).toBe('succeeded');
    const cancelledCalls = (await reopened.listMessages('s')).filter(
      (message) => message.role === 'tool',
    );
    expect(cancelledCalls).toHaveLength(1);
    expect(cancelledCalls).toMatchObject([
      { sessionId: 's', runId: f.run.id, toolCallId: 'a', sourceIds: ['a'] },
    ]);
    expect(cancelledCalls[0]?.content).toContain('recovery_cancelled_unstarted');
    expect(
      (
        await reopened.getInteraction({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          interactionId: 'a',
        })
      )?.answer,
    ).toEqual({ kind: 'approval', decision: 'approve' });
    await rejected(reopened.acceptInteractionDecision(f.accept('a')), 'owner_changed');
  } finally {
    await reopened?.close();
    await f.cleanup();
  }
});
test('question schema rejects invalid answers and never becomes approval; plan modes retain immutable original binding', async () => {
  const f = await fixture();
  try {
    await f.plan('q');
    await f.dispatch('q');
    const request = {
      ...f.request('q', 'q', 'question'),
      request: {
        schema: {
          type: 'object',
          properties: { choice: { enum: ['yes', 'no'] } },
          required: ['choice'],
          additionalProperties: false,
        },
      },
    };
    await f.store.requestInteraction(request);
    await rejected(
      f.store.answerInteraction(
        f.answer('q', 'bad-question', { kind: 'question', answers: { choice: 'invented' } }),
      ),
      'interaction_answer_invalid',
    );
    expect(await f.store.getCommand('bad-question')).toBeNull();
    await f.store.answerInteraction(
      f.answer('q', 'answer-q', { kind: 'question', answers: { choice: 'yes' } }),
    );
    await f.store.acceptInteractionDecision(f.accept('q'));
    expect((await f.store.getExecution('q'))?.interactionBinding).toBeNull();
    expect((await f.store.getExecution('q'))?.status).toBe('dispatching');
    await f.plan('p');
    await rejected(
      f.store.requestInteraction(f.request('p', 'p', 'plan_review')),
      'interaction_not_active',
    );
    await f.dispatch('p');
    await f.store.requestInteraction(f.request('p', 'p', 'plan_review'));
    await rejected(
      f.store.requestInteraction({
        ...f.request('p', 'p', 'plan_review'),
        inputDigest: await semanticDigest({ changed: true }),
      }),
      'interaction_binding_changed',
    );
    await f.store.answerInteraction(
      f.answer('p', 'answer-p', { kind: 'plan_review', decision: 'approve', mode: 'execute' }),
    );
    await rejected(
      f.store.acceptInteractionDecision({
        ...f.accept('p'),
        freshness: { checked: true, source: { changed: true } },
      }),
      'context_refresh_required',
    );
    await rejected(
      f.store.acceptInteractionDecision({ ...f.accept('p'), definitionVersion: '2' }),
      'interaction_binding_changed',
    );
    await f.store.acceptInteractionDecision(f.accept('p'));
    expect((await f.store.getExecution('p'))?.interactionBinding).toBeNull();
    expect((await f.store.getExecution('p'))?.status).toBe('dispatching');
    expect((await f.store.getExecution('p'))?.input).toEqual(f.input);
  } finally {
    await f.cleanup();
  }
});

test('child authoritative request projects only to root; detached parent completion does not revoke an exact child answer', async () => {
  const f = await fixture();
  try {
    await f.plan('carrier');
    await f.dispatch('carrier');
    const child = await f.store.ensureOperation({
      ...f.write,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'work',
      parentExecutionId: 'carrier',
      operationKey: 'child',
      cancellation: 'detached',
      request: { kind: 'agent', configurationId: 'child', input: {} },
      childConfiguration: { id: 'child', version: '1', snapshot: f.configuration },
    });
    await f.store.markDispatching({
      ...f.write,
      executionId: child.executionId!,
      authorization: {
        allowed: true,
        revision: 'policy-1',
        definitionVersion: '1',
        inputDigest: await semanticDigest({}),
      },
      requirements: [],
      freshness: { checked: true, source: f.source },
    });
    const active = await f.store.activateChildRun({
      ...f.write,
      executionId: child.executionId!,
      configuration: f.configuration,
      requirementEvaluations: [],
      freshness: { checked: true, source: f.source },
    });
    await f.plan('child-tool', child.childSessionId!, active.run.id, active.command.id);
    const card = await f.store.requestInteraction(f.request('child-card', 'child-tool'));
    expect(card.sessionId).toBe(child.childSessionId!);
    expect(card.presentationSessionId).toBe('s');
    expect(card.ancestry).toEqual([child.childSessionId!, 's']);
    expect(card.subjectId).toBe('user');
    expect(
      (
        await f.store.listInteractions({ expectedStoreId: f.expectedStoreId, sessionId: 's' })
      ).interactions.map((x) => x.id),
    ).toEqual(['child-card']);
    expect(
      (
        await f.store.getInteraction({
          expectedStoreId: f.expectedStoreId,
          sessionId: child.childSessionId!,
          interactionId: 'child-card',
        })
      )?.id,
    ).toBe('child-card');
    await rejected(
      f.store.answerInteraction(
        f.answer(
          'child-card',
          'child-direct',
          { kind: 'approval', decision: 'approve' },
          child.childSessionId!,
        ),
      ),
      'interaction_scope_denied',
    );
    expect(await f.store.getCommand('child-direct')).toBeNull();
    await f.store.finishExecution({
      ...f.write,
      executionId: 'carrier',
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'created' },
    });
    await f.store.finishRun({ ...f.write, runId: f.run.id, status: 'completed', requirements: [] });
    const receipt = await f.store.answerInteraction(f.answer('child-card'));
    expect(receipt.sessionId).toBe('s');
    expect(receipt.rootWorkCommandId).toBe('work');
    await f.store.acceptInteractionDecision(f.accept('child-card', 'child-tool'));
    await f.dispatch('child-tool', 'child-card', '2');
    expect((await f.store.getExecution('child-tool'))?.status).toBe('dispatching');
    expect((await f.store.getRun(f.run.id))?.status).toBe('completed');
  } finally {
    await f.cleanup();
  }
});

test('required record evaluations cannot be omitted or stale; idempotent acceptance adds no event and revision overflow rolls back answer', async () => {
  const f = await fixture();
  try {
    await f.plan('writer');
    await f.dispatch('writer');
    await f.store.writeExtensionRecord({
      ...f.write,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'work',
      originExecutionId: 'writer',
      write: {
        key: 'plan',
        expectedRevision: null,
        contentType: 'fixture.plan',
        contentVersion: 1,
        value: { ready: true },
        executable: true,
      },
    });
    const proposed = {
      extensionId: 'fixture',
      definitionVersion: '1',
      requirementId: 'ready',
      revision: '1',
      phase: 'dispatch' as const,
      sessionId: 's',
      runId: f.run.id,
      recordKey: 'plan',
    };
    const registered = await f.store.registerRunRequirements({
      ...f.write,
      runId: f.run.id,
      requirements: [proposed],
    });
    const requirement = registered.requirements[0]!;
    expect(requirement.originStoreId).toBe(f.expectedStoreId);
    await f.plan('a');
    await rejected(f.store.requestInteraction(f.request('a')), 'interaction_binding_changed');
    await f.store.requestInteraction({ ...f.request('a'), requiredRefs: [requirement] });
    await f.store.answerInteraction(f.answer('a'));
    await rejected(f.store.acceptInteractionDecision(f.accept('a')), 'requirement_not_satisfied');
    const accepted = {
      ...f.accept('a'),
      requirements: [
        {
          requirement,
          recordRevision: '1',
          outcome: 'satisfied' as const,
          evidence: { ready: true },
        },
      ],
    };
    const decision = await f.store.acceptInteractionDecision(accepted);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    expect(await f.store.acceptInteractionDecision(accepted)).toEqual(decision);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    f.db.exec("UPDATE extension_record SET revision=2 WHERE key='plan'");
    await rejected(f.store.acceptInteractionDecision(accepted), 'requirement_not_satisfied');
    await f.plan('max');
    await f.store.requestInteraction({ ...f.request('max'), requiredRefs: [requirement] });
    f.db.exec("UPDATE interaction SET revision=9223372036854775807 WHERE id='max'");
    await rejected(
      f.store.answerInteraction({ ...f.answer('max'), expectedRevision: '9223372036854775807' }),
      'sequence_exhausted',
    );
    expect(await f.store.getCommand('answer-max')).toBeNull();
    expect(
      (
        await f.store.getInteraction({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          interactionId: 'max',
        })
      )?.answer,
    ).toBeNull();
  } finally {
    await f.cleanup();
  }
});

test('dispatched Tool informational plan_review/question preserve its accepted approval and cannot authorize another execution', async () => {
  const f = await fixture();
  try {
    await f.plan('approved');
    await f.store.requestInteraction(f.request('approval', 'approved'));
    await f.store.answerInteraction(f.answer('approval'));
    await f.store.acceptInteractionDecision(f.accept('approval', 'approved'));
    await f.dispatch('approved', 'approval', '2');
    const binding = (await f.store.getExecution('approved'))!.interactionBinding;
    await f.store.requestInteraction({
      ...f.request('review', 'approved', 'plan_review'),
      request: { planId: 'business-plan', revision: '1' },
    });
    await f.store.requestInteraction(f.request('question', 'approved', 'question'));
    expect((await f.store.getExecution('approved'))!.interactionBinding).toEqual(binding);
    await f.store.answerInteraction(
      f.answer('review', 'answer-review', {
        kind: 'plan_review',
        decision: 'revise',
        feedback: 'change this plan',
        mode: 'accept_edits',
      }),
    );
    await f.store.answerInteraction(
      f.answer('question', 'answer-question', {
        kind: 'question',
        answers: { choice: 'continue' },
      }),
    );
    await rejected(
      f.store.acceptInteractionDecision({
        ...f.accept('review', 'approved'),
        inputDigest: await semanticDigest({ changed: true }),
      }),
      'interaction_binding_changed',
    );
    await rejected(
      f.store.requestInteraction({
        ...f.request('review', 'approved', 'plan_review'),
        request: { planId: 'business-plan', revision: '2' },
      }),
      'interaction_conflict',
    );
    const accepted = await f.store.acceptInteractionDecision(f.accept('review', 'approved'));
    expect(accepted.answer).toEqual({
      kind: 'plan_review',
      decision: 'revise',
      feedback: 'change this plan',
      mode: 'accept_edits',
    });
    await f.store.acceptInteractionDecision(f.accept('question', 'approved'));
    expect((await f.store.getExecution('approved'))!.interactionBinding).toEqual(binding);
    expect((await f.store.getExecution('approved'))!.status).toBe('dispatching');
    expect((await f.store.getRun(f.run.id))!.status).toBe('running');
    await f.plan('other');
    await rejected(f.dispatch('other', 'review', '2'), 'interaction_binding_changed');
    expect((await f.store.getExecution('other'))!.status).toBe('planned');
    await rejected(
      f.store.acceptInteractionDecision(f.accept('review', 'other')),
      'interaction_binding_changed',
    );
    expect((await f.store.getExecution('other'))!.interactionBinding).toBeNull();
  } finally {
    await f.cleanup();
  }
});

test('unsatisfied persistent requirements do not block informational decisions, but stale binding and final execution gates remain strict', async () => {
  const f = await fixture();
  try {
    await f.plan('writer');
    await f.dispatch('writer');
    await f.store.writeExtensionRecord({
      ...f.write,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'work',
      originExecutionId: 'writer',
      write: {
        key: 'unapproved',
        expectedRevision: null,
        contentType: 'fixture.plan',
        contentVersion: 3,
        value: { approved: false },
        executable: true,
      },
    });
    const registered = await f.store.registerRunRequirements({
      ...f.write,
      runId: f.run.id,
      requirements: [
        {
          extensionId: 'fixture',
          definitionVersion: '1',
          requirementId: 'approval-needed',
          revision: '1',
          phase: 'both',
          sessionId: 's',
          runId: f.run.id,
          recordKey: 'unapproved',
        },
      ],
    });
    const refs = registered.requirements;
    for (const kind of ['plan_review', 'question'] as const) {
      await f.store.requestInteraction({
        ...f.request(kind, 'writer', kind),
        requiredRefs: refs,
        request: { planId: 'unapproved', revision: '1' },
      });
      await f.store.answerInteraction(
        f.answer(
          kind,
          `answer-${kind}`,
          kind === 'question'
            ? { kind, answers: { note: 'information' } }
            : { kind, decision: 'approve', mode: 'auto' },
        ),
      );
      const accepted = await f.store.acceptInteractionDecision({
        ...f.accept(kind, 'writer'),
        requirements: [],
      });
      expect(accepted.acceptedDecisionRevision).toBe('2');
    }
    expect((await f.store.getExecution('writer'))!.interactionBinding).toBeNull();
    expect((await f.store.getRun(f.run.id))!.requirements).toEqual(refs);
    await f.plan('next');
    await rejected(f.dispatch('next'), 'requirement_not_satisfied');
    await f.store.finishExecution({
      ...f.write,
      executionId: 'next',
      status: 'cancelled',
      result: { outcome: 'cancelled', content: 'never dispatched' },
    });
    await f.store.requestInteraction({
      ...f.request('stale-review', 'writer', 'plan_review'),
      requiredRefs: refs,
      request: { planId: 'unapproved', revision: '1' },
    });
    await f.store.answerInteraction(
      f.answer('stale-review', 'answer-stale', { kind: 'plan_review', decision: 'deny' }),
    );
    await f.store.writeExtensionRecord({
      ...f.write,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'work',
      originExecutionId: 'writer',
      write: {
        key: 'unapproved',
        expectedRevision: '1',
        contentType: 'fixture.plan',
        contentVersion: 3,
        value: { approved: false, changed: true },
      },
    });
    await rejected(
      f.store.acceptInteractionDecision({
        ...f.accept('stale-review', 'writer'),
        requirements: [],
      }),
      'interaction_binding_changed',
    );
    expect(
      (await f.store.getInteraction({
        expectedStoreId: f.expectedStoreId,
        sessionId: 's',
        interactionId: 'stale-review',
      }))!.acceptedDecisionRevision,
    ).toBeNull();
    await f.store.cancelWork({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      subjectId: 'user',
      commandId: 'stop-unaccepted',
      kind: 'execution.cancel',
      executionId: 'writer',
    });
    await f.store.finishExecution({
      ...f.write,
      executionId: 'writer',
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'actual known Tool effect' },
    });
    await rejected(
      f.store.finishRun({ ...f.write, runId: f.run.id, status: 'completed', requirements: [] }),
      'requirement_not_satisfied',
    );
  } finally {
    await f.cleanup();
  }
});

test('late informational plan answer remains historical after cancellation and cannot reactivate its Tool or overwrite authority', async () => {
  const f = await fixture();
  try {
    await f.plan('tool');
    await f.dispatch('tool');
    await f.store.requestInteraction(f.request('review-late', 'tool', 'plan_review'));
    await f.store.cancelCommand({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      subjectId: 'user',
      commandId: 'cancel-tool',
      targetCommandId: 'work',
    });
    const saved = await f.store.answerInteraction(
      f.answer('review-late', 'late-answer', {
        kind: 'plan_review',
        decision: 'approve',
        mode: 'auto',
      }),
    );
    expect(saved.receipt).toMatchObject({ outcome: 'answer_saved', cancelled: true });
    const review = await f.store.getInteraction({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      interactionId: 'review-late',
    });
    expect(review!.state).toBe('cancelled');
    expect(review!.answer).toEqual({ kind: 'plan_review', decision: 'approve', mode: 'auto' });
    await rejected(
      f.store.acceptInteractionDecision(f.accept('review-late', 'tool')),
      'cancelled_before_dispatch',
    );
    expect((await f.store.getExecution('tool'))!.interactionBinding).toBeNull();
    expect((await f.store.getExecution('tool'))!.status).toBe('dispatching');
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    expect(
      await f.store.answerInteraction(
        f.answer('review-late', 'late-answer', {
          kind: 'plan_review',
          decision: 'approve',
          mode: 'auto',
        }),
      ),
    ).toEqual(saved);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await f.cleanup();
  }
});
