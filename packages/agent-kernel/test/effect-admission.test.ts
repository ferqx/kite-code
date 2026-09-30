import { describe, expect, test } from 'bun:test';
import {
  type AgentPendingApproval,
  type AgentState,
  assertAgentStateInvariants,
  assertCapabilityToolTerminalBatch,
  attachSuspendedCapabilityTerminals,
  createInitialAgentState,
  hasLateTerminalEventForCancelledTool,
  isConcurrentModelEffectBatchCurrent,
  isConcurrentShellEffectBatchCurrent,
  isConcurrentShellEffectEventCurrent,
  isConcurrentTaskControlEffectBatchCurrent,
  isConcurrentTaskControlEffectEventCurrent,
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

function runningTaskControlState(
  name: 'task_read' | 'task_wait' | 'task_cancel' | 'shell_stop',
  status: 'running' | 'succeeded' | 'cancelled' = 'running',
): AgentState {
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
        control: {
          toolCallId: 'control',
          name,
          modelMessageId: 'message-1',
          args: name === 'shell_stop' ? { shell_id: 'shell-1' } : { task_ids: ['child-1'] },
          createdAtTurnId: 'turn-1',
          status,
          effectClass: name === 'shell_stop' ? 'external_side_effect' : 'read_only',
          sideEffect: name === 'shell_stop',
        },
      },
      queue: [],
      active: status === 'running' ? ['control'] : [],
    },
    capabilities: {
      ...initial.capabilities,
      invocations: {
        controlInvocation: {
          invocationId: 'controlInvocation',
          toolCallId: 'control',
          capabilityId: `builtin:${name}`,
          capabilityRevision: 'revision-1',
          argumentsDigest: 'arguments-1',
          authorizationDigest: 'authorization-1',
          effectiveEffectsDigest: 'effects-1',
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

  test('closes a running approved capability before turn abortion implicitly cancels its Tool', () => {
    const running = runningShellState();
    const state: AgentState = {
      ...running,
      capabilities: {
        ...running.capabilities,
        invocations: {
          invocation: {
            ...running.capabilities.invocations.invocation!,
            attemptsStarted: 1,
            admissionDigest: 'admission-1',
          },
        },
      },
      pendingApprovals: new Map([
        [
          'review-shell',
          {
            interactionId: 'review-shell',
            toolCallId: 'shell',
            route: 'auto',
            fullModeBypassEligible: false,
            fullModePolicyBypassAllowed: false,
            bindingDigest: 'binding',
            approval: {} as AgentPendingApproval['approval'],
            invocation: {},
            sequence: 1,
            generation: 1,
            createdAt: '2026-08-20T00:00:00.000Z',
            status: 'running',
          },
        ],
      ]),
    };
    const aborted: KernelEvent = {
      type: 'turn.aborted',
      turnId: 'turn-1',
      reason: 'Runtime execution failed.',
      cause: 'error',
    };
    expect(suspendedCapabilityTerminalRequirements(state, [aborted])).toEqual([
      { invocationId: 'invocation', toolCallId: 'shell' },
    ]);
    const batch = attachSuspendedCapabilityTerminals(state, [aborted], {
      invocation: '2026-08-20T00:00:02.000Z',
    });
    expect(batch.map((event) => event.type)).toEqual([
      'capability.execution_unknown',
      'turn.aborted',
    ]);
    let settled = state;
    for (const event of batch) {
      settled = reduce(settled, [normalizeAgentEvent(event, settled, '2026-08-20T00:00:02.000Z')]);
    }
    expect(settled.tools.calls.shell?.status).toBe('cancelled');
    expect(settled.capabilities.invocations.invocation?.status).toBe('unknown');
    expect(() => assertAgentStateInvariants(settled)).not.toThrow();
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

  test('admits an exact live shell_read terminal across unrelated background revisions', () => {
    const state = runningShellState();
    const shellReadState: AgentState = {
      ...state,
      tools: {
        ...state.tools,
        calls: {
          shell: {
            ...state.tools.calls.shell!,
            name: 'shell_read',
            args: { shell_id: 'sh-1', wait_until: 'terminal' },
          },
        },
      },
    };
    expect(
      isConcurrentShellEffectEventCurrent(shellReadState, lease, {
        type: 'tool.finished',
        toolCallId: 'shell',
        name: 'shell_read',
        result: {
          ok: true,
          command: 'sleep 5',
          exitCode: 0,
          stdout: '',
          stderr: '',
          resultMeta: { shellId: 'sh-1', shellStatus: 'exited' },
        },
      }),
    ).toBe(true);
    expect(
      isConcurrentShellEffectEventCurrent(
        shellReadState,
        { ...lease, effect: { type: 'run_tools', toolCallIds: ['other'] } },
        finished,
      ),
    ).toBe(false);
  });

  for (const name of ['task_read', 'task_wait', 'task_cancel', 'shell_stop'] as const) {
    test(`admits only the exact live ${name} terminal across child settlement revisions`, () => {
      const state = runningTaskControlState(name);
      const taskLease = {
        turnId: 'turn-1',
        effect: { type: 'run_tools' as const, toolCallIds: ['control'] },
      };
      const terminal: KernelEvent = {
        type: 'tool.finished',
        toolCallId: 'control',
        name,
        result: {
          ok: true,
          command: '',
          exitCode: 0,
          stdout: '{}',
          stderr: '',
        },
      };
      const occurredAt = () => '2026-08-20T00:00:02.000Z';
      const capabilityTerminal: KernelEvent = {
        type: 'capability.execution_succeeded',
        invocationId: 'controlInvocation',
        resultDigest: 'result-digest',
        evidenceDigest: 'evidence-digest',
        finishedAt: '2026-08-20T00:00:02.000Z',
        artifact: {
          artifactId: 'task-control-result',
          kind: 'capability_result',
          integrityIdentifier: 'task-control-integrity',
          byteLength: 1,
        },
      };

      expect(isConcurrentTaskControlEffectEventCurrent(state, taskLease, terminal)).toBe(true);
      expect(
        isConcurrentTaskControlEffectBatchCurrent(
          state,
          taskLease,
          [capabilityTerminal, terminal],
          occurredAt,
        ),
      ).toBe(true);
      expect(
        isConcurrentTaskControlEffectEventCurrent(state, taskLease, {
          type: 'capability.execution_unknown',
          invocationId: 'controlInvocation',
          reason: 'child settlement raced the result commit',
          finishedAt: '2026-08-20T00:00:02.000Z',
        }),
      ).toBe(true);
    });
  }

  for (const name of ['task_wait', 'shell_stop'] as const) {
    test(`rejects cross-bound or settled ${name} concurrent results`, () => {
      const state = runningTaskControlState(name);
      const taskLease = {
        turnId: 'turn-1',
        effect: { type: 'run_tools' as const, toolCallIds: ['control'] },
      };
      expect(
        isConcurrentTaskControlEffectEventCurrent(state, taskLease, {
          type: 'tool.started',
          toolCallId: 'control',
        }),
      ).toBe(false);
      expect(
        isConcurrentTaskControlEffectEventCurrent(state, taskLease, {
          type: 'capability.execution_started',
          invocationId: 'controlInvocation',
          attempt: 2,
          startedAt: '2026-08-20T00:00:02.000Z',
        }),
      ).toBe(false);
      const terminal: KernelEvent = {
        type: 'tool.finished',
        toolCallId: 'control',
        name,
        result: { ok: true, command: '', exitCode: 0, stdout: '{}', stderr: '' },
      };

      expect(
        isConcurrentTaskControlEffectEventCurrent(
          {
            ...state,
            turn: { ...state.turn, status: 'aborted' },
          },
          taskLease,
          terminal,
        ),
      ).toBe(false);
      expect(
        isConcurrentTaskControlEffectEventCurrent(
          state,
          {
            ...taskLease,
            effect: { type: 'run_tools', toolCallIds: ['other'] },
          },
          terminal,
        ),
      ).toBe(false);
      expect(
        isConcurrentTaskControlEffectEventCurrent(
          state,
          { ...taskLease, turnId: 'other-turn' },
          terminal,
        ),
      ).toBe(false);
      expect(
        isConcurrentTaskControlEffectEventCurrent(
          runningTaskControlState(name, 'succeeded'),
          taskLease,
          terminal,
        ),
      ).toBe(false);
      expect(
        isConcurrentTaskControlEffectEventCurrent(
          runningTaskControlState(name, 'cancelled'),
          taskLease,
          terminal,
        ),
      ).toBe(false);
      expect(
        isConcurrentTaskControlEffectEventCurrent(state, taskLease, {
          type: 'tool.finished',
          toolCallId: 'control',
          name: 'read_file',
          result: { ok: true, command: '', exitCode: 0, stdout: '', stderr: '' },
        }),
      ).toBe(false);
      expect(
        isConcurrentTaskControlEffectEventCurrent(
          {
            ...state,
            capabilities: { ...state.capabilities, invocations: {} },
          },
          taskLease,
          terminal,
        ),
      ).toBe(false);
      expect(
        isConcurrentTaskControlEffectEventCurrent(
          {
            ...state,
            capabilities: {
              ...state.capabilities,
              invocations: {
                controlInvocation: {
                  ...state.capabilities.invocations.controlInvocation!,
                  status: 'recorded',
                },
              },
            },
          },
          taskLease,
          terminal,
        ),
      ).toBe(false);
      expect(
        isConcurrentTaskControlEffectEventCurrent(state, taskLease, {
          type: 'capability.execution_unknown',
          invocationId: 'foreign-invocation',
          reason: 'foreign',
          finishedAt: '2026-08-20T00:00:02.000Z',
        }),
      ).toBe(false);
      expect(
        isConcurrentTaskControlEffectEventCurrent(state, taskLease, {
          type: 'user.message_appended',
          messageId: 'foreign-event',
          content: 'foreign',
        }),
      ).toBe(false);
    });
  }

  test('requires exact capability and Tool terminal pairs for every concurrent task-control call', () => {
    const first = runningTaskControlState('task_wait');
    const state: AgentState = {
      ...first,
      tools: {
        calls: {
          ...first.tools.calls,
          second: {
            ...first.tools.calls.control!,
            toolCallId: 'second',
            name: 'task_read',
          },
        },
        queue: [],
        active: ['control', 'second'],
      },
      capabilities: {
        ...first.capabilities,
        invocations: {
          ...first.capabilities.invocations,
          secondInvocation: {
            ...first.capabilities.invocations.controlInvocation!,
            invocationId: 'secondInvocation',
            toolCallId: 'second',
            capabilityId: 'builtin:task_read',
          },
        },
      },
    };
    const taskLease = {
      turnId: 'turn-1',
      effect: { type: 'run_tools' as const, toolCallIds: ['control', 'second'] },
    };
    const capabilityTerminal = (invocationId: string): KernelEvent => ({
      type: 'capability.execution_succeeded',
      invocationId,
      resultDigest: `result-${invocationId}`,
      evidenceDigest: `evidence-${invocationId}`,
      finishedAt: '2026-08-20T00:00:02.000Z',
      artifact: {
        artifactId: `result-${invocationId}`,
        kind: 'capability_result',
        integrityIdentifier: `integrity-${invocationId}`,
        byteLength: 1,
      },
    });
    const toolTerminal = (toolCallId: string, name: 'task_wait' | 'task_read'): KernelEvent => ({
      type: 'tool.finished',
      toolCallId,
      name,
      result: { ok: true, command: '', exitCode: 0, stdout: '{}', stderr: '' },
    });
    const occurredAt = () => '2026-08-20T00:00:02.000Z';

    expect(
      isConcurrentTaskControlEffectBatchCurrent(
        state,
        taskLease,
        [capabilityTerminal('controlInvocation'), toolTerminal('second', 'task_read')],
        occurredAt,
      ),
    ).toBe(false);
    expect(
      isConcurrentTaskControlEffectBatchCurrent(
        state,
        taskLease,
        [toolTerminal('control', 'task_wait')],
        occurredAt,
      ),
    ).toBe(false);
    expect(
      isConcurrentTaskControlEffectBatchCurrent(
        state,
        taskLease,
        [
          {
            type: 'capability.reconciliation_resolved',
            invocationId: 'controlInvocation',
            decision: 'confirmed_success',
            reconciledAt: '2026-08-20T00:00:02.000Z',
          },
          toolTerminal('control', 'task_wait'),
        ],
        occurredAt,
      ),
    ).toBe(false);
    expect(
      isConcurrentTaskControlEffectBatchCurrent(
        state,
        taskLease,
        [
          capabilityTerminal('controlInvocation'),
          toolTerminal('control', 'task_wait'),
          capabilityTerminal('secondInvocation'),
          toolTerminal('second', 'task_read'),
        ],
        occurredAt,
      ),
    ).toBe(true);
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
