import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createArtifactStore } from '../../../src/artifacts';
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
test('same operation atomically creates one Job/child/start command and sealed configuration conflict or SQL failure creates no child', async () => {
  const f = await fixture();
  try {
    const ref = await f.store.ensureOperation(f.request);
    expect(ref.childSessionId).toBeString();
    expect(await f.store.ensureOperation(f.request)).toEqual(ref);
    expect(
      f.db.query('SELECT count(*) AS n FROM session WHERE parent_id IS NOT NULL').get(),
    ).toEqual({ n: 1 });
    expect((await f.store.getExecution(ref.executionId!))?.childSessionId).toBe(
      ref.childSessionId!,
    );
    await rejected(
      f.store.ensureOperation({
        ...f.request,
        childConfiguration: { ...f.request.childConfiguration!, version: '2' },
      }),
      'operation_conflict',
    );
    await rejected(
      f.store.ensureOperation({
        ...f.request,
        request: { kind: 'agent', configurationId: 'missing', input: {} },
      }),
      'invalid_child_configuration',
    );
    f.db.run(
      "CREATE TRIGGER child_fault BEFORE INSERT ON execution WHEN NEW.child_session_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'fault'); END",
    );
    let failed = false;
    try {
      await f.store.ensureOperation({ ...f.request, operationKey: 'rollback' });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(
      f.db.query('SELECT count(*) AS n FROM session WHERE parent_id IS NOT NULL').get(),
    ).toEqual({ n: 1 });
    expect(
      f.db.query("SELECT count(*) AS n FROM command WHERE operation_key='rollback'").get(),
    ).toEqual({ n: 0 });
  } finally {
    await f.close();
  }
});
test('root OS owner covers child writes, parent can finish first, messages and model facts stay in child Session', async () => {
  const f = await fixture();
  const peer = await openSqliteStore(f.profile);
  try {
    const ref = await prepared(f, { cancellation: 'detached' });
    await rejected(peer.acquireSessionOwner(ref.childSessionId!, 'peer'), 'group_root_required');
    expect(await peer.acquireSessionOwner('s', 'peer')).toBeNull();
    await rejected(peer.activateChildRun(activation(f, ref.executionId!)), 'owner_changed');
    await f.store.finishExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'parent',
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'created' },
    });
    await f.store.finishRun({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      runId: f.run.id,
      status: 'completed',
      requirements: [],
    });
    const active = await f.store.activateChildRun(activation(f, ref.executionId!));
    expect(active.session.rootSessionId).toBe('s');
    expect(active.session.parentSessionId).toBe('s');
    expect(active.run.rootWorkCommandId).toBe('work');
    expect(active.command.subjectId).toBe('owner');
    const artifacts = createArtifactStore({ profile: f.profile, store: f.store });
    try {
      const artifact = {
        expectedStoreId: f.expectedStoreId,
        refId: 'child-ref',
        sessionId: ref.childSessionId!,
        subjectId: 'owner',
        scope: { kind: 'session' as const, id: ref.childSessionId! },
        content: Buffer.from('child immutable fact'),
        mediaType: 'text/plain',
      };
      await artifacts.publish(artifact);
      expect(Buffer.from(await artifacts.read(artifact)).toString()).toBe('child immutable fact');
      await rejected(
        artifacts.read({ ...artifact, subjectId: 'intruder' }),
        'artifact_scope_denied',
      );
      await rejected(artifacts.read({ ...artifact, sessionId: 's' }), 'artifact_scope_denied');
    } finally {
      await artifacts.close();
    }

    expect(await f.store.activateChildRun(activation(f, ref.executionId!))).toEqual(active);
    expect(await f.store.releaseSessionOwner(f.owner)).toBe(false);
    await f.store.markRunning({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: ref.executionId!,
      reference: { childSessionId: ref.childSessionId!, runId: active.run.id },
    });
    const childSource = { kind: 'model_decision', child: true };
    await f.store.planExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'child-model',
      sessionId: ref.childSessionId!,
      runId: active.run.id,
      originCommandId: active.command.id,
      stepId: 'step',
      callId: 'model',
      kind: 'model',
      definitionId: 'fixed',
      definitionVersion: '1',
      input: {},
      decisionSource: childSource,
    });
    expect((await f.store.getExecution('child-model'))?.parentExecutionId).toBe(ref.executionId!);
    await f.store.markDispatching({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'child-model',
      authorization: {
        allowed: true,
        revision: '1',
        definitionVersion: '1',
        inputDigest: await semanticDigest({}),
      },
      requirements: [],
      freshness: { checked: true, source: childSource },
    });
    await f.store.persistModelPartial({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'child-model',
      content: 'partial',
    });
    expect(
      (await f.store.listMessages(ref.childSessionId!)).some((m) => m.content === 'partial'),
    ).toBe(true);
    expect((await f.store.listMessages('s')).some((m) => m.content === 'partial')).toBe(false);
    await rejected(
      f.store.finishExecution({
        expectedStoreId: f.expectedStoreId,
        owner: f.owner,
        executionId: ref.executionId!,
        status: 'succeeded',
        result: { outcome: 'succeeded', content: 'too early' },
      }),
      'child_execution_unsettled',
    );
    await f.store.finishExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'child-model',
      status: 'succeeded',
      result: { outcome: 'succeeded' },
      message: { role: 'assistant', content: 'child result' },
    });
    await f.store.finishRun({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      runId: active.run.id,
      status: 'completed',
      requirements: [],
    });
    await f.store.finishExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: ref.executionId!,
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'child result' },
    });
    expect(await f.store.releaseSessionOwner(f.owner)).toBe(true);
    expect((await f.store.getExecution(ref.executionId!))?.delivery).toBe('pending');
  } finally {
    await peer.close();
    await f.close();
  }
});

test('attached cancellation reaches child startup and Run; detached sibling only stops at the durable root boundary', async () => {
  const f = await fixture();
  try {
    const attached = await prepared(f, { operationKey: 'attached' });
    const detached = await prepared(f, { operationKey: 'detached', cancellation: 'detached' });
    await f.store.cancelWork({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'cancel-parent',
      kind: 'execution.cancel',
      executionId: 'parent',
    });
    await rejected(
      f.store.activateChildRun(activation(f, attached.executionId!)),
      'cancelled_before_dispatch',
    );
    expect((await f.store.getExecution(detached.executionId!))?.cancelRequestedAt).toBeNull();
    const active = await f.store.activateChildRun(activation(f, detached.executionId!));
    expect(active.run.isActive).toBe(true);
    expect(f.db.query("SELECT count(*) AS n FROM execution WHERE kind='model'").get()).toEqual({
      n: 0,
    });
    await f.store.cancelWork({
      expectedStoreId: f.expectedStoreId,
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'stop-group',
      kind: 'session.cancel',
      includeBackground: true,
    });
    expect((await f.store.getExecution(detached.executionId!))?.cancelRequestedAt).not.toBeNull();
    expect((await f.store.getCommand(active.command.id))?.cancelRequestedAt).not.toBeNull();
    expect(
      f.db.query('SELECT cancel_requested AS cancelled FROM run WHERE id=?').get(active.run.id),
    ).toEqual({ cancelled: 1 });
    await rejected(
      f.store.activateChildRun(activation(f, detached.executionId!)),
      'cancelled_before_dispatch',
    );
    await rejected(
      f.store.ensureOperation({ ...f.request, operationKey: 'late', cancellation: 'detached' }),
      'cancelled_before_dispatch',
    );
    expect(f.db.query("SELECT count(*) AS n FROM execution WHERE kind='model'").get()).toEqual({
      n: 0,
    });
  } finally {
    await f.close();
  }
});

test('child activation and dispatch recheck sealed sources/requirements, original Store and generation with zero model creation on rejection', async () => {
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
      phase: 'both' as const,
      sessionId: 's',
      runId: f.run.id,
      recordKey: 'plan',
    };
    const registered = await f.store.registerRunRequirements({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      runId: f.run.id,
      requirements: [proposed],
    });
    const requirement = registered.requirements[0]!;
    expect(requirement.originStoreId).toBe(f.expectedStoreId);
    const ref = await prepared(f, {}, [
      { requirement, recordRevision: '1', outcome: 'satisfied', evidence: {} },
    ]);
    const input = activation(f, ref.executionId!);
    await rejected(
      f.store.activateChildRun({ ...input, configuration: { modelId: 'other' } }),
      'child_configuration_conflict',
    );
    await rejected(
      f.store.activateChildRun({ ...input, freshness: { checked: false, source: f.source } }),
      'context_refresh_required',
    );
    await rejected(
      f.store.activateChildRun({
        ...input,
        freshness: { checked: true, source: { changed: true } },
      }),
      'context_refresh_required',
    );
    await rejected(
      f.store.activateChildRun({ ...input, expectedStoreId: 'other' }),
      'store_identity_mismatch',
    );
    await rejected(
      f.store.activateChildRun({ ...input, owner: { ...f.owner, generation: '999' } }),
      'owner_changed',
    );

    await rejected(f.store.activateChildRun(input), 'requirement_not_satisfied');
    await rejected(
      f.store.activateChildRun({
        ...input,
        requirementEvaluations: [
          { requirement, recordRevision: '2', outcome: 'satisfied', evidence: {} },
        ],
      }),
      'requirement_not_satisfied',
    );
    expect(
      f.db.query('SELECT count(*) AS n FROM run WHERE session_id=?').get(ref.childSessionId!),
    ).toEqual({ n: 0 });
    const active = await f.store.activateChildRun({
      ...input,
      requirementEvaluations: [
        { requirement, recordRevision: '1', outcome: 'satisfied', evidence: {} },
      ],
    });
    expect(active.run.requirements).toEqual([requirement]);
    await f.store.planExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'child-pending',
      sessionId: ref.childSessionId!,
      runId: active.run.id,
      originCommandId: active.command.id,
      stepId: 'step',
      callId: 'model',
      kind: 'model',
      definitionId: 'fixed',
      definitionVersion: '1',
      input: {},
      decisionSource: f.source,
    });
    f.db.run("UPDATE extension_record SET revision=2 WHERE key='plan'");
    await rejected(
      f.store.markDispatching({
        expectedStoreId: f.expectedStoreId,
        owner: f.owner,
        executionId: 'child-pending',
        authorization: {
          allowed: true,
          revision: '1',
          definitionVersion: '1',
          inputDigest: await semanticDigest({}),
        },
        requirements: [{ requirement, recordRevision: '1', outcome: 'satisfied', evidence: {} }],
        freshness: { checked: true, source: f.source },
      }),
      'requirement_not_satisfied',
    );
    expect((await f.store.getExecution('child-pending'))?.status).toBe('planned');
  } finally {
    await f.close();
  }
});

test('child-scoped stop isolates parent/sibling; nested descendants share the root generation and one OS execution group', async () => {
  const f = await fixture();
  try {
    const one = await prepared(f, { operationKey: 'one', cancellation: 'detached' });
    const two = await prepared(f, { operationKey: 'two', cancellation: 'detached' });
    const active = await f.store.activateChildRun(activation(f, one.executionId!));
    await f.store.planExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'child-tool',
      sessionId: one.childSessionId!,
      runId: active.run.id,
      originCommandId: active.command.id,
      stepId: 'step',
      callId: 'tool',
      kind: 'tool',
      definitionId: 'fixture/parent',
      definitionVersion: '1',
      input: {},
      decisionSource: f.source,
    });
    await f.store.markDispatching({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'child-tool',
      authorization: {
        allowed: true,
        revision: '1',
        definitionVersion: '1',
        inputDigest: await semanticDigest({}),
      },
      requirements: [],
      freshness: { checked: true, source: f.source },
    });
    const nested = await f.store.ensureOperation({
      ...f.request,
      sessionId: one.childSessionId!,
      originCommandId: active.command.id,
      parentExecutionId: 'child-tool',
      operationKey: 'nested',
      cancellation: 'detached',
    });
    expect((await f.store.getSession(nested.childSessionId!))?.parentSessionId).toBe(
      one.childSessionId!,
    );
    expect((await f.store.getSession(nested.childSessionId!))?.rootSessionId).toBe('s');
    expect((await f.store.getExecution(nested.executionId!))?.ownerGeneration).toBe(
      f.owner.generation,
    );
    await f.store.cancelWork({
      expectedStoreId: f.expectedStoreId,
      sessionId: one.childSessionId!,
      subjectId: 'owner',
      commandId: 'stop-one',
      kind: 'session.cancel',
      includeBackground: true,
    });
    expect((await f.store.getExecution(nested.executionId!))?.cancelRequestedAt).not.toBeNull();
    expect((await f.store.getExecution(two.executionId!))?.cancelRequestedAt).toBeNull();
    expect((await f.store.getExecution('parent'))?.cancelRequestedAt).toBeNull();
    expect((await f.store.getSession('s'))?.ownerGeneration).toBe(f.owner.generation);
    expect((await f.store.activateChildRun(activation(f, two.executionId!))).run.isActive).toBe(
      true,
    );
  } finally {
    await f.close();
  }
});

test('explicit root recovery fences the entire group and never revives child models or unknown Job effects', async () => {
  const f = await fixture();
  let next: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    const ref = await prepared(f, { cancellation: 'detached' });
    const active = await f.store.activateChildRun(activation(f, ref.executionId!));
    await f.store.planExecution({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'recover-model',
      sessionId: ref.childSessionId!,
      runId: active.run.id,
      originCommandId: active.command.id,
      stepId: 's',
      callId: 'm',
      kind: 'model',
      definitionId: 'fixed',
      definitionVersion: '1',
      input: {},
      decisionSource: f.source,
    });
    await f.store.markDispatching({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'recover-model',
      authorization: {
        allowed: true,
        revision: '1',
        definitionVersion: '1',
        inputDigest: await semanticDigest({}),
      },
      requirements: [],
      freshness: { checked: true, source: f.source },
    });
    await f.store.persistModelPartial({
      expectedStoreId: f.expectedStoreId,
      owner: f.owner,
      executionId: 'recover-model',
      content: 'unfinished child',
    });
    await f.store.close();
    next = await openSqliteStore(f.profile);
    const report = await next.recoverSession({
      expectedStoreId: f.expectedStoreId,
      commandId: 'recover',
      sessionId: 's',
      subjectId: 'owner',
      expectedOwnerGeneration: f.owner.generation,
      decision: 'interrupt',
    });
    expect(report.interruptedRunIds).toContain(active.run.id);
    expect(report.settledExecutionIds).toContain('recover-model');
    expect(report.unknownExecutionIds).toContain(ref.executionId!);
    expect(report.partialMessageIds).toContain('partial_recover-model');
    expect((await next.getRun(active.run.id))?.status).toBe('interrupted');
    expect(Number.isFinite((await next.getRun(active.run.id))?.finishedAt)).toBe(true);
    expect((await next.getSession(ref.childSessionId!))?.ownerGeneration).toBe(report.generation);
    await rejected(
      next.finishExecution({
        expectedStoreId: f.expectedStoreId,
        owner: f.owner,
        executionId: 'recover-model',
        status: 'succeeded',
        result: {},
      }),
      'owner_changed',
    );
    await rejected(next.acquireSessionOwner('s', 'new'), 'recovery_required');
    expect((await next.getExecution(ref.executionId!))?.status).toBe('outcome_unknown');
    expect(
      await next.recoverSession({
        expectedStoreId: f.expectedStoreId,
        commandId: 'recover',
        sessionId: 's',
        subjectId: 'owner',
        expectedOwnerGeneration: f.owner.generation,
        decision: 'interrupt',
      }),
    ).toEqual(report);
  } finally {
    await next?.close();
    await f.close();
  }
});

test('large trusted child configuration is sealed whole, activated exactly and remains immutable across readonly reopen', async () => {
  const f = await fixture();
  let readonly: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  const body =
    'CHILD CONFIG BEGIN ' + 'c'.repeat(1024 * 1024 + 4096) + ' CHILD CONFIG VERIFIED TAIL';
  const configuration = { ...f.configuration, snapshot: { body } };
  const childConfiguration = { ...f.request.childConfiguration!, snapshot: configuration };
  const request = { ...f.request, childConfiguration };
  try {
    const ref = await prepared(f, { childConfiguration });
    expect((await f.store.getExecution(ref.executionId!))?.childConfiguration).toEqual(
      childConfiguration,
    );
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    expect(await f.store.ensureOperation(request)).toEqual(ref);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    await rejected(
      f.store.ensureOperation({
        ...request,
        childConfiguration: {
          ...childConfiguration,
          snapshot: { ...configuration, snapshot: { body: body + 'changed' } },
        },
      }),
      'operation_conflict',
    );
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    const input = { ...activation(f, ref.executionId!), configuration };
    const active = await f.store.activateChildRun(input);
    expect(active.run.configuration).toEqual(configuration);
    expect((active.run.configuration as typeof configuration).snapshot.body).toEndWith(
      'CHILD CONFIG VERIFIED TAIL',
    );
    const after = (await f.store.getMetadata()).lastChangeCursor;
    expect(await f.store.activateChildRun(input)).toEqual(active);
    await rejected(
      f.store.activateChildRun({
        ...input,
        configuration: { ...configuration, snapshot: { body: body + 'changed' } },
      }),
      'child_configuration_conflict',
    );
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(after);
    expect((await f.store.getView(ref.childSessionId!)).runs).toHaveLength(1);
    await f.store.close();
    readonly = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    const coldCursor = (await readonly.getMetadata()).lastChangeCursor;
    expect((await readonly.getExecution(ref.executionId!))?.childConfiguration).toEqual(
      childConfiguration,
    );
    expect((await readonly.getRun(active.run.id))?.configuration).toEqual(configuration);
    expect((await readonly.getMetadata()).storeId).toBe(f.expectedStoreId);
    expect((await readonly.getMetadata()).lastChangeCursor).toBe(coldCursor);
  } finally {
    await readonly?.close();
    await f.close();
  }
});
