import { describe, expect, test } from 'bun:test';
import type { RuntimeNotificationEvent } from '@kite-ai/runtime-contract';
import { projectCliRuntimeEvent } from '#kite-cli/cli';

describe('CLI Runtime Client failure projection', () => {
  test('adds terminal presentation only to the closed client event', () => {
    const event: RuntimeNotificationEvent = {
      type: 'run.terminal',
      runId: 'run-client-fixture',
      status: 'failed',
      outcome: {
        status: 'unknown',
        reasonCode: 'persistence_unavailable',
        safeRetry: false,
        recoveryEntry: 'reconcile',
      },
    };

    expect(projectCliRuntimeEvent(event)).toMatchObject({
      ...event,
      terminalPresentation: {
        label: 'persistence unavailable',
        severity: 'warning',
        complete: false,
        safeRetry: false,
        recoveryEntry: 'reconcile',
      },
    });
    expect(projectCliRuntimeEvent(event, false)).toEqual(event);
  });

  test('passes content-free failure facts through unchanged', () => {
    const event: RuntimeNotificationEvent = {
      type: 'run.failure',
      runId: 'run-client-fixture',
      code: 'verification_inconclusive',
      retryable: false,
      recoveryEntry: 'operator_action',
    };
    expect(projectCliRuntimeEvent(event)).toEqual(event);
  });
});
