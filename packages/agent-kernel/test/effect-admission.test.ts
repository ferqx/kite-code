import { describe, expect, test } from 'bun:test';
import {
  type AgentState,
  assertAgentStateInvariants,
  assertCapabilityToolTerminalBatch,
  attachSuspendedCapabilityTerminals,
  createInitialAgentState,
  hasLateTerminalEventForCancelledTool,
  isConcurrentModelEffectBatchCurrent,
  isConcurrentShellEffectBatchCurrent,
  isConcurrentShellEffectEventCurrent,
  type KernelEvent,
  normalizeAgentEvent,
  reduce,
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

function dispatchingModelState(): AgentState {
  const artifact = {
    kind: 'model_surface' as const,
    artifactId: `pa_${'b'.repeat(64)}`,
    integrityIdentifier: `sha256:${'c'.repeat(64)}`,
    byteLength: 1,
  };
  let state = createInitialAgentState({
    threadId: 'model-session',
    userId: 'user-1',
    workspace: '/workspace',
    turnId: 'turn-1',
    recoveryIdentityKey: RECOVERY_KEY,
  });
  const events: KernelEvent[] = [
    {
      type: 'model.invocation_prepared',
      invocationId: 'model-1',
      purpose: 'primary_agent',
      surfaceArtifact: artifact,
      surfaceIntegrityIdentifier: artifact.integrityIdentifier,
      routeFingerprint: `sha256:${'d'.repeat(64)}`,
      budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
      limits: { maxAttempts: 2, perAttemptTimeoutMs: 1_000, totalTimeBudgetMs: 2_000 },
      preparedStateRevision: 0,
      parentInvocationId: null,
      parentToolCallId: null,
    },
    {
      type: 'model.invocation_attempt_started',
      invocationId: 'model-1',
      attempt: 1,
      maxAttempts: 2,
    },
  ];
  for (const event of events) {
    state = reduce(state, [normalizeAgentEvent(event, state, '2026-08-20T00:00:00.000Z')]);
  }
  return state;
}

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

  test('closes every live capability before a Tool terminal, including recorded invocations', () => {
    const state = runningShellState();
    const invocation = state.capabilities.invocations.invocation;
    if (!invocation) throw new Error('capability fixture is missing');
    const {
      receiptRequirement: _receiptRequirement,
      startedAt: _startedAt,
      ...recordedInvocation
    } = invocation;
    const liveState: AgentState = {
      ...state,
      capabilities: {
        ...state.capabilities,
        invocations: {
          invocation: {
            ...recordedInvocation,
            status: 'running',
            startedAt: invocation.startedAt,
          },
          recorded: {
            ...recordedInvocation,
            invocationId: 'recorded',
            status: 'recorded',
          },
        },
      },
    };
    const reconciled: KernelEvent = {
      type: 'capability.reconciliation_resolved',
      invocationId: 'invocation',
      decision: 'confirmed_failure',
      reconciledAt: '2026-08-20T00:00:02.000Z',
      reason: 'The owning Tool was cancelled.',
    };
    const cancelled: KernelEvent = {
      type: 'tool.cancelled',
      toolCallId: 'shell',
      reason: 'user cancellation',
    };

    expect(suspendedCapabilityTerminalRequirements(liveState, [cancelled, reconciled])).toEqual([
      { invocationId: 'recorded', toolCallId: 'shell' },
    ]);
    const batch = attachSuspendedCapabilityTerminals(liveState, [cancelled, reconciled], {
      recorded: '2026-08-20T00:00:02.000Z',
    });
    expect(batch.map((event) => event.type)).toEqual([
      'capability.reconciliation_resolved',
      'capability.execution_unknown',
      'tool.cancelled',
    ]);
    let settled = liveState;
    for (const event of batch) {
      settled = reduce(settled, [normalizeAgentEvent(event, settled, '2026-08-20T00:00:02.000Z')]);
    }
    expect(() => assertAgentStateInvariants(settled)).not.toThrow();
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

  test('admits only the exact live Model retry or terminal batch across control revisions', () => {
    const state = dispatchingModelState();
    const modelLease = { turnId: 'turn-1', effect: { type: 'call_model' as const } };
    const responseArtifact = {
      kind: 'model_response' as const,
      artifactId: `pa_${'e'.repeat(64)}`,
      integrityIdentifier: `sha256:${'f'.repeat(64)}`,
      byteLength: 2,
    };
    const completion: KernelEvent[] = [
      {
        type: 'model.invocation_completed',
        invocationId: 'model-1',
        responseArtifact,
        finishReason: 'stop',
      },
      {
        type: 'model.responded',
        invocationId: 'model-1',
        messageId: 'assistant-1',
        text: 'done',
        toolCalls: [],
      },
    ];
    const occurredAt = () => '2026-08-20T00:00:02.000Z';

    expect(isConcurrentModelEffectBatchCurrent(state, modelLease, completion, occurredAt)).toBe(
      true,
    );
    expect(
      isConcurrentModelEffectBatchCurrent(
        state,
        modelLease,
        [
          {
            type: 'model.retry',
            invocationId: 'model-1',
            attempt: 1,
            maxAttempts: 2,
            error: 'transient_model_connection_error',
            delayMs: 500,
          },
        ],
        occurredAt,
      ),
    ).toBe(true);
    expect(
      isConcurrentModelEffectBatchCurrent(
        state,
        modelLease,
        [{ type: 'model.text_delta', requestId: 'model-1', text: 'streaming' }],
        occurredAt,
      ),
    ).toBe(true);
    expect(
      isConcurrentModelEffectBatchCurrent(
        state,
        modelLease,
        [{ ...completion[0]!, invocationId: 'other-model' } as KernelEvent],
        occurredAt,
      ),
    ).toBe(false);
    expect(
      isConcurrentModelEffectBatchCurrent(
        { ...state, turn: { ...state.turn, status: 'aborted', abortReason: 'cancelled' } },
        modelLease,
        completion,
        occurredAt,
      ),
    ).toBe(false);
    expect(
      isConcurrentModelEffectBatchCurrent(
        state,
        modelLease,
        [
          ...completion,
          { type: 'user.message_appended', messageId: 'injected', content: 'not model evidence' },
        ],
        occurredAt,
      ),
    ).toBe(false);
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
