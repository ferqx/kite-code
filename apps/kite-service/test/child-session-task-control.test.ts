import { expect, test } from 'bun:test';
import { createChildSessionTaskControl } from '../src/bootstrap/runtime/subagent/child-session-task-control';

const ref = Object.freeze({
  artifactId: 'result-1',
  kind: 'subagent_task' as const,
  integrityIdentifier: 'sha256:result',
  byteLength: 42,
});
const result = Object.freeze({ ok: true, terminalStatus: 'completed', summary: 'done' });

function fixture() {
  const link = {
    childThreadId: 'child-1',
    grantDigest: 'grant-1',
    originRunId: 'run-1',
    originTurnId: 'turn-1',
    originToolCallId: 'tool-1',
  };
  const parent = {
    revision: 4,
    session: { threadId: 'parent-1' },
    capabilities: {
      invocations: {
        'invocation-1': {
          subagentProviderLifecycle: { childInvocationId: 'task-1', childSession: link },
        },
      },
    },
  };
  const intent = {
    parentSessionId: 'parent-1',
    parentInvocationId: 'invocation-1',
    childInvocationId: 'task-1',
    childThreadId: 'child-1',
    originRunId: 'run-1',
    originTurnId: 'turn-1',
    originToolCallId: 'tool-1',
    grantDigest: 'grant-1',
    failureReceiptDigest: null,
    parentClaimSettledEventId: null,
    parentClaimSettledRevision: null,
  };
  const child = {
    revision: 4,
    session: { threadId: 'child-1' },
    modelInvocations: {} as Record<string, unknown>,
    childSessionOrigin: {
      parentSessionId: 'parent-1',
      parentInvocationId: 'invocation-1',
      childInvocationId: 'task-1',
      grantDigest: 'grant-1',
      terminal: {
        status: 'completed',
        sealedRevision: 12,
        resultRef: ref,
        cancelRequested: false,
        cleanupConfirmed: true,
      },
    },
  };
  const childEvents: { event: Record<string, unknown> }[] = [];
  const authority = {
    status: 'active',
    leaseUntilMs: Date.now() + 60_000,
  };
  const readers: Parameters<typeof createChildSessionTaskControl>[0] = {
    parentSessionId: 'parent-1',
    getParentState: () => parent as never,
    readIntent: (id) => (id === 'child-1' ? (intent as never) : null),
    readChildState: (id) => (id === 'child-1' ? (child as never) : null),
    readChildEvents: (id) => (id === 'child-1' ? (childEvents as never) : []),
    readAuthority: (parentSessionId, childThreadId) =>
      parentSessionId === 'parent-1' && childThreadId === 'child-1' ? (authority as never) : null,
    artifacts: {
      lookup: (owner, taskId) =>
        owner === 'owner-1' && taskId === 'task-1' ? { ref, result } : undefined,
      read: () => result,
    },
    parentArtifactOwnerKey: 'owner-1',
    waitForParentRevisionChange: async () => {},
    waitForChildRevisionChange: () => null,
  };
  return { parent, link, intent, child, childEvents, authority, readers };
}

test('readTask binds parent intent, child terminal and result Artifact before publishing', async () => {
  const f = fixture();
  const control = createChildSessionTaskControl(f.readers);
  expect(await control.readTask('foreign-task')).toMatchObject({ status: 'not_found', ok: false });
  expect(await control.readTask('task-1')).toMatchObject({ status: 'running', ok: true });
  f.intent.parentSessionId = 'foreign-parent';
  expect(await control.readTask('task-1')).toMatchObject({ status: 'not_found', ok: false });
});

test('task_wait wakes on a committed child model retry without exposing Provider error text', async () => {
  const f = fixture();
  let wakeChild: (() => void) | undefined;
  let childRevision = -1;
  const control = createChildSessionTaskControl({
    ...f.readers,
    waitForParentRevisionChange: () => new Promise<void>(() => {}),
    waitForChildRevisionChange: (_id, revision) => {
      childRevision = revision;
      return new Promise<void>((resolve) => {
        wakeChild = resolve;
      });
    },
  });
  const waiting = control.waitTasks(['task-1'], 1_000);
  await Promise.resolve();
  expect(childRevision).toBe(4);
  f.child.revision = 5;
  f.child.modelInvocations['model-1'] = {
    invocationId: 'model-1',
    status: 'dispatching',
    preparedStateRevision: 4,
  };
  f.childEvents.push({
    event: {
      type: 'model.retry',
      invocationId: 'model-1',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 200,
      failureClassification: 'provider_rate_limited',
      error: 'PRIVATE_PROVIDER_DETAIL',
    },
  });
  wakeChild?.();
  const result = await waiting;
  expect(result).toMatchObject({
    ok: true,
    status: 'running',
    reason: 'model_retry',
    tasks: [
      {
        status: 'running',
        retry: {
          attempt: 1,
          maxAttempts: 3,
          delayMs: 200,
          failureClassification: 'provider_rate_limited',
        },
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_PROVIDER_DETAIL');
  expect(await control.readTask('task-1')).toMatchObject({
    status: 'running',
    retry: { attempt: 1 },
  });
});

test('retry progress clears on model response, interruption, and terminal settlement', async () => {
  const f = fixture();
  f.child.modelInvocations['model-1'] = {
    invocationId: 'model-1',
    status: 'dispatching',
    preparedStateRevision: 4,
  };
  f.childEvents.push({
    event: {
      type: 'model.retry',
      invocationId: 'model-1',
      attempt: 1,
      maxAttempts: 3,
      delayMs: 200,
      error: 'hidden',
    },
  });
  const control = createChildSessionTaskControl(f.readers);
  expect(await control.readTask('task-1')).toHaveProperty('retry');
  f.childEvents.push({ event: { type: 'model.responded', invocationId: 'model-1' } });
  expect(await control.readTask('task-1')).not.toHaveProperty('retry');
  f.childEvents.push({
    event: {
      type: 'model.retry',
      invocationId: 'model-1',
      attempt: 2,
      maxAttempts: 3,
      delayMs: 400,
      error: 'hidden',
    },
  });
  expect(await control.readTask('task-1')).toHaveProperty('retry');
  f.childEvents.push({ event: { type: 'model.invocation_interrupted', invocationId: 'model-1' } });
  expect(await control.readTask('task-1')).not.toHaveProperty('retry');
  Object.assign(f.link, {
    terminalImport: { terminalRevision: 12, status: 'failed', resultRef: ref },
  });
  Object.assign(f.intent, {
    parentClaimSettledEventId: 'settled-1',
    parentClaimSettledRevision: 5,
  });
  f.parent.revision = 5;
  Object.assign(f.child.childSessionOrigin.terminal, { status: 'failed' });
  Object.assign(f.child, {
    terminalOutcome: {
      reasonCode: 'model_retry_exhausted',
      safeRetry: false,
      recoveryEntry: 'new_run',
      knownExternalEffects: 'none',
    },
  });
  const failed = { ok: false, terminalStatus: 'failed', summary: 'Child Session failed.' };
  const settled = createChildSessionTaskControl({
    ...f.readers,
    artifacts: { lookup: () => ({ ref, result: failed }), read: () => failed },
  });
  expect(await settled.waitTasks(['task-1'], 0)).toMatchObject({
    ok: true,
    status: 'failed',
    tasks: [
      {
        ok: false,
        status: 'failed',
        outcome: {
          reasonCode: 'model_retry_exhausted',
          safeRetry: false,
          recoveryEntry: 'new_run',
          knownExternalEffects: 'none',
        },
      },
    ],
  });
});

test('foreign parent-child lineage never reads child model events', async () => {
  const f = fixture();
  f.intent.parentSessionId = 'other-parent';
  let readCount = 0;
  const control = createChildSessionTaskControl({
    ...f.readers,
    readChildEvents: () => {
      readCount++;
      return [];
    },
  });
  expect(await control.readTask('task-1')).toMatchObject({ status: 'not_found' });
  expect(readCount).toBe(0);
  f.intent.parentSessionId = 'parent-1';
  f.child.childSessionOrigin.parentSessionId = 'other-parent';
  expect(await control.readTask('task-1')).toMatchObject({ status: 'unknown' });
  expect(readCount).toBe(0);
});

test('readTask exposes only a parent-settled exact terminal', async () => {
  const f = fixture();
  Object.assign(f.link, {
    terminalImport: { terminalRevision: 12, status: 'completed', resultRef: ref },
  });
  Object.assign(f.intent, {
    parentClaimSettledEventId: 'settled-1',
    parentClaimSettledRevision: 5,
  });
  f.parent.revision = 5;
  const control = createChildSessionTaskControl(f.readers);
  expect(await control.readTask('task-1')).toMatchObject({
    status: 'completed',
    cleanup_confirmed: true,
    result,
  });
  Object.assign(f.child.childSessionOrigin.terminal, {
    resultRef: { ...ref, artifactId: 'foreign' },
  });
  expect(await control.readTask('task-1')).toMatchObject({ status: 'unknown', ok: false });
});

test('readTask presents a settled child creation failure without a child Session', async () => {
  const f = fixture();
  const failed = Object.freeze({
    ok: false,
    terminalStatus: 'failed',
    summary: 'Could not start.',
  });
  Object.assign(f.link, {
    terminalImport: { terminalRevision: 0, status: 'failed', resultRef: ref },
  });
  Object.assign(f.intent, {
    failureReceiptDigest: ref.integrityIdentifier,
  });
  Object.assign(f.parent.capabilities.invocations['invocation-1']!.subagentProviderLifecycle, {
    backgroundResult: {
      artifactIntegrityIdentifier: ref.integrityIdentifier,
      admissionRevision: 5,
    },
  });
  f.parent.revision = 5;
  const control = createChildSessionTaskControl({
    ...f.readers,
    readChildState: () => null,
    artifacts: {
      lookup: () => ({ ref, result: failed }),
      read: () => failed,
    },
  });
  expect(await control.readTask('task-1')).toMatchObject({
    status: 'failed',
    ok: false,
    cleanup_confirmed: true,
    result: failed,
  });
});

test('a durable recovery diagnostic wakes task_wait without forging a child terminal', async () => {
  const f = fixture();
  Object.assign(f.link, {
    recoveryDiagnostic: {
      diagnosticCode: 'recovery_blocked',
      observedAt: '2026-09-25T00:00:00.000Z',
    },
  });
  f.parent.revision = 5;
  const control = createChildSessionTaskControl(f.readers);
  expect(await control.readTask('task-1')).toMatchObject({
    status: 'unknown',
    ok: false,
    cleanup_confirmed: false,
  });
  expect(await control.waitTasks(['task-1'], 60_000)).toMatchObject({
    status: 'unknown',
    ok: true,
    tasks: [{ status: 'unknown', ok: false }],
  });
  expect(f.link).not.toHaveProperty('terminalImport');
  expect(f.intent.parentClaimSettledEventId).toBeNull();
});

test('an expired active child lease is readable as unknown and wakes task_wait', async () => {
  const f = fixture();
  const control = createChildSessionTaskControl(f.readers);
  f.authority.leaseUntilMs = Date.now() - 1;
  expect(await control.readTask('task-1')).toMatchObject({
    status: 'unknown',
    ok: false,
    cleanup_confirmed: false,
  });
  expect(await control.waitTasks(['task-1'], 60_000)).toMatchObject({
    status: 'unknown',
    ok: true,
    tasks: [{ status: 'unknown', ok: false }],
  });
});

test('task_wait observes child lease expiry during a bounded wait', async () => {
  const f = fixture();
  f.authority.leaseUntilMs = Date.now() + 25;
  const control = createChildSessionTaskControl({
    ...f.readers,
    waitForParentRevisionChange: (_revision, signal) =>
      new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('wait aborted')), { once: true });
      }),
  });
  const startedAt = Date.now();
  expect(await control.waitTasks(['task-1'], 60_000)).toMatchObject({
    status: 'unknown',
    ok: true,
    tasks: [{ status: 'unknown', ok: false }],
  });
  expect(Date.now() - startedAt).toBeLessThan(1_000);
});

test('recovery-required authority is actionable even before a parent diagnostic', async () => {
  const f = fixture();
  f.authority.status = 'recovery_required';
  const control = createChildSessionTaskControl(f.readers);
  expect(await control.readTask('task-1')).toMatchObject({ status: 'unknown', ok: false });
  expect(await control.waitTasks(['task-1'], 60_000)).toMatchObject({
    status: 'unknown',
    ok: true,
    tasks: [{ status: 'unknown', ok: false }],
  });
});

test('a verified terminal import wins over stale child execution authority', async () => {
  const f = fixture();
  f.authority.leaseUntilMs = Date.now() - 1;
  Object.assign(f.link, {
    terminalImport: { terminalRevision: 12, status: 'completed', resultRef: ref },
  });
  Object.assign(f.intent, {
    parentClaimSettledEventId: 'settled-1',
    parentClaimSettledRevision: 5,
  });
  f.parent.revision = 5;
  const control = createChildSessionTaskControl(f.readers);
  expect(await control.readTask('task-1')).toMatchObject({ status: 'completed', ok: true });
  expect(await control.waitTasks(['task-1'], 60_000)).toMatchObject({
    status: 'completed',
    ok: true,
    tasks: [{ status: 'completed', ok: true }],
  });
});

test('waitTasks wakes from a parent revision and rereads the imported result', async () => {
  const f = fixture();
  let wake: (() => void) | undefined;
  let waitedRevision = -1;
  const control = createChildSessionTaskControl({
    ...f.readers,
    waitForParentRevisionChange: (revision) => {
      waitedRevision = revision;
      return new Promise<void>((resolve) => {
        wake = resolve;
      });
    },
  });
  const waiting = control.waitTasks(['task-1'], 1_000);
  await Promise.resolve();
  expect(waitedRevision).toBe(4);
  Object.assign(f.link, {
    terminalImport: { terminalRevision: 12, status: 'completed', resultRef: ref },
  });
  Object.assign(f.intent, {
    parentClaimSettledEventId: 'settled-1',
    parentClaimSettledRevision: 5,
  });
  f.parent.revision = 5;
  wake?.();
  expect(await waiting).toMatchObject({
    status: 'completed',
    ok: true,
    tasks: [{ status: 'completed' }],
  });
});

test('waitTasks yields to a new user message while the child remains required', async () => {
  const f = fixture();
  Object.assign(f.parent, {
    turn: { turnId: 'turn-1' },
    transcript: { messages: [{ kind: 'user', turnId: 'turn-1', messageId: 'first' }] },
  });
  let wake: (() => void) | undefined;
  const control = createChildSessionTaskControl({
    ...f.readers,
    waitForParentRevisionChange: () =>
      new Promise<void>((resolve) => {
        wake = resolve;
      }),
  });
  const waiting = control.waitTasks(['task-1'], 1_000);
  await Promise.resolve();
  f.parent.revision = 5;
  (f.parent as unknown as { transcript: { messages: unknown[] } }).transcript.messages.push({
    kind: 'user',
    turnId: 'turn-1',
    messageId: 'steer',
  });
  wake?.();
  expect(await waiting).toMatchObject({ status: 'running', reason: 'user_input' });
});

test('waitTasks returns any terminal, timeout and abort without Provider polling', async () => {
  const f = fixture();
  const control = createChildSessionTaskControl(f.readers);
  expect(await control.waitTasks(['task-1'], 0)).toMatchObject({ status: 'timeout', ok: true });
  const abort = new AbortController();
  abort.abort();
  expect(await control.waitTasks(['task-1'], 100, abort.signal)).toMatchObject({
    status: 'cancelled',
    reason: 'run_cancelled',
  });
  expect(await control.waitTasks(['foreign-task', 'task-1'], 100)).toMatchObject({
    status: 'not_found',
    ok: false,
  });
  expect(control.waitTasks([], 1)).rejects.toThrow();
  expect(control.waitTasks(Array(9).fill('task-1'), 1)).rejects.toThrow();
});

test('waitTasks treats an aborted revision waiter as a bounded timeout', async () => {
  const f = fixture();
  const control = createChildSessionTaskControl({
    ...f.readers,
    waitForParentRevisionChange: (_revision, signal) =>
      new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('wait aborted')), { once: true });
      }),
  });
  expect(await control.waitTasks(['task-1'], 1)).toMatchObject({ status: 'timeout' });
});
