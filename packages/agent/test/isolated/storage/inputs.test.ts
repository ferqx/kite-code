import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
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
  const dataRoot = temporaryDirectory('kite-inputs-');
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

test('ordinary starts seal input provenance in each message before Run observation and preserve it cold', async () => {
  const f = await fixture();
  try {
    await f.finish();
    await f.store.acceptCommand({
      ...f.base,
      commandId: 'second-work',
      request: { kind: 'run.start', content: 'original' },
    });
    const second = await f.store.startRun({
      ...f.write,
      commandId: 'second-work',
      configuration: {},
    });
    const expected = [
      { runId: f.run.id, originCommandId: 'work', sourceIds: ['work'], content: 'original' },
      {
        runId: second.id,
        originCommandId: 'second-work',
        sourceIds: ['second-work'],
        content: 'original',
      },
    ];
    expect(await f.store.listMessages('s')).toMatchObject(expected);
    await f.store.startRun({ ...f.write, commandId: 'second-work', configuration: {} });
    expect(await f.store.listMessages('s')).toHaveLength(2);
    await f.store.close();
    const cold = await openSqliteStore(f.profile);
    try {
      expect(await cold.listMessages('s')).toMatchObject(expected);
      expect((await cold.getView('s')).messages).toMatchObject(expected);
    } finally {
      await cold.close();
    }
  } finally {
    await f.cleanup();
  }
});

test('message first-publication time survives streamed updates, finalization and cold reads; legacy time requires complete original logs', async () => {
  const before = Date.now();
  const f = await fixture();
  try {
    const user = (await f.store.listMessages('s'))[0]!;
    expect(user.createdAt).toBeGreaterThanOrEqual(before);
    expect(user.createdAt).toBeLessThanOrEqual(Date.now());
    await f.plan('message-time-model', 'model');
    await dispatch(f, 'message-time-model');
    await f.store.persistModelPartial({
      ...f.write,
      executionId: 'message-time-model',
      content: 'first',
    });
    const partialId = 'partial_message-time-model';
    const first = (await f.store.listMessages('s')).find((message) => message.id === partialId)!;
    expect(first.createdAt).toBeGreaterThanOrEqual(before);
    f.db
      .query("UPDATE message SET source_json=json_set(source_json,'$.createdAt',42) WHERE id=?")
      .run(partialId);
    await f.store.persistModelPartial({
      ...f.write,
      executionId: 'message-time-model',
      content: 'first and second',
    });
    expect(
      (await f.store.listMessages('s')).find((message) => message.id === partialId)?.createdAt,
    ).toBe(42);
    await f.store.finishExecution({
      ...f.write,
      executionId: 'message-time-model',
      status: 'succeeded',
      result: {},
      message: { role: 'assistant', content: 'final reply', sourceIds: ['message-time-model'] },
    });
    expect(
      (await f.store.getView('s')).messages.find((message) => message.id === partialId),
    ).toMatchObject({ content: 'final reply', status: 'complete', createdAt: 42 });
    f.db
      .query("UPDATE message SET source_json=json_remove(source_json,'$.createdAt') WHERE id=?")
      .run(user.id);
    const event = f.db
      .query(
        "SELECT payload_json FROM change_event WHERE object_id=? AND type='message.updated' ORDER BY cursor LIMIT 1",
      )
      .get(user.id) as { payload_json: string };
    expect(
      (await f.store.listMessages('s')).find((message) => message.id === user.id)?.createdAt,
    ).toBe(JSON.parse(event.payload_json).occurredAt);
    f.db
      .query(
        "UPDATE change_event SET payload_json='null' WHERE cursor=(SELECT MIN(cursor) FROM change_event WHERE object_id=? AND type='message.updated')",
      )
      .run(user.id);
    expect(
      (await f.store.listMessages('s')).find((message) => message.id === user.id)?.createdAt,
    ).toBeUndefined();
    f.db
      .query(
        "UPDATE change_event SET payload_json=? WHERE cursor=(SELECT MIN(cursor) FROM change_event WHERE object_id=? AND type='message.updated')",
      )
      .run('{malformed', user.id);
    const legacyExpected = { ...user };
    delete legacyExpected.createdAt;
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    expect((await f.store.listMessages('s')).find((message) => message.id === user.id)).toEqual(
      legacyExpected,
    );
    expect((await f.store.getView('s')).messages.find((message) => message.id === user.id)).toEqual(
      legacyExpected,
    );
    expect((await f.store.getMessageOrigin({ ...f.base, messageId: user.id })).message).toEqual(
      legacyExpected,
    );
    await rejected(
      f.store.getMessageOrigin({ ...f.base, subjectId: 'foreign', messageId: user.id }),
      'permission_denied',
    );
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect((await cold.listMessages('s')).find((message) => message.id === user.id)).toEqual(
        legacyExpected,
      );
      expect((await cold.getMetadata()).lastChangeCursor).toBe(cursor);
    } finally {
      await cold.close();
    }
    f.db
      .query(
        "UPDATE change_event SET payload_json=? WHERE cursor=(SELECT MIN(cursor) FROM change_event WHERE object_id=? AND type='message.updated')",
      )
      .run(event.payload_json, user.id);
    f.db.run('UPDATE storage_meta SET replay_floor=1 WHERE singleton=1');
    expect(
      (await f.store.listMessages('s')).find((message) => message.id === user.id)?.createdAt,
    ).toBeUndefined();
    expect(
      (await f.store.listMessages('s')).find((message) => message.id === partialId)?.createdAt,
    ).toBe(42);
    await f.store.close();
    const reopened = await openSqliteStore(f.profile);
    try {
      expect(
        (await reopened.listMessages('s')).find((message) => message.id === partialId)?.createdAt,
      ).toBe(42);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.cleanup();
  }
});
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

test('pending queue reorder preserves command provenance, CAS pages and actual steer consumption; cold readers see persisted order', async () => {
  const f = await fixture();
  try {
    await f.steer('qa');
    await f.steer('qb');
    await f.steer('qc');
    const originals = await Promise.all(['qa', 'qb', 'qc'].map((id) => f.store.getCommand(id)));
    const query = { expectedStoreId: f.expectedStoreId, sessionId: 's' };
    const before = await f.store.getPendingInputQueue(query);
    const operation = {
      ...f.base,
      kind: 'input.reorder' as const,
      commandId: 'reorder',
      expectedRevision: before.revision,
      commandIds: ['qc', 'qa', 'qb'],
    };
    const changed = await f.store.reorderPendingInputs(operation);
    expect(changed.status).toBe('applied');
    expect((await f.store.reorderPendingInputs(operation)).id).toBe(changed.id);
    const first = await f.store.getPendingInputQueue({ ...query, limit: 1 });
    expect(first.commands.map((c) => c.id)).toEqual(['qc']);
    const rest = await f.store.getPendingInputQueue({
      ...query,
      afterOrder: first.nextAfterOrder!,
      expectedRevision: first.revision,
    });
    expect(rest.commands.map((c) => c.id)).toEqual(['qa', 'qb']);
    await rejected(f.apply('qa'), 'input_order_conflict');
    await f.apply('qc');
    await rejected(
      f.store.getPendingInputQueue({ ...query, expectedRevision: first.revision }),
      'input_queue_changed',
    );
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect((await cold.getPendingInputQueue(query)).commands.map((c) => c.id)).toEqual([
        'qa',
        'qb',
      ]);
    } finally {
      await cold.close();
    }
    await f.apply('qa');
    await f.apply('qb');
    for (let i = 0; i < originals.length; i++) {
      const now = await f.store.getCommand(originals[i]!.id);
      expect(now!.seq).toBe(originals[i]!.seq);
      expect(now!.requestDigest).toBe(originals[i]!.requestDigest);
      expect(now!.request).toEqual(originals[i]!.request);
    }
    expect(
      (await f.store.listMessages('s'))
        .filter((m) => m.inputKind === 'input.steer')
        .map((m) => m.content),
    ).toEqual(['qc', 'qa', 'qb']);
  } finally {
    await f.cleanup();
  }
});

test('withdraw is an atomic pending-only operation and never cancels consumed work or its Run', async () => {
  const f = await fixture();
  try {
    const query = { expectedStoreId: f.expectedStoreId, sessionId: 's' };
    await f.steer('withdraw-me');
    const operation = {
      ...f.base,
      kind: 'input.withdraw' as const,
      commandId: 'withdraw',
      targetCommandId: 'withdraw-me',
      expectedRevision: (await f.store.getPendingInputQueue(query)).revision,
    };
    const receipt = await f.store.withdrawPendingInput(operation);
    expect(receipt.receipt).toEqual({ outcome: 'input_withdrawn', targetCommandId: 'withdraw-me' });
    expect((await f.store.withdrawPendingInput(operation)).id).toBe(receipt.id);
    expect((await f.store.getPendingInputQueue(query)).commands).toHaveLength(0);
    await rejected(f.apply('withdraw-me'), 'input_cancelled');
    expect(
      (await f.store.listMessages('s')).filter((m) => m.inputKind === 'input.steer'),
    ).toHaveLength(0);
    expect((await f.store.getRun(f.run.id))!.isActive).toBe(true);
    await f.steer('consumed');
    const before = await f.store.getPendingInputQueue(query);
    await f.apply('consumed');
    await rejected(
      f.store.withdrawPendingInput({
        ...operation,
        commandId: 'late',
        targetCommandId: 'consumed',
        expectedRevision: before.revision,
      }),
      'input_already_consumed',
    );
    expect(
      f.db
        .query<{ cancel_requested: number }, [string]>(
          'SELECT cancel_requested FROM run WHERE id=?',
        )
        .get(f.run.id)!.cancel_requested,
    ).toBe(0);
    expect((await f.store.getCommand('consumed'))!.cancelRequestedAt).toBeNull();
    expect(await f.store.getCommand('late')).toBeNull();
  } finally {
    await f.cleanup();
  }
});

test('follow-up uses the same persisted queue order and refuses a stale pre-reorder dispatch', async () => {
  const f = await fixture();
  try {
    await f.follow('next-a');
    await f.follow('next-b');
    const query = { expectedStoreId: f.expectedStoreId, sessionId: 's' };
    const queue = await f.store.getPendingInputQueue(query);
    await f.store.reorderPendingInputs({
      ...f.base,
      kind: 'input.reorder',
      commandId: 'move-next',
      expectedRevision: queue.revision,
      commandIds: ['next-b', 'next-a'],
    });
    await f.finish();
    await rejected(
      f.store.applyInput({ ...f.write, kind: 'follow_up', commandId: 'next-a', configuration: {} }),
      'input_order_conflict',
    );
    const first = await f.store.applyInput({
      ...f.write,
      kind: 'follow_up',
      commandId: 'next-b',
      configuration: {},
    });
    expect(first.message.content).toBe('next-b');
    const stale = (await f.store.getPendingInputQueue(query)).revision;
    await rejected(
      f.store.withdrawPendingInput({
        ...f.base,
        kind: 'input.withdraw',
        commandId: 'late-follow-withdraw',
        targetCommandId: 'next-b',
        expectedRevision: stale,
      }),
      'input_already_consumed',
    );
    expect((await f.store.getRun(first.run.id))!.isActive).toBe(true);
    expect(
      f.db
        .query<{ cancel_requested: number }, [string]>(
          'SELECT cancel_requested FROM run WHERE id=?',
        )
        .get(first.run.id)!.cancel_requested,
    ).toBe(0);
    await f.store.finishRun({
      ...f.write,
      runId: first.run.id,
      status: 'completed',
      requirements: [],
    });
    expect(
      (
        await f.store.applyInput({
          ...f.write,
          kind: 'follow_up',
          commandId: 'next-a',
          configuration: {},
        })
      ).message.content,
    ).toBe('next-a');
  } finally {
    await f.cleanup();
  }
});

test('concurrent withdrawal and consumption serialize to one fact, with zero Run cancellation', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 8; index++) {
      const id = `race-${index}`;
      await f.steer(id);
      const revision = (
        await f.store.getPendingInputQueue({ expectedStoreId: f.expectedStoreId, sessionId: 's' })
      ).revision;
      const results = await Promise.allSettled([
        f.store.withdrawPendingInput({
          ...f.base,
          kind: 'input.withdraw',
          commandId: `withdraw-${index}`,
          targetCommandId: id,
          expectedRevision: revision,
        }),
        f.apply(id),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const command = await f.store.getCommand(id);
      expect(['applied', 'rejected']).toContain(command!.status);
      const messages = (await f.store.listMessages('s')).filter(
        (message) => message.originCommandId === id,
      );
      expect(messages).toHaveLength(command!.status === 'applied' ? 1 : 0);
      expect(
        f.db
          .query<{ cancel_requested: number }, [string]>(
            'SELECT cancel_requested FROM run WHERE id=?',
          )
          .get(f.run.id)!.cancel_requested,
      ).toBe(0);
    }
  } finally {
    await f.cleanup();
  }
});

test('queue revision cannot ABA and incorrect members, subjects, Store or child do not change pending work', async () => {
  const f = await fixture();
  try {
    await f.steer('stable-a');
    await f.steer('stable-b');
    const query = { expectedStoreId: f.expectedStoreId, sessionId: 's' };
    const original = await f.store.getPendingInputQueue(query);
    await f.store.reorderPendingInputs({
      ...f.base,
      kind: 'input.reorder',
      commandId: 'reverse',
      expectedRevision: original.revision,
      commandIds: ['stable-b', 'stable-a'],
    });
    const reverse = await f.store.getPendingInputQueue(query);
    await f.store.reorderPendingInputs({
      ...f.base,
      kind: 'input.reorder',
      commandId: 'restore-order',
      expectedRevision: reverse.revision,
      commandIds: ['stable-a', 'stable-b'],
    });
    const restored = await f.store.getPendingInputQueue(query);
    expect(restored.commands.map((c) => c.id)).toEqual(original.commands.map((c) => c.id));
    expect(restored.revision).not.toBe(original.revision);
    await rejected(
      f.store.reorderPendingInputs({
        ...f.base,
        kind: 'input.reorder',
        commandId: 'stale-aba',
        expectedRevision: original.revision,
        commandIds: ['stable-b', 'stable-a'],
      }),
      'input_queue_changed',
    );
    await rejected(
      f.store.reorderPendingInputs({
        ...f.base,
        kind: 'input.reorder',
        commandId: 'duplicates',
        expectedRevision: restored.revision,
        commandIds: ['stable-a', 'stable-a'],
      }),
      'input_queue_members_changed',
    );
    const withdraw = {
      ...f.base,
      kind: 'input.withdraw' as const,
      commandId: 'untrusted',
      expectedRevision: restored.revision,
      targetCommandId: 'stable-a',
    };
    await rejected(
      f.store.withdrawPendingInput({ ...withdraw, subjectId: 'other' }),
      'permission_denied',
    );
    await rejected(
      f.store.withdrawPendingInput({ ...withdraw, expectedStoreId: 'other' }),
      'store_identity_mismatch',
    );
    f.db.run("UPDATE session SET parent_id='s' WHERE id='s'");
    await rejected(f.store.getPendingInputQueue(query), 'group_root_required');
    await rejected(f.store.withdrawPendingInput(withdraw), 'group_root_required');
    f.db.run("UPDATE session SET parent_id=NULL WHERE id='s'");
    expect((await f.store.getPendingInputQueue(query)).revision).toBe(restored.revision);
  } finally {
    await f.cleanup();
  }
});

test('concurrent reorder and consumption use one order and failed withdrawal publication rolls back', async () => {
  const f = await fixture();
  try {
    const query = { expectedStoreId: f.expectedStoreId, sessionId: 's' };
    for (let index = 0; index < 4; index++) {
      const a = `order-race-a-${index}`,
        b = `order-race-b-${index}`;
      await f.steer(a);
      await f.steer(b);
      const revision = (await f.store.getPendingInputQueue(query)).revision;
      const [reorder, apply] = await Promise.allSettled([
        f.store.reorderPendingInputs({
          ...f.base,
          kind: 'input.reorder',
          commandId: `order-race-${index}`,
          expectedRevision: revision,
          commandIds: [b, a],
        }),
        f.apply(a),
      ]);
      expect([reorder, apply].filter((item) => item.status === 'fulfilled')).toHaveLength(1);
      if (reorder.status === 'fulfilled') {
        expect(
          (await f.store.getPendingInputQueue(query)).commands.map((command) => command.id),
        ).toEqual([b, a]);
        await f.apply(b);
        await f.apply(a);
      } else {
        expect(
          (await f.store.getPendingInputQueue(query)).commands.map((command) => command.id),
        ).toEqual([b]);
        await f.apply(b);
      }
    }
    await f.steer('rollback');
    const before = await f.store.getPendingInputQueue(query);
    f.db.run('UPDATE session SET next_seq=9223372036854775807 WHERE id=?', ['s']);
    await rejected(
      f.store.withdrawPendingInput({
        ...f.base,
        kind: 'input.withdraw',
        commandId: 'overflow-withdraw',
        targetCommandId: 'rollback',
        expectedRevision: before.revision,
      }),
      'sequence_exhausted',
    );
    expect((await f.store.getCommand('rollback'))!.status).toBe('accepted');
    expect((await f.store.getPendingInputQueue(query)).revision).toBe(before.revision);
    expect(await f.store.getCommand('overflow-withdraw')).toBeNull();
  } finally {
    await f.cleanup();
  }
});

test('queue survives closing and reopening its original Store without applying any pending input', async () => {
  const f = await fixture();
  try {
    await f.steer('cold-a');
    await f.steer('cold-b');
    const query = { expectedStoreId: f.expectedStoreId, sessionId: 's' };
    const first = await f.store.getPendingInputQueue(query);
    await f.store.reorderPendingInputs({
      ...f.base,
      kind: 'input.reorder',
      commandId: 'cold-order',
      commandIds: ['cold-b', 'cold-a'],
      expectedRevision: first.revision,
    });
    const saved = await f.store.getPendingInputQueue(query);
    await f.store.close();
    const reopened = await openSqliteStore(f.profile);
    try {
      const cold = await reopened.getPendingInputQueue({
        ...query,
        expectedRevision: saved.revision,
      });
      expect(cold).toEqual(saved);
      expect(cold.commands.map((command) => command.id)).toEqual(['cold-b', 'cold-a']);
      expect(
        (await reopened.listMessages('s')).filter((message) => message.inputKind === 'input.steer'),
      ).toHaveLength(0);
      expect((await reopened.getRun(f.run.id))!.isActive).toBe(true);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.cleanup();
  }
});

test('file-only queued inputs keep exact attachment metadata while reordering and withdrawing safely', async () => {
  const f = await fixture();
  try {
    await f.steer('text-slot');
    const files = [{ name: 'report **original**.md', uri: 'file:///fixture/report%20original.md' }];
    const attachment = await f.store.acceptCommand({
      ...f.base,
      commandId: 'file-only',
      request: {
        kind: 'input.steer',
        content: '',
        files,
        targetRunId: f.run.id,
        contextSelectionId: f.contextSelectionId,
      },
    });
    const query = { expectedStoreId: f.expectedStoreId, sessionId: 's' };
    const first = await f.store.getPendingInputQueue(query);
    await f.store.reorderPendingInputs({
      ...f.base,
      kind: 'input.reorder',
      commandId: 'file-first',
      commandIds: ['file-only', 'text-slot'],
      expectedRevision: first.revision,
    });
    const moved = await f.store.getPendingInputQueue(query);
    expect(moved.commands.map((command) => command.id)).toEqual(['file-only', 'text-slot']);
    expect(moved.commands[0]!.request).toEqual(attachment.request);
    expect(moved.commands[0]!.requestDigest).toBe(attachment.requestDigest);
    const result = await f.store.withdrawPendingInput({
      ...f.base,
      kind: 'input.withdraw',
      commandId: 'remove-file',
      targetCommandId: 'file-only',
      expectedRevision: moved.revision,
    });
    expect(result.receipt).toEqual({ outcome: 'input_withdrawn', targetCommandId: 'file-only' });
    expect((await f.store.getCommand('file-only'))!.request).toEqual(attachment.request);
    expect(
      (await f.store.getPendingInputQueue(query)).commands.map((command) => command.id),
    ).toEqual(['text-slot']);
    expect(
      (await f.store.listMessages('s')).filter(
        (message) => message.originCommandId === 'file-only',
      ),
    ).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

test('image-only queued input reorders and withdraws without losing its immutable original image reference', async () => {
  const f = await fixture();
  const runtime = createRuntime({
    store: f.store,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    artifacts: createArtifactStore({ profile: f.profile, store: f.store }),
    model: {
      stream() {
        throw Error('No Model dispatch permitted');
      },
    },
  });
  try {
    const image = await runtime.uploadInputImage({
      ...f.base,
      id: 'queue-image',
      name: 'original.png',
      mediaType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1eIAAAAASUVORK5CYII=',
    });
    await f.steer('plain-before-image');
    const original = await f.store.acceptCommand({
      ...f.base,
      commandId: 'image-only',
      request: {
        kind: 'input.steer',
        content: '',
        images: [image],
        targetRunId: f.run.id,
        contextSelectionId: f.contextSelectionId,
      },
    });
    const query = { expectedStoreId: f.expectedStoreId, sessionId: 's' };
    const first = await f.store.getPendingInputQueue(query);
    await f.store.reorderPendingInputs({
      ...f.base,
      kind: 'input.reorder',
      commandId: 'image-first',
      commandIds: ['image-only', 'plain-before-image'],
      expectedRevision: first.revision,
    });
    const moved = await f.store.getPendingInputQueue(query);
    expect(moved.commands.map((command) => command.id)).toEqual([
      'image-only',
      'plain-before-image',
    ]);
    expect(moved.commands[0]!.request).toEqual(original.request);
    expect(moved.commands[0]!.requestDigest).toBe(original.requestDigest);
    await f.store.withdrawPendingInput({
      ...f.base,
      kind: 'input.withdraw',
      commandId: 'remove-image',
      targetCommandId: 'image-only',
      expectedRevision: moved.revision,
    });
    expect((await f.store.getCommand('image-only'))!.request).toEqual(original.request);
    expect(
      (await f.store.getPendingInputQueue(query)).commands.map((command) => command.id),
    ).toEqual(['plain-before-image']);
    expect(
      (await f.store.listMessages('s')).filter(
        (message) => message.originCommandId === 'image-only',
      ),
    ).toHaveLength(0);
  } finally {
    await runtime.close();
    await f.cleanup();
  }
});

test('queue deletion trigger advances a live queue and never resurrects a cascaded Session revision', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE session(id TEXT PRIMARY KEY);
      CREATE TABLE command(id TEXT PRIMARY KEY,session_id TEXT REFERENCES session(id) ON DELETE CASCADE,
        seq INTEGER,status TEXT,kind TEXT,cancelled INTEGER,receipt_json TEXT);`);
    db.exec(
      readFileSync(
        new URL('../../../src/storage/migrations/0004-pending-input-order.sql', import.meta.url),
        'utf8',
      ),
    );
    db.run('INSERT INTO session VALUES(?)', ['cascade-root']);
    const insert = (id: string) =>
      db.run('INSERT INTO command(id,session_id,seq,status,kind,cancelled) VALUES(?,?,?,?,?,?)', [
        id,
        'cascade-root',
        1,
        'accepted',
        'input.steer',
        0,
      ]);
    insert('delete-live');
    const version = () =>
      db.query<{ revision: number }, []>('SELECT revision FROM pending_input_queue_revision').get()!
        .revision;
    expect(version()).toBe(1);
    db.run('DELETE FROM command WHERE id=?', ['delete-live']);
    expect(version()).toBe(2);
    insert('cascade-pending');
    expect(version()).toBe(3);
    db.run('DELETE FROM session WHERE id=?', ['cascade-root']);
    expect(db.query('SELECT * FROM session').all()).toHaveLength(0);
    expect(db.query('SELECT * FROM command').all()).toHaveLength(0);
    expect(db.query('SELECT * FROM pending_input_queue_revision').all()).toHaveLength(0);
    expect(db.query('PRAGMA foreign_key_check').all()).toHaveLength(0);
  } finally {
    db.close();
  }
});
