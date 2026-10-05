import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function setup(dispatch = true) {
  const dataRoot = mkdtempSync('/private/tmp/kite-store-extension-');
  chmodSync(dataRoot, 0o700);
  const store = await openSqliteStore({ dataRoot, profile: 'test' });
  cleanups.push(async () => {
    await store.close();
    rmSync(dataRoot, { recursive: true, force: true });
  });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({ expectedStoreId, id: 'w', rootUri: 'file:///fixture', name: 'w' });
  await store.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 's',
    subjectId: 'user',
  });
  await store.acceptCommand({
    expectedStoreId,
    commandId: 'action',
    sessionId: 's',
    subjectId: 'user',
    request: {
      kind: 'extension.invoke',
      extensionId: 'test',
      actionId: 'run',
      definitionVersion: '1',
      input: { user: 'input' },
    },
  });
  const owner = (await store.acquireSessionOwner('s', 'owner'))!;
  const input = { prepared: 'description' };
  const source = {
    kind: 'action_decision',
    commandId: 'action',
    extensionId: 'test',
    actionId: 'run',
    definitionVersion: '1',
    preparedDigest: await semanticDigest(input),
  };
  await store.planAction({
    expectedStoreId,
    owner,
    commandId: 'action',
    executionId: 'parent',
    extensionId: 'test',
    definitionId: 'test/run',
    definitionVersion: '1',
    input,
    decisionSource: source,
  });
  if (dispatch)
    await store.markDispatching({
      expectedStoreId,
      owner,
      executionId: 'parent',
      authorization: {
        allowed: true,
        revision: '0',
        definitionVersion: '1',
        inputDigest: await semanticDigest(input),
      },
      requirements: [],
      freshness: { checked: true, source },
    });
  return { store, dataRoot, expectedStoreId, owner, source };
}
async function reject(promise: Promise<unknown>, code: string) {
  let caught = false;
  try {
    await promise;
  } catch (error) {
    caught = true;
    expect((error as { code: string }).code).toBe(code);
  }
  expect(caught).toBe(true);
}
test('runless Action and controlled tool persist without any fabricated Run', async () => {
  const { store, expectedStoreId, owner, source } = await setup();
  const operation = await store.ensureOperation({
    expectedStoreId,
    owner,
    extensionId: 'test',
    sessionId: 's',
    originCommandId: 'action',
    parentExecutionId: 'parent',
    operationKey: 'count',
    request: {
      kind: 'tool',
      definitionId: 'test/count',
      definitionVersion: '1',
      input: { value: 1 },
    },
  });
  expect(operation.executionId).toBeNull();
  const same = await store.ensureOperation({
    expectedStoreId,
    owner,
    extensionId: 'test',
    sessionId: 's',
    originCommandId: 'action',
    parentExecutionId: 'parent',
    operationKey: 'count',
    request: {
      kind: 'tool',
      definitionId: 'test/count',
      definitionVersion: '1',
      input: { value: 1 },
    },
  });
  expect(same.commandId).toBe(operation.commandId);
  await store.planExecution({
    expectedStoreId,
    owner,
    executionId: 'child',
    sessionId: 's',
    runId: null,
    kind: 'tool',
    parentExecutionId: 'parent',
    originCommandId: operation.commandId,
    stepId: 'action',
    callId: 'count',
    definitionId: 'test/count',
    definitionVersion: '1',
    input: { value: 1 },
    decisionSource: source,
  });
  await store.markDispatching({
    expectedStoreId,
    owner,
    executionId: 'child',
    authorization: {
      allowed: true,
      revision: '0',
      definitionVersion: '1',
      inputDigest: await semanticDigest({ value: 1 }),
    },
    requirements: [],
    freshness: { checked: true, source },
  });
  await store.finishExecution({
    expectedStoreId,
    owner,
    executionId: 'child',
    status: 'succeeded',
    result: { count: 1 },
  });
  await store.applyExtensionAction({
    expectedStoreId,
    owner,
    executionId: 'parent',
    extensionId: 'test',
    status: 'succeeded',
    result: { summary: 'done' },
    writes: [
      {
        key: 'result',
        expectedRevision: null,
        contentType: 'test.result',
        contentVersion: 1,
        value: { count: 1 },
      },
    ],
  });
  expect((await store.getView('s')).runs).toHaveLength(0);
  expect(
    (await store.getExtensionRecord({ extensionId: 'test', sessionId: 's', key: 'result' }))?.value,
  ).toEqual({ count: 1 });
  expect(
    (
      await store.getOperation({
        extensionId: 'test',
        sessionId: 's',
        key: 'count',
        subjectId: 'user',
        originStoreId: expectedStoreId,
      })
    )?.executionId,
  ).toBe('child');
});
test('record CAS preserves immutable executable origin and action commit rolls back every write', async () => {
  const { store, dataRoot, expectedStoreId, owner } = await setup();
  const scope = {
    expectedStoreId,
    owner,
    extensionId: 'test',
    sessionId: 's',
    originCommandId: 'action',
  };
  const plan = await store.writeExtensionRecord({
    ...scope,
    write: {
      key: 'plan',
      expectedRevision: null,
      contentType: 'test.plan',
      contentVersion: 1,
      value: {},
      executable: true,
    },
  });
  expect(plan.originStoreId).toBe(expectedStoreId);
  await reject(
    store.writeExtensionRecord({
      ...scope,
      write: {
        key: 'plan',
        expectedRevision: null,
        contentType: 'test.plan',
        contentVersion: 1,
        value: {},
      },
    }),
    'record_revision_conflict',
  );
  const updated = await store.writeExtensionRecord({
    ...scope,
    write: {
      key: 'plan',
      expectedRevision: '1',
      contentType: 'test.plan',
      contentVersion: 1,
      value: { updated: true },
    },
  });
  expect(updated.originStoreId).toBe(expectedStoreId);
  const db = new Database(join(dataRoot, 'test', 'core.db'));
  db.exec(
    "CREATE TRIGGER fail_action BEFORE INSERT ON change_event WHEN NEW.type='action.finished' BEGIN SELECT RAISE(ABORT,'action commit fault'); END",
  );
  try {
    await store.applyExtensionAction({
      expectedStoreId,
      owner,
      executionId: 'parent',
      extensionId: 'test',
      status: 'succeeded',
      result: {},
      writes: [
        {
          key: 'rolledback',
          expectedRevision: null,
          contentType: 'test.result',
          contentVersion: 1,
          value: {},
        },
      ],
    });
    throw new Error('Expected rollback');
  } catch (error) {
    expect(String(error)).toContain('action commit fault');
  }
  expect(
    await store.getExtensionRecord({ extensionId: 'test', sessionId: 's', key: 'rolledback' }),
  ).toBeNull();
  expect((await store.getExecution('parent'))?.status).toBe('dispatching');
  db.exec('DROP TRIGGER fail_action');
  db.close();
});
test('logical operation conflicts and restored executable plan missing key cannot create work', async () => {
  const { store, dataRoot, expectedStoreId, owner } = await setup();
  const input = {
    expectedStoreId,
    owner,
    extensionId: 'test',
    sessionId: 's',
    originCommandId: 'action',
    parentExecutionId: 'parent',
    operationKey: 'same',
    request: { kind: 'tool' as const, definitionId: 'count', definitionVersion: '1', input: {} },
  };
  await store.ensureOperation(input);
  await reject(
    store.ensureOperation({ ...input, request: { ...input.request, input: { different: true } } }),
    'operation_conflict',
  );
  await store.writeExtensionRecord({
    expectedStoreId,
    owner,
    extensionId: 'test',
    sessionId: 's',
    originCommandId: 'action',
    write: {
      key: 'old-plan',
      expectedRevision: null,
      contentType: 'test.plan',
      contentVersion: 1,
      value: {},
      executable: true,
    },
  });
  const db = new Database(join(dataRoot, 'test', 'core.db'));
  db.run("UPDATE extension_record SET origin_store_id='old-store' WHERE key='old-plan'");
  db.close();
  const before = (await store.listAcceptedCommands('s')).length;
  await reject(
    store.ensureOperation({ ...input, operationKey: 'missing', planRecordKey: 'old-plan' }),
    'operation_unverifiable',
  );
  expect(await store.listAcceptedCommands('s')).toHaveLength(before);
  expect(
    await store.getOperation({
      extensionId: 'test',
      sessionId: 's',
      key: 'missing',
      subjectId: 'user',
      originStoreId: 'old-store',
    }),
  ).toBeNull();
});

test('Action refresh creates a new immutable attempt and binds its fresh authorization', async () => {
  const { store, expectedStoreId, owner, source } = await setup(false);
  const finish = {
    expectedStoreId,
    owner,
    executionId: 'parent',
    extensionId: 'test',
    status: 'failed' as const,
    preparingNextAttempt: true,
    result: { details: { code: 'context_refresh_required', adapterAttempted: false } },
  };
  await store.applyExtensionAction(finish);
  expect((await store.getCommand('action'))?.receipt).toMatchObject({
    executionId: 'parent',
    preparingNextAttempt: true,
  });
  await reject(
    store.applyExtensionAction({ ...finish, preparingNextAttempt: false }),
    'terminal_conflict',
  );
  const input = { prepared: 'fresh description' };
  const nextSource = { ...source, preparedDigest: await semanticDigest(input) };
  const plan = {
    expectedStoreId,
    owner,
    commandId: 'action',
    executionId: 'next',
    extensionId: 'test',
    definitionId: 'test/run',
    definitionVersion: '1',
    input,
    decisionSource: nextSource,
    predecessorExecutionId: 'parent',
    attempt: 2,
  };
  const next = await store.planAction(plan);
  expect(next.attempt).toBe(2);
  expect((await store.planAction(plan)).id).toBe('next');
  await reject(store.planAction({ ...plan, input: { changed: true } }), 'action_source_conflict');
  await reject(store.planAction({ ...plan, attempt: 3 }), 'action_intent_conflict');
  await reject(
    store.planAction({ ...plan, predecessorExecutionId: 'missing' }),
    'action_intent_conflict',
  );
  expect((await store.getExecution('parent'))?.decisionSource).toEqual(source);
  expect((await store.getExecution('parent'))?.input).toEqual({ prepared: 'description' });
  await store.applyExtensionAction(finish);
  expect((await store.getCommand('action'))?.receipt).toEqual({
    executionId: 'next',
    preparingNextAttempt: false,
  });
  await reject(store.planAction({ ...plan, executionId: 'other' }), 'action_attempt_conflict');
  await reject(
    store.markDispatching({
      expectedStoreId,
      owner,
      executionId: 'next',
      requirements: [],
      authorization: {
        allowed: true,
        revision: '0',
        definitionVersion: '1',
        inputDigest: source.preparedDigest,
      },
      freshness: { checked: true, source: nextSource },
    }),
    'permission_denied',
  );
  await store.markDispatching({
    expectedStoreId,
    owner,
    executionId: 'next',
    requirements: [],
    authorization: {
      allowed: true,
      revision: '0',
      definitionVersion: '1',
      inputDigest: nextSource.preparedDigest,
    },
    freshness: { checked: true, source: nextSource },
  });
  await store.applyExtensionAction({
    ...finish,
    executionId: 'next',
    status: 'succeeded',
    preparingNextAttempt: false,
    result: { done: true },
  });
  expect((await store.getCommand('action'))?.receipt).toMatchObject({
    executionId: 'next',
    status: 'succeeded',
  });
  expect((await store.getView('s')).runs).toHaveLength(0);
});
test('Action arbitrary failure, dispatched failure, unknown outcome and cancellation forbid refresh', async () => {
  for (const mode of ['failure', 'dispatched', 'unknown', 'cancelled']) {
    const { store, expectedStoreId, owner, source } = await setup(
      mode === 'dispatched' || mode === 'unknown',
    );
    await store.applyExtensionAction({
      expectedStoreId,
      owner,
      executionId: 'parent',
      extensionId: 'test',
      status: mode === 'unknown' ? 'outcome_unknown' : 'failed',
      result: {
        details: {
          code: mode === 'failure' ? 'arbitrary' : 'context_refresh_required',
          adapterAttempted: false,
        },
      },
    });
    if (mode === 'cancelled')
      await store.cancelCommand({
        expectedStoreId,
        sessionId: 's',
        commandId: 'cancel',
        targetCommandId: 'action',
        subjectId: 'user',
      });
    await reject(
      store.planAction({
        expectedStoreId,
        owner,
        commandId: 'action',
        executionId: 'next',
        extensionId: 'test',
        definitionId: 'test/run',
        definitionVersion: '1',
        input: { prepared: 'description' },
        decisionSource: source,
        predecessorExecutionId: 'parent',
        attempt: 2,
      }),
      mode === 'cancelled' ? 'cancelled_before_dispatch' : 'action_attempt_conflict',
    );
    expect(await store.getExecution('next')).toBeNull();
  }
});
test('orphan accepted operation can persist needs review without remaining pump work', async () => {
  const { store, expectedStoreId, owner } = await setup();
  const operation = await store.ensureOperation({
    expectedStoreId,
    owner,
    extensionId: 'test',
    sessionId: 's',
    originCommandId: 'action',
    parentExecutionId: 'parent',
    operationKey: 'orphan',
    request: { kind: 'tool', definitionId: 'test/tool', definitionVersion: '1', input: {} },
  });
  expect(
    (
      await store.rejectCommand({
        expectedStoreId,
        owner,
        commandId: operation.commandId,
        reason: 'operation_unverifiable',
        needsReview: true,
      })
    ).status,
  ).toBe('needs_review');
  expect(await store.listAcceptedCommands('s')).toHaveLength(0);
});

test('preparing next attempt flag rejects dispatched and unrelated terminal results', async () => {
  for (const dispatched of [true, false]) {
    const { store, expectedStoreId, owner } = await setup(dispatched);
    await reject(
      store.applyExtensionAction({
        expectedStoreId,
        owner,
        executionId: 'parent',
        extensionId: 'test',
        status: 'failed',
        preparingNextAttempt: true,
        result: {
          details: {
            code: dispatched ? 'context_refresh_required' : 'arbitrary',
            adapterAttempted: false,
          },
        },
      }),
      'action_attempt_conflict',
    );
    expect((await store.getExecution('parent'))?.status).toBe(
      dispatched ? 'dispatching' : 'planned',
    );
    expect((await store.getCommand('action'))?.receipt).toMatchObject({
      preparingNextAttempt: false,
    });
  }
});

test('stopping Action preparation clears pending receipt without rewriting the old finalization', async () => {
  for (const cancelled of [false, true]) {
    const { store, expectedStoreId, owner } = await setup(false);
    const finish = {
      expectedStoreId,
      owner,
      executionId: 'parent',
      extensionId: 'test',
      status: 'failed' as const,
      preparingNextAttempt: true,
      result: { details: { code: 'context_refresh_required', adapterAttempted: false } },
    };
    await store.applyExtensionAction(finish);
    const old = await store.getExecution('parent');
    const input = {
      expectedStoreId,
      owner,
      commandId: 'action',
      predecessorExecutionId: 'parent',
      reason: 'prepare_failed',
      cancelled,
    };
    const stopped = await store.stopActionPreparation(input);
    expect(stopped.status).toBe(cancelled ? 'applied' : 'needs_review');
    expect(stopped.receipt).toMatchObject({
      preparingNextAttempt: false,
      status: cancelled ? 'cancelled' : 'needs_review',
    });
    expect(await store.stopActionPreparation(input)).toEqual(stopped);
    expect(await store.getExecution('parent')).toEqual(old);
    await reject(
      store.stopActionPreparation({ ...input, reason: 'different' }),
      'action_attempt_conflict',
    );
    await store.applyExtensionAction(finish);
    expect(await store.getCommand('action')).toEqual(stopped);
  }
});
