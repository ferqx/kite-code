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
    session: { threadId: 'child-1' },
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
  const readers: Parameters<typeof createChildSessionTaskControl>[0] = {
    parentSessionId: 'parent-1',
    getParentState: () => parent as never,
    readIntent: (id) => (id === 'child-1' ? (intent as never) : null),
    readChildState: (id) => (id === 'child-1' ? (child as never) : null),
    artifacts: {
      lookup: (owner, taskId) =>
        owner === 'owner-1' && taskId === 'task-1' ? { ref, result } : undefined,
      read: () => result,
    },
    parentArtifactOwnerKey: 'owner-1',
    waitForParentRevisionChange: async () => {},
  };
  return { parent, link, intent, child, readers };
}

test('readTask binds parent intent, child terminal and result Artifact before publishing', async () => {
  const f = fixture();
  const control = createChildSessionTaskControl(f.readers);
  expect(await control.readTask('foreign-task')).toMatchObject({ status: 'not_found', ok: false });
  expect(await control.readTask('task-1')).toMatchObject({ status: 'running', ok: true });
  f.intent.parentSessionId = 'foreign-parent';
  expect(await control.readTask('task-1')).toMatchObject({ status: 'not_found', ok: false });
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
    ok: false,
    tasks: [{ status: 'unknown' }],
  });
  expect(f.link).not.toHaveProperty('terminalImport');
  expect(f.intent.parentClaimSettledEventId).toBeNull();
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
