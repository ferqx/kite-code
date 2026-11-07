import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import type { PermissionDecision } from '../../../src/extensions';
import { canonicalJson, semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import type { AutoAuthorizationEvidence } from '../../../src/storage/port';
import {
  ensureFixtureAuthorizationCheck,
  fixtureCheckResult,
  resolveFixtureAutoAuthorization,
} from '../../fixtures/review-behavior';

const checker = { id: 'checker', version: '1', modelId: 'reviewer' };
const operationKey = 'a'.repeat(64);
function decision(kind: 'tool' | 'job' = 'tool'): PermissionDecision {
  return {
    allowed: false,
    revision: `policy-${kind}`,
    check: {
      request: { task: 'authorized fixture' },
      timeoutScope: { filesystem: 'full_access', network: 'none' },
    },
    snapshot: {
      namespace: 'builtin.permissions',
      version: '1',
      data: {
        mode: 'auto',
        workspaceTrust: true,
        policyRevision: 'stable-control',
        capability: {
          kind,
          definitionId: kind === 'tool' ? 'shell.execute' : 'shell.command',
          definitionVersion: '1',
          hardAllowed: true,
          effects:
            kind === 'tool' ? ['process', 'unknown', 'record_write'] : ['process', 'unknown'],
          executionScope: { filesystem: 'full_access', network: 'internet' },
        },
      },
    },
  };
}

async function fixture() {
  const root = temporaryDirectory('kite-auto-policy-');
  const store = await openSqliteStore({ dataRoot: root, profile: 'new' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: 'file:///fixture',
    name: 'Fixture',
  });
  await store.createSession({
    expectedStoreId,
    subjectId: 'owner',
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'Fixture',
  });
  await store.acceptCommand({
    expectedStoreId,
    subjectId: 'owner',
    commandId: 'work',
    sessionId: 's',
    request: { kind: 'run.start', content: 'Authorized fixture task' },
  });
  const owner = (await store.acquireSessionOwner('s', 'host'))!;
  const owned = { expectedStoreId, owner };
  const run = await store.startRun({
    ...owned,
    commandId: 'work',
    configuration: {
      authorizationCheck: { ...checker, timeoutMs: 3000 },
      tools: [{ id: 'shell.execute', version: '1', extensionId: 'builtin.shell' }],
    },
  });
  const source = { kind: 'host_intent', commandId: 'work' };
  const ids = new Map<string, string>();
  async function plan(id: string, kind: 'tool' | 'job' = 'tool', parentExecutionId?: string) {
    let executionId = id,
      originCommandId = 'work';
    if (kind === 'job') {
      const ref = await store.ensureOperation({
        ...owned,
        sessionId: 's',
        extensionId: 'builtin.shell',
        originCommandId: 'work',
        parentExecutionId: parentExecutionId!,
        operationKey: id,
        request: {
          kind: 'job',
          definitionId: 'shell.command',
          definitionVersion: '1',
          input: { command: 'printf fixture', key: id },
        },
      });
      executionId = ref.executionId!;
      originCommandId = ref.commandId;
      ids.set(id, executionId);
    }
    return store.planExecution({
      ...owned,
      executionId,
      sessionId: 's',
      runId: kind === 'job' ? null : run.id,
      originCommandId,
      stepId: kind === 'job' ? `operation-${originCommandId}` : id,
      callId: kind === 'job' ? originCommandId : id,
      kind,
      definitionId: kind === 'tool' ? 'shell.execute' : 'shell.command',
      definitionVersion: '1',
      input: { command: 'printf fixture', key: id },
      decisionSource: source,
      ...(parentExecutionId ? { parentExecutionId } : {}),
    });
  }
  async function check(
    id: string,
    answer: 'approve_once' | 'reject' | 'ask_user' | 'timeout' | 'pending' | 'technical',
    future = false,
    requireApproval = false,
  ) {
    const now = Date.now(),
      timeout = { startedAt: now - 50, deadlineAt: future ? now + 60000 : now - 1 };
    const fact = await ensureFixtureAuthorizationCheck(store, {
      ...owned,
      targetExecutionId: ids.get(id) ?? id,
      checker,
      policyRevision: 'policy-tool',
      operationKey,
      request: decision().check!.request,
      timeout,
      requireApproval,
    });
    if (answer === 'technical') {
      await store.finishAuthorizationCheck({
        ...owned,
        executionId: fact.execution.id,
        status: 'failed',
        result: { code: 'model_failed' },
      });
    } else if (answer === 'timeout') {
      await store.finishAuthorizationCheck({
        ...owned,
        executionId: fact.execution.id,
        status: 'failed',
        result: {
          code: 'authorization_check_timeout',
          deadlineAt: timeout.deadlineAt,
          incomplete: true,
        },
      });
    } else {
      await store.prepareAuthorizationCheck({
        ...owned,
        executionId: fact.execution.id,
        input: {
          modelId: checker.modelId,
          requestId: fact.execution.id,
          tools: [],
          messages: [{ role: 'user', content: canonicalJson(fact.input) }],
        },
        modelMetadata: {},
      });
      await store.dispatchAuthorizationCheck({ ...owned, executionId: fact.execution.id });
      if (answer === 'pending') return fact;
      await store.finishAuthorizationCheck({
        ...owned,
        executionId: fact.execution.id,
        status: 'succeeded',
        result: await fixtureCheckResult(
          store,
          fact.execution.id,
          {
            content: JSON.stringify({ decision: answer, reason: 'Exact fixture decision' }),
            toolCalls: [],
            finishReason: 'stop',
            usage: {},
          },
          { decision: answer, reason: 'Exact fixture decision' },
        ),
      });
    }
    return fact;
  }
  function resolve(id: string, current = decision(), timedOutCheckId?: string) {
    return resolveFixtureAutoAuthorization(store, {
      ...owned,
      targetExecutionId: ids.get(id) ?? id,
      decision: current,
      checker,
      operationKey,
      ...(timedOutCheckId ? { timedOutCheckId } : {}),
    });
  }
  async function dispatch(id: string, proof: AutoAuthorizationEvidence, current = decision()) {
    const target = (await store.getExecution(ids.get(id) ?? id))!;
    return store.markDispatching({
      ...owned,
      executionId: target.id,
      authorization: {
        allowed: true,
        revision: current.revision,
        definitionVersion: '1',
        inputDigest: await semanticDigest(target.input),
        snapshot: proof.snapshot,
        policyEvidenceId: proof.policyEvidenceId,
      },
      requirements: [],
      freshness: { checked: true, source },
    });
  }
  return {
    root,
    store,
    owned,
    run,
    plan,
    check,
    resolve,
    dispatch,
    close: async () => {
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('policy logs preserve append-time source identity, finite scopes and status through current drift and cold reads', async () => {
  const f = await fixture();
  try {
    await f.plan('first');
    const checked = await f.check('first', 'approve_once');
    const first = (await f.store.getExecution('first'))!;
    await f.store.markDispatching({
      ...f.owned,
      executionId: 'first',
      authorization: {
        allowed: true,
        revision: 'policy-tool',
        definitionVersion: '1',
        inputDigest: await semanticDigest(first.input),
        snapshot: decision().snapshot,
        checkExecutionId: checked.execution.id,
      },
      requirements: [],
      freshness: { checked: true, source: first.decisionSource },
    });
    await f.store.finishExecution({
      ...f.owned,
      executionId: 'first',
      status: 'succeeded',
      result: { content: 'done' },
    });
    await f.plan('second');
    const proof = (await f.resolve('second'))!;
    await f.dispatch('second', proof);
    await f.plan('nested', 'job', 'second');
    const nested = (await f.resolve('nested', decision('job')))!;
    const query = {
      expectedStoreId: f.owned.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      afterCursor: '0',
    };
    const page = await f.store.getSessionLogs(query);
    const policies = page.entries.filter((e) => e.type === 'authorization.policy');
    expect(policies).toHaveLength(2);
    expect(policies[0]).toMatchObject({
      category: 'execution',
      objectId: 'second',
      recordedStatus: 'planned',
      modelExecutionId: null,
      details: {
        executionId: 'second',
        kind: 'tool',
        policy: {
          targetExecutionId: 'second',
          policyEvidenceId: proof.policyEvidenceId,
          reason: 'reused_approval',
          source: { kind: 'check', id: checked.execution.id, targetExecutionId: 'first' },
          requestedScope: { filesystem: 'full_access', network: 'internet' },
          effectiveScope: { filesystem: 'full_access', network: 'internet' },
        },
      },
    });
    expect(policies[1]!.details.policy).toMatchObject({
      policyEvidenceId: nested.policyEvidenceId,
      reason: 'parent_review',
      source: { kind: 'policy', id: proof.policyEvidenceId },
    });
    expect(policies[1]!.details.policy!.source.id).not.toBe('second');
    const changes = await f.store.getChanges({ after: '0', sessionIds: ['s'] });
    expect(changes.events.find((e) => e.type === 'authorization.policy')!.payload).toEqual(
      policies[0]!.details.policy!,
    );
    await f.store.finishExecution({
      ...f.owned,
      executionId: 'second',
      status: 'failed',
      result: { content: 'later failure' },
    });
    expect(
      (await f.store.getSessionLogs({ ...query, upperCursor: page.upperCursor })).entries,
    ).toEqual(page.entries);
    expect(JSON.stringify(policies)).not.toContain('authorized fixture');
    const db = new Database(join(f.root, 'new', 'core.db'));
    try {
      const row = db
        .query('SELECT payload_json FROM change_event WHERE cursor=?')
        .get(policies[0]!.cursor) as { payload_json: string };
      const saved = JSON.parse(row.payload_json);
      const legacy = {
        ...saved,
        snapshot: { ...saved.snapshot, category: 'other', details: {}, recordedStatus: null },
      };
      db.query('UPDATE change_event SET payload_json=? WHERE cursor=?').run(
        JSON.stringify(legacy),
        policies[0]!.cursor,
      );
      const old = (await f.store.getSessionLogs(query)).entries.find(
        (e) => e.cursor === policies[0]!.cursor,
      )!;
      expect(old.category).toBe('other');
      expect(old.details).toEqual({});
      for (const invalid of [
        { ...saved.snapshot.details.policy, privateSnapshot: 'PRIVATE_SECRET' },
        { ...saved.snapshot.details.policy, source: { kind: 'execution', id: 'wrong' } },
        { ...saved.snapshot.details.policy, targetExecutionId: 'foreign' },
      ]) {
        db.query('UPDATE change_event SET payload_json=? WHERE cursor=?').run(
          JSON.stringify({
            ...saved,
            snapshot: {
              ...saved.snapshot,
              details: { ...saved.snapshot.details, policy: invalid },
            },
          }),
          policies[0]!.cursor,
        );
        const entry = (await f.store.getSessionLogs(query)).entries.find(
          (e) => e.cursor === policies[0]!.cursor,
        )!;
        expect(entry.details).toEqual({});
        expect(entry.occurredAt).toBeNull();
        expect(JSON.stringify(entry)).not.toContain('PRIVATE_SECRET');
        expect(
          (await f.store.getChanges({ after: '0', sessionIds: ['s'] })).events.find(
            (e) => e.cursor === entry.cursor,
          )!.payload,
        ).toEqual(saved.payload);
      }
      db.query('UPDATE change_event SET payload_json=? WHERE cursor=?').run(
        row.payload_json,
        policies[0]!.cursor,
      );
    } finally {
      db.close();
    }
    await f.store.close();
    const cold = await openSqliteStore({ dataRoot: f.root, profile: 'new', mode: 'readonly' });
    try {
      const before = await cold.getMetadata();
      expect(
        (await cold.getSessionLogs({ ...query, upperCursor: page.upperCursor })).entries,
      ).toEqual(page.entries);
      expect(await cold.getMetadata()).toEqual(before);
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
});
