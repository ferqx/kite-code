import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { semanticDigest } from '../../../src/json';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json, RequirementEvaluation, RequirementRecordRead } from '../../../src/storage';

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
  const dataRoot = mkdtempSync('/private/tmp/kite-requirement-reads-');
  chmodSync(dataRoot, 0o700);
  const store = await openSqliteStore({ dataRoot, profile: 'new' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const base = { expectedStoreId, sessionId: 's', subjectId: 'user' };
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'temporary',
    rootUri: 'file:///temporary',
  });
  await store.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 's' });
  await store.acceptCommand({
    ...base,
    commandId: 'work',
    request: { kind: 'run.start', content: 'read-set fixture' },
  });
  const owner = (await store.acquireSessionOwner('s', 'host'))!;
  const write = { expectedStoreId, owner };
  const run = await store.startRun({
    ...write,
    commandId: 'work',
    configuration: {
      tools: [
        { id: 'writer', version: '1', extensionId: 'fixture' },
        { id: 'foreign', version: '1', extensionId: 'foreign' },
      ],
    },
  });
  const source = { kind: 'model_decision', modelExecutionId: 'fixed' };
  const inputDigest = await semanticDigest({});
  const plan = (executionId: string, definitionId = 'writer') =>
    store.planExecution({
      ...write,
      executionId,
      sessionId: 's',
      runId: run.id,
      originCommandId: 'work',
      kind: 'tool',
      stepId: executionId,
      callId: executionId,
      definitionId,
      definitionVersion: '1',
      input: {},
      decisionSource: source,
    });
  const dispatch = (executionId: string, requirements: RequirementEvaluation[], approved = false) =>
    store.markDispatching({
      ...write,
      executionId,
      authorization: {
        allowed: true,
        revision: '1',
        definitionVersion: '1',
        inputDigest,
        ...(approved ? { interactionId: 'approval', decisionRevision: '2' } : {}),
      },
      requirements,
      freshness: { checked: true, source },
    });
  await plan('writer');
  await store.requestInteraction({
    ...write,
    interactionId: 'approval',
    executionId: 'writer',
    attempt: 1,
    kind: 'approval',
    definitionId: 'writer',
    definitionVersion: '1',
    inputDigest,
    policyRevision: '1',
    requiredRefs: [],
    source,
    request: { title: 'Approve exact temporary record writer' },
  });
  await store.answerInteraction({
    ...base,
    commandId: 'answer',
    presentationSessionId: 's',
    interactionId: 'approval',
    expectedRevision: '1',
    answer: { kind: 'approval', decision: 'approve' },
  });
  await store.acceptInteractionDecision({
    ...write,
    interactionId: 'approval',
    executionId: 'writer',
    attempt: 1,
    decisionRevision: '2',
    definitionId: 'writer',
    definitionVersion: '1',
    inputDigest,
    policyRevision: '1',
    requirements: [],
    freshness: { checked: true, source },
  });
  await dispatch('writer', [], true);
  await plan('foreign', 'foreign');
  await dispatch('foreign', []);
  const record = (
    key: string,
    value: Json,
    expectedRevision: string | null = null,
    namespace = 'fixture',
    executable = true,
  ) =>
    store.writeExtensionRecord({
      ...write,
      sessionId: 's',
      extensionId: namespace,
      originCommandId: 'work',
      originExecutionId: namespace === 'fixture' ? 'writer' : 'foreign',
      write: {
        key,
        expectedRevision,
        contentType: 'fixture.facts',
        contentVersion: 1,
        value,
        ...(executable ? { executable: true as const } : {}),
      },
    });
  await record('required', { enabled: true });
  const registered = await store.registerRunRequirements({
    ...write,
    runId: run.id,
    requirements: [
      {
        extensionId: 'fixture',
        definitionVersion: '1',
        requirementId: 'required',
        recordKey: 'required',
        revision: '1',
        phase: 'both',
        sessionId: 's',
        runId: run.id,
      },
    ],
  });
  const requirement = registered.requirements[0]!;
  const read = async (key: string, namespace = 'fixture'): Promise<RequirementRecordRead> => {
    const row = await store.getExtensionRecord({ extensionId: namespace, sessionId: 's', key });
    return { key, revision: row?.revision ?? null, originStoreId: row?.originStoreId ?? null };
  };
  const evaluation = (recordReads: RequirementRecordRead[]): RequirementEvaluation => ({
    requirement,
    recordRevision: '1',
    outcome: 'satisfied',
    evidence: { checked: 'actual named metadata' },
    recordReads,
  });
  const finish = (executionId: string) =>
    store.finishExecution({
      ...write,
      executionId,
      status: 'succeeded',
      result: { outcome: 'succeeded', content: 'actual known fact' },
    });
  return {
    store,
    base,
    write,
    run,
    requirement,
    plan,
    dispatch,
    record,
    read,
    evaluation,
    finish,
    async close() {
      await store.close();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

test('plan/approval reads are final-transaction CAS: changed plan rejects old evaluation with zero dispatch/events; unrelated write is harmless', async () => {
  const f = await fixture();
  try {
    await f.record('plan', { version: 1 });
    await f.record('plan-approval', { planVersion: 1, approved: true });
    await f.record('unrelated', { version: 1 });
    const stale = f.evaluation([await f.read('plan'), await f.read('plan-approval')]);
    await f.plan('target');
    await f.record('plan', { version: 2 }, '1');
    const changed = (await f.store.getMetadata()).lastChangeCursor;
    await rejected(f.dispatch('target', [stale]), 'requirement_not_satisfied');
    expect((await f.store.getExecution('target'))!.status).toBe('planned');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(changed);
    await f.record('plan-approval', { planVersion: 2, approved: true }, '1');
    const fresh = f.evaluation([await f.read('plan'), await f.read('plan-approval')]);
    await f.record('unrelated', { version: 2 }, '1');
    expect((await f.dispatch('target', [fresh])).status).toBe('dispatching');
    expect((await f.store.getExecution('target'))!.input).toEqual({});
    expect((await f.store.getRun(f.run.id))!.requirements).toEqual([f.requirement]);
  } finally {
    await f.close();
  }
});

test('completion rejects a changed related evidence snapshot without finishing; fresh exact read-set completes', async () => {
  const f = await fixture();
  try {
    await f.record('proof', { outcome: 'passed', scope: 'v1' });
    const stale = f.evaluation([await f.read('proof')]);
    await f.record('proof', { outcome: 'passed', scope: 'v2' }, '1');
    const fresh = f.evaluation([await f.read('proof')]);
    await f.finish('writer');
    await f.finish('foreign');
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await rejected(
      f.store.finishRun({
        ...f.write,
        runId: f.run.id,
        status: 'completed',
        requirements: [stale],
      }),
      'requirement_not_satisfied',
    );
    expect((await f.store.getRun(f.run.id))!.isActive).toBe(true);
    expect((await f.store.getRun(f.run.id))!.finishedAt).toBeNull();
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect(
      (
        await f.store.finishRun({
          ...f.write,
          runId: f.run.id,
          status: 'completed',
          requirements: [fresh],
        })
      ).status,
    ).toBe('completed');
  } finally {
    await f.close();
  }
});

test('absence, executable origin and implicit namespace cannot be self-granted by read-set claims', async () => {
  const f = await fixture();
  try {
    const missing = f.evaluation([await f.read('new-record')]);
    await f.record('new-record', { appeared: true });
    await f.plan('target');
    let cursor = (await f.store.getMetadata()).lastChangeCursor;
    await rejected(f.dispatch('target', [missing]), 'requirement_not_satisfied');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    await f.record('foreign-only', { approved: true }, null, 'foreign');
    const foreign = f.evaluation([await f.read('foreign-only', 'foreign')]);
    cursor = (await f.store.getMetadata()).lastChangeCursor;
    await rejected(f.dispatch('target', [foreign]), 'requirement_not_satisfied');
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    await f.record('nonexecutable', { approved: true }, null, 'fixture', false);
    await rejected(
      f.dispatch('target', [
        f.evaluation([
          { key: 'nonexecutable', revision: '1', originStoreId: f.base.expectedStoreId },
        ]),
      ]),
      'requirement_not_satisfied',
    );
    await rejected(
      f.dispatch('target', [
        {
          ...f.evaluation([]),
          requirement: { ...f.requirement, originStoreId: 'new-self-claimed-store' },
        },
      ]),
      'requirement_not_satisfied',
    );
    await rejected(
      f.dispatch('target', [
        f.evaluation([
          { key: 'new-record', revision: '1', originStoreId: 'new-self-claimed-store' },
        ]),
      ]),
      'requirement_read_set_invalid',
    );
    // A foreign namespace row does not count as existence in this requirement's own scope.
    expect(
      (await f.dispatch('target', [f.evaluation([await f.read('foreign-only')])])).status,
    ).toBe('dispatching');
  } finally {
    await f.close();
  }
});

test('invalid outcome, duplicate/oversized read sets and unknown authority fields reject without dispatch or event writes', async () => {
  const f = await fixture();
  try {
    await f.record('proof', { actual: true });
    await f.plan('target');
    const read = await f.read('proof');
    const cursor = (await f.store.getMetadata()).lastChangeCursor;
    await rejected(
      f.dispatch('target', [
        { ...f.evaluation([read]), outcome: 'invented' } as unknown as RequirementEvaluation,
      ]),
      'requirement_not_satisfied',
    );
    await rejected(
      f.dispatch('target', [f.evaluation([read, read])]),
      'requirement_read_set_invalid',
    );
    await rejected(
      f.dispatch('target', [
        f.evaluation(Array.from({ length: 65 }, (_, i) => ({ ...read, key: `key-${i}` }))),
      ]),
      'requirement_read_set_invalid',
    );
    await rejected(
      f.dispatch('target', [
        f.evaluation(
          Array.from({ length: 32 }, (_, i) => ({ ...read, key: `${'\0'.repeat(250)}${i}` })),
        ),
      ]),
      'requirement_read_set_invalid',
    );
    await rejected(
      f.dispatch('target', [
        f.evaluation([{ ...read, extensionId: 'foreign' }] as unknown as RequirementRecordRead[]),
      ]),
      'requirement_read_set_invalid',
    );
    await rejected(
      f.dispatch('target', [
        f.evaluation([{ key: 'absent', revision: null, originStoreId: f.base.expectedStoreId }]),
      ]),
      'requirement_read_set_invalid',
    );
    await rejected(
      f.dispatch('target', [f.evaluation([{ ...read, revision: '9223372036854775808' }])]),
      'requirement_read_set_invalid',
    );
    expect((await f.store.getMetadata()).lastChangeCursor).toBe(cursor);
    expect((await f.store.getExecution('target'))!.status).toBe('planned');
  } finally {
    await f.close();
  }
});
