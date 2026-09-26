import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { SubagentGrantAuthority } from '@kite-ai/builtin-runtime/subagent';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import {
  type RuntimeEffectLeaseExpectation,
  sealChildGrantPayload,
} from '@kite-ai/runtime-host/storage';
import {
  type RuntimeStateSessionPort,
  runStateRuntimeLoop,
} from '#kite-service/bootstrap/runtime/state-runner';
import type { RuntimeEvent, RuntimeState } from '#kite-service/bootstrap/runtime/state-runtime';

const receiptLease: RuntimeEffectLeaseExpectation = {
  effectId: 'child-acceptance-effect',
  ownerId: 'child-acceptance-owner',
  observedAtMs: 1,
};
const preceding: RuntimeEvent = { type: 'runtime.action_ignored', reason: 'queued-before-child' };
const childThreadId = `child_${createHash('sha256')
  .update(
    JSON.stringify([
      'kite.child-session.v1',
      'child-acceptance-runner',
      'parent-invocation',
      'parent-tool',
      1,
    ]),
  )
  .digest('hex')}`;
const taskArtifactRef = {
  artifactId: `pa_${'a'.repeat(64)}`,
  kind: 'subagent_task' as const,
  integrityIdentifier: `sha256:${'b'.repeat(64)}`,
  byteLength: 100,
};
const grant = new SubagentGrantAuthority({ idSource: () => 'runner-grant' }).issueStart({
  parentInvocationId: 'parent-invocation',
  parentToolCallId: 'parent-tool',
  parentAttempt: 1,
  capabilityRevision: '1'.repeat(64),
  admissionDigest: '2'.repeat(64),
  effectiveEffectsDigest: '3'.repeat(64),
  childInvocationId: 'child-invocation',
  role: 'review',
  taskArtifact: taskArtifactRef,
  taskDigest: `sha256:${'c'.repeat(64)}`,
  capabilityCeiling: {
    allowedTools: ['read_file'],
    bindingIds: [],
    bindingRevision: '4'.repeat(64),
    ceilingDigest: '5'.repeat(64),
  },
  authorization: {
    authorizationDigest: '6'.repeat(64),
    interactionMode: 'accept_edits',
    phase: 'building',
    workspaceAccess: 'write',
  },
  executionBoundary: {
    canonicalWorkspace: '/workspace',
    executionBoundaryDigest: `sha256:${'7'.repeat(64)}`,
  },
  resource: { parentReservationId: null, budgetDigest: '8'.repeat(64) },
  cancellationCorrelation: 'parent-tool',
  model: { parentModelInvocationId: 'parent-model', parentToolCallId: 'parent-tool' },
});
const sealedGrant = sealChildGrantPayload(grant);
const accepted = [
  { type: 'capability.subagent_dispatch_intent_recorded', invocationId: 'parent-invocation' },
  {
    type: 'subagent.child_session_intended',
    childThreadId,
    parentInvocationId: grant.parentInvocationId,
    originToolCallId: grant.parentToolCallId,
    childInvocationId: grant.childInvocationId,
    role: grant.role,
    grantDigest: sealedGrant.sealedGrantDigest,
    taskArtifactRef,
    taskTextDigest: grant.taskDigest,
  },
  { type: 'tool.finished', toolCallId: 'parent-tool' },
] as unknown as readonly RuntimeEvent[];

function initialState(): RuntimeState {
  return createRuntimeHostStateInitialState({
    recoveryIdentityKey: 'a'.repeat(64),
    threadId: 'child-acceptance-runner',
    userId: 'user-1',
    workspace: '/workspace',
  });
}

test('run_tools queues one child acceptance behind prior facts and publishes the complete revision batch once', async () => {
  let state = initialState();
  let phase: 'tool' | 'stop' = 'tool';
  let last: readonly RuntimeEvent[] = [];
  const calls: string[] = [];
  let hostCalls = 0;
  const kernel: RuntimeStateSessionPort = {
    getState: () => state,
    processEvent: () => ({ status: 'applied', eventId: 'unused' }),
    processEventBatch: () => [],
    getLastAppliedEvents: () => last,
    selectPendingEffects: () =>
      phase === 'tool' ? [{ type: 'run_tools', toolCallIds: ['parent-tool'] }] : [{ type: 'stop' }],
    acquireRunner: () => 'child-acceptance-runner',
    releaseRunner: () => undefined,
    beginEffect: (effect) => ({
      effectId: 'run-tools-effect',
      expectedRevision: state.revision,
      turnId: state.turn.turnId,
      effect,
    }),
    isEffectEventCurrent: () => true,
    applyEffectEvent: (lease, event) => {
      calls.push('preceding');
      expect(lease.expectedRevision).toBe(state.revision);
      state = { ...state, revision: state.revision + 1 };
      lease.expectedRevision = state.revision;
      last = [event];
      return true;
    },
    applyEffectResult: () => false,
    applyLateResourceReconciliation: () => false,
    applyAction: () => ({
      status: 'stale',
      reason: 'unused',
      telemetry: { type: 'runtime.action_ignored', reason: 'unused' },
    }),
    commitBackgroundChildAcceptance: (lease, events, requiredLease, payload) => {
      calls.push('host-child-acceptance');
      hostCalls += 1;
      expect(lease.effect.type).toBe('run_tools');
      expect(lease.expectedRevision).toBe(state.revision);
      expect(requiredLease).toEqual(receiptLease);
      expect(payload).toEqual(sealedGrant);
      expect(events).toBe(accepted);
      state = { ...state, revision: state.revision + events.length };
      lease.expectedRevision = state.revision;
      last = events;
      return true;
    },
  };
  const yielded: RuntimeEvent[] = [];
  for await (const event of runStateRuntimeLoop(
    kernel,
    async (effect, _state, _emit, context) => {
      if (effect.type === 'run_tools') {
        expect(context?.commitBackgroundChildAcceptance).toBeDefined();
        const prior = context!.persistEvents([preceding]);
        const child = context!.commitBackgroundChildAcceptance!(
          accepted,
          receiptLease,
          sealedGrant,
        );
        expect(await prior).toBe(true);
        expect(await child).toBe(true);
        calls.push('ack-returned');
        phase = 'stop';
      }
      return [];
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    5,
  ))
    yielded.push(event);
  expect(calls).toEqual(['preceding', 'host-child-acceptance', 'ack-returned']);
  expect(hostCalls).toBe(1);
  expect(yielded).toEqual([preceding, ...accepted]);
  expect(state.revision).toBe(1 + accepted.length);
});

for (const rejection of ['host-refused', 'stale-lease'] as const) {
  test(`${rejection} rejects child acceptance before any following Tool action`, async () => {
    const controller = new AbortController();
    let state = initialState();
    let phase: 'tool' | 'stop' = 'tool';
    let hostCalls = 0;
    let followingAction = false;
    let last: readonly RuntimeEvent[] = [];
    const kernel: RuntimeStateSessionPort = {
      getState: () => state,
      processEvent: () => ({ status: 'applied', eventId: 'unused' }),
      processEventBatch: () => [],
      getLastAppliedEvents: () => last,
      selectPendingEffects: () =>
        phase === 'tool'
          ? [{ type: 'run_tools', toolCallIds: ['parent-tool'] }]
          : [{ type: 'stop' }],
      acquireRunner: () => 'child-acceptance-runner',
      releaseRunner: () => undefined,
      beginEffect: (effect) => ({
        effectId: 'run-tools-effect',
        expectedRevision: state.revision,
        turnId: state.turn.turnId,
        effect,
      }),
      isEffectEventCurrent: () => true,
      applyEffectEvent: (lease, event) => {
        if (event === preceding) {
          state = { ...state, revision: state.revision + 1 };
          lease.expectedRevision = state.revision;
          last = [event];
          return true;
        }
        followingAction = true;
        return false;
      },
      applyEffectResult: () => false,
      applyLateResourceReconciliation: () => false,
      applyAction: () => ({
        status: 'stale',
        reason: 'unused',
        telemetry: { type: 'runtime.action_ignored', reason: 'unused' },
      }),
      commitBackgroundChildAcceptance: (lease, _events, _requiredLease, payload) => {
        expect(payload).toEqual(sealedGrant);
        hostCalls += 1;
        if (rejection === 'host-refused') throw new Error('Host rejected child receipt');
        state = { ...state, revision: state.revision + 1 };
        expect(lease.expectedRevision).toBeLessThan(state.revision);
        return false;
      },
    };
    const yielded: RuntimeEvent[] = [];
    for await (const event of runStateRuntimeLoop(
      kernel,
      async (effect, _state, _emit, context) => {
        if (effect.type === 'run_tools') {
          const prior = context!.persistEvents([preceding]);
          const child = context!.commitBackgroundChildAcceptance!(
            accepted,
            receiptLease,
            sealedGrant,
          );
          expect(await prior).toBe(true);
          await expect(child).rejects.toThrow(
            rejection === 'host-refused' ? 'Host rejected child receipt' : 'became stale',
          );
          controller.abort();
          phase = 'stop';
        }
        return [];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
      5,
      undefined,
      controller.signal,
    ))
      yielded.push(event);
    expect(hostCalls).toBe(1);
    expect(followingAction).toBe(false);
    expect(yielded).toEqual([preceding]);
  });
}
