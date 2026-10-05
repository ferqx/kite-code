import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import type { RequirementRef } from '../../../src/storage';

async function rejected(promise: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string })?.code).toBe(code);
}
async function fixture() {
  const dataRoot = mkdtempSync('/private/tmp/kite-requirements-');
  chmodSync(dataRoot, 0o700);
  const profile = { dataRoot, profile: 'new' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'user' };
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: 'file:///temporary',
    name: 'w',
  });
  await store.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 's' });
  await store.acceptCommand({
    ...base,
    commandId: 'work',
    request: { kind: 'run.start', content: 'fixture' },
  });
  const owner = (await store.acquireSessionOwner('s', 'host'))!;
  const write = { expectedStoreId, owner };
  const configuration = { tools: [{ id: 'parent', version: '1', extensionId: 'fixture' }] };
  const run = await store.startRun({ ...write, commandId: 'work', configuration });
  const source = { kind: 'model_decision', modelExecutionId: 'fixed' };
  const authorization = {
    allowed: true,
    revision: '1',
    definitionVersion: '1',
    inputDigest: await semanticDigest({}),
  };
  const plan = async (executionId: string) =>
    store.planExecution({
      ...write,
      executionId,
      sessionId: 's',
      runId: run.id,
      originCommandId: 'work',
      kind: 'tool',
      stepId: executionId,
      callId: executionId,
      definitionId: 'parent',
      definitionVersion: '1',
      input: {},
      decisionSource: source,
    });
  const dispatch = (
    executionId: string,
    requirements: Parameters<typeof store.markDispatching>[0]['requirements'] = [],
  ) =>
    store.markDispatching({
      ...write,
      executionId,
      authorization,
      requirements,
      freshness: { checked: true, source },
    });
  await plan('parent');
  await dispatch('parent');
  const record = async (key: string, executable = true, expectedRevision: string | null = null) =>
    store.writeExtensionRecord({
      ...write,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'work',
      originExecutionId: 'parent',
      write: {
        key,
        expectedRevision,
        contentType: 'fixture.required',
        contentVersion: 7,
        value: { actual: 'local metadata' },
        ...(executable ? { executable: true as const } : {}),
      },
    });
  const ref = (key: string, extra: Partial<RequirementRef> = {}): RequirementRef => ({
    extensionId: 'fixture',
    definitionVersion: '1',
    requirementId: key,
    recordKey: key,
    revision: '1',
    phase: 'both',
    sessionId: 's',
    runId: run.id,
    ...extra,
  });
  const register = (requirements: RequirementRef[]) =>
    store.registerRunRequirements({ ...write, runId: run.id, requirements });
  const evaluation = (requirement: RequirementRef) => ({
    requirement,
    recordRevision: requirement.revision,
    outcome: 'satisfied' as const,
    evidence: { record: requirement.recordKey },
  });
  const finish = (
    executionId: string,
    requirements: Parameters<typeof store.finishExecution>[0]['requirements'] = [],
  ) =>
    store.finishExecution({
      ...write,
      executionId,
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'actual fact' },
      requirements,
    });
  const db = new Database(join(dataRoot, 'new', 'core.db'));
  return {
    store,
    profile,
    base,
    write,
    run,
    source,
    authorization,
    configuration,
    record,
    ref,
    register,
    evaluation,
    plan,
    dispatch,
    finish,
    db,
    async close() {
      db.close();
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

test('real append-only Run registration gates dispatch and completion on exact persistent evaluation without SQL fake refs', async () => {
  const f = await fixture();
  try {
    await f.record('required');
    const registered = await f.register([f.ref('required')]);
    const ref = registered.requirements[0]!;
    expect(ref.originStoreId).toBe(f.base.expectedStoreId);
    expect(ref.definitionVersion).toBe('1');
    expect(
      (await f.store.getExtensionRecord({ ...f.base, extensionId: 'fixture', key: 'required' }))!
        .contentVersion,
    ).toBe(7);
    await f.plan('target');
    await rejected(f.dispatch('target'), 'requirement_not_satisfied');
    await rejected(
      f.dispatch('target', [{ ...f.evaluation(ref), recordRevision: '2' }]),
      'requirement_not_satisfied',
    );
    expect((await f.store.getExecution('target'))!.status).toBe('planned');
    await f.dispatch('target', [f.evaluation(ref)]);
    await f.finish('target');
    await f.finish('parent');
    await rejected(
      f.store.finishRun({ ...f.write, runId: f.run.id, status: 'completed', requirements: [] }),
      'requirement_not_satisfied',
    );
    await rejected(
      f.store.finishRun({
        ...f.write,
        runId: f.run.id,
        status: 'completed',
        requirements: [{ ...f.evaluation(ref), recordRevision: '2' }],
      }),
      'requirement_not_satisfied',
    );
    expect(
      (
        await f.store.finishRun({
          ...f.write,
          runId: f.run.id,
          status: 'completed',
          requirements: [f.evaluation(ref)],
        })
      ).status,
    ).toBe('completed');
    const terminalCursor = (await f.store.getMetadata()).lastChangeCursor;
    await rejected(f.register([f.ref('required')]), 'run_not_active');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(terminalCursor);
  } finally {
    await f.close();
  }
});

test('concurrent exact registration is zero duplicate events; immutable key binding rejects phase/version/record revision replacement', async () => {
  const f = await fixture();
  try {
    await f.record('one');
    const before = (await f.store.getMetadata()).lastChangeCursor;
    const results = await Promise.all(Array.from({ length: 8 }, () => f.register([f.ref('one')])));
    expect(results.every((run) => run.requirements.length === 1)).toBe(true);
    expect(BigInt((await f.store.getMetadata()).lastChangeCursor) - BigInt(before)).toBe(1n);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    expect((await f.register([])).requirements).toEqual(results[0]!.requirements);
    await rejected(
      f.register(
        Array.from({ length: 64 }, (_, index) => f.ref('one', { requirementId: `extra-${index}` })),
      ),
      'requirement_limit',
    );
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect((await f.register(results[0]!.requirements)).requirements).toEqual(
      results[0]!.requirements,
    );
    await rejected(f.register([f.ref('one', { phase: 'completion' })]), 'requirement_conflict');
    await rejected(
      f.register([f.ref('one', { definitionVersion: 'other' })]),
      'requirement_conflict',
    );
    await f.record('two');
    await rejected(f.register([f.ref('one', { recordKey: 'two' })]), 'requirement_conflict');
    await rejected(
      f.register([f.ref('one', { originStoreId: 'forged' })]),
      'operation_unverifiable',
    );
    expect((await f.store.getRun(f.run.id))!.requirements).toHaveLength(1);
    expect(BigInt((await f.store.getMetadata()).lastChangeCursor) - BigInt(cursor)).toBe(1n);
    await f.record('one', true, '1');
    const revisionChangedCursor = (await f.store.getMetadata()).lastChangeCursor;
    expect((await f.register([f.ref('one')])).requirements).toEqual(results[0]!.requirements);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(revisionChangedCursor);
    await rejected(f.register([f.ref('one', { revision: '2' })]), 'requirement_conflict');
    await f.plan('stale');
    await rejected(
      f.dispatch('stale', [f.evaluation(results[0]!.requirements[0]!)]),
      'requirement_not_satisfied',
    );
  } finally {
    await f.close();
  }
});

test('scope, original executable origin, owner/cancel and bounded input reject without adding requirements', async () => {
  const f = await fixture();
  try {
    await f.record('record');
    await f.record('nonexecutable', false);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await rejected(f.register([f.ref('missing')]), 'record_revision_conflict');
    await rejected(f.register([f.ref('nonexecutable')]), 'operation_unverifiable');
    await rejected(f.register([f.ref('record', { revision: '2' })]), 'record_revision_conflict');
    await rejected(
      f.register([f.ref('record', { sessionId: 'other' })]),
      'requirement_scope_mismatch',
    );
    await rejected(f.register([f.ref('record', { runId: 'other' })]), 'requirement_scope_mismatch');
    await rejected(
      f.register([f.ref('record', { executionId: 'imagined', attempt: 1 })]),
      'requirement_scope_mismatch',
    );
    await rejected(
      f.register([f.ref('record', { executionId: 'parent', attempt: 2 })]),
      'requirement_scope_mismatch',
    );
    await rejected(f.register([f.ref('record', { attempt: 1 })]), 'invalid_requirement');
    await rejected(
      f.store.registerRunRequirements({
        ...f.write,
        expectedStoreId: 'other',
        runId: f.run.id,
        requirements: [],
      }),
      'store_identity_mismatch',
    );
    await rejected(
      f.store.registerRunRequirements({
        ...f.write,
        owner: { ...f.write.owner, generation: '999' },
        runId: f.run.id,
        requirements: [],
      }),
      'owner_changed',
    );
    await rejected(
      f.register(Array.from({ length: 65 }, () => f.ref('record'))),
      'requirement_limit',
    );
    const long = f.ref('record', {
      requirementId: 'a'.repeat(256),
      recordKey: 'b'.repeat(256),
      definitionVersion: 'c'.repeat(256),
    });
    await rejected(f.register(Array.from({ length: 64 }, () => long)), 'requirement_limit');
    expect((await f.store.getRun(f.run.id))!.requirements).toEqual([]);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    const scoped = await f.register([f.ref('record', { executionId: 'parent', attempt: 1 })]);
    expect(scoped.requirements[0]!.executionId).toBe('parent');
    await f.store.cancelWork({
      ...f.base,
      commandId: 'cancel',
      kind: 'run.cancel',
      runId: f.run.id,
    });
    const cancelledCursor = (await f.store.getMetadata()).lastChangeCursor;
    await rejected(
      f.register([f.ref('record', { requirementId: 'new' })]),
      'cancelled_before_dispatch',
    );
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cancelledCursor);
  } finally {
    await f.close();
  }
});

test('real registration trigger failure rolls back and readonly reopen retains obligations; restored origin cannot regrant qualification', async () => {
  const f = await fixture();
  try {
    await f.record('one');
    await f.record('two');
    const first = await f.register([f.ref('one')]);
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    f.db.exec(
      "CREATE TRIGGER registration_fault BEFORE INSERT ON change_event WHEN NEW.type='run.requirements_registered' BEGIN SELECT RAISE(ABORT,'fault'); END",
    );
    let failed = false;
    try {
      await f.register([f.ref('two')]);
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    expect((await f.store.getRun(f.run.id))!.requirements).toEqual(first.requirements);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    f.db.exec('DROP TRIGGER registration_fault');
    const readonly = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect((await readonly.getRun(f.run.id))!.requirements).toEqual(first.requirements);
      await rejected(
        readonly.registerRunRequirements({ ...f.write, runId: f.run.id, requirements: [] }),
        'owner_changed',
      );
    } finally {
      await readonly.close();
    }
    await f.plan('restored');
    f.db.run("UPDATE extension_record SET origin_store_id='original-other-store' WHERE key='one'");
    await rejected(
      f.dispatch('restored', [f.evaluation(first.requirements[0]!)]),
      'requirement_not_satisfied',
    );
    const originChangedCursor = (await f.store.getMetadata()).lastChangeCursor;
    expect((await f.register([f.ref('one')])).requirements).toEqual(first.requirements);
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(originChangedCursor);
    await rejected(
      f.register([f.ref('one', { requirementId: 'new-origin' })]),
      'operation_unverifiable',
    );
    expect((await f.store.getRun(f.run.id))!.requirements).toEqual(first.requirements);
  } finally {
    await f.close();
  }
});

test('unknown scoped Execution cannot grant requirements and prior immutable Job refs freeze independently of later Run additions', async () => {
  const f = await fixture();
  try {
    await f.record('one');
    await f.record('two');
    const first = await f.register([f.ref('one', { phase: 'completion' })]);
    const job = await f.store.ensureOperation({
      ...f.write,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'work',
      parentExecutionId: 'parent',
      operationKey: 'job',
      cancellation: 'detached',
      request: { kind: 'job', definitionId: 'job', definitionVersion: '1', input: {} },
    });
    expect((await f.store.getExecution(job.executionId!))!.requirements).toEqual(
      first.requirements,
    );
    const all = await f.register([f.ref('two', { phase: 'completion' })]);
    expect(all.requirements).toHaveLength(2);
    expect((await f.store.getExecution(job.executionId!))!.requirements).toEqual(
      first.requirements,
    );
    await f.store.markDispatching({
      ...f.write,
      executionId: job.executionId!,
      authorization: f.authorization,
      requirements: [],
      freshness: { checked: true, source: f.source },
    });
    await rejected(f.finish(job.executionId!), 'requirement_not_satisfied');
    expect((await f.finish(job.executionId!, first.requirements.map(f.evaluation))).status).toBe(
      'succeeded',
    );
    await f.plan('unknown');
    await f.dispatch('unknown');
    await f.store.finishExecution({
      ...f.write,
      executionId: 'unknown',
      status: 'outcome_unknown',
      result: { outcome: 'outcome_unknown', content: 'unknown actual effect' },
    });
    await rejected(
      f.register([f.ref('two', { requirementId: 'unknown', executionId: 'unknown', attempt: 1 })]),
      'operation_unverifiable',
    );
    expect((await f.store.getRun(f.run.id))!.requirements).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('child registration keeps inherited parent source and appends only its actual child Run namespace', async () => {
  const f = await fixture();
  try {
    await f.record('parent-duty');
    const parent = await f.register([f.ref('parent-duty', { phase: 'completion' })]);
    const child = await f.store.ensureOperation({
      ...f.write,
      sessionId: 's',
      extensionId: 'fixture',
      originCommandId: 'work',
      parentExecutionId: 'parent',
      operationKey: 'child',
      cancellation: 'detached',
      request: { kind: 'agent', configurationId: 'child', input: {} },
      childConfiguration: { id: 'child', version: '1', snapshot: f.configuration },
    });
    await f.store.markDispatching({
      ...f.write,
      executionId: child.executionId!,
      authorization: f.authorization,
      requirements: [],
      freshness: { checked: true, source: f.source },
    });
    const activated = await f.store.activateChildRun({
      ...f.write,
      executionId: child.executionId!,
      configuration: f.configuration,
      requirementEvaluations: [],
      freshness: { checked: true, source: f.source },
    });
    expect(activated.run.requirements).toEqual(parent.requirements);
    await f.store.planExecution({
      ...f.write,
      executionId: 'child-tool',
      sessionId: activated.session.id,
      runId: activated.run.id,
      originCommandId: activated.command.id,
      kind: 'tool',
      stepId: 'child-tool',
      callId: 'child-tool',
      definitionId: 'parent',
      definitionVersion: '1',
      input: {},
      decisionSource: f.source,
    });
    await f.store.markDispatching({
      ...f.write,
      executionId: 'child-tool',
      authorization: f.authorization,
      requirements: [],
      freshness: { checked: true, source: f.source },
    });
    await f.store.writeExtensionRecord({
      ...f.write,
      sessionId: activated.session.id,
      extensionId: 'fixture',
      originCommandId: activated.command.id,
      originExecutionId: 'child-tool',
      write: {
        key: 'own',
        expectedRevision: null,
        contentType: 'fixture.required',
        contentVersion: 9,
        value: { own: true },
        executable: true,
      },
    });
    const own = f.ref('own', {
      sessionId: activated.session.id,
      runId: activated.run.id,
      phase: 'completion',
    });
    const registered = await f.store.registerRunRequirements({
      ...f.write,
      runId: activated.run.id,
      requirements: [own],
    });
    expect(registered.requirements[0]).toEqual(parent.requirements[0]);
    expect(registered.requirements[1]).toEqual({ ...own, originStoreId: f.base.expectedStoreId });
    await rejected(
      f.store.registerRunRequirements({
        ...f.write,
        runId: activated.run.id,
        requirements: [f.ref('parent-duty', { requirementId: 'new-child-duty' })],
      }),
      'requirement_scope_mismatch',
    );
    expect((await f.store.getRun(f.run.id))!.requirements).toEqual(parent.requirements);
    await f.store.cancelWork({
      ...f.base,
      kind: 'session.cancel',
      includeBackground: true,
      commandId: 'stop-group',
    });
    const stopped = (await f.store.getMetadata()).lastChangeCursor;
    await rejected(
      f.store.registerRunRequirements({
        ...f.write,
        runId: activated.run.id,
        requirements: [{ ...own, requirementId: 'late-after-stop' }],
      }),
      'cancelled_before_dispatch',
    );
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(stopped);
    expect((await f.store.getRun(activated.run.id))!.requirements).toEqual(registered.requirements);
  } finally {
    await f.close();
  }
});
