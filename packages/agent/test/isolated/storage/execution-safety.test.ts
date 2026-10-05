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
async function plannedJob(
  f: Awaited<ReturnType<typeof fixture>>,
  options: Partial<EnsureOperationInput> = {},
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
  return ref;
}
async function dispatchJob(
  f: Awaited<ReturnType<typeof fixture>>,
  executionId: string,
  requirements: RequirementEvaluation[] = [],
) {
  await f.store.markDispatching({
    expectedStoreId: f.expectedStoreId,
    owner: f.owner,
    executionId,
    authorization: {
      allowed: true,
      revision: '1',
      definitionVersion: '1',
      inputDigest: await semanticDigest({ task: 'review' }),
    },
    requirements,
    freshness: { checked: true, source: f.source },
  });
}
async function prepared(
  f: Awaited<ReturnType<typeof fixture>>,
  options: Partial<EnsureOperationInput> = {},
  requirements: RequirementEvaluation[] = [],
) {
  const ref = await plannedJob(f, options);
  await dispatchJob(f, ref.executionId!, requirements);
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

const safety = (f: Awaited<ReturnType<typeof fixture>>, excludeExecutionId?: string) =>
  f.store.readRunExecutionSafety({
    expectedStoreId: f.expectedStoreId,
    subjectId: 'owner',
    sessionId: 's',
    runId: f.run.id,
    ...(excludeExecutionId ? { excludeExecutionId } : {}),
  });
async function safetyRequirement(
  f: Awaited<ReturnType<typeof fixture>>,
  phase: 'dispatch' | 'both' = 'dispatch',
) {
  await f.store.writeExtensionRecord({
    expectedStoreId: f.expectedStoreId,
    owner: f.owner,
    sessionId: 's',
    extensionId: 'fixture',
    originCommandId: 'work',
    originExecutionId: 'parent',
    write: {
      key: 'job-dispatch-facts',
      expectedRevision: null,
      contentType: 'fixture',
      contentVersion: 1,
      value: { required: true },
      executable: true,
    },
  });
  const registered = await f.store.registerRunRequirements({
    expectedStoreId: f.expectedStoreId,
    owner: f.owner,
    runId: f.run.id,
    requirements: [
      {
        extensionId: 'fixture',
        requirementId: 'job-dispatch-facts',
        recordKey: 'job-dispatch-facts',
        revision: '1',
        definitionVersion: '1',
        phase,
        sessionId: 's',
        runId: f.run.id,
      },
    ],
  });
  const requirement = registered.requirements[0]!;
  return async (outcome: 'satisfied' | 'waived' = 'satisfied'): Promise<RequirementEvaluation> => {
    const facts = await safety(f);
    return {
      requirement,
      recordRevision: '1',
      outcome,
      evidence: {},
      executionSafetyReads: [
        {
          runId: f.run.id,
          excludedExecutionId: facts.excludedExecutionId,
          revision: facts.revision,
          unconfirmed: facts.unconfirmed,
        },
      ],
    };
  };
}
test('ordinary Job approval and dispatch retain the exact planned Job and parent closure read without granting a waiver', async () => {
  const f = await fixture();
  try {
    const evaluate = await safetyRequirement(f);
    const ref = await plannedJob(f);
    const facts = await safety(f);
    expect(facts.excludedExecutionId).toBeNull();
    expect(facts.unconfirmedExecutionIds.sort()).toEqual(['parent', ref.executionId!].sort());
    const read = await evaluate();
    const inputDigest = await semanticDigest({ task: 'review' });
    await f.store.requestInteraction({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      interactionId: 'job-approval',
      executionId: ref.executionId!,
      attempt: 1,
      kind: 'approval',
      definitionId: 'agent/reviewer',
      definitionVersion: '1',
      inputDigest,
      policyRevision: 'original-policy',
      requiredRefs: [read.requirement],
      source: f.source,
      request: { title: 'Exact original ordinary Job' },
    });
    await f.store.answerInteraction({
      expectedStoreId: f.expectedStoreId,
      subjectId: 'owner',
      commandId: 'job-answer',
      presentationSessionId: 's',
      interactionId: 'job-approval',
      expectedRevision: '1',
      answer: { kind: 'approval', decision: 'approve' },
    });
    const accepted = await f.store.acceptInteractionDecision({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      interactionId: 'job-approval',
      executionId: ref.executionId!,
      attempt: 1,
      decisionRevision: '2',
      definitionId: 'agent/reviewer',
      definitionVersion: '1',
      inputDigest,
      policyRevision: 'original-policy',
      requirements: [read],
      freshness: { checked: true, source: f.source },
    });
    expect(accepted.acceptedDecisionRevision).toBe('2');
    await f.store.markDispatching({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: ref.executionId!,
      authorization: {
        allowed: true,
        revision: 'original-policy',
        definitionVersion: '1',
        inputDigest,
        interactionId: 'job-approval',
        decisionRevision: '2',
      },
      requirements: [read],
      freshness: { checked: true, source: f.source },
    });
    expect((await f.store.getExecution(ref.executionId!))?.status).toBe('dispatching');
  } finally {
    await f.close();
  }
});
for (const change of ['third_unknown', 'parent_settled', 'waived'] as const)
  test(`Job dispatch safety CAS refuses ${change} with zero dispatch or event writes`, async () => {
    const f = await fixture();
    try {
      const evaluate = await safetyRequirement(f);
      const ref = await plannedJob(f);
      const observed = await evaluate(change === 'waived' ? 'waived' : 'satisfied');
      if (change === 'third_unknown') {
        const third = await plannedJob(f, { operationKey: 'independent-third' });
        await dispatchJob(f, third.executionId!, [await evaluate()]);
        await f.store.finishExecution({
          expectedStoreId: f.expectedStoreId,
          owner: f.owner,
          executionId: third.executionId!,
          status: 'outcome_unknown',
          result: { outcome: 'outcome_unknown', content: 'actual independent unknown work' },
        });
      } else if (change === 'parent_settled')
        await f.store.finishExecution({
          expectedStoreId: f.expectedStoreId,
          owner: f.owner,
          executionId: 'parent',
          status: 'succeeded',
          result: { outcome: 'succeeded', content: 'parent settled after observation' },
        });
      const before = (await f.store.getMetadata()).lastChangeCursor;
      await rejected(
        dispatchJob(f, ref.executionId!, [observed]),
        change === 'waived' ? 'requirement_read_set_invalid' : 'requirement_not_satisfied',
      );
      expect((await f.store.getExecution(ref.executionId!))?.status).toBe('planned');
      expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
    } finally {
      await f.close();
    }
  });
test('a true closure read cannot qualify Job completion or Run waiver even after a valid Job dispatch', async () => {
  const f = await fixture();
  try {
    const evaluate = await safetyRequirement(f, 'both');
    const ref = await plannedJob(f);
    await dispatchJob(f, ref.executionId!, [await evaluate()]);
    const before = (await f.store.getMetadata()).lastChangeCursor;
    await rejected(
      f.store.finishExecution({
        expectedStoreId: f.expectedStoreId,
        owner: f.owner,
        executionId: ref.executionId!,
        status: 'succeeded',
        result: { outcome: 'succeeded', content: 'must not satisfy completion' },
        requirements: [await evaluate()],
      }),
      'requirement_read_set_invalid',
    );
    expect((await f.store.getExecution(ref.executionId!))?.status).toBe('dispatching');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
    await f.store.finishExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'parent',
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'parent done' },
    });
    const settled = (await f.store.getMetadata()).lastChangeCursor;
    await rejected(
      f.store.finishRun({
        expectedStoreId: f.expectedStoreId,
        owner: f.owner,
        runId: f.run.id,
        status: 'completed',
        requirements: [await evaluate('waived')],
      }),
      'requirement_read_set_invalid',
    );
    expect((await f.store.getRun(f.run.id))?.isActive).toBe(true);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(settled);
  } finally {
    await f.close();
  }
});
test('Run safety fixes Store/subject/scope and excludes only actual Tool while traversing runless descendants', async () => {
  const f = await fixture();
  try {
    expect((await safety(f)).unconfirmed).toBe(true);
    const clear = await safety(f, 'parent');
    expect(clear.unconfirmed).toBe(false);
    expect(await safety(f, 'parent')).toEqual(clear);
    for (const override of [{ subjectId: 'foreign' }, { sessionId: 'foreign' }])
      await rejected(
        f.store.readRunExecutionSafety({
          expectedStoreId: f.expectedStoreId,
          subjectId: 'owner',
          sessionId: 's',
          runId: f.run.id,
          ...override,
        }),
        'execution_safety_scope_denied',
      );
    await rejected(
      f.store.readRunExecutionSafety({
        expectedStoreId: 'foreign',
        subjectId: 'owner',
        sessionId: 's',
        runId: f.run.id,
      }),
      'store_identity_mismatch',
    );
    const ref = await prepared(f);
    expect((await safety(f, 'parent')).unconfirmed).toBe(true);
    expect((await f.store.getExecution(ref.executionId!))?.runId).toBeNull();
    await rejected(safety(f, ref.executionId!), 'execution_safety_boundary_invalid');
    await f.store.finishExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: ref.executionId!,
      status: 'outcome_unknown',
      result: { outcome: 'outcome_unknown', content: 'unknown carrier' },
    });
    const unknown = await safety(f, 'parent');
    expect(unknown.unconfirmed).toBe(true);
    expect(unknown.revision).not.toBe(clear.revision);
  } finally {
    await f.close();
  }
});
test('safety follows actual child Run and deeper child Tool instead of relying on parent waiting list', async () => {
  const f = await fixture();
  try {
    const ref = await prepared(f);
    const active = await f.store.activateChildRun(activation(f, ref.executionId!));
    await f.store.planExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'actual-child-tool',
      sessionId: ref.childSessionId!,
      runId: active.run.id,
      originCommandId: active.command.id,
      kind: 'tool',
      stepId: 'child-step',
      callId: 'child-call',
      definitionId: 'fixture/parent',
      definitionVersion: '1',
      input: {},
      decisionSource: f.source,
    });
    expect((await f.store.getRun(f.run.id))?.waitingForResults).toEqual([]);
    expect((await safety(f, 'parent')).unconfirmed).toBe(true);
    await rejected(
      f.store.readRunExecutionSafety({
        expectedStoreId: f.expectedStoreId,
        subjectId: 'owner',
        sessionId: 's',
        runId: active.run.id,
      }),
      'execution_safety_scope_denied',
    );
  } finally {
    await f.close();
  }
});
test('waiver safety read-set is rechecked inside completion transaction; a later runless Job invalidates old fact', async () => {
  const f = await fixture();
  try {
    await f.store.writeExtensionRecord({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'work',
      originExecutionId: 'parent',
      write: {
        key: 'obligation',
        expectedRevision: null,
        contentType: 'fixture',
        contentVersion: 1,
        value: { required: true },
        executable: true,
      },
    });
    const registered = await f.store.registerRunRequirements({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      runId: f.run.id,
      requirements: [
        {
          extensionId: 'fixture',
          requirementId: 'safe',
          recordKey: 'obligation',
          revision: '1',
          definitionVersion: '1',
          phase: 'completion',
          sessionId: 's',
          runId: f.run.id,
        },
      ],
    });
    const ref = registered.requirements[0]!;
    const clear = await safety(f, 'parent');
    expect(clear.unconfirmed).toBe(false);
    const carrier = await prepared(f);
    await f.store.finishExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'parent',
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'parent done' },
    });
    const before = (await f.store.getMetadata()).lastChangeCursor;
    await rejected(
      f.store.finishRun({
        expectedStoreId: f.expectedStoreId,
        owner: f.owner,
        runId: f.run.id,
        status: 'completed',
        requirements: [
          {
            requirement: ref,
            recordRevision: '1',
            outcome: 'waived',
            evidence: {},
            executionSafetyReads: [
              {
                runId: f.run.id,
                excludedExecutionId: null,
                revision: clear.revision,
                unconfirmed: false,
              },
            ],
          },
        ],
      }),
      'requirement_not_satisfied',
    );
    expect((await f.store.getRun(f.run.id))?.isActive).toBe(true);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(before);
    expect((await f.store.getExecution(carrier.executionId!))?.status).toBe('dispatching');
    await rejected(
      f.store.finishRun({
        expectedStoreId: f.expectedStoreId,
        owner: f.owner,
        runId: f.run.id,
        status: 'completed',
        requirements: [
          {
            requirement: ref,
            recordRevision: '1',
            outcome: 'waived',
            evidence: {},
            executionSafetyReads: [
              {
                runId: f.run.id,
                excludedExecutionId: carrier.executionId!,
                revision: clear.revision,
                unconfirmed: false,
              },
            ],
          },
        ],
      }),
      'requirement_read_set_invalid',
    );
  } finally {
    await f.close();
  }
});

test('information permission control reads are rechecked by the acceptance transaction and never create grants', async () => {
  const f = await fixture();
  try {
    const inputDigest = await semanticDigest({});
    const stamp = {
      revision: 'policy',
      bindingDigest: 'a'.repeat(64),
      controlReads: [{ kind: 'workspace.trust' as const, scope: 'workspace:w', revision: '0' }],
    };
    const request = {
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      interactionId: 'information',
      executionId: 'parent',
      attempt: 1,
      kind: 'question' as const,
      definitionId: 'fixture/parent',
      definitionVersion: '1',
      inputDigest,
      policyRevision: 'information-1',
      requiredRefs: [],
      source: f.source,
      request: { schema: { type: 'object' } },
      informationPermission: stamp,
    };
    await f.store.requestInteraction(request);
    await f.store.answerInteraction({
      expectedStoreId: f.expectedStoreId,
      commandId: 'answer',
      presentationSessionId: 's',
      subjectId: 'owner',
      interactionId: 'information',
      expectedRevision: '1',
      answer: { kind: 'question', answers: {} },
    });
    const safeRequest = {
      scope: 'workspace',
      workspaceId: 'w',
      trusted: true,
      ifRevision: '0',
      canonicalIdentity: 'a'.repeat(64),
      externalReadScopeDigest: 'b'.repeat(64),
    };
    const requestDigest = await semanticDigest(safeRequest);
    await f.store.beginHostMutation({
      expectedStoreId: f.expectedStoreId,
      commandId: 'trust',
      subjectId: 'owner',
      kind: 'workspace.trust',
      scope: 'workspace:w',
      safeRequest,
      requestDigest,
    });
    await f.store.finishHostMutation({
      expectedStoreId: f.expectedStoreId,
      commandId: 'trust',
      subjectId: 'owner',
      requestDigest,
      state: 'applied',
      receipt: { status: 'applied' },
    });
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await rejected(
      f.store.acceptInteractionDecision({
        ...request,
        decisionRevision: '2',
        requirements: [],
        freshness: { checked: true, source: f.source },
      }),
      'permission_control_changed',
    );
    expect(
      (
        await f.store.getInteraction({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          interactionId: 'information',
        })
      )?.acceptedDecisionRevision,
    ).toBeNull();
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(
      (
        await f.store.listPermissionGrants({
          expectedStoreId: f.expectedStoreId,
          sessionId: 's',
          subjectId: 'owner',
          limit: 10,
        })
      ).items,
    ).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('readonly worker safety observation preserves original facts and change cursor', async () => {
  const f = await fixture();
  const readonly = await openSqliteStore({ ...f.profile, mode: 'readonly' });
  try {
    const input = {
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      runId: f.run.id,
      excludeExecutionId: 'parent',
    };
    const original = await f.store.readRunExecutionSafety(input);
    const cursor = (await readonly.getMetadata()).lastChangeCursor;
    expect(await readonly.readRunExecutionSafety(input)).toEqual(original);
    expect((await readonly.getMetadata()).lastChangeCursor).toBe(cursor);
  } finally {
    await readonly.close();
    await f.close();
  }
});
