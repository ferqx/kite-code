import { describe, expect, test } from 'bun:test';
import type { RuntimeClientEvent } from '@kite-ai/runtime-contract';
import { projectCliRuntimeEvent } from '#kite-cli/cli';

describe('CLI Runtime Client failure projection', () => {
  test('adds terminal presentation only to the closed client event', () => {
    const event: RuntimeClientEvent = {
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

  test('passes canonical failed Run terminal facts through unchanged', () => {
    const event: RuntimeClientEvent = {
      type: 'run.terminal',
      runId: 'run-client-fixture',
      status: 'failed',
      outcome: {
        status: 'unknown',
        reasonCode: 'verification_inconclusive',
        safeRetry: false,
        recoveryEntry: 'operator_action',
      },
    };
    expect(projectCliRuntimeEvent(event)).toEqual({
      ...event,
      terminalPresentation: {
        label: 'verification inconclusive',
        severity: 'warning',
        complete: false,
        safeRetry: false,
        recoveryEntry: 'operator_action',
      },
    });
  });
});
