import { describe, expect, test } from 'bun:test';
import { projectCliRuntimeEventV1 } from '@/app/cli';
import { classifyFailure, terminalReasonForFailureV1 } from '@/core/runtime/failures';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import { createInitialRuntimeState } from '@/core/runtime/state';
import {
  completedTerminalOutcomeV1,
  failedTerminalOutcomeV1,
  projectTerminalOutcomeV1,
} from '@/core/runtime/terminal-outcome';

describe('runtime terminal taxonomy v1', () => {
  test('keeps blocked, unknown, budget and saturation distinct', () => {
    expect(terminalReasonForFailureV1('budget_exceeded')).toBe('budget_exhausted');
    expect(terminalReasonForFailureV1('resource_saturated')).toBe('resource_saturated');
    expect(terminalReasonForFailureV1('mandatory_policy_unavailable')).toBe(
      'mandatory_policy_unavailable',
    );
    const unknown = failedTerminalOutcomeV1(classifyFailure('unknown', 'unknown external result'), {
      knownExternalEffects: 'unknown',
    });
    expect(unknown).toMatchObject({
      status: 'unknown',
      reasonCode: 'unknown',
      safeRetry: false,
      recoveryEntry: 'reconcile',
    });
    expect(projectTerminalOutcomeV1(unknown).complete).toBe(false);
    expect(projectTerminalOutcomeV1(completedTerminalOutcomeV1()).complete).toBe(true);
  });

  test('persists a structured terminal outcome without parsing the message', () => {
    const initial = createInitialRuntimeState({
      threadId: 'terminal',
      userId: 'u',
      workspace: '/',
    });
    const failure = classifyFailure('verification_inconclusive', 'localized display text');
    const outcome = failedTerminalOutcomeV1(failure, { pendingVerification: true });
    const state = reduceRuntimeState(initial, {
      type: 'run.error',
      message: '任意展示字符串',
      recoverable: false,
      failure,
      outcome,
    });
    expect(state.terminalOutcome).toEqual(outcome);
    expect(state.terminalOutcome?.reasonCode).toBe('verification_inconclusive');
    expect(
      projectCliRuntimeEventV1({
        type: 'run.error',
        message: '任意展示字符串',
        recoverable: false,
        failure,
        outcome,
      }),
    ).toMatchObject({
      terminalPresentation: {
        label: 'verification inconclusive',
        complete: false,
        recoveryEntry: 'operator_action',
      },
    });
  });
});
