import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '@kite/agent-kernel';
import { createRuntimeHostStateInitialState, type RuntimeState } from '@kite/runtime-host';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { projectCompletionSemantics } from '../../apps/kite/src/release/capability-status';

function request(): RuntimeEvent {
  return {
    type: 'verification.requested',
    verificationId: 'verification-1',
    mode: 'required',
    spec: {
      schemaVersion: 1,
      verificationId: 'verification-1',
      subject: 'completion semantics',
      checks: [
        {
          checkId: 'check-1',
          type: 'schema',
          description: 'validate evidence',
          subject: { kind: 'literal', value: { ok: true } },
          schema: { type: 'object' },
        },
      ],
      repair: { maxAttempts: 1 },
    },
    requestedAt: '2026-08-01T00:00:00.000Z',
  };
}

function stateWithRequest(): RuntimeState {
  return reduceRuntimeState(
    createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'thread',
      userId: 'user',
      workspace: '.',
    }),
    request(),
  );
}

function markRuntimeCompleted(state: RuntimeState): RuntimeState {
  return {
    ...state,
    terminalOutcome: {
      version: 1,
      status: 'completed',
      reasonCode: 'completed',
      knownExternalEffects: 'known',
      safeRetry: false,
      recoveryEntry: 'none',
      pendingVerification: false,
    },
  };
}

describe('Verification completion semantics', () => {
  test('does not equate Agent final, Runtime end, Plan state, checks, or Verification', () => {
    const state = stateWithRequest();
    state.transcript.final = 'done';
    const projection = projectCompletionSemantics({
      state: markRuntimeCompleted(state),
      verificationFeatureEnabled: false,
    });
    expect(projection).toMatchObject({
      agentFinal: 'present',
      runtimeTerminal: 'completed',
      planLifecycle: 'building_without_plan',
      checks: { declared: 1, executed: 0 },
      verification: {
        newAdmission: 'disabled',
        requiredFactCount: 1,
        requiredFactsRetained: true,
        status: 'pending',
      },
      assessment: 'runtime_completed_verification_pending',
    });
  });

  test('an executed failed check is not a pass or verified completion', () => {
    let state = stateWithRequest();
    state = reduceRuntimeState(state, {
      type: 'verification.started',
      verificationId: 'verification-1',
      attempt: 1,
      startedAt: '2026-08-01T00:00:01.000Z',
    });
    state = reduceRuntimeState(state, {
      type: 'verification.check_completed',
      verificationId: 'verification-1',
      result: {
        checkId: 'check-1',
        outcome: 'failed',
        summary: 'not established',
        startedAt: '2026-08-01T00:00:01.000Z',
        finishedAt: '2026-08-01T00:00:02.000Z',
      },
    });
    state = reduceRuntimeState(state, {
      type: 'verification.completed',
      verificationId: 'verification-1',
      outcome: 'failed',
      completedAt: '2026-08-01T00:00:02.000Z',
    });
    const projection = projectCompletionSemantics({
      state: markRuntimeCompleted(state),
      verificationFeatureEnabled: true,
    });
    expect(projection.checks).toMatchObject({ executed: 1, passed: 0, failed: 1 });
    expect(projection.verification.status).toBe('failed');
    expect(projection.assessment).toBe('runtime_completed_verification_pending');
  });

  test('structured user waiver remains distinct from Verification passed', () => {
    let state = stateWithRequest();
    state = reduceRuntimeState(state, {
      type: 'verification.waived',
      verificationId: 'verification-1',
      actor: 'user',
      reason: 'User accepted residual risk.',
      waivedAt: '2026-08-01T00:00:03.000Z',
    });
    const projection = projectCompletionSemantics({
      state: markRuntimeCompleted(state),
      verificationFeatureEnabled: false,
    });
    expect(projection.verification.status).toBe('waived');
    expect(projection.assessment).toBe('runtime_completed_verification_waived');
  });
});
