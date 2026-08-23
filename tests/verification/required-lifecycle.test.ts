import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '@kite/agent-kernel';
import { resolveKernelVerificationModeV1 as resolveVerificationMode } from '@kite/agent-kernel';
import { createRuntimeHostStateInitialStateV1, type RuntimeState } from '@kite/runtime-host';
import type { VerificationSpecV1 } from '@kite/runtime-spi';
import { eventsForRuntimeAction } from '#app/bootstrap/runtime/state-actions';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { executeVerificationEffect } from '../../apps/kite/src/bootstrap/runtime/verification-effect';
import { projectCompletionSemanticsV1 } from '../../apps/kite/src/release/capability-status';
import { decideNextEffect } from '../helpers/agent-kernel-scheduler';

function initialState(): RuntimeState {
  const state = createRuntimeHostStateInitialStateV1({
    recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
    threadId: 'thread',
    userId: 'user',
    workspace: '.',
  });
  state.transcript.final = 'agent final';
  return state;
}

function spec(input: {
  checks: VerificationSpecV1['checks'];
  maxAttempts?: number;
  compensation?: VerificationSpecV1['compensation'];
}): VerificationSpecV1 {
  return {
    schemaVersion: 1,
    verificationId: 'verification-1',
    subject: 'required lifecycle',
    checks: input.checks,
    repair: { maxAttempts: input.maxAttempts ?? 1 },
    ...(input.compensation ? { compensation: input.compensation } : {}),
  };
}

function request(
  value: VerificationSpecV1,
  mode: 'not_required' | 'best_effort' | 'required' = 'required',
): RuntimeEvent {
  return {
    type: 'verification.requested',
    verificationId: value.verificationId,
    mode,
    spec: value,
    requestedAt: '2026-08-01T00:00:00.000Z',
  };
}

function reduceAll(state: RuntimeState, events: readonly RuntimeEvent[]): RuntimeState {
  return events.reduce(reduceRuntimeState, state);
}

describe('required Verification lifecycle conformance', () => {
  test('risk-derived required mode cannot be lowered', () => {
    expect(
      resolveVerificationMode({
        baseline: 'not_required',
        skillMode: 'best_effort',
        userMode: 'not_required',
        capabilityEffects: { filesystem: 'unknown', network: 'none', externalState: 'none' },
      }),
    ).toBe('required');
  });

  test('rollback disables new admission but existing required facts still execute and replay safely', async () => {
    const value = spec({
      checks: [
        {
          checkId: 'schema',
          type: 'schema',
          description: 'deterministic evidence',
          subject: { kind: 'literal', value: { ok: true } },
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false,
          },
        },
      ],
    });
    let state = reduceRuntimeState(initialState(), request(value));
    const rolledBack = projectCompletionSemanticsV1({
      state,
      verificationFeatureEnabled: false,
    });
    expect(rolledBack.verification).toMatchObject({
      newAdmission: 'disabled',
      requiredFactCount: 1,
      requiredFactsRetained: true,
      status: 'pending',
    });
    expect(decideNextEffect(state)).toEqual({
      type: 'run_verification',
      verificationId: 'verification-1',
    });

    const executionEvents = await executeVerificationEffect(
      { type: 'run_verification', verificationId: 'verification-1' },
      state,
    );
    state = reduceAll(state, executionEvents);
    expect(state.verification.records['verification-1']).toMatchObject({
      mode: 'required',
      status: 'passed',
      attempts: 1,
    });

    // A replayed or downgraded request cannot replace the durable required fact.
    state = reduceRuntimeState(state, request(value, 'not_required'));
    state = reduceAll(state, executionEvents);
    expect(state.verification.records['verification-1']).toMatchObject({
      mode: 'required',
      status: 'passed',
      attempts: 1,
    });
  });

  test('budget exhaustion needs a structured user waiver and the model has no waiver event path', async () => {
    const value = spec({
      checks: [
        {
          checkId: 'review',
          type: 'reviewer',
          description: 'independent review',
          instructions: 'review immutable evidence',
        },
      ],
      maxAttempts: 0,
    });
    let state = reduceRuntimeState(initialState(), request(value));
    state = reduceAll(
      state,
      await executeVerificationEffect(
        { type: 'run_verification', verificationId: 'verification-1' },
        state,
      ),
    );
    expect(state.verification.records['verification-1']?.status).toBe('budget_exhausted');
    expect(decideNextEffect(state).type).toBe('request_verification_decision');

    expect(
      eventsForRuntimeAction(state, {
        type: 'waive_verification',
        verificationId: 'verification-1',
        reason: '   ',
      }),
    ).toEqual([]);
    const waiver = eventsForRuntimeAction(state, {
      type: 'waive_verification',
      verificationId: 'verification-1',
      reason: 'User explicitly accepts the missing independent review.',
    });
    expect(waiver).toEqual([
      expect.objectContaining({ type: 'verification.waived', actor: 'user' }),
    ]);
    state = reduceAll(state, waiver);
    expect(state.verification.records['verification-1']).toMatchObject({
      mode: 'required',
      status: 'waived',
      waiver: { actor: 'user' },
    });
  });

  test('compensation preserves required status and remains a decision boundary', async () => {
    const value = spec({
      checks: [
        {
          checkId: 'missing',
          type: 'file_assertion',
          description: 'required output',
          path: `missing-${crypto.randomUUID()}`,
          assertion: 'exists',
        },
      ],
      maxAttempts: 0,
      compensation: { command: 'undo' },
    });
    let state = reduceRuntimeState(initialState(), request(value));
    state = reduceAll(
      state,
      await executeVerificationEffect(
        { type: 'run_verification', verificationId: 'verification-1' },
        state,
      ),
    );
    state = reduceAll(
      state,
      eventsForRuntimeAction(state, {
        type: 'request_verification_compensation',
        verificationId: 'verification-1',
      }),
    );
    state = reduceAll(
      state,
      await executeVerificationEffect(
        { type: 'run_verification_compensation', verificationId: 'verification-1' },
        state,
        {
          shellExecutor: async ({ command }) => ({
            ok: true,
            command,
            exitCode: 0,
            stdout: '',
            stderr: '',
          }),
        },
      ),
    );
    expect(state.verification.records['verification-1']).toMatchObject({
      mode: 'required',
      status: 'compensated',
      compensation: { outcome: 'passed' },
    });
    expect(decideNextEffect(state).type).toBe('request_verification_decision');
    expect(
      projectCompletionSemanticsV1({ state, verificationFeatureEnabled: false }).verification,
    ).toMatchObject({
      newAdmission: 'disabled',
      requiredFactsRetained: true,
      status: 'compensated',
    });
  });
});
