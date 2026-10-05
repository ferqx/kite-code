import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import type { RequirementEvaluation } from '../../../src/storage';
import type { EnsureOperationInput } from '../../../src/storage/port';

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
  const dataRoot = mkdtempSync('/private/tmp/kite-child-store-');
  chmodSync(dataRoot, 0o700);
  const profile = { dataRoot, profile: 'new' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: 'file:///disposable',
    name: 'w',
  });
  await store.createSession({
    expectedStoreId,
    sessionId: 's',
    workspaceId: 'w',
    commandId: 'create',
    subjectId: 'owner',
    title: 's',
  });
  await store.acceptCommand({
    expectedStoreId,
    sessionId: 's',
    commandId: 'work',
    subjectId: 'owner',
    request: { kind: 'run.start', content: 'delegate' },
  });
  const owner = (await store.acquireSessionOwner('s', 'host'))!;
  const configuration = {
    modelId: 'fixed',
    tools: [{ id: 'fixture/parent', version: '1', extensionId: 'fixture' }],
  };
  const run = await store.startRun({ expectedStoreId, owner, commandId: 'work', configuration });
  const source = { kind: 'model_decision', modelExecutionId: 'original-model' };
  await store.planExecution({
    expectedStoreId,
    owner,
    executionId: 'parent',
    sessionId: 's',
    runId: run.id,
    originCommandId: 'work',
    stepId: 'step',
    callId: 'call',
    kind: 'tool',
    definitionId: 'fixture/parent',
    definitionVersion: '1',
    input: {},
    decisionSource: source,
  });
  await store.markDispatching({
    expectedStoreId,
    owner,
    executionId: 'parent',
    authorization: {
      allowed: true,
      revision: '1',
      definitionVersion: '1',
      inputDigest: await semanticDigest({}),
    },
    requirements: [],
    freshness: { checked: true, source },
  });
  const db = new Database(join(dataRoot, 'new', 'core.db'));
  const request: EnsureOperationInput = {
    expectedStoreId,
    owner,
    sessionId: 's',
    extensionId: 'fixture',
    originCommandId: 'work',
    parentExecutionId: 'parent',
    operationKey: 'child',
    request: { kind: 'agent', configurationId: 'reviewer', input: { task: 'review' } },
    childConfiguration: { id: 'reviewer', version: '1', snapshot: configuration },
  };
  return {
    store,
    db,
    dataRoot,
    profile,
    owner,
    expectedStoreId,
    configuration,
    source,
    run,
    request,
    async close() {
      db.close();
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}
async function prepared(
  f: Awaited<ReturnType<typeof fixture>>,
  options: Partial<EnsureOperationInput> = {},
  requirements: RequirementEvaluation[] = [],
) {
  const ref = await f.store.ensureOperation({ ...f.request, ...options });
  await f.store.planExecution({
    expectedStoreId: f.expectedStoreId,
    owner: f.owner,
    executionId: ref.executionId!,
    sessionId: 's',
    runId: null,
    originCommandId: ref.commandId,
    stepId: `operation-${ref.commandId}`,
    callId: ref.commandId,
    kind: 'job',
    parentExecutionId: 'parent',
    cancelWithParent: options.cancellation !== 'detached',
    definitionId: 'agent/reviewer',
    definitionVersion: '1',
    input: { task: 'review' },
    decisionSource: f.source,
  });
  await f.store.markDispatching({
    expectedStoreId: f.expectedStoreId,
    owner: f.owner,
    executionId: ref.executionId!,
    authorization: {
      allowed: true,
      revision: '1',
      definitionVersion: '1',
      inputDigest: await semanticDigest({ task: 'review' }),
    },
    requirements,
    freshness: { checked: true, source: f.source },
  });
  return ref;
}
function activation(f: Awaited<ReturnType<typeof fixture>>, executionId: string) {
  return {
    expectedStoreId: f.expectedStoreId,
    owner: f.owner,
    executionId,
    configuration: f.configuration,
    requirementEvaluations: [],
    freshness: { checked: true, source: f.source },
  };
}

test('child activation persists exactly thirty minutes, ignores snapshot deadline flags, and expired final dispatch is atomic', async () => {
  const f = await fixture();
  try {
    const snapshot = {
      ...f.configuration,
      deadlineAt: 1,
      authorizationReview: { unlimited: true },
    };
    const ref = await prepared(f, {
      childConfiguration: { id: 'reviewer', version: '1', snapshot },
    });
    const beforeActivation = (await f.store.getMetadata()).lastChangeCursor;
    f.db.run(
      "CREATE TRIGGER deadline_activation_fault BEFORE INSERT ON run WHEN NEW.session_id!='s' BEGIN SELECT RAISE(ABORT,'deadline_fault'); END",
    );
    let failed = false;
    try {
      await f.store.activateChildRun({
        ...activation(f, ref.executionId!),
        configuration: snapshot,
      });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect((await f.store.getView(ref.childSessionId!)).runs).toHaveLength(0);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(beforeActivation);
    f.db.run('DROP TRIGGER deadline_activation_fault');
    const actual = await f.store.activateChildRun({
      ...activation(f, ref.executionId!),
      configuration: snapshot,
    });
    expect(actual.run.deadlineAt! - actual.run.createdAt).toBe(1800000);
    expect(f.run.deadlineAt).toBeNull();
    const owned = { expectedStoreId: f.expectedStoreId, owner: f.owner };
    const planned = {
      ...owned,
      executionId: 'child-model',
      sessionId: actual.session.id,
      runId: actual.run.id,
      originCommandId: actual.command.id,
      stepId: 'first',
      callId: 'first',
      kind: 'model' as const,
      definitionId: 'fixed',
      definitionVersion: '1',
      input: {},
      decisionSource: f.source,
    };
    await f.store.planExecution(planned);
    await f.store.planExecution({
      ...planned,
      executionId: 'origin-tool',
      stepId: 'tool',
      callId: 'tool',
      kind: 'tool',
      definitionId: 'fixture/parent',
    });
    await f.store.markDispatching({
      ...owned,
      executionId: 'origin-tool',
      authorization: {
        allowed: true,
        revision: '1',
        definitionVersion: '1',
        inputDigest: await semanticDigest({}),
      },
      requirements: [],
      freshness: { checked: true, source: f.source },
    });
    const job = await f.store.ensureOperation({
      ...f.request,
      sessionId: actual.session.id,
      originCommandId: actual.command.id,
      parentExecutionId: 'origin-tool',
      operationKey: 'job',
      request: { kind: 'job', definitionId: 'fixture/job', definitionVersion: '1', input: {} },
    });
    const expiredAt = Date.now() - 1;
    f.db
      .query('UPDATE run SET started_at=?,deadline_at=? WHERE id=?')
      .run(expiredAt - 1800000, expiredAt, actual.run.id);
    expect((await f.store.getRun(actual.run.id))!.deadlineAt).toBe(expiredAt);
    const before = (await f.store.getMetadata()).lastChangeCursor;
    await rejected(
      f.store.markDispatching({
        ...owned,
        executionId: planned.executionId,
        authorization: {
          allowed: true,
          revision: '1',
          definitionVersion: '1',
          inputDigest: await semanticDigest({}),
        },
        requirements: [],
        freshness: { checked: true, source: f.source },
      }),
      'child_deadline_exceeded',
    );
    await rejected(
      f.store.planExecution({
        ...planned,
        executionId: 'next-model',
        stepId: 'next',
        callId: 'next',
      }),
      'child_deadline_exceeded',
    );
    await rejected(
      f.store.markDispatching({
        ...owned,
        executionId: job.executionId!,
        authorization: {
          allowed: true,
          revision: '1',
          definitionVersion: '1',
          inputDigest: await semanticDigest({}),
        },
        requirements: [],
        freshness: { checked: true, source: f.source },
      }),
      'child_deadline_exceeded',
    );
    expect((await f.store.getExecution(job.executionId!))!.status).toBe('planned');
    expect(await f.store.getExecution('next-model')).toBeNull();
    expect((await f.store.getExecution('child-model'))!.status).toBe('planned');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
    const reader = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect((await reader.getRun(actual.run.id))!.deadlineAt).toBe(expiredAt);
      expect((await reader.getMetadata()).lastChangeCursor).toBe(before);
    } finally {
      await reader.close();
    }
  } finally {
    await f.close();
  }
});

test('expired child blocks attached descendants but detached child has its own activation deadline; late actual facts remain writable', async () => {
  const f = await fixture();
  try {
    const ref = await prepared(f),
      parent = await f.store.activateChildRun(activation(f, ref.executionId!));
    const owned = { expectedStoreId: f.expectedStoreId, owner: f.owner };
    await f.store.planExecution({
      ...owned,
      executionId: 'child-parent',
      sessionId: parent.session.id,
      runId: parent.run.id,
      originCommandId: parent.command.id,
      stepId: 'parent',
      callId: 'parent',
      kind: 'tool',
      definitionId: 'fixture/parent',
      definitionVersion: '1',
      input: {},
      decisionSource: f.source,
    });
    await f.store.markDispatching({
      ...owned,
      executionId: 'child-parent',
      authorization: {
        allowed: true,
        revision: '1',
        definitionVersion: '1',
        inputDigest: await semanticDigest({}),
      },
      requirements: [],
      freshness: { checked: true, source: f.source },
    });
    const children = [];
    for (const cancellation of ['attached', 'detached'] as const) {
      const child = await f.store.ensureOperation({
        ...f.request,
        originCommandId: parent.command.id,
        sessionId: parent.session.id,
        parentExecutionId: 'child-parent',
        operationKey: cancellation,
        cancellation,
      });
      await f.store.markDispatching({
        ...owned,
        executionId: child.executionId!,
        authorization: {
          allowed: true,
          revision: '1',
          definitionVersion: '1',
          inputDigest: await semanticDigest({ task: 'review' }),
        },
        requirements: [],
        freshness: { checked: true, source: f.source },
      });
      children.push(await f.store.activateChildRun(activation(f, child.executionId!)));
    }
    const expiredAt = Date.now() - 1;
    f.db
      .query('UPDATE run SET started_at=?,deadline_at=? WHERE id=?')
      .run(expiredAt - 1800000, expiredAt, parent.run.id);
    for (const [index, child] of children.entries()) {
      const planned = {
        ...owned,
        executionId: `nested-${index}`,
        sessionId: child.session.id,
        runId: child.run.id,
        originCommandId: child.command.id,
        stepId: 'model',
        callId: 'model',
        kind: 'model' as const,
        definitionId: 'fixed',
        definitionVersion: '1',
        input: {},
        decisionSource: f.source,
      };
      await f.store.planExecution(planned);
      const dispatch = f.store.markDispatching({
        ...owned,
        executionId: planned.executionId,
        authorization: {
          allowed: true,
          revision: '1',
          definitionVersion: '1',
          inputDigest: await semanticDigest({}),
        },
        requirements: [],
        freshness: { checked: true, source: f.source },
      });
      if (index === 0) await rejected(dispatch, 'child_deadline_exceeded');
      else {
        await dispatch;
        expect(child.run.deadlineAt! - child.run.createdAt).toBe(1800000);
      }
    }
    await f.store.finishExecution({
      ...owned,
      executionId: 'child-parent',
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'actual late tool fact' },
      requirements: [],
    });
    expect((await f.store.getExecution('child-parent'))!.status).toBe('succeeded');
  } finally {
    await f.close();
  }
});
