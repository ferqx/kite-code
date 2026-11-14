import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureGrant as basicFixtureGrant } from '../../../../../tests/fixtures/permission-grant';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import { authorizationCheckInput } from '../../../src/authorization-check-input';
import { InteractionGate } from '../../../src/execution/interactions';
import type { PermissionDecision } from '../../../src/extensions';
import { canonicalJson, semanticDigest } from '../../../src/json';
import { approvalOptions } from '../../../src/permission-grants';
import { shellRiskInstructions } from '../../../src/shell-risk-review';
import { openSqliteStore } from '../../../src/sqlite';
import type { AutoAuthorizationEvidence } from '../../../src/storage/port';
import { authorizationTaskContext } from '../../../src/storage/sqlite/authorization-check-context';
import { SqliteOperations } from '../../../src/storage/sqlite/operations';
import type { InteractionRecord, Json } from '../../../src/storage/types';
import {
  ensureFixtureAuthorizationCheck,
  fixtureCheckResult,
  resolveFixtureAutoAuthorization,
} from '../../fixtures/review-behavior';

const fixtureGrant: typeof basicFixtureGrant = (...args) => {
  const offer = basicFixtureGrant(...args);
  return {
    ...offer,
    policyBindings: offer.policyBindings.map((binding) => ({
      ...binding,
      satisfiesCheck: true as const,
      requireApproval: false,
    })),
  };
};
const checker = { id: 'checker', version: '1', modelId: 'reviewer' };
const operationKey = 'a'.repeat(64);
async function rejects(promise: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code });
}
function decision(kind: 'tool' | 'job' = 'tool'): PermissionDecision {
  return {
    allowed: false,
    revision: `policy-${kind}`,
    check: {
      request: {
        task: 'authorized fixture',
        context: { reviewInput: 'task_authorization', task: { availability: 'available' } },
      },
      timeoutScope: { filesystem: 'full_access', network: 'internet' },
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
          autoReviewKey: operationKey,
          effects:
            kind === 'tool' ? ['process', 'unknown', 'record_write'] : ['process', 'unknown'],
          executionScope: { filesystem: 'full_access', network: 'internet' },
        },
      },
    },
  };
}

async function fixture(
  options: { risk?: boolean; reusable?: boolean; missingPreparation?: boolean } = {},
) {
  const preparation = options.missingPreparation
    ? null
    : {
        instructions: shellRiskInstructions,
        material: { cwd: '/fixture', command: 'printf fixture' },
        fingerprint: 'b'.repeat(64),
        reusable: options.reusable ?? true,
      };
  const currentDecision = (kind: 'tool' | 'job' = 'tool') => {
    const current = decision(kind);
    if (options.risk) current.check!.request = { reviewPurpose: 'shell_risk' };
    return current;
  };
  const root = temporaryDirectory('kite-auto-policy-');
  const store = await openSqliteStore({ dataRoot: root, profile: 'new' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: pathToFileURL(root).href,
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
  async function plan(
    id: string,
    kind: 'tool' | 'job' = 'tool',
    parentExecutionId?: string,
    command = 'printf fixture',
  ) {
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
          input: { command, key: id },
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
      input: { command, key: id },
      decisionSource: source,
      ...(parentExecutionId ? { parentExecutionId } : {}),
    });
  }
  async function check(
    id: string,
    answer: 'approve_once' | 'reject' | 'ask_user' | 'timeout' | 'pending' | 'technical',
    future = false,
    requireApproval = false,
    stopOnTimeout = false,
    now = Date.now(),
  ) {
    const timeout = { startedAt: now - 50, deadlineAt: future ? now + 60000 : now - 1 };
    const fact = await ensureFixtureAuthorizationCheck(store, {
      ...owned,
      targetExecutionId: ids.get(id) ?? id,
      checker,
      policyRevision: 'policy-tool',
      operationKey,
      request: currentDecision().check!.request,
      ...(options.risk ? { review: preparation } : {}),
      timeout,
      requireApproval,
      ...(stopOnTimeout ? { stopOnTimeout: true as const } : {}),
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
      if (answer === 'pending') return fact;
      await store.finishAuthorizationCheck({
        ...owned,
        executionId: fact.execution.id,
        status: 'succeeded',
        result: await fixtureCheckResult(
          store,
          fact.execution.id,
          {
            content: JSON.stringify(
              options.risk
                ? {
                    risk:
                      answer === 'approve_once'
                        ? 'ordinary'
                        : answer === 'reject'
                          ? 'critical'
                          : 'high',
                    reason: 'Exact fixture risk',
                  }
                : { decision: answer, reason: 'Exact fixture decision' },
            ),
            toolCalls: [],
            finishReason: 'stop',
            usage: {},
          },
          {
            decision: answer,
            reason: options.risk ? 'Exact fixture risk' : 'Exact fixture decision',
          },
          options.risk
            ? {
                risk:
                  answer === 'approve_once'
                    ? 'ordinary'
                    : answer === 'reject'
                      ? 'critical'
                      : 'high',
              }
            : undefined,
        ),
      });
    }
    return fact;
  }
  function resolve(id: string, current = currentDecision(), timedOutCheckId?: string) {
    return resolveFixtureAutoAuthorization(store, {
      ...owned,
      targetExecutionId: ids.get(id) ?? id,
      decision: current,
      checker,
      operationKey,
      ...(options.risk ? { review: preparation } : {}),
      ...(timedOutCheckId ? { timedOutCheckId } : {}),
    });
  }
  async function dispatch(
    id: string,
    proof: AutoAuthorizationEvidence,
    current = currentDecision(),
  ) {
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
        ...(proof.materialReviewed ? { materialReviewed: true as const } : {}),
      },
      requirements: [],
      freshness: { checked: true, source },
    });
  }
  async function humanApproval(
    id: string,
    selection: 'approve_once' | 'same_command' = 'approve_once',
    commandDigest?: string,
    coversDefaultCheck = true,
  ) {
    const target = (await store.getExecution(ids.get(id) ?? id))!;
    const binding = {
      ...owned,
      executionId: target.id,
      attempt: 1,
      definitionId: target.definitionId,
      definitionVersion: target.definitionVersion,
      inputDigest: await semanticDigest(target.input),
      policyRevision: 'policy-tool',
    };
    const scopeOffer = (coversDefaultCheck ? fixtureGrant : basicFixtureGrant)(
      target.definitionId!,
      commandDigest ?? target.input,
      target.kind as 'tool' | 'job',
    );
    const interactionId = `card-${id}`;
    await store.requestInteraction({
      ...binding,
      interactionId,
      kind: 'approval',
      requiredRefs: [],
      source: target.decisionSource,
      request: {
        options: approvalOptions([scopeOffer]) as unknown as Json,
      },
    });
    await store.answerInteraction({
      expectedStoreId,
      subjectId: 'owner',
      commandId: `answer-${id}`,
      presentationSessionId: 's',
      interactionId,
      expectedRevision: '1',
      answer: {
        kind: 'approval',
        decision: 'approve',
        optionId:
          selection === 'same_command'
            ? `scope-${fixtureGrant(target.definitionId!, commandDigest ?? target.input, target.kind as 'tool' | 'job').scopeDigest}`
            : 'once',
      },
    });
    await store.acceptInteractionDecision({
      ...binding,
      interactionId,
      decisionRevision: '2',
      requirements: [],
      freshness: { checked: true, source: target.decisionSource },
    });
    return {
      allowed: true as const,
      revision: 'policy-tool',
      definitionVersion: target.definitionVersion,
      inputDigest: binding.inputDigest,
      snapshot: currentDecision().snapshot,
      interactionId,
      decisionRevision: '2',
    };
  }
  return {
    store,
    owned,
    run,
    plan,
    check,
    resolve,
    dispatch,
    humanApproval,
    currentDecision,
    preparation,
    material(id: string) {
      const physical = new Database(join(root, 'new', 'core.db'));
      const operations = new SqliteOperations(physical, true);
      try {
        return authorizationTaskContext(
          operations,
          operations.row('SELECT * FROM execution WHERE id=?', ids.get(id) ?? id)!,
          operationKey,
        ) as Record<string, Json>;
      } finally {
        operations.releaseStatements();
        physical.close();
      }
    },
    close: async () => {
      await store.close();
      removeTemporaryDirectory(root);
    },
  };
}

test('a risk ask followed by exact human approval is inherited by its own Job without a second review', async () => {
  const f = await fixture({ risk: true });
  try {
    const target = await f.plan('risk-human');
    await f.check('risk-human', 'ask_user');
    const binding = {
      ...f.owned,
      executionId: target.id,
      attempt: 1,
      definitionId: 'shell.execute',
      definitionVersion: '1',
      inputDigest: await semanticDigest(target.input),
      policyRevision: 'policy-tool',
    };
    await f.store.requestInteraction({
      ...binding,
      interactionId: 'risk-card',
      kind: 'approval',
      requiredRefs: [],
      source: target.decisionSource,
      request: {
        options: [
          { optionId: 'once', kind: 'once', presentation: { label: '仅此次', details: [] } },
        ],
      },
    });
    await f.store.answerInteraction({
      expectedStoreId: f.owned.expectedStoreId,
      subjectId: 'owner',
      commandId: 'risk-answer',
      presentationSessionId: 's',
      interactionId: 'risk-card',
      expectedRevision: '1',
      answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
    });
    await f.store.acceptInteractionDecision({
      ...binding,
      interactionId: 'risk-card',
      decisionRevision: '2',
      requirements: [],
      freshness: { checked: true, source: target.decisionSource },
    });
    await f.store.markDispatching({
      ...f.owned,
      executionId: target.id,
      authorization: {
        allowed: true,
        revision: 'policy-tool',
        definitionVersion: '1',
        inputDigest: binding.inputDigest,
        snapshot: f.currentDecision().snapshot,
        interactionId: 'risk-card',
        decisionRevision: '2',
        materialReviewed: true,
      },
      requirements: [],
      freshness: { checked: true, source: target.decisionSource },
    });
    const job = await f.plan('risk-human-job', 'job', target.id);
    const proof = await f.resolve('risk-human-job', f.currentDecision('job'));
    expect(proof).toMatchObject({ reason: 'parent_review', materialReviewed: true });
    await f.dispatch('risk-human-job', proof!, f.currentDecision('job'));
    expect((await f.store.getExecution(job.id))!.authorization?.policy).toMatchObject({
      reason: 'parent_review',
    });
    const changed = await f.plan('risk-human-changed', 'job', target.id);
    expect(
      await resolveFixtureAutoAuthorization(f.store, {
        ...f.owned,
        targetExecutionId: changed.id,
        decision: f.currentDecision('job'),
        checker,
        operationKey,
        review: { ...f.preparation!, fingerprint: 'c'.repeat(64) },
      }),
    ).toBeNull();
  } finally {
    await f.close();
  }
});

test('risk classification preserves raw risk, omits business material and cannot cache nonreusable preparation', async () => {
  const f = await fixture({ risk: true, reusable: false });
  try {
    const tool = await f.plan('risk-tool');
    const checked = await f.check('risk-tool', 'approve_once');
    expect(checked.input).toMatchObject({
      behavior: { contractRef: 'kite.authorization-check' },
      decisionContext: null,
      review: { reusable: false },
    });
    expect(checked.input).not.toHaveProperty('authorizationContext');
    const result = await f.store.getAuthorizationCheck({
      ...f.owned,
      targetExecutionId: tool.id,
      checkExecutionId: checked.execution.id,
      policyRevision: 'policy-tool',
      request: f.currentDecision().check!.request,
      checker,
    });
    expect(result).toMatchObject({ decision: 'approve_once', materialReviewed: true });
    expect((await f.store.getExecution(checked.execution.id))!.result).toMatchObject({
      content: JSON.stringify({ risk: 'ordinary', reason: 'Exact fixture risk' }),
    });
    await f.store.markDispatching({
      ...f.owned,
      executionId: tool.id,
      authorization: {
        allowed: true,
        revision: 'policy-tool',
        definitionVersion: '1',
        inputDigest: await semanticDigest(tool.input),
        snapshot: f.currentDecision().snapshot,
        checkExecutionId: checked.execution.id,
        materialReviewed: true,
      },
      requirements: [],
      freshness: { checked: true, source: tool.decisionSource },
    });
    await f.plan('risk-job', 'job', tool.id);
    const inherited = await f.resolve('risk-job', f.currentDecision('job'));
    expect(inherited).toMatchObject({ reason: 'parent_review', materialReviewed: true });
    await f.dispatch('risk-job', inherited!, f.currentDecision('job'));
    await f.plan('independent');
    expect(await f.resolve('independent')).toBeNull();
  } finally {
    await f.close();
  }
});

test('risk human dispatch cannot drop reviewed-material proof or override a critical classification', async () => {
  const f = await fixture({ risk: true });
  try {
    for (const answer of ['ask_user', 'reject'] as const) {
      const target = await f.plan(`human-${answer}`);
      await f.check(target.id, answer);
      const authorization = await f.humanApproval(target.id);
      const input = {
        ...f.owned,
        executionId: target.id,
        authorization,
        requirements: [],
        freshness: { checked: true as const, source: target.decisionSource },
      };
      await rejects(f.store.markDispatching(input), 'permission_denied');
      if (answer === 'reject')
        await rejects(
          f.store.markDispatching({
            ...input,
            authorization: { ...authorization, materialReviewed: true },
          }),
          'permission_denied',
        );
      else
        await f.store.markDispatching({
          ...input,
          authorization: { ...authorization, materialReviewed: true },
        });
    }
  } finally {
    await f.close();
  }
});

test('risk exact independent cache requires matching reusable material and preserves original risk proof', async () => {
  const f = await fixture({ risk: true });
  try {
    await f.plan('cache-source');
    await f.check('cache-source', 'approve_once');
    const target = await f.plan('cache-target');
    const proof = await f.resolve(target.id);
    expect(proof).toMatchObject({ reason: 'reused_approval', materialReviewed: true });
    await f.dispatch(target.id, proof!);
    const changed = await f.plan('cache-changed');
    expect(
      await resolveFixtureAutoAuthorization(f.store, {
        ...f.owned,
        targetExecutionId: changed.id,
        decision: f.currentDecision(),
        checker,
        operationKey,
        review: { ...f.preparation!, fingerprint: 'c'.repeat(64) },
      }),
    ).toBeNull();
  } finally {
    await f.close();
  }
});

test('current Auto command grant reaches only its dispatched builtin Tool own Job without claiming current material was reviewed', async () => {
  const f = await fixture({ risk: true });
  const commandDigest = 'e'.repeat(64);
  try {
    await f.plan('grant-original');
    await f.check('grant-original', 'ask_user');
    await f.humanApproval('grant-original', 'same_command', commandDigest);
    const parent = await f.plan('grant-parent');
    const grant = await f.store.getPermissionGrant({
      expectedStoreId: f.owned.expectedStoreId,
      executionId: parent.id,
      offers: [fixtureGrant(parent.definitionId!, commandDigest)],
    });
    expect(grant).not.toBeNull();
    await f.store.markDispatching({
      ...f.owned,
      executionId: parent.id,
      authorization: {
        allowed: true,
        revision: 'policy-tool',
        definitionVersion: '1',
        inputDigest: await semanticDigest(parent.input),
        snapshot: f.currentDecision().snapshot,
        grant: grant!,
      },
      requirements: [],
      freshness: { checked: true, source: parent.decisionSource },
    });
    const job = await f.plan('grant-job', 'job', parent.id);
    const current = {
      ...f.owned,
      targetExecutionId: job.id,
      decision: f.currentDecision('job'),
      checker,
      operationKey: 'f'.repeat(64),
      review: { ...f.preparation!, fingerprint: 'c'.repeat(64), reusable: false },
    };
    const proof = await resolveFixtureAutoAuthorization(f.store, current);
    expect(proof).toMatchObject({ reason: 'parent_review' });
    expect(proof).not.toHaveProperty('materialReviewed');
    await f.dispatch(job.id, proof!, f.currentDecision('job'));
    expect((await f.store.getExecution(job.id))!.authorization?.policy).toMatchObject({
      reason: 'parent_review',
      sourceExecutionId: parent.id,
    });
    const changed = await f.plan('grant-changed', 'job', parent.id, 'printf CHANGED');
    expect(
      await resolveFixtureAutoAuthorization(f.store, { ...current, targetExecutionId: changed.id }),
    ).toBeNull();
    const independent = await f.plan('grant-independent');
    expect(
      await resolveFixtureAutoAuthorization(f.store, {
        ...current,
        targetExecutionId: independent.id,
        decision: f.currentDecision(),
      }),
    ).toBeNull();
    const manualGate = await f.plan('grant-independent-human-gate', 'job', parent.id);
    expect(
      await resolveFixtureAutoAuthorization(f.store, {
        ...current,
        targetExecutionId: manualGate.id,
        decision: {
          ...f.currentDecision('job'),
          check: { ...f.currentDecision('job').check!, requireApproval: true },
        },
      }),
    ).toBeNull();
    const unbound = await f.plan('grant-without-owner-bridge', 'job', parent.id);
    expect(
      await resolveFixtureAutoAuthorization(f.store, {
        ...current,
        targetExecutionId: unbound.id,
        decision: f.currentDecision('job'),
        parentProof: null,
      }),
    ).toBeNull();
    // The literal command is unchanged, but its resolved directory changed after
    // the Tool was authorized. A fresh Job snapshot must not inherit that grant.
    const changedDirectory = await f.plan('grant-directory-changed', 'job', parent.id);
    const directorySnapshot = JSON.parse(JSON.stringify(f.currentDecision('job').snapshot));
    directorySnapshot.data.capability.autoReviewKey = 'd'.repeat(64);
    expect(
      await resolveFixtureAutoAuthorization(f.store, {
        ...current,
        targetExecutionId: changedDirectory.id,
        decision: { ...f.currentDecision('job'), snapshot: directorySnapshot },
      }),
    ).toBeNull();
    const changedScope = await f.plan('grant-scope-changed', 'job', parent.id);
    const scopedDecision = f.currentDecision('job');
    const scopedSnapshot = JSON.parse(JSON.stringify(scopedDecision.snapshot));
    scopedSnapshot.data.capability.executionScope.network = 'none';
    expect(
      await resolveFixtureAutoAuthorization(f.store, {
        ...current,
        targetExecutionId: changedScope.id,
        decision: { ...scopedDecision, snapshot: scopedSnapshot },
      }),
    ).toBeNull();
    const changedControl = await f.plan('grant-control-changed', 'job', parent.id);
    expect(
      await resolveFixtureAutoAuthorization(f.store, {
        ...current,
        targetExecutionId: changedControl.id,
        decision: { ...f.currentDecision('job'), controlReads: [] },
      }),
    ).toBeNull();
    const pending = await f.plan('grant-before-clear', 'job', parent.id);
    const beforeClear = await resolveFixtureAutoAuthorization(f.store, {
      ...current,
      targetExecutionId: pending.id,
    });
    expect(beforeClear?.reason).toBe('parent_review');
    await f.store.clearPermissionGrants({
      expectedStoreId: f.owned.expectedStoreId,
      subjectId: 'owner',
      sessionId: 's',
      commandId: 'clear-current-grant',
      ifRevision: grant!.revision,
    });
    await rejects(
      f.dispatch(pending.id, beforeClear!, f.currentDecision('job')),
      'permission_grant_changed',
    );
    expect(
      await resolveFixtureAutoAuthorization(f.store, { ...current, targetExecutionId: pending.id }),
    ).toBeNull();
  } finally {
    await f.close();
  }
});

test('revoked original human command grant cannot authorize its later Tool child', async () => {
  const f = await fixture({ risk: true });
  const commandDigest = 'e'.repeat(64);
  try {
    await f.plan('revoke-original');
    await f.check('revoke-original', 'ask_user');
    const original = await f.humanApproval('revoke-original', 'same_command', commandDigest);
    const parent = await f.plan('revoke-parent');
    const grant = await f.store.getPermissionGrant({
      expectedStoreId: f.owned.expectedStoreId,
      executionId: parent.id,
      offers: [fixtureGrant(parent.definitionId!, commandDigest)],
    });
    await f.store.markDispatching({
      ...f.owned,
      executionId: parent.id,
      authorization: {
        allowed: true,
        revision: 'policy-tool',
        definitionVersion: '1',
        inputDigest: await semanticDigest(parent.input),
        snapshot: f.currentDecision().snapshot,
        grant: grant!,
      },
      requirements: [],
      freshness: { checked: true, source: parent.decisionSource },
    });
    const child = await f.plan('revoke-child', 'job', parent.id);
    const proof = await f.resolve(child.id, f.currentDecision('job'));
    expect(proof?.reason).toBe('parent_review');
    await f.store.refreshApproval({
      ...f.owned,
      executionId: 'revoke-original',
      interactionId: original.interactionId,
      policyRevision: 'new-tool-policy',
    });
    await rejects(
      f.dispatch(child.id, proof!, f.currentDecision('job')),
      'permission_grant_changed',
    );
    expect(await f.resolve(child.id, f.currentDecision('job'))).toBeNull();
  } finally {
    await f.close();
  }
});

test('timeout with no preparation passes only its exact builtin child despite later material and never marks material approved', async () => {
  const f = await fixture({ risk: true, missingPreparation: true });
  try {
    const tool = await f.plan('risk-timeout');
    const check = await f.check('risk-timeout', 'timeout');
    const proof = await f.resolve('risk-timeout', f.currentDecision(), check.execution.id);
    expect(proof).toMatchObject({ reason: 'timeout_continue' });
    expect(proof).not.toHaveProperty('materialReviewed');
    await f.dispatch('risk-timeout', proof!);
    const job = await f.plan('risk-timeout-job', 'job', tool.id);
    const next = {
      ...f.owned,
      targetExecutionId: job.id,
      decision: f.currentDecision('job'),
      checker,
      operationKey: 'c'.repeat(64),
      review: {
        instructions: shellRiskInstructions,
        material: { cwd: '/fixture' },
        fingerprint: 'd'.repeat(64),
        reusable: false,
      },
    };
    const inherited = await resolveFixtureAutoAuthorization(f.store, next);
    expect(inherited).toMatchObject({ reason: 'parent_review' });
    expect(inherited).not.toHaveProperty('materialReviewed');
    await f.dispatch('risk-timeout-job', inherited!, f.currentDecision('job'));
    const different = await f.plan('different-command', 'job', tool.id, 'printf DIFFERENT');
    expect(
      await resolveFixtureAutoAuthorization(f.store, { ...next, targetExecutionId: different.id }),
    ).toBeNull();
  } finally {
    await f.close();
  }
});

test('compact task material retains exact prior Shell Job unknown effects without counting its Tool twice', async () => {
  const f = await fixture();
  try {
    const first = await f.plan('first');
    const check = await f.check('first', 'approve_once');
    await f.store.markDispatching({
      ...f.owned,
      executionId: first.id,
      authorization: {
        allowed: true,
        revision: 'policy-tool',
        definitionVersion: '1',
        inputDigest: await semanticDigest(first.input),
        snapshot: decision().snapshot,
        checkExecutionId: check.execution.id,
      },
      requirements: [],
      freshness: { checked: true, source: first.decisionSource },
    });
    const job = await f.plan('first-job', 'job', 'first');
    const proof = await f.resolve('first-job', decision('job'));
    await f.dispatch('first-job', proof!, decision('job'));
    await f.plan('next');
    await f.store.finishExecution({
      ...f.owned,
      executionId: job.id,
      status: 'outcome_unknown',
      result: {
        outcome: 'outcome_unknown',
        details: { code: 'operation_unverifiable' },
        content: 'Unknown; do not replay.',
      },
    });
    const material = f.material('next');
    expect(material.priorEffects).toEqual([
      expect.objectContaining({
        executionId: job.id,
        kind: 'job',
        status: 'outcome_unknown',
        dispatched: true,
        sourceKind: 'policy',
        outcome: 'outcome_unknown',
        code: 'operation_unverifiable',
      }),
    ]);
    expect(material.effectEvidenceScope).toBe('same_operation_only');
    expect(material.effectEvidenceNote).toContain(
      'Missing entries do not prove an effect never happened',
    );
  } finally {
    await f.close();
  }
});

test('compact task material carries a verified refusal with its exact original target, not generic failed-tool text', async () => {
  const f = await fixture();
  try {
    await f.plan('refused');
    const check = await f.check('refused', 'reject');
    await f.store.finishExecution({
      ...f.owned,
      executionId: 'refused',
      status: 'failed',
      result: {
        outcome: 'failed',
        details: { code: 'permission_denied' },
        content: 'Refused exact operation.',
      },
    });
    await f.plan('next');
    expect(f.material('next').refusals).toEqual([
      expect.objectContaining({
        executionId: 'refused',
        sourceId: check.execution.id,
        decision: 'reject',
        input: { command: 'printf fixture', key: 'refused' },
        reason: 'Exact fixture decision',
      }),
    ]);
  } finally {
    await f.close();
  }
});

test('an actual human denial reaches compact task evidence without consuming an approval grant', async () => {
  const f = await fixture();
  try {
    const target = await f.plan('human-refused');
    const gate = new InteractionGate(f.store, {
      async authorize() {
        return {
          allowed: false,
          revision: 'policy-tool',
          approval: { request: 'Exact original operation' },
        };
      },
    });
    const outcome = gate
      .authorize(
        {
          ...f.owned,
          executionId: target.id,
          signal: new AbortController().signal,
          requiredRefs: [],
          requirements: async () => [],
        },
        {
          kind: 'tool',
          sessionId: 's',
          runId: f.run.id,
          executionId: target.id,
          definitionId: target.definitionId,
          definitionVersion: target.definitionVersion,
          input: target.input,
          signal: new AbortController().signal,
        },
        target.decisionSource,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    let card: InteractionRecord | undefined;
    const deadline = Date.now() + 3000;
    do {
      card = (
        await f.store.listInteractions({ expectedStoreId: f.owned.expectedStoreId, sessionId: 's' })
      ).interactions[0];
      if (card) break;
      if (Date.now() >= deadline) throw new Error('human_card_not_created');
      await Bun.sleep(5);
    } while (!card);
    await f.store.answerInteraction({
      expectedStoreId: f.owned.expectedStoreId,
      subjectId: 'owner',
      commandId: 'deny-original',
      presentationSessionId: 's',
      interactionId: card.id,
      expectedRevision: card.revision,
      answer: { kind: 'approval', decision: 'deny' },
    });
    expect(await outcome).toMatchObject({ code: 'approval_denied' });
    await f.store.finishExecution({
      ...f.owned,
      executionId: target.id,
      status: 'failed',
      result: {
        outcome: 'failed',
        content: 'approval_denied',
        details: { code: 'approval_denied', adapterAttempted: false, dispatchCommitted: false },
      },
    });
    expect((await f.store.getExecution(target.id))?.authorization?.human).toMatchObject({
      state: 'answered',
      decision: 'deny',
      accepted: false,
      acceptedDecisionRevision: null,
    });
    await f.plan('after-human-refusal');
    expect(f.material('after-human-refusal').refusals).toEqual([
      expect.objectContaining({
        executionId: target.id,
        sessionId: 's',
        decision: 'deny',
        sourceId: card.id,
        input: target.input,
      }),
    ]);
  } finally {
    await f.close();
  }
});

test('a pending check keeps its sealed prior-effect snapshot when that exact earlier Job settles', async () => {
  const f = await fixture();
  try {
    const first = await f.plan('first');
    const original = await f.check('first', 'approve_once');
    await f.store.markDispatching({
      ...f.owned,
      executionId: first.id,
      authorization: {
        allowed: true,
        revision: 'policy-tool',
        definitionVersion: '1',
        inputDigest: await semanticDigest(first.input),
        snapshot: decision().snapshot,
        checkExecutionId: original.execution.id,
      },
      requirements: [],
      freshness: { checked: true, source: first.decisionSource },
    });
    const job = await f.plan('first-job', 'job', 'first');
    await f.dispatch(
      'first-job',
      (await f.resolve('first-job', decision('job')))!,
      decision('job'),
    );
    await f.plan('pending');
    const check = await f.check('pending', 'pending');
    expect((check.input as Record<string, Json>).authorizationContext).toHaveProperty(
      'priorEffects',
    );
    await f.store.finishExecution({
      ...f.owned,
      executionId: job.id,
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'completed' },
    });
    await f.store.finishExecution({
      ...f.owned,
      executionId: first.id,
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'completed' },
    });
    const again = await ensureFixtureAuthorizationCheck(f.store, {
      ...f.owned,
      targetExecutionId: 'pending',
      checker,
      policyRevision: 'policy-tool',
      operationKey,
      request: decision().check!.request,
      timeout: { startedAt: Date.now(), deadlineAt: Date.now() + 3000 },
    });
    expect(again.created).toBe(false);
    expect(again.execution.id).toBe(check.execution.id);
    expect(again.input).toEqual(check.input);
    const changed = await ensureFixtureAuthorizationCheck(f.store, {
      ...f.owned,
      targetExecutionId: 'pending',
      checker,
      policyRevision: 'changed-authority',
      operationKey,
      request: decision().check!.request,
      timeout: { startedAt: Date.now(), deadlineAt: Date.now() + 3000 },
    });
    expect(changed.created).toBe(true);
    expect(changed.execution.id).not.toBe(check.execution.id);
  } finally {
    await f.close();
  }
});

test('a completed exact approval is reusable, while forged proof, policy changes and refusal revoke dispatch', async () => {
  const f = await fixture();
  try {
    await f.plan('first');
    await f.check('first', 'approve_once');
    await f.plan('second');
    const proof = await f.resolve('second');
    expect(proof?.reason).toBe('reused_approval');
    expect(await f.resolve('second', { ...decision(), revision: 'different-policy' })).toBeNull();
    expect(
      await f.resolve('second', {
        ...decision(),
        check: { ...decision().check!, requireApproval: true },
      }),
    ).toBeNull();
    await rejects(
      f.dispatch('second', { ...proof!, policyEvidenceId: 'forged' }),
      'authorization_policy_unverifiable',
    );
    await f.plan('refused');
    await f.store.finishExecution({
      ...f.owned,
      executionId: 'refused',
      status: 'failed',
      result: { code: 'permission_denied' },
    });
    await rejects(f.dispatch('second', proof!), 'authorization_policy_changed');
    expect((await f.store.getExecution('second'))?.status).toBe('planned');
  } finally {
    await f.close();
  }
});

test('third and fourth exact operations reuse the original approval after their own sealed Tool and Job effects', async () => {
  const f = await fixture();
  try {
    await f.plan('first');
    const check = await f.check('first', 'approve_once');
    const original = (await f.store.getExecution('first'))!;
    await f.store.markDispatching({
      ...f.owned,
      executionId: original.id,
      authorization: {
        allowed: true,
        revision: 'policy-tool',
        definitionVersion: '1',
        inputDigest: await semanticDigest(original.input),
        snapshot: decision().snapshot,
        checkExecutionId: check.execution.id,
      },
      requirements: [],
      freshness: { checked: true, source: original.decisionSource },
    });
    await f.plan('first-job', 'job', 'first');
    const firstJobProof = await f.resolve('first-job', decision('job'));
    expect(firstJobProof?.reason).toBe('parent_review');
    await f.dispatch('first-job', firstJobProof!, decision('job'));
    const firstJob = await f.store.getOperation({
      originStoreId: f.owned.expectedStoreId,
      extensionId: 'builtin.shell',
      sessionId: 's',
      subjectId: 'owner',
      key: 'first-job',
    });
    await f.store.finishExecution({
      ...f.owned,
      executionId: firstJob!.executionId!,
      status: 'succeeded',
      result: { content: 'done' },
    });
    await f.store.finishExecution({
      ...f.owned,
      executionId: 'first',
      status: 'succeeded',
      result: { content: 'done' },
    });
    for (const id of ['second', 'third', 'fourth']) {
      await f.plan(id);
      const proof = await f.resolve(id);
      expect(proof?.reason).toBe('reused_approval');
      await f.dispatch(id, proof!);
      expect((await f.store.getExecution(id))?.authorization?.policy).toMatchObject({
        reason: 'reused_approval',
        sourceExecutionId: 'first',
        checkExecutionId: check.execution.id,
      });
      await f.plan(`${id}-job`, 'job', id);
      const jobProof = await f.resolve(`${id}-job`, decision('job'));
      expect(jobProof?.reason).toBe('parent_review');
      await f.dispatch(`${id}-job`, jobProof!, decision('job'));
      const job = await f.store.getOperation({
        originStoreId: f.owned.expectedStoreId,
        extensionId: 'builtin.shell',
        sessionId: 's',
        subjectId: 'owner',
        key: `${id}-job`,
      });
      await f.store.finishExecution({
        ...f.owned,
        executionId: job!.executionId!,
        status: 'succeeded',
        result: { content: 'done' },
      });
      await f.store.finishExecution({
        ...f.owned,
        executionId: id,
        status: 'succeeded',
        result: { content: 'done' },
      });
    }
    // A different effect has no proof bound to this original approval, even with the same command.
    await f.plan('independent');
    const independent = (await f.store.getExecution('independent'))!;
    await f.store.markDispatching({
      ...f.owned,
      executionId: independent.id,
      authorization: {
        allowed: true,
        revision: 'independent',
        definitionVersion: '1',
        inputDigest: await semanticDigest(independent.input),
        snapshot: decision().snapshot,
      },
      requirements: [],
      freshness: { checked: true, source: independent.decisionSource },
    });
    await f.store.finishExecution({
      ...f.owned,
      executionId: independent.id,
      status: 'succeeded',
      result: { content: 'done' },
    });
    await f.plan('after-independent');
    expect(await f.resolve('after-independent')).toBeNull();
  } finally {
    await f.close();
  }
});

test('an original Tool child without its exact inherited approval proof remains an intervening effect', async () => {
  const f = await fixture();
  try {
    await f.plan('first');
    const check = await f.check('first', 'approve_once');
    const original = (await f.store.getExecution('first'))!;
    await f.store.markDispatching({
      ...f.owned,
      executionId: 'first',
      authorization: {
        allowed: true,
        revision: 'policy-tool',
        definitionVersion: '1',
        inputDigest: await semanticDigest(original.input),
        snapshot: decision().snapshot,
        checkExecutionId: check.execution.id,
      },
      requirements: [],
      freshness: { checked: true, source: original.decisionSource },
    });
    await f.plan('independent-child', 'job', 'first');
    const ref = await f.store.getOperation({
      originStoreId: f.owned.expectedStoreId,
      extensionId: 'builtin.shell',
      sessionId: 's',
      subjectId: 'owner',
      key: 'independent-child',
    });
    const child = (await f.store.getExecution(ref!.executionId!))!;
    await f.store.markDispatching({
      ...f.owned,
      executionId: child.id,
      authorization: {
        allowed: true,
        revision: 'independent',
        definitionVersion: '1',
        inputDigest: await semanticDigest(child.input),
        snapshot: decision('job').snapshot,
      },
      requirements: [],
      freshness: { checked: true, source: child.decisionSource },
    });
    await f.store.finishExecution({
      ...f.owned,
      executionId: child.id,
      status: 'succeeded',
      result: { content: 'other effect' },
    });
    await f.store.finishExecution({
      ...f.owned,
      executionId: 'first',
      status: 'succeeded',
      result: { content: 'done' },
    });
    await f.plan('next');
    expect(await f.resolve('next')).toBeNull();
  } finally {
    await f.close();
  }
});

test('an unknown result is not excluded merely because its approval was reused', async () => {
  const f = await fixture();
  try {
    await f.plan('first');
    const check = await f.check('first', 'approve_once');
    const original = (await f.store.getExecution('first'))!;
    await f.store.markDispatching({
      ...f.owned,
      executionId: 'first',
      authorization: {
        allowed: true,
        revision: 'policy-tool',
        definitionVersion: '1',
        inputDigest: await semanticDigest(original.input),
        snapshot: decision().snapshot,
        checkExecutionId: check.execution.id,
      },
      requirements: [],
      freshness: { checked: true, source: original.decisionSource },
    });
    await f.store.finishExecution({
      ...f.owned,
      executionId: 'first',
      status: 'succeeded',
      result: { content: 'done' },
    });
    await f.plan('second');
    const proof = await f.resolve('second');
    await f.dispatch('second', proof!);
    await f.store.finishExecution({
      ...f.owned,
      executionId: 'second',
      status: 'outcome_unknown',
      result: { content: 'unconfirmed effect' },
    });
    await f.plan('third');
    expect(await f.resolve('third')).toBeNull();
  } finally {
    await f.close();
  }
});

test('timeout defaults to allow within the requested tool scope without an approval cache entry', async () => {
  const f = await fixture();
  try {
    await f.plan('slow');
    const fact = await f.check('slow', 'timeout');
    const proof = await f.resolve('slow', decision(), fact.execution.id);
    expect(proof?.reason).toBe('timeout_continue');
    expect(proof?.snapshot).toMatchObject({
      data: { capability: { executionScope: { filesystem: 'full_access', network: 'internet' } } },
    });
    await f.dispatch('slow', proof!);
    await f.plan('later');
    expect(await f.resolve('later')).toBeNull();
    await rejects(
      f.store.finishAuthorizationCheck({
        ...f.owned,
        executionId: fact.execution.id,
        status: 'succeeded',
        result: { content: 'late' },
      }),
      'terminal_conflict',
    );
    expect((await f.store.getExecution(fact.execution.id))?.result).toMatchObject({
      code: 'authorization_check_timeout',
    });
  } finally {
    await f.close();
  }
});

test('an early timer or a prior real decision cannot be converted to timeout authority', async () => {
  const f = await fixture();
  try {
    await f.plan('early');
    await rejects(f.check('early', 'timeout', true), 'authorization_check_timeout_invalid');
    for (const answer of ['approve_once', 'reject', 'ask_user'] as const) {
      await f.plan(answer);
      const fact = await f.check(answer, answer);
      expect(await f.resolve(answer, decision(), fact.execution.id)).toBeNull();
      await rejects(
        f.store.finishAuthorizationCheck({
          ...f.owned,
          executionId: fact.execution.id,
          status: 'failed',
          result: { code: 'authorization_check_timeout', deadlineAt: Date.now() - 1 },
        }),
        'terminal_conflict',
      );
    }
  } finally {
    await f.close();
  }
});

test('an expired fail-closed check cannot publish a completed decision or grant timeout authority', async () => {
  const f = await fixture();
  try {
    await f.plan('strict-timeout');
    const now = Date.now();
    // The original deadline has already elapsed, but the timeout writer has not settled it.
    await rejects(
      f.check('strict-timeout', 'approve_once', false, false, true, now),
      'authorization_check_timeout',
    );
    const fact = await f.check('strict-timeout', 'timeout', false, false, true, now);
    expect((await f.store.getExecution(fact.execution.id))?.result).toMatchObject({
      code: 'authorization_check_timeout',
    });
    expect(await f.resolve('strict-timeout', decision(), fact.execution.id)).toBeNull();
  } finally {
    await f.close();
  }
});

test('only the actual equal-scope Shell child inherits the parent review and still gets its own exact dispatch proof', async () => {
  const f = await fixture();
  try {
    await f.plan('parent');
    const fact = await f.check('parent', 'approve_once');
    const parent = (await f.store.getExecution('parent'))!;
    await f.store.markDispatching({
      ...f.owned,
      executionId: 'parent',
      authorization: {
        allowed: true,
        revision: 'policy-tool',
        definitionVersion: '1',
        inputDigest: await semanticDigest(parent.input),
        snapshot: decision().snapshot,
        checkExecutionId: fact.execution.id,
      },
      requirements: [],
      freshness: { checked: true, source: parent.decisionSource },
    });
    await f.plan('job', 'job', 'parent');
    const proof = await f.resolve('job', decision('job'));
    expect(proof?.reason).toBe('parent_review');
    await f.dispatch('job', proof!, decision('job'));
    await f.plan('outsider');
    const outsider = (await f.store.getExecution('outsider'))!;
    await f.store.markDispatching({
      ...f.owned,
      executionId: 'outsider',
      authorization: {
        allowed: true,
        revision: 'p',
        definitionVersion: '1',
        inputDigest: await semanticDigest(outsider.input),
        snapshot: decision().snapshot,
      },
      requirements: [],
      freshness: { checked: true, source: outsider.decisionSource },
    });
    await f.plan('unrelated', 'job', 'outsider');
    expect(await f.resolve('unrelated', decision('job'))).toBeNull();
  } finally {
    await f.close();
  }
});

test('read-only observations preserve cached authority but an intervening write invalidates it before dispatch', async () => {
  const f = await fixture();
  try {
    await f.plan('original');
    const check = await f.check('original', 'approve_once');
    const original = (await f.store.getExecution('original'))!;
    await f.store.markDispatching({
      ...f.owned,
      executionId: 'original',
      authorization: {
        allowed: true,
        revision: 'policy-tool',
        definitionVersion: '1',
        inputDigest: await semanticDigest(original.input),
        snapshot: decision().snapshot,
        checkExecutionId: check.execution.id,
      },
      requirements: [],
      freshness: { checked: true, source: original.decisionSource },
    });
    await f.store.finishExecution({
      ...f.owned,
      executionId: 'original',
      status: 'succeeded',
      result: { content: 'done' },
    });
    async function effect(id: string, effects: string[]) {
      await f.plan(id);
      const target = (await f.store.getExecution(id))!;
      const snapshot = structuredClone(decision().snapshot!);
      (snapshot.data as { capability: { effects: string[] } }).capability.effects = effects;
      await f.store.markDispatching({
        ...f.owned,
        executionId: id,
        authorization: {
          allowed: true,
          revision: 'observation',
          definitionVersion: '1',
          inputDigest: await semanticDigest(target.input),
          snapshot,
        },
        requirements: [],
        freshness: { checked: true, source: target.decisionSource },
      });
      await f.store.finishExecution({
        ...f.owned,
        executionId: id,
        status: 'succeeded',
        result: { content: 'observed' },
      });
    }
    await effect('read', ['read']);
    await f.plan('next');
    const proof = await f.resolve('next');
    expect(proof?.reason).toBe('reused_approval');
    await effect('write', ['workspace_write']);
    expect(await f.resolve('next')).toBeNull();
    await rejects(f.dispatch('next', proof!), 'authorization_policy_changed');
  } finally {
    await f.close();
  }
});

test('timeout preserves received partial output and usage, and historical policy display survives later refusal', async () => {
  const f = await fixture();
  try {
    await f.plan('partial');
    const check = await f.check('partial', 'pending');
    await f.store.persistAuthorizationCheckPartial({
      ...f.owned,
      executionId: check.execution.id,
      content: 'received prefix',
      reasoning: 'received reasoning',
      firstOutput: 'reasoning',
      usage: { inputTokens: 42 },
    });
    const timeout = (check.input as { timeout: { deadlineAt: number } }).timeout;
    await f.store.finishAuthorizationCheck({
      ...f.owned,
      executionId: check.execution.id,
      status: 'failed',
      result: {
        code: 'authorization_check_timeout',
        deadlineAt: timeout.deadlineAt,
        incomplete: true,
        timing: {
          prepareMs: 5,
          queueMs: 7,
          providerMs: 13,
          totalMs: 25,
          startedAt: -1,
          budgetMs: -1,
          deadlineAt: -1,
          private: 'not persisted',
        },
      },
    });
    expect((await f.store.getExecution(check.execution.id))?.result).toMatchObject({
      content: 'received prefix',
      reasoning: 'received reasoning',
      firstOutput: 'reasoning',
      usage: { inputTokens: 42 },
      timing: {
        budgetMs: 49,
        deadlineAt: timeout.deadlineAt,
        prepareMs: 5,
        queueMs: 7,
        providerMs: 13,
        totalMs: 25,
      },
    });
    const proof = await f.resolve('partial', decision(), check.execution.id);
    await f.dispatch('partial', proof!);
    const before = (await f.store.getExecution('partial'))?.authorization?.policy;
    expect(before).toMatchObject({
      evidenceId: proof!.policyEvidenceId,
      reason: 'timeout_continue',
      checkExecutionId: check.execution.id,
      requestedScope: { filesystem: 'full_access', network: 'internet' },
      effectiveScope: { filesystem: 'full_access', network: 'internet' },
    });
    await f.plan('refusal');
    await f.store.finishExecution({
      ...f.owned,
      executionId: 'refusal',
      status: 'failed',
      result: { details: { code: 'approval_denied' } },
    });
    expect((await f.store.getExecution('partial'))?.authorization?.policy).toEqual(before);
  } finally {
    await f.close();
  }
});

test('timeout retains business proof and never widens an independent parent-child filesystem ceiling', async () => {
  const f = await fixture();
  try {
    await f.plan('business');
    const check = await f.check('business', 'timeout');
    const current = decision(),
      narrower = structuredClone(current.snapshot!);
    (narrower.data as { mode: string }).mode = 'accept_edits';
    (
      narrower.data as { capability: { executionScope: { filesystem: string; network: string } } }
    ).capability.executionScope = { filesystem: 'workspace_write', network: 'none' };
    const gate = {
      namespace: 'builtin.planning',
      version: '1',
      data: {
        planning: { status: 'approved', planId: 'p', version: 1, digest: 'exact' },
        originalRun: { sessionId: 's', runId: f.run.id },
      },
    };
    current.snapshot = {
      namespace: 'builtin.business.permissions',
      version: '1',
      data: {
        gate,
        current: {
          namespace: 'agent.permission-intersection',
          version: '1',
          data: {
            policies: [current.snapshot!, narrower].map((snapshot, index) => ({
              scope: index === 0 ? 'parent' : 'child',
              revision: 'exact-current',
              allowed: true,
              snapshot,
            })),
          },
        },
      },
    };
    const proof = await f.resolve('business', current, check.execution.id);
    expect(proof?.snapshot).toMatchObject({
      data: {
        gate,
        current: {
          data: {
            policies: [
              {
                snapshot: {
                  data: {
                    capability: {
                      executionScope: { filesystem: 'full_access', network: 'internet' },
                    },
                  },
                },
              },
              {
                snapshot: {
                  data: {
                    mode: 'accept_edits',
                    capability: {
                      executionScope: { filesystem: 'workspace_write', network: 'none' },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    });
    await f.dispatch('business', proof!, current);
  } finally {
    await f.close();
  }
});

test('only a durable timeout preserves the independent actual human approval gate', async () => {
  const f = await fixture();
  try {
    for (const outcome of ['timeout', 'technical', 'reject'] as const) {
      const id = `human-${outcome}`;
      await f.plan(id);
      const check = await f.check(id, outcome, false, true);
      expect(
        await f.resolve(
          id,
          { ...decision(), check: { ...decision().check!, requireApproval: true } },
          check.execution.id,
        ),
      ).toBeNull();
      const target = (await f.store.getExecution(id))!;
      const binding = {
        ...f.owned,
        executionId: id,
        attempt: 1,
        definitionId: 'shell.execute',
        definitionVersion: '1',
        inputDigest: await semanticDigest(target.input),
        policyRevision: 'policy-tool',
      };
      await f.store.requestInteraction({
        ...binding,
        interactionId: `card-${id}`,
        kind: 'approval',
        requiredRefs: [],
        source: target.decisionSource,
        request: {
          options: [
            { optionId: 'once', kind: 'once', presentation: { label: '仅此次', details: [] } },
          ],
        },
      });
      await f.store.answerInteraction({
        expectedStoreId: f.owned.expectedStoreId,
        subjectId: 'owner',
        commandId: `answer-${id}`,
        presentationSessionId: 's',
        interactionId: `card-${id}`,
        expectedRevision: '1',
        answer: { kind: 'approval', decision: 'approve', optionId: 'once' },
      });
      await f.store.acceptInteractionDecision({
        ...binding,
        interactionId: `card-${id}`,
        decisionRevision: '2',
        requirements: [],
        freshness: { checked: true, source: target.decisionSource },
      });
      const dispatch = f.store.markDispatching({
        ...f.owned,
        executionId: id,
        authorization: {
          allowed: true,
          revision: 'policy-tool',
          definitionVersion: '1',
          inputDigest: binding.inputDigest,
          snapshot: decision().snapshot,
          interactionId: `card-${id}`,
          decisionRevision: '2',
        },
        requirements: [],
        freshness: { checked: true, source: target.decisionSource },
      });
      if (outcome === 'timeout') expect((await dispatch).status).toBe('dispatching');
      else await rejects(dispatch, 'authorization_check_required');
    }
  } finally {
    await f.close();
  }
});

test('timeout Shell Job inherits the exact parent scope and a workspace/offline request never widens', async () => {
  const f = await fixture();
  try {
    await f.plan('timeout-parent');
    const check = await f.check('timeout-parent', 'timeout');
    const proof = await f.resolve('timeout-parent', decision(), check.execution.id);
    await f.dispatch('timeout-parent', proof!);
    await f.plan('timeout-job', 'job', 'timeout-parent');
    const inherited = await f.resolve('timeout-job', decision('job'));
    expect(inherited?.reason).toBe('parent_review');
    expect(inherited?.snapshot).toMatchObject({
      data: { capability: { executionScope: { filesystem: 'full_access', network: 'internet' } } },
    });
    await f.dispatch('timeout-job', inherited!, decision('job'));
    await f.plan('workspace-only');
    const narrowCheck = await f.check('workspace-only', 'timeout');
    const narrow = decision();
    (
      narrow.snapshot!.data as {
        capability: { executionScope: { filesystem: string; network: string } };
      }
    ).capability.executionScope = { filesystem: 'workspace_write', network: 'none' };
    const bounded = await f.resolve('workspace-only', narrow, narrowCheck.execution.id);
    expect(bounded?.snapshot).toMatchObject({
      data: { capability: { executionScope: { filesystem: 'workspace_write', network: 'none' } } },
    });
    await f.dispatch('workspace-only', bounded!, narrow);
  } finally {
    await f.close();
  }
});

test('a parent human range without explicit default-check coverage cannot satisfy its own Job review', async () => {
  const f = await fixture({ risk: true, reusable: false });
  const commandDigest = 'e'.repeat(64);
  try {
    await f.plan('manual-original');
    await f.check('manual-original', 'ask_user');
    await f.humanApproval('manual-original', 'same_command', commandDigest, false);
    const parent = await f.plan('manual-parent');
    const grant = await f.store.getPermissionGrant({
      expectedStoreId: f.owned.expectedStoreId,
      executionId: parent.id,
      offers: [basicFixtureGrant(parent.definitionId!, commandDigest)],
    });
    expect(grant).not.toBeNull();
    await f.store.markDispatching({
      ...f.owned,
      executionId: parent.id,
      authorization: {
        allowed: true,
        revision: 'policy-tool',
        definitionVersion: '1',
        inputDigest: await semanticDigest(parent.input),
        snapshot: f.currentDecision().snapshot,
        grant: grant!,
      },
      requirements: [],
      freshness: { checked: true, source: parent.decisionSource },
    });
    const job = await f.plan('manual-job', 'job', parent.id);
    const before = (await f.store.getMetadata()).lastChangeCursor;
    expect(await f.resolve(job.id, f.currentDecision('job'))).toBeNull();
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
    expect((await f.store.getExecution(job.id))!.status).toBe('planned');
  } finally {
    await f.close();
  }
});
