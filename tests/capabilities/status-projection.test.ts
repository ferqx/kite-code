import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite/agent-kernel';
import { createRuntimeHostState26InitialStateV1 } from '@kite/runtime-host';
import {
  evaluateCapabilityProfileAdmissionV1,
  parseCapabilityProfileV1,
} from '#app/config/release-capabilities';
import { reduceRuntimeState } from '#runtime-support/runtime-state26-reducer';
import {
  formatCapabilityStatusV1,
  projectCapabilityStatusV1,
} from '../../apps/kite/src/release/capability-status';

function verificationProfile() {
  return parseCapabilityProfileV1(
    JSON.parse(
      readFileSync(
        join(import.meta.dir, '../../release/capability-profiles/verification-v1.json'),
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
    const admission = evaluateCapabilityProfileAdmissionV1({
      profile,
      embeddedCeiling: { maturity: 'under_development', maxRollout: 'off' },
      features: { verificationV1: true },
      dependencies: {},
    });
    const state = createRuntimeHostState26InitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'thread',
      userId: 'user',
      workspace: '.',
    });
    const status = projectCapabilityStatusV1({
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
    const admission = evaluateCapabilityProfileAdmissionV1({
      profile,
      embeddedCeiling: { maturity: 'under_development', maxRollout: 'off' },
      features: { verificationV1: false },
      dependencies: {},
    });
    let state = createRuntimeHostState26InitialStateV1({
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
    const status = projectCapabilityStatusV1({
      profile,
      admission,
      executionBoundary: 'local',
      expectedSideEffects: { filesystem: 'write', network: 'none', externalState: 'none' },
      state,
      verificationFeatureEnabled: false,
    });
    const output = formatCapabilityStatusV1(status);
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
