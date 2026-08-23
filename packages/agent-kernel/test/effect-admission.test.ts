import { describe, expect, test } from 'bun:test';
import {
  type AgentState,
  assertCapabilityToolTerminalBatch,
  attachSuspendedCapabilityTerminals,
  createInitialAgentState,
  hasLateTerminalEventForCancelledTool,
  isConcurrentShellEffectBatchCurrent,
  isConcurrentShellEffectEventCurrent,
  type KernelEvent,
  suspendedCapabilityTerminalRequirements,
} from '../src';

const RECOVERY_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function runningShellState(status: 'running' | 'cancelled' = 'running'): AgentState {
  const initial = createInitialAgentState({
    threadId: 'session-1',
    userId: 'user-1',
    workspace: '/workspace',
    turnId: 'turn-1',
    recoveryIdentityKey: RECOVERY_KEY,
  });
  return {
    ...initial,
    tools: {
      calls: {
        shell: {
          toolCallId: 'shell',
          name: 'shell_execute',
          modelMessageId: 'message-1',
          args: { command: 'pwd' },
          createdAtTurnId: 'turn-1',
          status,
          effectClass: 'read_only',
          sideEffect: false,
        },
      },
      queue: [],
      active: status === 'running' ? ['shell'] : [],
    },
    capabilities: {
      ...initial.capabilities,
      invocations: {
        invocation: {
          invocationId: 'invocation',
          toolCallId: 'shell',
          capabilityId: 'builtin:shell_execute',
          capabilityRevision: 'revision-1',
          argumentsDigest: 'arguments-1',
          authorizationDigest: 'authorization-1',
          effectiveEffectsDigest: 'effects-1',
          receiptRequirement: 'effect_receipt',
          retryEligibility: 'none',
          status: 'running',
          recordedAt: '2026-08-20T00:00:00.000Z',
          startedAt: '2026-08-20T00:00:01.000Z',
        },
      },
    },
  };
}

const lease = {
  turnId: 'turn-1',
  effect: { type: 'run_tools' as const, toolCallIds: ['shell'] },
};

const finished: KernelEvent = {
  type: 'tool.finished',
  toolCallId: 'shell',
  name: 'shell_execute',
  result: {
    ok: true,
    command: 'pwd',
    exitCode: 0,
    stdout: '/workspace',
    stderr: '',
  },
};

describe('State effect admission policy', () => {
  test('requires and atomically attaches one suspended capability terminal', () => {
    const state = runningShellState();
    const cancelled: KernelEvent = {
      type: 'tool.cancelled',
      toolCallId: 'shell',
      reason: 'user cancellation',
    };
    expect(suspendedCapabilityTerminalRequirements(state, [cancelled])).toEqual([
      { invocationId: 'invocation', toolCallId: 'shell' },
    ]);
    const batch = attachSuspendedCapabilityTerminals(state, [cancelled], {
      invocation: '2026-08-20T00:00:02.000Z',
    });
    expect(batch.map((event) => event.type)).toEqual([
      'capability.execution_unknown',
      'tool.cancelled',
    ]);
    expect(() => assertCapabilityToolTerminalBatch(state, lease, batch)).not.toThrow();
    expect(() => assertCapabilityToolTerminalBatch(state, lease, [batch[0]!])).toThrow(
      /atomic batch/u,
    );
  });

  test('rejects late cancelled results and admits only exact live Shell identities', () => {
    expect(
      hasLateTerminalEventForCancelledTool(runningShellState('cancelled'), lease, [finished]),
    ).toBe(true);
    const state = runningShellState();
    expect(isConcurrentShellEffectEventCurrent(state, lease, finished)).toBe(true);
    expect(
      isConcurrentShellEffectEventCurrent(
        state,
        { ...lease, effect: { type: 'run_tools', toolCallIds: ['other'] } },
        finished,
      ),
    ).toBe(false);
    expect(
      isConcurrentShellEffectBatchCurrent(
        state,
        lease,
        [finished],
        () => '2026-08-20T00:00:02.000Z',
      ),
    ).toBe(true);
    expect(isConcurrentShellEffectBatchCurrent(state, lease, [finished], () => 'not-a-time')).toBe(
      false,
    );
  });

  test('admits verification only in the atomic batch that commits its source receipt', () => {
    const state = runningShellState();
    const verification: KernelEvent = {
      type: 'verification.requested',
      verificationId: 'verification-1',
      mode: 'required',
      spec: {
        schemaVersion: 1,
        verificationId: 'verification-1',
        subject: 'Committed capability result',
        checks: [
          {
            checkId: 'schema-1',
            description: 'Validate the committed capability Artifact.',
            type: 'schema',
            subject: { kind: 'capability_artifact', invocationId: 'invocation' },
            schema: { type: 'object' },
          },
        ],
        repair: { maxAttempts: 0 },
      },
      requestedAt: '2026-08-20T00:00:02.000Z',
    };
    expect(() => assertCapabilityToolTerminalBatch(state, lease, [verification])).toThrow(
      'uncommitted capability receipt',
    );

    const receipt: KernelEvent = {
      type: 'capability.execution_succeeded',
      invocationId: 'invocation',
      resultDigest: 'result-digest',
      evidenceDigest: 'evidence-digest',
      finishedAt: '2026-08-20T00:00:02.000Z',
      artifact: {
        artifactId: 'artifact-result',
        kind: 'capability_result',
        integrityIdentifier: 'integrity-result',
        byteLength: 1,
      },
    };
    expect(() =>
      assertCapabilityToolTerminalBatch(state, lease, [receipt, finished, verification]),
    ).not.toThrow();
  });
});
