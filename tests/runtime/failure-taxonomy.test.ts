import { describe, expect, test } from 'bun:test';
import { createRuntimeHostState25InitialStateV1 } from '@kite/runtime-host';
import { resolveFailureModeV1 } from '#app/bootstrap/runtime/failure-mode-conformance';
import { classifyFailure, terminalReasonForFailureV1 } from '#app/bootstrap/runtime/failures';
import {
  completedTerminalOutcomeV1,
  failedTerminalOutcomeV1,
  projectTerminalOutcomeV1,
} from '#app/bootstrap/runtime/terminal-outcome';
import { reduceRuntimeState } from '#runtime-support/runtime-state25-reducer';
import { projectCliRuntimeEventV1 } from '@/app/cli';

describe('runtime terminal taxonomy v1', () => {
  test('keeps blocked, unknown, budget and saturation distinct', () => {
    expect(terminalReasonForFailureV1('budget_exceeded')).toBe('budget_exhausted');
    expect(terminalReasonForFailureV1('resource_saturated')).toBe('resource_saturated');
    expect(terminalReasonForFailureV1('mandatory_policy_unavailable')).toBe(
      'mandatory_policy_unavailable',
    );
    expect(
      failedTerminalOutcomeV1(classifyFailure('process_limit_exceeded', 'tree too large')),
    ).toMatchObject({
      status: 'budget_exhausted',
      reasonCode: 'process_limit_exceeded',
    });
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
    const initial = createRuntimeHostState25InitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'terminal',
      userId: 'u',
      workspace: '/',
    });
    const failure = classifyFailure('verification_inconclusive', 'localized display text');
    const outcome = resolveFailureModeV1('verification_inconclusive', {
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
    expect(
      projectCliRuntimeEventV1(
        {
          type: 'run.error',
          message: '任意展示字符串',
          recoverable: false,
          failure,
          outcome,
        },
        false,
      ),
    ).toEqual({
      type: 'run.error',
      message: '任意展示字符串',
      recoverable: false,
      failure,
      outcome,
    });
  });
});
