import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite/agent-kernel';
import { createRuntimeHostStateInitialState } from '@kite/runtime-host/kernel-adapter';
import {
  evaluateCapabilityProfileAdmission,
  parseCapabilityProfile,
} from '#app/config/release-capabilities';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import {
  formatCapabilityStatus,
  projectCapabilityStatus,
} from '../../apps/kite/src/release/capability-status';

function verificationProfile() {
  return parseCapabilityProfile(
    JSON.parse(
      readFileSync(
        join(import.meta.dir, '../../release/capability-profiles/verification.json'),
        'utf8',
      ),
    ),
  );
}

function requiredRequest(): RuntimeEvent {
  return {
    type: 'verification.requested',
    verificationId: 'required-1',
    mode: 'required',
    spec: {
      schemaVersion: 1,
      verificationId: 'required-1',
      subject: 'write outcome',
      checks: [
        {
          checkId: 'receipt',
          type: 'external_reference',
          description: 'confirm durable receipt',
          invocationId: 'invocation-1',
        },
      ],
      repair: { maxAttempts: 1 },
    },
    requestedAt: '2026-08-01T00:00:00.000Z',
  };
}

describe('capability status projection', () => {
  test('keeps status presentation unable to bypass admission', () => {
    const profile = verificationProfile();
    const admission = evaluateCapabilityProfileAdmission({
      profile,
      embeddedCeiling: { maturity: 'under_development', maxRollout: 'off' },
      features: { verification: true },
      dependencies: {},
    });
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'thread',
      userId: 'user',
      workspace: '.',
    });
    const status = projectCapabilityStatus({
      profile,
      admission,
      executionBoundary: 'local',
      expectedSideEffects: { filesystem: 'read', network: 'none', externalState: 'none' },
      state,
      verificationFeatureEnabled: false,
    });
    expect(status.admission).toBe('blocked');
    expect(status.disabledReasons).toContain('dependency_unknown');
    expect(status.rollout).toBe('off');
  });

  test('renders independent completion facts and never a single ambiguous status', () => {
    const profile = verificationProfile();
    const admission = evaluateCapabilityProfileAdmission({
      profile,
      embeddedCeiling: { maturity: 'under_development', maxRollout: 'off' },
      features: { verification: false },
      dependencies: {},
    });
    let state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'thread',
      userId: 'user',
      workspace: '.',
    });
    state = reduceRuntimeState(state, requiredRequest());
    state.transcript.final = 'The model says the work is done.';
    state.terminalOutcome = {
      version: 1,
      status: 'completed',
      reasonCode: 'completed',
      knownExternalEffects: 'known',
      safeRetry: false,
      recoveryEntry: 'none',
      pendingVerification: true,
    };
    const status = projectCapabilityStatus({
      profile,
      admission,
      executionBoundary: 'local',
      expectedSideEffects: { filesystem: 'write', network: 'none', externalState: 'none' },
      state,
      verificationFeatureEnabled: false,
    });
    const output = formatCapabilityStatus(status);
    expect(output).toContain('Agent final: present');
    expect(output).toContain('Runtime terminal: completed');
    expect(output).toContain('Plan lifecycle: building_without_plan');
    expect(output).toContain('Checks: executed=0 declared=1');
    expect(output).toContain('Required Verification facts: retained=yes count=1 status=pending');
    expect(output).toContain('Completion assessment: runtime_completed_verification_pending');
    expect(output.split('\n')).not.toContain('Completed');
    expect(status.admission).toBe('blocked');
  });
});
