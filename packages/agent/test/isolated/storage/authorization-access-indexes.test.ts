import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '#kite-test';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import { authorizationCheckInput } from '../../../src/authorization-check-input';
import type { PermissionDecision } from '../../../src/extensions';
import { canonicalJson, semanticDigest } from '../../../src/json';
import { Database } from '../../../src/runtime-sqlite';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { autoAuthorizationContext } from '../../../src/storage/sqlite/authorization-policy-evidence';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';
import type { Json } from '../../../src/storage/types';
import {
  ensureFixtureAuthorizationCheck,
  fixtureCheckResult,
  resolveFixtureAutoAuthorization,
} from '../../fixtures/review-behavior';

type Bind = string | number | bigint | null;
class ObservedOperations extends SqliteOperations {
  reads: { sql: string; args: Bind[] }[] = [];
  override row(sql: string, ...args: Bind[]) {
    this.reads?.push({ sql, args });
    return super.row(sql, ...args);
  }
  override rows(sql: string, ...args: Bind[]) {
    this.reads?.push({ sql, args });
    return super.rows(sql, ...args);
  }
}
const checker = { id: 'checker', version: '1', modelId: 'reviewer' };
const operationKey = 'a'.repeat(64);
const input = { command: 'printf fixture' };
function decision(): PermissionDecision {
  return {
    allowed: false,
    revision: 'policy',
    check: { request: { task: 'original task' } },
    snapshot: {
      namespace: 'builtin.permissions',
      version: '1',
      data: {
        mode: 'auto',
        workspaceTrust: true,
        policyRevision: 'control',
        capability: {
          kind: 'tool',
          definitionId: 'shell.execute',
          definitionVersion: '1',
          hardAllowed: true,
          effects: ['process', 'unknown', 'record_write'],
          executionScope: { filesystem: 'full_access', network: 'internet' },
        },
      },
    },
  };
}

async function fixture() {
  const root = temporaryDirectory('kite-authorization-access-');
  const initialized = await openSqliteStore({ dataRoot: root, profile: 'new' });
  const expectedStoreId = (await initialized.getMetadata()).storeId;
  const database = new Database(join(root, 'new', 'core.db'));
  const operations = new ObservedOperations(database, false);
  // Exercise the same SQL operations as the Worker without adding a production trace hook.
  const store = new Proxy({} as Store, {
    get:
      (_target, method) =>
      async (...args: unknown[]) => {
        try {
          if (method === 'acquireSessionOwner')
            return initialized.acquireSessionOwner(String(args[0]), String(args[1]));
          return operations.call(String(method), args);
        } finally {
          operations.releaseStatements();
        }
      },
  });
  const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  await store.createWorkspace({ expectedStoreId, id: 'w', name: 'w', rootUri: 'file:///fixture' });
  await store.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 'original' });
  await store.acceptCommand({
    ...base,
    commandId: 'work',
    request: { kind: 'run.start', content: 'original task' },
  });
  const owner = (await store.acquireSessionOwner('s', 'host'))!;
  await initialized.close();
  const owned = { expectedStoreId, owner };
  const run = await store.startRun({
    ...owned,
    commandId: 'work',
    configuration: { authorizationCheck: { ...checker, timeoutMs: 5000 } },
  });
  const source = { kind: 'host_intent', commandId: 'work' };
  const plan = (id: string) =>
    store.planExecution({
      ...owned,
      executionId: id,
      sessionId: 's',
      runId: run.id,
      originCommandId: 'work',
      stepId: id,
      callId: id,
      kind: 'tool',
      definitionId: 'shell.execute',
      definitionVersion: '1',
      input,
      decisionSource: source,
    });
  async function check(id: string) {
    const fact = await ensureFixtureAuthorizationCheck(store, {
      ...owned,
      targetExecutionId: id,
      checker,
      policyRevision: 'policy',
      operationKey,
      request: decision().check!.request,
      requireApproval: false,
      timeout: { startedAt: Date.now(), deadlineAt: Date.now() + 5000 },
    });
    await store.prepareAuthorizationCheck({
      ...owned,
      executionId: fact.execution.id,
      input: {
        modelId: checker.modelId,
        requestId: fact.execution.id,
        tools: [],
        messages: [
          {
            role: 'user',
            content: canonicalJson(authorizationCheckInput(fact.input as Record<string, Json>)),
          },
        ],
      },
      modelMetadata: {},
    });
    await store.dispatchAuthorizationCheck({ ...owned, executionId: fact.execution.id });
    await store.finishAuthorizationCheck({
      ...owned,
      executionId: fact.execution.id,
      status: 'succeeded',
      result: await fixtureCheckResult(
        store,
        fact.execution.id,
        { content: 'approved', toolCalls: [], finishReason: 'stop', usage: {} },
        { decision: 'approve_once', reason: 'exact original check' },
      ),
    });
    return fact;
  }
  const resolve = (id: string) =>
    resolveFixtureAutoAuthorization(store, {
      ...owned,
      targetExecutionId: id,
      decision: decision(),
      checker,
      operationKey,
    });
  async function dispatch(id: string, authorization: Record<string, Json>) {
    return store.markDispatching({
      ...owned,
      executionId: id,
      authorization: {
        allowed: true,
        revision: 'policy',
        definitionVersion: '1',
        inputDigest: await semanticDigest(input),
        snapshot: decision().snapshot,
        ...authorization,
      },
      requirements: [],
      freshness: { checked: true, source },
    });
  }
  function indexed(fragment: string, index: string) {
    const reads = operations.reads.filter(({ sql }) => sql.includes(fragment));
    expect(reads.length).toBeGreaterThan(0);
    for (const { sql, args } of reads) {
      const plan = database
        .query<{ detail: string }, Bind[]>(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...args)
        .map(({ detail }) => detail);
      expect(plan.some((detail) => detail.includes(`SEARCH`) && detail.includes(index))).toBe(true);
      expect(plan.some((detail) => detail.startsWith('SCAN'))).toBe(false);
      if (index === 'context_result_execution' || index === 'command_work_authority')
        expect(plan.some((detail) => detail.includes('TEMP B-TREE'))).toBe(false);
    }
  }
  return {
    database,
    operations,
    store,
    base,
    owned,
    run,
    plan,
    check,
    resolve,
    dispatch,
    indexed,
    close() {
      operations.releaseStatements();
      database.close(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('production check, dispatch and reuse retain exact facts while using bounded access indexes', async () => {
  const f = await fixture();
  try {
    await f.plan('original');
    const check = await f.check('original');
    await f.dispatch('original', { checkExecutionId: check.execution.id });
    await f.store.finishExecution({
      ...f.owned,
      executionId: 'original',
      status: 'succeeded',
      result: { content: 'finished original' },
    });
    expect((await f.store.getExecution('original'))?.authorization?.check).toMatchObject({
      executionId: check.execution.id,
      decision: 'approve_once',
    });
    await f.plan('next');
    const proof = await f.resolve('next');
    expect(proof?.reason).toBe('reused_approval');
    // An independent actual write in the same work invalidates this saved proof.
    await f.plan('intervening');
    await f.dispatch('intervening', {});
    await f.store.finishExecution({
      ...f.owned,
      executionId: 'intervening',
      status: 'succeeded',
      result: { content: 'independent effect' },
    });
    expect(await f.resolve('next')).toBeNull();
    await expect(
      f.dispatch('next', { policyEvidenceId: proof!.policyEvidenceId }),
    ).rejects.toMatchObject({
      code: 'authorization_policy_changed',
    });
    expect((await f.store.getExecution('next'))?.status).toBe('planned');
    f.indexed("WHERE c.kind='result_ref'", 'context_result_execution');
    f.indexed('WHERE origin_command_id=? LIMIT 2', 'execution_origin_command');
    f.indexed("c.kind='authorization.invalidate'", 'authorization_invalidation_check');
    f.indexed("WHERE kind='authorization.invalidate'", 'authorization_invalidation_check');
    f.indexed('AND (completed_cursor>?', 'execution_work_effect');
    f.indexed('SELECT id,request_digest,cancelled FROM command', 'command_work_authority');
  } finally {
    f.close();
  }
});

test('authority context preserves cross-Session work inputs, original ordering and cancellation without including another Store or work', async () => {
  const f = await fixture();
  try {
    await f.plan('original');
    for (const id of ['a-child', 'b-sibling'])
      await f.store.createSession({
        ...f.base,
        sessionId: id,
        commandId: `create-${id}`,
        workspaceId: 'w',
        title: id,
      });
    f.database.run(
      "UPDATE session SET parent_id='s',root_id='s' WHERE id IN('a-child','b-sibling')",
    );
    const commands = [
      { id: 'child-start', session: 'a-child', seq: 10, kind: 'child.start' },
      { id: 'child-steer', session: 'a-child', seq: 20, kind: 'input.steer' },
      { id: 'sibling-start', session: 'b-sibling', seq: 10, kind: 'child.start' },
      { id: 'sibling-steer', session: 'b-sibling', seq: 20, kind: 'input.steer', cancelled: 1 },
      { id: 'root-steer', session: 's', seq: 10, kind: 'input.steer' },
      { id: 'not-applied', session: 's', seq: 20, kind: 'input.steer', status: 'accepted' },
      { id: 'another-work', session: 's', seq: 30, kind: 'input.steer', work: 'different-work' },
      { id: 'another-store', session: 's', seq: 40, kind: 'input.steer', store: 'different-store' },
      {
        id: 'foreign-start',
        session: 'a-child',
        seq: 30,
        kind: 'child.start',
        store: 'different-store',
      },
      {
        id: 'different-start',
        session: 'a-child',
        seq: 40,
        kind: 'child.start',
        work: 'different-work',
      },
      { id: 'unrelated-kind', session: 's', seq: 50, kind: 'session.title' },
    ];
    // Seed saved provenance only. Reading its digest creates no execution or grant authority.
    for (const entry of commands)
      f.database.run(
        "INSERT INTO command(id,session_id,seq,kind,subject_id,request_digest,request_json,status,origin_store_id,root_work_command_id,root_work_seq,cancelled) VALUES(?,?,?,?,'owner',?,'{}',?,?,?,2,?)",
        [
          entry.id,
          entry.session,
          entry.seq,
          entry.kind,
          `digest-${entry.id}`,
          entry.status ?? 'applied',
          entry.store ?? f.base.expectedStoreId,
          entry.work ?? 'work',
          entry.cancelled ?? 0,
        ],
      );
    const columns = f.database.query<{ name: string }, []>('PRAGMA table_info(execution)').all();
    const replacement: Record<string, string> = {
      id: "'child-target'",
      session_id: "'a-child'",
      origin_command_id: "'child-start'",
      run_id: 'NULL',
    };
    f.database.run(
      `INSERT INTO execution(${columns.map(({ name }) => name).join(',')}) SELECT ${columns
        .map(({ name }) => replacement[name] ?? name)
        .join(',')} FROM execution WHERE id='original'`,
    );
    const target = f.operations.row('SELECT * FROM execution WHERE id=?', 'child-target')!;
    f.operations.reads = [];
    const original = autoAuthorizationContext(f.operations, target);
    const query = f.operations.reads.find(({ sql }) =>
      sql.startsWith('SELECT id,request_digest,cancelled FROM command'),
    )!;
    const rows = f.operations.rows(query.sql, ...query.args);
    expect(rows.map(({ id }) => id)).toEqual([
      'child-start',
      'child-steer',
      'sibling-steer',
      'work',
      'root-steer',
    ]);
    expect(rows.map(({ cancelled }) => Boolean(cancelled))).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(original).toBe(
      await semanticDigest({
        origin: rows.map((row) => [
          String(row.id),
          String(row.request_digest),
          Boolean(row.cancelled),
        ]),
        refusals: [],
      }),
    );
    f.indexed('SELECT id,request_digest,cancelled FROM command', 'command_work_authority');
    f.database.run("UPDATE command SET cancelled=0 WHERE id='sibling-steer'");
    expect(autoAuthorizationContext(f.operations, target)).not.toBe(original);
    f.database.run("UPDATE command SET cancelled=1 WHERE id='sibling-steer'");
    expect(autoAuthorizationContext(f.operations, target)).toBe(original);
    f.database.run(
      "UPDATE command SET request_digest='changed-outside-work' WHERE id IN('another-work','another-store','foreign-start','different-start')",
    );
    expect(autoAuthorizationContext(f.operations, target)).toBe(original);
  } finally {
    f.close();
  }
});

test('a real positive invalidation blocks reuse and an ambiguous check never becomes authority', async () => {
  const f = await fixture();
  try {
    await f.plan('original');
    const check = await f.check('original');
    await f.plan('next');
    expect((await f.resolve('next'))?.reason).toBe('reused_approval');
    await f.store.invalidateAuthorizationCheck({
      ...f.owned,
      executionId: 'original',
      checkExecutionId: check.execution.id,
      previousPolicyRevision: 'policy',
      policyRevision: 'changed-policy',
    });
    expect(await f.resolve('next')).toBeNull();
    f.indexed("WHERE kind='authorization.invalidate'", 'authorization_invalidation_check');
    expect(
      f.database.query("SELECT id FROM command WHERE kind='authorization.invalidate'").all(),
    ).toHaveLength(1);
    // A second actual row for this command must still fail the LIMIT 2 uniqueness guard.
    const columns = f.database.query<{ name: string }, []>('PRAGMA table_info(execution)').all();
    f.database.run(
      `INSERT INTO execution(${columns.map(({ name }) => name).join(',')}) SELECT ${columns
        .map(({ name }) => (name === 'id' ? '?' : name))
        .join(',')} FROM execution WHERE id=?`,
      ['ambiguous-check', check.execution.id],
    );
    await expect(
      f.store.getAuthorizationCheck({
        expectedStoreId: f.base.expectedStoreId,
        targetExecutionId: 'original',
        checkExecutionId: check.execution.id,
        policyRevision: 'policy',
        request: decision().check!.request,
        checker,
        requireApproval: false,
      }),
    ).rejects.toMatchObject({ code: 'authorization_check_unverifiable' });
    f.indexed('WHERE origin_command_id=? LIMIT 2', 'execution_origin_command');
    expect((await f.store.getExecution('original'))?.status).toBe('planned');
  } finally {
    f.close();
  }
});

test('result acceptance searches all consumer Sessions and retains selection, diagnostic and pending filters', async () => {
  const f = await fixture();
  try {
    await f.plan('original');
    await f.store.createSession({
      ...f.base,
      sessionId: 'consumer',
      commandId: 'create-consumer',
      workspaceId: 'w',
      title: 'consumer',
    });
    const consumer = (await f.store.getSession('consumer'))!;
    // Stored result sources belong to the accepting Session, not necessarily the producer.
    for (const [id, selection, flags, seq] of [
      ['old-selection', 'unselected', {}, 1],
      ['diagnostic', consumer.contextSelectionId, { diagnostic: true }, 2],
      ['pending', consumer.contextSelectionId, { pendingInput: true }, 3],
      ['accepted', consumer.contextSelectionId, {}, 4],
    ] as const) {
      f.database.run(
        "INSERT INTO context_snapshot(id,session_id,selection_id,sources_json,request_json,kind,seq,execution_id,result_revision) VALUES(?,'consumer',?,'[]',?,'result_ref',?,'original',0)",
        [id, selection, canonicalJson({ targetRunId: 'consumer-run', ...flags }), seq],
      );
    }
    expect((await f.store.getExecution('original'))?.resultAcceptance).toEqual({
      runId: 'consumer-run',
      selectionId: consumer.contextSelectionId,
      sourceId: 'accepted',
      resultRevision: '0',
    });
    expect((await f.store.getExecution('original'))?.sessionId).toBe('s');
    expect((await f.store.getExecution('original'))?.status).toBe('planned');
    f.indexed("WHERE c.kind='result_ref'", 'context_result_execution');
  } finally {
    f.close();
  }
});

test('actual empty inbox high-water reads use recipient and subject without walking unrelated commands', async () => {
  const f = await fixture();
  try {
    const before = await f.store.getMetadata();
    f.operations.reads = [];
    const page = await f.store.listAgentMessages({
      ...f.base,
      runId: f.run.id,
      pendingOnly: true,
      afterSeq: '0',
      limit: 50,
    });
    expect(page).toMatchObject({
      storeId: f.base.expectedStoreId,
      sessionId: 's',
      items: [],
      upperSeq: '0',
      highWaterSeq: '0',
      receivedSeq: '0',
      nextAfterSeq: null,
    });
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before.lastChangeCursor);
    f.indexed('AS water FROM command c', 'command_mail_recipient');
    expect(
      f.database
        .query<{ sql: string }, []>(
          "SELECT sql FROM sqlite_schema WHERE name='command_mail_recipient'",
        )
        .get()?.sql,
    ).toBe(
      'CREATE INDEX command_mail_recipient ON command(mail_target_session_id,subject_id) WHERE mail_target_session_id IS NOT NULL',
    );
  } finally {
    f.close();
  }
});
