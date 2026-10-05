import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import type { CommandRequest } from '../../../src/storage/types';

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
  const dataRoot = mkdtempSync('/private/tmp/kite-inputs-');
  chmodSync(dataRoot, 0o700);
  const profile = { dataRoot, profile: 'test' };
  const store = await openSqliteStore(profile);
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
  const contextSelectionId = (await store.getSession('s'))!.contextSelectionId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'user' };
  await store.acceptCommand({
    ...base,
    commandId: 'work',
    request: { kind: 'run.start', content: 'original' },
  });
  const owner = (await store.acquireSessionOwner('s', 'host'))!;
  const write = { expectedStoreId, owner };
  const run = await store.startRun({
    ...write,
    commandId: 'work',
    configuration: { modelId: 'fixed' },
  });
  const db = new Database(join(dataRoot, 'test', 'core.db'));
  const source = { kind: 'model_decision', modelExecutionId: 'decision' };
  const steer = (id: string, content = id) =>
    store.acceptCommand({
      ...base,
      commandId: id,
      request: { kind: 'input.steer', content, targetRunId: run.id, contextSelectionId },
    });
  const follow = (id: string) =>
    store.acceptCommand({
      ...base,
      commandId: id,
      request: {
        kind: 'input.follow_up',
        content: id,
        afterRunId: run.id,
        contextSelectionId,
        modelId: 'next',
      },
    });
  const apply = (id: string) =>
    store.applyInput({ ...write, commandId: id, kind: 'steer', runId: run.id });
  const plan = (id: string, kind: 'model' | 'tool' = 'tool') =>
    store.planExecution({
      ...write,
      executionId: id,
      sessionId: 's',
      runId: run.id,
      originCommandId: 'work',
      stepId: id,
      callId: id,
      kind,
      definitionId: 'fixed',
      definitionVersion: '1',
      input: { content: 'original request' },
      decisionSource: source,
    });
  return {
    store,
    profile,
    db,
    expectedStoreId,
    contextSelectionId,
    base,
    write,
    run,
    source,
    steer,
    follow,
    apply,
    plan,
    finish: () =>
      store.finishRun({ ...write, runId: run.id, status: 'completed', requirements: [] }),
    cleanup: async () => {
      db.close();
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}
async function dispatch(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  return f.store.markDispatching({
    ...f.write,
    executionId: id,
    authorization: {
      allowed: true,
      revision: '1',
      definitionVersion: '1',
      inputDigest: await semanticDigest({ content: 'original request' }),
    },
    requirements: [],
    freshness: { checked: true, source: f.source },
  });
}
test('steer preserves real Run/order/provenance, supersedes only unstarted calls/cards and leaves dispatched request immutable', async () => {
  const f = await fixture();
  try {
    await f.plan('decision-model', 'model');
    await dispatch(f, 'decision-model');
    await f.store.finishExecution({
      ...f.write,
      executionId: 'decision-model',
      status: 'succeeded',
      result: {
        toolCalls: [
          {
            id: 'old-tool',
            name: 'fixed',
            arguments: JSON.stringify({ content: 'original request' }),
          },
        ],
      },
      message: {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'old-tool',
            name: 'fixed',
            arguments: JSON.stringify({ content: 'original request' }),
          },
        ],
      },
    });
    await f.plan('live-model', 'model');
    await dispatch(f, 'live-model');
    await f.plan('old-tool');
    await f.plan('live-question');
    await dispatch(f, 'live-question');
    await f.store.requestInteraction({
      ...f.write,
      interactionId: 'question',
      executionId: 'live-question',
      attempt: 1,
      kind: 'question',
      definitionId: 'fixed',
      definitionVersion: '1',
      inputDigest: await semanticDigest({ content: 'original request' }),
      policyRevision: '1',
      requiredRefs: [],
      source: f.source,
      request: { prompt: 'still waiting' },
    });
    await f.store.requestInteraction({
      ...f.write,
      interactionId: 'old-approval',
      executionId: 'old-tool',
      attempt: 1,
      kind: 'approval',
      definitionId: 'fixed',
      definitionVersion: '1',
      inputDigest: await semanticDigest({ content: 'original request' }),
      policyRevision: '1',
      requiredRefs: [],
      source: f.source,
      request: { title: 'original params' },
    });
    for (let n = 0; n < 12; n++) await f.steer(`steer-${n}`);
    const page = await f.store.listPendingInputs({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      kind: 'input.steer',
      targetRunId: f.run.id,
      limit: 5,
    });
    expect(page.commands.map((c) => c.id)).toEqual([
      'steer-0',
      'steer-1',
      'steer-2',
      'steer-3',
      'steer-4',
    ]);
    expect(page.nextAfterSeq).toBe(page.commands[4]!.seq);
    expect(
      (
        await f.store.listPendingInputs({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          afterSeq: page.nextAfterSeq!,
          limit: 20,
        })
      ).commands,
    ).toHaveLength(7);
    await rejected(f.apply('steer-1'), 'input_order_conflict');
    await rejected(f.finish(), 'input_pending');
    await rejected(dispatch(f, 'old-tool'), 'input_pending');
    const first = await f.apply('steer-0');
    expect(first.supersededExecutionIds).toEqual(['old-tool']);
    expect(first.message.sourceIds).toEqual(['steer-0']);
    expect(first.message.contextSelectionId).toBe(f.contextSelectionId);
    expect(first.message.originCommandId).toBe('steer-0');
    expect(first.message.inputKind).toBe('input.steer');
    expect(first.command.rootWorkCommandId).toBe('work');
    expect(first.run.id).toBe(f.run.id);
    expect(first.run.status).toBe('waiting_interaction');
    expect((await f.store.getExecution('old-tool'))?.result).toMatchObject({
      content: 'superseded_by_user_input',
      details: { adapterAttempted: false },
    });
    expect(
      (
        await f.store.getInteraction({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          interactionId: 'old-approval',
        })
      )?.state,
    ).toBe('cancelled');
    expect((await f.store.getExecution('live-model'))?.status).toBe('dispatching');
    expect((await f.store.getExecution('live-model'))?.input).toEqual({
      content: 'original request',
    });
    expect(await f.apply('steer-0')).toEqual(first);
    for (let n = 1; n < 12; n++) await f.apply(`steer-${n}`);
    expect(
      (await f.store.listPendingInputs({ expectedStoreId: f.expectedStoreId, sessionId: 's' }))
        .commands,
    ).toHaveLength(0);
    await f.store.answerInteraction({
      expectedStoreId: f.expectedStoreId,
      commandId: 'answer-question',
      presentationSessionId: 's',
      interactionId: 'question',
      expectedRevision: '1',
      subjectId: 'user',
      answer: { kind: 'question', answers: 'answer' },
    });
    await f.store.acceptInteractionDecision({
      ...f.write,
      interactionId: 'question',
      executionId: 'live-question',
      attempt: 1,
      decisionRevision: '2',
      definitionId: 'fixed',
      definitionVersion: '1',
      inputDigest: await semanticDigest({ content: 'original request' }),
      policyRevision: '1',
      requirements: [],
      freshness: { checked: true, source: f.source },
    });
    expect((await f.store.getRun(f.run.id))?.status).toBe('running');
    const messages = await f.store.listMessages('s', { limit: 100 });
    expect(
      messages.some(
        (m) => m.role === 'assistant' && m.toolCalls?.some((call) => call.id === 'old-tool'),
      ),
    ).toBe(true);
    expect(
      messages
        .filter((m) => m.role === 'tool' && m.toolCallId === 'old-tool')
        .map((m) => ({ content: m.content, sourceIds: m.sourceIds })),
    ).toEqual([{ content: 'superseded_by_user_input', sourceIds: ['old-tool'] }]);
    expect(messages.filter((m) => m.inputKind === 'input.steer').map((m) => m.content)).toEqual(
      Array.from({ length: 12 }, (_, n) => `steer-${n}`),
    );
    expect(new Set(messages.filter((m) => m.inputKind).map((m) => m.id)).size).toBe(12);
  } finally {
    await f.cleanup();
  }
});
test('cancellation before input application creates zero messages; exact Run cancellation consumes pending steer but preserves new followup intent', async () => {
  const f = await fixture();
  try {
    await f.steer('cancel-input');
    const before = (await f.store.listMessages('s')).length;
    await f.store.cancelCommand({
      ...f.base,
      commandId: 'cancel',
      targetCommandId: 'cancel-input',
    });
    expect((await f.store.getCommand('cancel-input'))?.receipt).toEqual({
      outcome: 'cancelled_before_apply',
    });
    await rejected(f.apply('cancel-input'), 'input_cancelled');
    expect(await f.store.listMessages('s')).toHaveLength(before);
    await f.steer('target-input');
    await f.follow('new-intent');
    await f.store.cancelCommand({ ...f.base, commandId: 'cancel-run', targetCommandId: 'work' });
    expect((await f.store.getCommand('target-input'))?.status).toBe('rejected');
    expect((await f.store.getCommand('new-intent'))?.status).toBe('accepted');
    expect((await f.store.getCommand('new-intent'))?.cancelRequestedAt).toBeNull();
    await rejected(f.apply('target-input'), 'input_cancelled');
    expect(await f.store.listMessages('s')).toHaveLength(before);
  } finally {
    await f.cleanup();
  }
});
test('steer completion/admission race is exact and finished target never drifts to a later Run', async () => {
  const f = await fixture();
  try {
    await f.steer('before-finish');
    await rejected(f.finish(), 'input_pending');
    await f.apply('before-finish');
    expect((await f.finish()).status).toBe('completed');
    await rejected(f.steer('late'), 'input_target_stopped');
    expect(await f.store.getCommand('late')).toBeNull();
    await f.store.acceptCommand({
      ...f.base,
      commandId: 'later',
      request: { kind: 'run.start', content: 'later' },
    });
    const later = await f.store.startRun({ ...f.write, commandId: 'later', configuration: {} });
    await rejected(f.steer('drift'), 'input_target_stopped');
    expect((await f.store.getRun(later.id))?.isActive).toBe(true);
    const history = await f.apply('before-finish');
    expect(history.run.id).toBe(f.run.id);
    expect(history.run.status).toBe('completed');
    expect(history.message.sourceIds).toEqual(['before-finish']);
    expect(
      (await f.store.listMessages('s')).filter((m) => m.sourceIds?.includes('before-finish')),
    ).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});
test('follow-up queues immutable new work and only owner application creates one next foreground Run in original order', async () => {
  const f = await fixture();
  try {
    const first = await f.follow('next-1');
    const second = await f.follow('next-2');
    expect(first.rootWorkCommandId).toBe('next-1');
    expect(second.rootWorkCommandId).toBe('next-2');
    await rejected(
      f.store.applyInput({ ...f.write, commandId: 'next-1', kind: 'follow_up', configuration: {} }),
      'input_not_ready',
    );
    await rejected(
      f.store.startRun({ ...f.write, commandId: 'next-1', configuration: {} }),
      'command_not_startable',
    );
    expect((await f.store.getRun(f.run.id))?.isActive).toBe(true);
    await f.finish();
    await f.store.acceptCommand({
      ...f.base,
      commandId: 'new-top',
      request: { kind: 'run.start', content: 'newer' },
    });
    await rejected(
      f.store.startRun({ ...f.write, commandId: 'new-top', configuration: {} }),
      'input_order_conflict',
    );
    await rejected(
      f.store.applyInput({ ...f.write, commandId: 'next-2', kind: 'follow_up', configuration: {} }),
      'input_order_conflict',
    );
    const applied = await f.store.applyInput({
      ...f.write,
      commandId: 'next-1',
      kind: 'follow_up',
      configuration: { modelId: 'next' },
    });
    expect(applied.run.id).not.toBe(f.run.id);
    expect(applied.run.originCommandId).toBe('next-1');
    expect(applied.message.sourceIds).toEqual(['next-1']);
    expect(applied.message.contextSelectionId).toBe(f.contextSelectionId);
    expect(
      await f.store.applyInput({
        ...f.write,
        commandId: 'next-1',
        kind: 'follow_up',
        configuration: { modelId: 'next' },
      }),
    ).toEqual(applied);
    await rejected(
      f.store.applyInput({ ...f.write, commandId: 'next-2', kind: 'follow_up', configuration: {} }),
      'session_busy',
    );
    await f.store.finishRun({
      ...f.write,
      runId: applied.run.id,
      status: 'completed',
      requirements: [],
    });
    const next = await f.store.applyInput({
      ...f.write,
      commandId: 'next-2',
      kind: 'follow_up',
      configuration: {},
    });
    expect(next.run.id).not.toBe(applied.run.id);
    expect(next.run.rootWorkCommandId).toBe('next-2');
    expect(next.command.seq).toBe(second.seq);
  } finally {
    await f.cleanup();
  }
});
test('selection/subject/Store/owner/child guards are closed and stale accepted inputs can be explicitly rejected without effects', async () => {
  const f = await fixture();
  try {
    await rejected(
      f.store.acceptCommand({
        ...f.base,
        subjectId: 'intruder',
        commandId: 'intruder',
        request: {
          kind: 'input.steer',
          content: 'intrude',
          targetRunId: f.run.id,
          contextSelectionId: f.contextSelectionId,
        },
      }),
      'permission_denied',
    );
    await rejected(
      f.store.acceptCommand({
        ...f.base,
        commandId: 'old-name',
        request: { kind: 'input.followup', content: 'old' } as unknown as CommandRequest,
      }),
      'invalid_command_kind',
    );
    await f.steer('stale');
    const before = (await f.store.listMessages('s')).length;
    await rejected(
      f.store.applyInput({
        ...f.write,
        expectedStoreId: 'other',
        commandId: 'stale',
        kind: 'steer',
        runId: f.run.id,
      }),
      'store_identity_mismatch',
    );
    await rejected(
      f.store.applyInput({
        ...f.write,
        owner: { ...f.write.owner, generation: '999' },
        commandId: 'stale',
        kind: 'steer',
        runId: f.run.id,
      }),
      'owner_changed',
    );
    await rejected(
      f.store.applyInput({ ...f.write, commandId: 'stale', kind: 'steer', runId: 'other' }),
      'input_target_changed',
    );
    f.db.run("UPDATE session SET context_selection_id='new-selection' WHERE id='s'");
    await rejected(f.apply('stale'), 'context_selection_changed');
    expect(await f.store.listMessages('s')).toHaveLength(before);
    await f.store.rejectCommand({
      ...f.write,
      commandId: 'stale',
      reason: 'context_selection_changed',
    });
    expect(
      (await f.store.listPendingInputs({ expectedStoreId: f.expectedStoreId, sessionId: 's' }))
        .commands,
    ).toHaveLength(0);
    expect((await f.store.getCommand('stale'))?.request).toMatchObject({
      contextSelectionId: f.contextSelectionId,
    });
    f.db.run(
      "INSERT INTO session(id,workspace_id,parent_id,root_id,title,context_selection_id) VALUES('child','w','s','s','child','child-selection')",
    );
    await rejected(
      f.store.acceptCommand({
        ...f.base,
        sessionId: 'child',
        commandId: 'child-input',
        request: {
          kind: 'input.follow_up',
          content: 'no public mutation',
          afterRunId: null,
          contextSelectionId: 'child-selection',
        },
      }),
      'group_root_required',
    );
    expect(await f.store.getCommand('child-input')).toBeNull();
  } finally {
    await f.cleanup();
  }
});
test('real message transaction fault and INT64 exhaustion roll back input/Run/supersession atomically; readonly pending keysets are lossless', async () => {
  const f = await fixture();
  let readonly: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    await f.plan('old-tool');
    await f.steer('atomic');
    f.db.exec(
      "CREATE TRIGGER input_fault BEFORE INSERT ON message_part BEGIN SELECT RAISE(ABORT,'fault'); END",
    );
    let failed = false;
    try {
      await f.apply('atomic');
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect((await f.store.getCommand('atomic'))?.status).toBe('accepted');
    expect((await f.store.getExecution('old-tool'))?.status).toBe('planned');
    expect(await f.store.listMessages('s')).toHaveLength(1);
    f.db.exec('DROP TRIGGER input_fault');
    await f.store.cancelCommand({
      ...f.base,
      commandId: 'cancel-atomic',
      targetCommandId: 'atomic',
    });
    await f.store.finishExecution({
      ...f.write,
      executionId: 'old-tool',
      status: 'cancelled',
      result: { outcome: 'cancelled', content: 'fixture' },
    });
    await f.follow('next');
    await f.finish();
    f.db.exec(
      "CREATE TRIGGER follow_fault BEFORE INSERT ON message_part BEGIN SELECT RAISE(ABORT,'fault'); END",
    );
    failed = false;
    try {
      await f.store.applyInput({
        ...f.write,
        commandId: 'next',
        kind: 'follow_up',
        configuration: {},
      });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(
      f.db.query("SELECT count(*) AS n FROM run WHERE origin_command_id='next'").get(),
    ).toEqual({ n: 0 });
    expect((await f.store.getCommand('next'))?.status).toBe('accepted');
    f.db.exec('DROP TRIGGER follow_fault');
    await f.store.cancelCommand({ ...f.base, commandId: 'cancel-next', targetCommandId: 'next' });
    await f.store.acceptCommand({
      ...f.base,
      commandId: 'fresh',
      request: { kind: 'run.start', content: 'fresh' },
    });
    const fresh = await f.store.startRun({ ...f.write, commandId: 'fresh', configuration: {} });
    f.db.exec("UPDATE session SET next_seq=9223372036854775806 WHERE id='s'");
    const maximum = await f.store.acceptCommand({
      ...f.base,
      commandId: 'max',
      request: {
        kind: 'input.steer',
        content: 'max',
        targetRunId: fresh.id,
        contextSelectionId: f.contextSelectionId,
      },
    });
    expect(maximum.seq).toBe('9223372036854775807');
    await rejected(
      f.store.applyInput({ ...f.write, commandId: 'max', kind: 'steer', runId: fresh.id }),
      'sequence_exhausted',
    );
    expect((await f.store.getCommand('max'))?.status).toBe('accepted');
    expect(
      f.db
        .query(
          "SELECT count(*) AS n FROM message WHERE json_extract(source_json,'$.originCommandId')='max'",
        )
        .get(),
    ).toEqual({ n: 0 });
    readonly = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    const cursor = (await readonly.getMetadata()).lastChangeCursor;
    expect(
      (
        await readonly.listPendingInputs({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          afterSeq: '9007199254740993',
        })
      ).commands.map((c) => c.seq),
    ).toEqual(['9223372036854775807']);
    expect((await readonly.getMetadata()).lastChangeCursor).toBe(cursor);
    await rejected(
      readonly.applyInput({ ...f.write, commandId: 'max', kind: 'steer', runId: fresh.id }),
      'owner_changed',
    );
  } finally {
    await readonly?.close();
    await f.cleanup();
  }
});

test('large trusted follow-up configuration is saved whole and repeated application only returns the original fact', async () => {
  const f = await fixture();
  let readonly: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  const body =
    'FOLLOW CONFIG BEGIN ' + 'f'.repeat(1024 * 1024 + 4096) + ' FOLLOW CONFIG VERIFIED TAIL';
  const configuration = { modelId: 'next', snapshot: { body } };
  try {
    await f.follow('large-follow');
    await f.finish();
    const input = {
      ...f.write,
      commandId: 'large-follow',
      kind: 'follow_up' as const,
      configuration,
    };
    const applied = await f.store.applyInput(input);
    expect(applied.run.configuration).toEqual(configuration);
    expect((applied.run.configuration as typeof configuration).snapshot.body).toEndWith(
      'FOLLOW CONFIG VERIFIED TAIL',
    );
    expect(applied.run.originCommandId).toBe('large-follow');
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    expect(await f.store.applyInput(input)).toEqual(applied);
    // An already-applied input is a fact lookup; a later host argument cannot replace its configuration.
    expect(
      await f.store.applyInput({
        ...input,
        configuration: { ...configuration, snapshot: { body: body + 'changed' } },
      }),
    ).toEqual(applied);
    expect((await f.store.getRun(applied.run.id))?.configuration).toEqual(configuration);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(
      (await f.store.getView('s')).runs.filter((run) => run.originCommandId === 'large-follow'),
    ).toHaveLength(1);
    await f.store.close();
    readonly = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    const coldCursor = (await readonly.getMetadata()).lastChangeCursor;
    expect((await readonly.getRun(applied.run.id))?.configuration).toEqual(configuration);
    expect((await readonly.getCommand('large-follow'))?.receipt).toEqual(applied.command.receipt);
    expect((await readonly.getMetadata()).storeId).toBe(f.expectedStoreId);
    expect((await readonly.getMetadata()).lastChangeCursor).toBe(coldCursor);
  } finally {
    await readonly?.close();
    await f.cleanup();
  }
});
