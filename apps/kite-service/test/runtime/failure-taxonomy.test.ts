import { describe, expect, test } from 'bun:test';
import {
  createRuntimeHostStateInitialState,
  runtimeHostStateResolveFailureMode as resolveFailureMode,
} from '@kite-ai/runtime-host/kernel-adapter';
import {
  classifyFailure,
  terminalReasonForFailure,
} from '#kite-service/bootstrap/runtime/failures';
import {
  completedTerminalOutcome,
  failedTerminalOutcome,
  projectTerminalOutcome,
} from '#kite-service/bootstrap/runtime/terminal-outcome';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import { projectRuntimeClientEvent } from '../../src/runtime-client/event-projector';

describe('runtime terminal taxonomy v1', () => {
  test('keeps blocked, unknown, budget and saturation distinct', () => {
    expect(terminalReasonForFailure('budget_exceeded')).toBe('budget_exhausted');
    expect(terminalReasonForFailure('resource_saturated')).toBe('resource_saturated');
    expect(terminalReasonForFailure('mandatory_policy_unavailable')).toBe(
      'mandatory_policy_unavailable',
    );
    expect(
      failedTerminalOutcome(classifyFailure('process_limit_exceeded', 'tree too large')),
    ).toMatchObject({
      status: 'budget_exhausted',
      reasonCode: 'process_limit_exceeded',
    });
    const unknown = failedTerminalOutcome(classifyFailure('unknown', 'unknown external result'), {
      knownExternalEffects: 'unknown',
    });
    expect(unknown).toMatchObject({
      status: 'unknown',
      reasonCode: 'unknown',
      safeRetry: false,
      recoveryEntry: 'reconcile',
    });
    expect(projectTerminalOutcome(unknown).complete).toBe(false);
    expect(projectTerminalOutcome(completedTerminalOutcome()).complete).toBe(true);
  });

  test('persists a structured terminal outcome without parsing the message', () => {
    const initial = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'terminal',
      userId: 'u',
      workspace: '/',
    });
    const failure = classifyFailure('verification_inconclusive', 'localized display text');
    const outcome = resolveFailureMode('verification_inconclusive', {
      knownExternalEffects: 'known',
    }).terminalOutcome!;
    const state = reduceRuntimeState(initial, {
      type: 'run.error',
      message: '任意展示字符串',
      recoverable: false,
      failure,
      outcome,
    });
    expect(state.terminalOutcome).toEqual(outcome);
    expect(state.terminalOutcome?.reasonCode).toBe('verification_inconclusive');
    const clientEvent = projectRuntimeClientEvent(
      {
        type: 'run.error',
        turnId: 'runtime-run',
        message: '任意展示字符串',
        recoverable: false,
        failure,
        outcome,
      },
      { sessionRevision: state.revision },
    );
    if (!clientEvent) throw new Error('expected a projected failure lifecycle event');
    expect(clientEvent).toEqual({
      type: 'run.terminal',
      runId: 'runtime-run',
      status: 'failed',
      outcome: {
        status: outcome.status,
        reasonCode: 'verification_inconclusive',
        safeRetry: false,
        recoveryEntry: 'operator_action',
      },
    });
  });
});
