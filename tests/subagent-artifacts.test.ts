import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite/agent-kernel';
import { createToolRecoveryJournal } from '@kite/agent-kernel';
import { digestCapabilityValue } from '@kite/builtin-runtime/capability';
import { aiMessage, PrivateImmutableArtifactStorage } from '@kite/builtin-runtime/model';
import {
  BuiltinChildRuntimeDriver,
  getRoleConfig,
  LocalSubagentProvider,
  SubagentContinuationArtifactStore,
  SubagentGrantAuthority,
  SubagentLifecycleArtifactStore,
  SubagentTaskArtifactError,
  SubagentTaskArtifactStore,
  SubagentTaskRequestArtifactStore,
  subagentDispatchIntentDigest,
  subagentTaskDigest,
} from '@kite/builtin-runtime/subagent';
import { createRuntimeHostStateInitialState } from '@kite/runtime-host/kernel-adapter';
import type { SubagentHandle } from '@kite/runtime-spi';
import {
  serializeSubagentContinuation,
  subagentContinuationCursorId,
} from '#app/bootstrap/runtime/subagent/continuation-codec';
import { reconcilePendingSubagentProvidersAfterCrash } from '#app/bootstrap/runtime/subagent-provider-recovery';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kite-subagent-artifacts-'));
  roots.push(root);
  const key = new Uint8Array(32).fill(21);
  const taskRoot = join(root, 'subagent-tasks');
  const lifecycleRoot = join(root, 'subagent-lifecycles');
  const continuationRoot = join(root, 'subagent-continuations');
  const taskStore = new SubagentTaskArtifactStore({ root: taskRoot });
  const lifecycleStore = new SubagentLifecycleArtifactStore({
    root: lifecycleRoot,
  });
  const owner = {
    parentInvocationId: 'parent-invocation',
    parentAttempt: 2,
    parentToolCallId: 'parent-tool',
    childInvocationId: 'child-private',
  } as const;
  return { root, key, taskRoot, lifecycleRoot, continuationRoot, taskStore, lifecycleStore, owner };
}

function issueHandle(input: ReturnType<typeof fixture>) {
  const published = input.taskStore.write({ owner: input.owner, task: 'sentinel private task' });
  const authority = new SubagentGrantAuthority({
    idSource: () => 'grant-private',
  });
  const hash = (value: string) => digestCapabilityValue({ value });
  const grant = authority.issueStart({
    ...input.owner,
    capabilityRevision: hash('capability'),
    admissionDigest: hash('admission'),
    effectiveEffectsDigest: hash('effects'),
    role: 'review',
    taskArtifact: published.ref,
    taskDigest: published.taskDigest,
    capabilityCeiling: {
      allowedTools: ['read_file'],
      bindingIds: [],
      bindingRevision: hash('bindings'),
      ceilingDigest: hash('ceiling'),
    },
    authorization: {
      authorizationDigest: hash('authorization'),
      interactionMode: 'accept_edits',
      phase: 'building',
      workspaceAccess: 'write',
    },
    executionBoundary: {
      canonicalWorkspace: '/workspace',
      executionBoundaryDigest: `sha256:${hash('boundary')}`,
    },
    resource: { parentReservationId: null, budgetDigest: hash('budget') },
    cancellationCorrelation: input.owner.parentToolCallId,
    model: {
      parentModelInvocationId: 'parent-model',
      parentToolCallId: input.owner.parentToolCallId,
    },
  });
  const handle = authority.verifier().issueHandle(grant, {
    handleId: 'handle-private',
    ownerProcessId: 2_147_483_647,
    ownerProcessStartIdentity: 'dead-owner-start',
    providerInstanceId: 'provider-private',
  });
  return { authority, grant, handle, published };
}

describe('private Subagent Artifact namespaces', () => {
  test('publishes an opaque task ref and requires exact owner, attempt, child, digest, and length', () => {
    const value = fixture();
    const task = 'dictionary-resistant sentinel task';
    const published = value.taskStore.write({ owner: value.owner, task });
    expect(published.ref).toEqual({
      artifactId: expect.stringMatching(/^pa_[0-9a-f]{64}$/),
      kind: 'subagent_task',
      integrityIdentifier: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      byteLength: expect.any(Number),
    });
    expect(JSON.stringify(published.ref)).not.toContain(task);
    expect(JSON.stringify(published.ref)).not.toContain(subagentTaskDigest(task));
    expect(
      value.taskStore.read(published.ref, { ...value.owner, taskDigest: published.taskDigest }),
    ).toMatchObject({ task, taskByteLength: Buffer.byteLength(task, 'utf8') });
    for (const expected of [
      { ...value.owner, parentAttempt: 3, taskDigest: published.taskDigest },
      { ...value.owner, childInvocationId: 'other-child', taskDigest: published.taskDigest },
      { ...value.owner, taskDigest: subagentTaskDigest('other task') },
    ]) {
      expect(() => value.taskStore.read(published.ref, expected)).toThrow(
        expect.objectContaining({ code: 'artifact_corrupt' }),
      );
    }
    expect(() =>
      value.taskStore.read(
        { ...published.ref, byteLength: published.ref.byteLength + 1 },
        { ...value.owner, taskDigest: published.taskDigest },
      ),
    ).toThrow(expect.objectContaining({ code: 'artifact_corrupt' }));
  });

  test('reopens refs without a key and rejects canonical payload corruption', () => {
    const value = fixture();
    const published = value.taskStore.write({ owner: value.owner, task: 'private task' });
    const reopened = new SubagentTaskArtifactStore({ root: value.taskRoot });
    expect(
      reopened.read(published.ref, { ...value.owner, taskDigest: published.taskDigest }).task,
    ).toBe('private task');

    const primitive = new PrivateImmutableArtifactStorage({
      root: value.taskRoot,
      namespace: 'subagent-tasks',
      partitions: [{ kind: 'subagent_task' as const, directory: 'tasks', extension: '.json' }],
      maxArtifactBytes: 1024 * 1024,
    });
    const malformed = primitive.write(
      'subagent_task',
      Buffer.from(JSON.stringify({ artifactFormatVersion: 1, unexpected: true }), 'utf8'),
    );
    expect(() =>
      value.taskStore.read(malformed, { ...value.owner, taskDigest: published.taskDigest }),
    ).toThrow(expect.objectContaining({ code: 'artifact_corrupt' }));
  });

  test('stores the full handle privately and reopens it without installation keys', () => {
    const value = fixture();
    const { authority, handle } = issueHandle(value);
    const ref = value.lifecycleStore.write(handle, authority.verifier());
    expect(JSON.stringify(ref)).not.toContain(handle.handleId);
    expect(value.lifecycleStore.read(ref, authority.verifier())).toEqual(handle);

    const wrongAuthority = new SubagentGrantAuthority();
    expect(value.lifecycleStore.read(ref, wrongAuthority.verifier())).toEqual(handle);
    expect(() =>
      value.lifecycleStore.read(
        { ...ref, integrityIdentifier: `sha256:${'0'.repeat(64)}` },
        authority.verifier(),
      ),
    ).toThrow(expect.objectContaining({ code: 'artifact_corrupt' }));
  });

  test('classifies invalid caller task separately from persisted corruption', () => {
    const value = fixture();
    expect(() => value.taskStore.write({ owner: value.owner, task: '' })).toThrow(
      SubagentTaskArtifactError,
    );
  });

  test('queue-time task requests require the exact model invocation and tool-call owner', () => {
    const value = fixture();
    const store = new SubagentTaskRequestArtifactStore({
      root: value.taskRoot,
    });
    const task = 'queue-only privacy sentinel';
    const ref = store.write({
      parentModelInvocationId: 'model-parent',
      parentToolCallId: 'task-call',
      role: 'review',
      task,
    });
    expect(JSON.stringify(ref)).not.toContain(task);
    expect(JSON.stringify(ref)).not.toContain(subagentTaskDigest(task));
    expect(
      store.read(ref, {
        parentModelInvocationId: 'model-parent',
        parentToolCallId: 'task-call',
      }),
    ).toEqual({ role: 'review', task });
    for (const expected of [
      { parentModelInvocationId: 'other-model', parentToolCallId: 'task-call' },
      { parentModelInvocationId: 'model-parent', parentToolCallId: 'other-call' },
    ]) {
      expect(() => store.read(ref, expected)).toThrow(
        expect.objectContaining({ code: 'artifact_corrupt' }),
      );
    }
    const reopened = new SubagentTaskRequestArtifactStore({ root: value.taskRoot });
    expect(
      reopened.read(ref, {
        parentModelInvocationId: 'model-parent',
        parentToolCallId: 'task-call',
      }),
    ).toEqual({ role: 'review', task });
  });

  test('continuations are private immutable payloads with exact parent, child, and cursor binding', () => {
    const value = fixture();
    const store = new SubagentContinuationArtifactStore({
      root: value.continuationRoot,
    });
    const snapshot = serializeSubagentContinuation(
      {
        id: value.owner.childInvocationId,
        role: getRoleConfig('review'),
        task: 'continuation privacy sentinel',
        messages: [aiMessage({ content: 'private child message' })],
        toolCallCount: 1,
        modelInvocationOrdinal: 1,
        steps: [
          {
            toolName: 'shell_execute',
            toolArgs: { command: 'private-command-sentinel' },
            status: 'awaiting_approval',
          },
        ],
        toolRecovery: createToolRecoveryJournal('1'.repeat(64)),
      },
      {
        reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
        toolCallId: 'blocked-call',
        toolName: 'shell_execute',
        args: { command: 'private-command-sentinel' },
        command: 'private-command-sentinel',
      },
    );
    const owner = {
      ...value.owner,
      continuationId: subagentContinuationCursorId(snapshot),
    };
    const ref = store.write({ owner, snapshot });
    expect(JSON.stringify(ref)).not.toContain('continuation privacy sentinel');
    expect(JSON.stringify(ref)).not.toContain('private-command-sentinel');
    expect(store.read(ref, owner)).toEqual(snapshot);
    expect(() => store.read(ref, { ...owner, parentAttempt: owner.parentAttempt + 1 })).toThrow(
      expect.objectContaining({ code: 'artifact_corrupt' }),
    );
    expect(() => store.read(ref, { ...owner, childInvocationId: 'other-child' })).toThrow(
      expect.objectContaining({ code: 'artifact_corrupt' }),
    );
    const reopened = new SubagentContinuationArtifactStore({ root: value.continuationRoot });
    expect(reopened.read(ref, owner)).toEqual(snapshot);
  });
});

function runningInvocation(invocationId: string, attempt: number) {
  const state = createRuntimeHostStateInitialState({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: `thread-${invocationId}`,
    userId: 'test',
    workspace: process.cwd(),
  });
  state.capabilities.invocations[invocationId] = {
    invocationId,
    toolCallId: 'parent-tool',
    capabilityId: 'builtin:task',
    capabilityRevision: digestCapabilityValue({ value: 'capability' }),
    argumentsDigest: digestCapabilityValue({ value: 'arguments' }),
    authorizationDigest: digestCapabilityValue({ value: 'authorization' }),
    admissionDigest: digestCapabilityValue({ value: 'admission' }),
    effectiveEffectsDigest: digestCapabilityValue({ value: 'effects' }),
    status: 'running',
    recordedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    attemptsStarted: attempt,
  };
  return state;
}

function stateWithHandle(
  value: ReturnType<typeof fixture>,
  handle: SubagentHandle,
  published: ReturnType<SubagentTaskArtifactStore['write']>,
  authority: SubagentGrantAuthority,
) {
  const handleRef = value.lifecycleStore.write(handle, authority.verifier());
  const dispatchIntentDigest = subagentDispatchIntentDigest(handle);
  let state = runningInvocation(value.owner.parentInvocationId, value.owner.parentAttempt);
  state = reduceRuntimeState(state, {
    type: 'capability.subagent_dispatch_intent_recorded',
    invocationId: value.owner.parentInvocationId,
    attempt: value.owner.parentAttempt,
    purpose: handle.purpose,
    childInvocationId: value.owner.childInvocationId,
    taskArtifact: published.ref,
    dispatchIntentDigest,
    recordedAt: new Date().toISOString(),
  });
  state = reduceRuntimeState(state, {
    type: 'capability.subagent_handle_recorded',
    invocationId: value.owner.parentInvocationId,
    attempt: value.owner.parentAttempt,
    dispatchIntentDigest,
    handleArtifact: handleRef,
    handleIntegrityIdentifier: handle.integrityIdentifier,
    recordedAt: new Date().toISOString(),
  });
  return state;
}

describe('durable Subagent lifecycle recovery', () => {
  test('intent-only restore records explicit undispatched cleanup before unknown', async () => {
    const value = fixture();
    const authority = new SubagentGrantAuthority();
    const driver = new BuiltinChildRuntimeDriver();
    const provider = new LocalSubagentProvider(authority.verifier(), driver, value.taskStore);
    let state = runningInvocation(value.owner.parentInvocationId, value.owner.parentAttempt);
    const published = value.taskStore.write({ owner: value.owner, task: 'never dispatched' });
    const dispatchIntentDigest = `sha256:${digestCapabilityValue({ value: 'dispatch-intent' })}`;
    state = reduceRuntimeState(state, {
      type: 'capability.subagent_dispatch_intent_recorded',
      invocationId: value.owner.parentInvocationId,
      attempt: value.owner.parentAttempt,
      purpose: 'start',
      childInvocationId: value.owner.childInvocationId,
      taskArtifact: published.ref,
      dispatchIntentDigest,
      recordedAt: new Date().toISOString(),
    });
    const events: RuntimeEvent[] = [];
    const recovered = await reconcilePendingSubagentProvidersAfterCrash({
      composition: {
        grants: authority,
        driver,
        provider,
        taskArtifacts: value.taskStore,
        lifecycleArtifacts: value.lifecycleStore,
      },
      persistence: {
        getState: () => state,
        persistEvents: async (batch) => {
          for (const event of batch) {
            state = reduceRuntimeState(state, event);
            events.push(event);
          }
          return true;
        },
      },
    });
    expect(recovered).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      'capability.subagent_cleanup_started',
      'capability.subagent_cleanup_completed',
      'capability.execution_unknown',
    ]);
    expect(state.capabilities.invocations[value.owner.parentInvocationId]).toMatchObject({
      status: 'unknown',
      subagentProviderLifecycle: {
        status: 'cleanup_completed',
        cleanupKind: 'undispatched',
        cleanupConfirmed: true,
      },
    });
  });

  test('a new same-key composition reads and reconciles a sealed dead-owner handle', async () => {
    const value = fixture();
    const { authority, handle, published } = issueHandle(value);
    const handleRef = value.lifecycleStore.write(handle, authority.verifier());
    const dispatchIntentDigest = subagentDispatchIntentDigest(handle);
    let state = runningInvocation(value.owner.parentInvocationId, value.owner.parentAttempt);
    for (const event of [
      {
        type: 'capability.subagent_dispatch_intent_recorded' as const,
        invocationId: value.owner.parentInvocationId,
        attempt: value.owner.parentAttempt,
        purpose: 'start' as const,
        childInvocationId: value.owner.childInvocationId,
        taskArtifact: published.ref,
        dispatchIntentDigest,
        recordedAt: new Date().toISOString(),
      },
      {
        type: 'capability.subagent_handle_recorded' as const,
        invocationId: value.owner.parentInvocationId,
        attempt: value.owner.parentAttempt,
        dispatchIntentDigest,
        handleArtifact: handleRef,
        handleIntegrityIdentifier: handle.integrityIdentifier,
        recordedAt: new Date().toISOString(),
      },
    ]) {
      state = reduceRuntimeState(state, event);
    }
    const restartedAuthority = new SubagentGrantAuthority();
    const restartedDriver = new BuiltinChildRuntimeDriver();
    const restartedProvider = new LocalSubagentProvider(
      restartedAuthority.verifier(),
      restartedDriver,
      value.taskStore,
    );
    const recovered = await reconcilePendingSubagentProvidersAfterCrash({
      composition: {
        grants: restartedAuthority,
        driver: restartedDriver,
        provider: restartedProvider,
        taskArtifacts: value.taskStore,
        lifecycleArtifacts: value.lifecycleStore,
      },
      persistence: {
        getState: () => state,
        persistEvents: async (events) => {
          for (const event of events) state = reduceRuntimeState(state, event);
          return true;
        },
      },
    });
    expect(recovered).toBe(true);
    expect(state.capabilities.invocations[value.owner.parentInvocationId]).toMatchObject({
      status: 'unknown',
      subagentProviderLifecycle: {
        status: 'cleanup_completed',
        cleanupKind: 'handle_reconcile',
        cleanupConfirmed: true,
      },
    });
  });

  test('Provider preparation performs zero Driver I/O and prepared cancellation reconciles', async () => {
    const value = fixture();
    const { authority, grant } = issueHandle(value);
    let driverStarts = 0;
    const provider = new LocalSubagentProvider(
      authority.verifier(),
      {
        abandon: () => true,
        start: async (startedGrant) => {
          driverStarts += 1;
          return {
            childInvocationId: startedGrant.childInvocationId,
            status: 'completed',
            summary: 'done',
            toolCallCount: 0,
            durationMs: 0,
            privatePayload: {},
          };
        },
        resume: async () => {
          throw new Error('unexpected resume');
        },
      },
      value.taskStore,
      () => 'two-phase',
    );
    const prepared = await provider.start({ grant });
    expect(prepared.ok).toBe(true);
    expect(driverStarts).toBe(0);
    if (!prepared.ok) return;
    expect(
      await provider.cancel({ handle: prepared.value, reason: 'pre-ready abandonment' }),
    ).toMatchObject({ ok: true });
    expect(await provider.reconcile({ handle: prepared.value })).toEqual({
      ok: true,
      value: { status: 'stopped', cleanupConfirmed: true },
    });
    expect(driverStarts).toBe(0);
  });

  test('same-process restore abandons a prepared handle without Driver dispatch', async () => {
    const value = fixture();
    const { authority, grant, published } = issueHandle(value);
    const driver = new BuiltinChildRuntimeDriver();
    driver.registerStart(grant.grantId, {
      childInvocationId: grant.childInvocationId,
      parentInvocationId: grant.parentInvocationId,
      parentToolCallId: grant.parentToolCallId,
      parentAttempt: grant.parentAttempt,
      run: async () => ({
        childInvocationId: grant.childInvocationId,
        status: 'completed' as const,
        summary: 'unexpected dispatch',
        toolCallCount: 0,
        durationMs: 0,
        privatePayload: {},
      }),
    });
    const provider = new LocalSubagentProvider(
      authority.verifier(),
      driver,
      value.taskStore,
      () => 'same-process-prepared',
    );
    const prepared = await provider.start({ grant });
    expect(prepared.ok).toBe(true);
    expect(driver.pendingRegistrationCount()).toBe(1);
    if (!prepared.ok) return;
    let state = stateWithHandle(value, prepared.value, published, authority);
    const recovered = await reconcilePendingSubagentProvidersAfterCrash({
      composition: {
        grants: authority,
        driver,
        provider,
        taskArtifacts: value.taskStore,
        lifecycleArtifacts: value.lifecycleStore,
      },
      persistence: {
        getState: () => state,
        persistEvents: async (events) => {
          for (const event of events) state = reduceRuntimeState(state, event);
          return true;
        },
      },
    });
    expect(recovered).toBe(true);
    expect(driver.pendingRegistrationCount()).toBe(0);
    expect(state.capabilities.invocations[value.owner.parentInvocationId]?.status).toBe('unknown');
  });

  test('same-process restore cancels one activated handle without duplicate Driver dispatch', async () => {
    const value = fixture();
    const { authority, grant, published } = issueHandle(value);
    let driverStarts = 0;
    const driver = {
      abandon: () => true,
      start: async (startedGrant: typeof grant, _task: string, signal: AbortSignal) => {
        driverStarts += 1;
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return {
          childInvocationId: startedGrant.childInvocationId,
          status: 'cancelled' as const,
          summary: 'cancelled on restore',
          toolCallCount: 0,
          durationMs: 0,
          privatePayload: {},
        };
      },
      resume: async () => {
        throw new Error('unexpected resume');
      },
    };
    const provider = new LocalSubagentProvider(
      authority.verifier(),
      driver,
      value.taskStore,
      () => 'same-process-active',
      50,
    );
    const prepared = await provider.start({ grant });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(await provider.activate({ handle: prepared.value })).toMatchObject({ ok: true });
    expect(driverStarts).toBe(1);
    let state = stateWithHandle(value, prepared.value, published, authority);
    const recovered = await reconcilePendingSubagentProvidersAfterCrash({
      composition: {
        grants: authority,
        driver: new BuiltinChildRuntimeDriver(),
        provider,
        taskArtifacts: value.taskStore,
        lifecycleArtifacts: value.lifecycleStore,
      },
      persistence: {
        getState: () => state,
        persistEvents: async (events) => {
          for (const event of events) state = reduceRuntimeState(state, event);
          return true;
        },
      },
    });
    expect(recovered).toBe(true);
    expect(driverStarts).toBe(1);
    expect(state.capabilities.invocations[value.owner.parentInvocationId]?.status).toBe('unknown');
  });
});
