import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage';
import type { DispatchInput } from '../../../src/storage/port';
import { executionGuard } from '../../../src/storage/sqlite/execution-group-safety';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';

async function code(work: Promise<unknown>) {
  try {
    await work;
    return 'success';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}
async function fixture() {
  const root = mkdtempSync('/private/tmp/kite-action-inheritance-');
  const store = await openSqliteStore({ dataRoot: root, profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, subjectId: 'owner', sessionId: 's' };
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'owned',
    rootUri: `file://${root}`,
  });
  for (const sessionId of ['s', 'other'])
    await store.createSession({
      ...base,
      sessionId,
      workspaceId: 'w',
      commandId: `create-${sessionId}`,
      title: sessionId,
    });
  const owner = (await store.acquireSessionOwner('s', 'host'))!;
  await store.acceptCommand({
    ...base,
    commandId: 'action',
    request: {
      kind: 'extension.invoke',
      extensionId: 'fixture',
      actionId: 'bridge',
      definitionVersion: '1',
      input: {},
    },
  });
  const source: Json = {
    kind: 'action_decision',
    commandId: 'action',
    extensionId: 'fixture',
    actionId: 'bridge',
    definitionVersion: '1',
    preparedDigest: await semanticDigest({}),
    sources: [],
    reads: [],
    recordReads: [],
    recordListReads: [],
  };
  await store.planAction({
    expectedStoreId,
    owner,
    commandId: 'action',
    executionId: 'action-execution',
    extensionId: 'fixture',
    definitionId: 'fixture/bridge',
    definitionVersion: '1',
    input: {},
    decisionSource: source,
  });
  const dispatch = async (executionId: string): Promise<DispatchInput> => ({
    expectedStoreId,
    owner,
    executionId,
    authorization: {
      allowed: true,
      revision: 'trusted',
      definitionVersion: '1',
      inputDigest: await semanticDigest({}),
    },
    requirements: [],
    freshness: { checked: true, source },
  });
  const db = new Database(join(root, 'test/core.db'));
  const reject = async (input: DispatchInput, expected?: string) => {
    const before = (await store.getMetadata()).lastChangeCursor;
    const result = await code(store.markDispatching(input));
    if (expected) expect(result).toBe(expected);
    else expect(result).not.toBe('success');
    expect((await store.getExecution(input.executionId))!.status).toBe('planned');
    expect((await store.getMetadata()).lastChangeCursor).toBe(before);
    expect(
      db
        .query(
          "SELECT count(*) AS n FROM change_event WHERE object_id=? AND type='execution.dispatching'",
        )
        .get(input.executionId),
    ).toEqual({ n: 0 });
  };
  const chain = async (extraTools = 0) => {
    await store.markDispatching({
      ...(await dispatch('action-execution')),
      readSet: { records: [], recordLists: [] },
    });
    const tool = await store.ensureOperation({
      expectedStoreId,
      owner,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'action',
      parentExecutionId: 'action-execution',
      operationKey: 'bridge',
      request: { kind: 'tool', definitionId: 'fixture/tool', definitionVersion: '1', input: {} },
      cancellation: 'detached',
    });
    await store.planExecution({
      expectedStoreId,
      owner,
      executionId: 'tool',
      sessionId: 's',
      runId: null,
      originCommandId: tool.commandId,
      parentExecutionId: 'action-execution',
      cancelWithParent: false,
      stepId: 'tool-step',
      callId: 'tool-call',
      kind: 'tool',
      definitionId: 'fixture/tool',
      definitionVersion: '1',
      input: {},
      decisionSource: source,
    });
    await store.markDispatching(await dispatch('tool'));
    let parentExecutionId = 'tool';
    let originCommandId = tool.commandId;
    for (let index = 0; index < extraTools; index++) {
      const executionId = `nested-tool-${index}`;
      const operation = await store.ensureOperation({
        expectedStoreId,
        owner,
        sessionId: 's',
        extensionId: 'fixture',
        originCommandId,
        parentExecutionId,
        operationKey: `nested-${index}`,
        request: { kind: 'tool', definitionId: 'fixture/tool', definitionVersion: '1', input: {} },
        cancellation: 'detached',
      });
      await store.planExecution({
        expectedStoreId,
        owner,
        executionId,
        sessionId: 's',
        runId: null,
        originCommandId: operation.commandId,
        parentExecutionId,
        cancelWithParent: false,
        stepId: executionId,
        callId: operation.commandId,
        kind: 'tool',
        definitionId: 'fixture/tool',
        definitionVersion: '1',
        input: {},
        decisionSource: source,
      });
      await store.markDispatching(await dispatch(executionId));
      parentExecutionId = executionId;
      originCommandId = operation.commandId;
    }
    const job = await store.ensureOperation({
      expectedStoreId,
      owner,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId,
      parentExecutionId,
      operationKey: 'worker',
      request: { kind: 'agent', configurationId: 'worker', input: {} },
      childConfiguration: { id: 'worker', version: '1', snapshot: { modelId: 'fixed', tools: [] } },
      cancellation: 'detached',
    });
    return { tool, job, input: await dispatch(job.executionId!) };
  };
  return {
    store,
    db,
    source,
    owner,
    base,
    dispatch,
    reject,
    chain,
    async close() {
      db.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('original Action needs its own collector; two-hop Tool to Job inherits exact provenance without collector or fabricated Run', async () => {
  const f = await fixture();
  try {
    await f.reject(await f.dispatch('action-execution'), 'dispatch_read_set_invalid');
    const { job, input } = await f.chain();
    expect((await f.store.markDispatching(input)).status).toBe('dispatching');
    const actual = await f.store.getExecution(job.executionId!);
    expect(actual!.decisionSource).toEqual(f.source);
    expect(actual!.parentExecutionId).toBe('tool');
    expect(actual!.rootWorkCommandId).toBe('action');
    expect((await f.store.getView('s')).runs).toEqual([]);
    expect((await f.store.getView(job.childSessionId!)).runs).toEqual([]);
  } finally {
    await f.close();
  }
}, 10000);

test('child rejects injected Action collector and leaves the original dispatch facts unchanged', async () => {
  const f = await fixture();
  try {
    const { input } = await f.chain();
    await f.reject(
      { ...input, readSet: { records: [], recordLists: [] } },
      'dispatch_read_set_invalid',
    );
  } finally {
    await f.close();
  }
}, 10000);

test('64 total genuine public Execution nodes dispatch, while node 65 cannot inherit', async () => {
  for (const extraTools of [61, 62]) {
    const f = await fixture();
    try {
      const { input } = await f.chain(extraTools);
      if (extraTools === 61)
        expect((await f.store.markDispatching(input)).status).toBe('dispatching');
      else await f.reject(input);
    } finally {
      await f.close();
    }
  }
}, 10000);

for (const corruption of [
  'source',
  'Store',
  'Session',
  'rootWork',
  'rootSeq',
  'rootSession',
  'subject',
  'commandEdge',
  'undispatched',
  'missingAuthorization',
  'anchorIntent',
  'broken',
  'cycle',
  'over64',
] as const)
  test(`owned SQLite corruption: ${corruption} ancestry cannot acquire inherited dispatch privilege`, async () => {
    const f = await fixture();
    try {
      const { input } = await f.chain();
      if (corruption === 'source')
        f.db.run('UPDATE execution SET decision_source_json=? WHERE id=?', [
          canonicalJson({ ...(f.source as object), preparedDigest: 'changed' } as Json),
          'tool',
        ]);
      if (corruption === 'Store')
        f.db.run("UPDATE execution SET origin_store_id='foreign' WHERE id='tool'");
      if (corruption === 'Session')
        f.db.run("UPDATE execution SET session_id='other' WHERE id='tool'");
      if (corruption === 'rootWork')
        f.db.run("UPDATE execution SET root_work_command_id='foreign' WHERE id='tool'");
      if (corruption === 'rootSeq')
        f.db.run("UPDATE execution SET root_work_seq=999 WHERE id='tool'");
      if (corruption === 'rootSession')
        f.db.run("UPDATE execution SET root_session_id='other' WHERE id='tool'");
      if (corruption === 'subject')
        f.db.run(
          "UPDATE command SET subject_id='foreign' WHERE id=(SELECT origin_command_id FROM execution WHERE id='tool')",
        );
      if (corruption === 'commandEdge')
        f.db.run(
          "UPDATE command SET request_json=json_set(request_json,'$.parentExecutionId','missing') WHERE id=(SELECT origin_command_id FROM execution WHERE id='tool')",
        );
      if (corruption === 'undispatched')
        f.db.run("UPDATE execution SET dispatched=0 WHERE id='tool'");
      if (corruption === 'missingAuthorization')
        f.db.run("UPDATE execution SET dispatch_authorization_json=NULL WHERE id='tool'");
      if (corruption === 'anchorIntent')
        f.db.run(
          "UPDATE execution SET intent_json='{\"different\":true}' WHERE id='action-execution'",
        );
      if (corruption === 'broken')
        f.db.run("UPDATE execution SET parent_execution_id='missing' WHERE id='tool'");
      if (corruption === 'cycle')
        f.db.run("UPDATE execution SET parent_execution_id='tool' WHERE id='tool'");
      if (corruption === 'over64') {
        const original = f.db.query('SELECT * FROM execution WHERE id=?').get('tool') as Record<
          string,
          unknown
        >;
        const columns = Object.keys(original);
        const insert = f.db.query(
          `INSERT INTO execution(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
        );
        for (let index = 0; index < 64; index++) {
          const row = {
            ...original,
            id: `fault-${index}`,
            parent_execution_id: index === 63 ? 'action-execution' : `fault-${index + 1}`,
          };
          insert.run(...(columns.map((key) => row[key as keyof typeof row]) as never[]));
        }
        f.db.run("UPDATE execution SET parent_execution_id='fault-0' WHERE id='tool'");
      }
      await f.reject(input);
    } finally {
      await f.close();
    }
  }, 10000);

for (const boundary of ['permission', 'freshness', 'cancel'] as const)
  test(`legitimate inherited descendant still obeys ${boundary} before any dispatch event`, async () => {
    const f = await fixture();
    try {
      const { input, job } = await f.chain();
      if (boundary === 'permission') input.authorization.allowed = false;
      if (boundary === 'freshness') input.freshness.checked = false;
      if (boundary === 'cancel')
        await f.store.cancelCommand({
          ...f.base,
          commandId: 'cancel-job',
          targetCommandId: job.commandId,
        });
      await f.reject(
        input,
        boundary === 'permission'
          ? 'permission_denied'
          : boundary === 'freshness'
            ? 'context_refresh_required'
            : undefined,
      );
    } finally {
      await f.close();
    }
  }, 10000);

test('fault setup of a guarded source preserves original Action fence; descendant is provenance and never a second guard', async () => {
  const f = await fixture();
  try {
    const { input, job } = await f.chain();
    // Public lifecycle forbids creating descendants behind a live fence. Inject only
    // the otherwise identical guard-bearing source into this owned SQLite chain.
    const guard = {
      kind: 'execution_group_quiescence',
      version: 1,
      rootSessionId: 's',
      originCommandId: 'action',
    } as const;
    const source = { ...(f.source as object), guard } as Json;
    f.db.run('UPDATE execution SET decision_source_json=?', [canonicalJson(source)]);
    const operations = new SqliteOperations(f.db, false);
    const row = (id: string) => operations.row('SELECT * FROM execution WHERE id=?', id)!;
    expect(executionGuard(operations, row('action-execution'))).toEqual(guard);
    expect(executionGuard(operations, row('tool'))).toBeNull();
    expect(executionGuard(operations, row(job.executionId!))).toBeNull();
    await f.reject({ ...input, freshness: { checked: true, source } }, 'execution_group_fenced');
  } finally {
    await f.close();
  }
}, 10000);

async function reviewFixture(target: 'Action' | 'Tool', guarded = false) {
  const f = await fixture();
  try {
    let targetExecutionId = 'action-execution';
    if (target === 'Tool') {
      await f.store.markDispatching({
        ...(await f.dispatch(targetExecutionId)),
        readSet: { records: [], recordLists: [] },
      });
      const operation = await f.store.ensureOperation({
        expectedStoreId: f.base.expectedStoreId,
        owner: f.owner,
        sessionId: 's',
        extensionId: 'fixture',
        originCommandId: 'action',
        parentExecutionId: targetExecutionId,
        operationKey: 'review-target',
        request: { kind: 'tool', definitionId: 'fixture/tool', definitionVersion: '1', input: {} },
        cancellation: 'detached',
      });
      await f.store.planExecution({
        expectedStoreId: f.base.expectedStoreId,
        owner: f.owner,
        executionId: 'review-target',
        sessionId: 's',
        runId: null,
        originCommandId: operation.commandId,
        parentExecutionId: targetExecutionId,
        cancelWithParent: false,
        stepId: 'review-target',
        callId: operation.commandId,
        kind: 'tool',
        definitionId: 'fixture/tool',
        definitionVersion: '1',
        input: {},
        decisionSource: f.source,
      });
      targetExecutionId = 'review-target';
    }
    if (guarded) {
      // Fault setup only: the original planned Action retains its own guard.
      // ensureAuthorizationReview then seals the actual guard-bearing target.
      (f.source as Record<string, Json>).guard = {
        kind: 'execution_group_quiescence',
        version: 1,
        rootSessionId: 's',
        originCommandId: 'action',
      };
      f.db.run('UPDATE execution SET decision_source_json=? WHERE id=?', [
        canonicalJson(f.source),
        targetExecutionId,
      ]);
    }
    const review = await f.store.ensureAuthorizationReview({
      expectedStoreId: f.base.expectedStoreId,
      owner: f.owner,
      targetExecutionId,
      policyRevision: 'exact-policy',
      request: { task: 'review original owned operation' },
      reviewer: { id: 'reviewer', version: '1', modelId: 'fixed-reviewer' },
    });
    const input = await f.dispatch(review.operation.executionId!);
    input.authorization.inputDigest = await semanticDigest(review.input);
    input.freshness.source = review.source;
    return { ...f, review, input, targetExecutionId };
  } catch (error) {
    await f.close();
    throw error;
  }
}

for (const target of ['Action', 'Tool'] as const)
  test(`actual ensureAuthorizationReview of an undispatched ${target} inherits only its sealed provenance without collector`, async () => {
    const f = await reviewFixture(target);
    try {
      expect((await f.store.getExecution(f.targetExecutionId))!.status).toBe('planned');
      expect((await f.store.getCommand(f.review.operation.commandId))!.kind).toBe(
        'authorization.review',
      );
      expect(f.review.source).toEqual(f.source);
      expect((await f.store.markDispatching(f.input)).status).toBe('dispatching');
      expect((await f.store.getExecution(f.targetExecutionId))!.status).toBe('planned');
      expect((await f.store.getView(f.review.operation.childSessionId!)).runs).toEqual([]);
    } finally {
      await f.close();
    }
  }, 10000);

for (const drift of ['payload', 'target', 'policy', 'reviewer'] as const)
  test(`owned SQLite corruption: reviewer ${drift} drift cannot borrow undispatched target provenance`, async () => {
    const f = await reviewFixture('Tool');
    try {
      const id = f.review.operation.executionId!;
      if (drift === 'payload') {
        const changed = { ...(f.review.input as object), request: { changed: true } } as Json;
        f.db.run('UPDATE execution SET intent_json=? WHERE id=?', [canonicalJson(changed), id]);
        // Align the supplied digest with the corrupted input: refusal must also
        // enforce the original sealed reviewer binding, beyond input hashing.
        f.input.authorization.inputDigest = await semanticDigest(changed);
      }
      if (drift === 'target')
        f.db.run('UPDATE execution SET intent_json=? WHERE id=?', [
          canonicalJson({ changed: true }),
          f.targetExecutionId,
        ]);
      if (drift === 'policy')
        f.db.run(
          "UPDATE execution SET child_configuration_json=json_set(child_configuration_json,'$.snapshot.authorizationReview.policyRevision','different-policy') WHERE id=?",
          [id],
        );
      if (drift === 'reviewer')
        f.db.run(
          "UPDATE execution SET child_configuration_json=json_set(child_configuration_json,'$.snapshot.modelId','different-reviewer') WHERE id=?",
          [id],
        );
      await f.reject(f.input);
    } finally {
      await f.close();
    }
  }, 10000);

test('guard-bearing original planned Action keeps its own authority while its actual reviewer has no own fence', async () => {
  const f = await reviewFixture('Action', true);
  try {
    const operations = new SqliteOperations(f.db, false);
    const row = (id: string) => operations.row('SELECT * FROM execution WHERE id=?', id)!;
    expect(executionGuard(operations, row(f.targetExecutionId))).toMatchObject({
      originCommandId: 'action',
    });
    expect(executionGuard(operations, row(f.review.operation.executionId!))).toBeNull();
    // The actual sealed review is pending: its target cannot dispatch through a
    // trusted authorization decision before that independent review completes.
    await f.reject(
      { ...(await f.dispatch(f.targetExecutionId)), readSet: { records: [], recordLists: [] } },
      'authorization_review_required',
    );
    expect((await f.store.markDispatching(f.input)).status).toBe('dispatching');
    expect((await f.store.getExecution(f.targetExecutionId))!.status).toBe('planned');
  } finally {
    await f.close();
  }
}, 10000);
