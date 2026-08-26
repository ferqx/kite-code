import { describe, expect, test } from 'bun:test';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import {
  type RuntimeStateSessionPort,
  runStateRuntimeLoop,
} from '#kite-cli/bootstrap/runtime/state-runner';
import type { RuntimeEvent, RuntimeState } from '#kite-cli/bootstrap/runtime/state-runtime';

const RECOVERY_KEY = 'a'.repeat(64);

function initialState(): RuntimeState {
  return createRuntimeHostStateInitialState({
    recoveryIdentityKey: RECOVERY_KEY,
    threadId: 'state-runner-ack-test',
    userId: 'user-1',
    workspace: '/workspace',
  });
}

describe('State runner effect acknowledgements', () => {
  test('routes explicit attempt and terminal recovery batches in queue order', async () => {
    const state = initialState();
    let pending = true;
    let lastApplied: RuntimeEvent[] = [];
    const acknowledgements: string[] = [];
    const lease = {
      effectId: 'effect-1',
      expectedRevision: state.revision,
      turnId: state.turn.turnId,
      effect: { type: 'call_model' as const },
    };
    const kernel: RuntimeStateSessionPort = {
      getState: () => state,
      processEvent: () => ({ status: 'applied', eventId: 'unused' }),
      processEventBatch: () => [],
      getLastAppliedEvents: () => lastApplied,
      selectPendingEffects: () => (pending ? [lease.effect] : []),
      acquireRunner: () => 'runner-1',
      releaseRunner: () => undefined,
      beginEffect: () => lease,
      isEffectEventCurrent: () => false,
      applyEffectEvent: () => false,
      applyEffectResult: () => false,
      applyEffectEvents: (_lease, events, acknowledgement) => {
        acknowledgements.push(acknowledgement);
        lastApplied = [...events];
        pending = false;
        return true;
      },
      applyLateResourceReconciliation: () => false,
      applyAction: () => ({
        status: 'stale',
        reason: 'unused',
        telemetry: { type: 'runtime.action_ignored', reason: 'unused' },
      }),
    };

    const emitted: RuntimeEvent[] = [];
    for await (const event of runStateRuntimeLoop(
      kernel,
      async (_effect, _state, _emit, context) => {
        expect(context?.persistAttemptStartEvents).toBeFunction();
        expect(context?.persistTerminalRecoveryEvents).toBeFunction();
        await context!.persistAttemptStartEvents!([
          { type: 'user.message_appended', messageId: 'attempt', content: 'attempt' },
        ]);
        await context!.persistTerminalRecoveryEvents!([
          { type: 'user.message_appended', messageId: 'recovery', content: 'recovery' },
        ]);
        return [];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      emitted.push(event);
    }

    expect(acknowledgements).toEqual(['attempt_start', 'terminal_recovery']);
    expect(emitted.map((event) => event.type)).toEqual([
      'user.message_appended',
      'user.message_appended',
    ]);
    expect(state.revision).toBe(0);
  });

  test('fails closed without a new acknowledgement port and never uses receipt fallback', async () => {
    const state = initialState();
    let pending = true;
    const lastApplied: RuntimeEvent[] = [];
    let legacyApplyEventCalls = 0;
    let legacyApplyResultCalls = 0;
    const lease = {
      effectId: 'effect-legacy-port',
      expectedRevision: state.revision,
      turnId: state.turn.turnId,
      effect: { type: 'call_model' as const },
    };
    const kernel: RuntimeStateSessionPort = {
      getState: () => state,
      processEvent: () => ({ status: 'applied', eventId: 'unused' }),
      processEventBatch: () => [],
      getLastAppliedEvents: () => lastApplied,
      selectPendingEffects: () => (pending ? [lease.effect] : []),
      acquireRunner: () => 'runner-legacy-port',
      releaseRunner: () => undefined,
      beginEffect: () => lease,
      isEffectEventCurrent: () => false,
      applyEffectEvent: () => {
        legacyApplyEventCalls += 1;
        return false;
      },
      applyEffectResult: () => {
        legacyApplyResultCalls += 1;
        return false;
      },
      applyLateResourceReconciliation: () => false,
      applyAction: () => ({
        status: 'stale',
        reason: 'unused',
        telemetry: { type: 'runtime.action_ignored', reason: 'unused' },
      }),
    };

    const accepted: boolean[] = [];
    const emitted: RuntimeEvent[] = [];
    for await (const event of runStateRuntimeLoop(
      kernel,
      async (_effect, _state, _emit, context) => {
        accepted.push(
          await context!.persistAttemptStartEvents!([
            { type: 'user.message_appended', messageId: 'attempt', content: 'attempt' },
          ]),
        );
        accepted.push(
          await context!.persistTerminalRecoveryEvents!([
            { type: 'user.message_appended', messageId: 'recovery', content: 'recovery' },
          ]),
        );
        pending = false;
        return [];
      },
      { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    )) {
      emitted.push(event);
    }

    expect(accepted).toEqual([false, false]);
    expect(legacyApplyEventCalls).toBe(0);
    expect(legacyApplyResultCalls).toBe(0);
    expect(lastApplied).toEqual([]);
    expect(emitted).toEqual([]);
  });
});
