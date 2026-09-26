import { describe, expect, test } from 'bun:test';
import { childThreadIdForToolAttempt, sameChildTaskArtifactRef } from '../src/child-session';
import { reduceCapabilityState } from '../src/domains/capability/reducer';
import { reduceContextState } from '../src/domains/context/reducer';
import type { KernelEvent } from '../src/events';
import { assertAgentStateInvariants } from '../src/invariants';
import { reduceAgentState } from '../src/reducer';
import { type AgentState, createInitialAgentState } from '../src/state';
import { decodeCurrentAgentStateJson, encodeCurrentAgentStateJson } from '../src/state-codec';

const parentSessionId = 'parent-session';
const parentInvocationId = 'parent-invocation';
const parentToolCallId = 'parent-tool';
const childInvocationId = 'child-invocation';
const childThreadId = childThreadIdForToolAttempt({
  parentSessionId,
  parentInvocationId,
  parentToolCallId,
  attempt: 1,
});
const grantDigest = `sha256:${'a'.repeat(64)}`;
const taskTextDigest = `sha256:${'b'.repeat(64)}`;
const taskArtifactRef = {
  artifactId: `pa_${'c'.repeat(64)}`,
  kind: 'subagent_task' as const,
  integrityIdentifier: `sha256:${'c'.repeat(64)}`,
  byteLength: 100,
};

function childState(): AgentState {
  return {
    ...createInitialAgentState({
      threadId: childThreadId,
      userId: 'user',
      workspace: '/workspace',
      turnId: 'child-run',
      recoveryIdentityKey: '0'.repeat(64),
    }),
    childSessionOrigin: {
      parentSessionId,
      parentInvocationId,
      parentToolCallId,
      attempt: 1,
      childInvocationId,
      grantDigest,
      taskArtifactRef,
      taskArtifactDigest: taskArtifactRef.integrityIdentifier,
      taskTextDigest,
      role: 'explore',
      fundingRunId: 'parent-run',
      delegatedReservationId: 'delegated-1',
      delegatedUpperBoundDigest: `sha256:${'d'.repeat(64)}`,
      deadlineAt: '2026-09-23T00:10:00.000Z',
    },
  };
}

describe('independent child Session facts', () => {
  test('prepares a fresh followup task and turn while retaining the first child terminal', () => {
    const initial = childState();
    const terminal: AgentState = {
      ...initial,
      turn: { ...initial.turn, status: 'completed' },
      terminalOutcome: {
        version: 1,
        status: 'completed',
        reasonCode: 'completed',
        knownExternalEffects: 'known',
        safeRetry: false,
        recoveryEntry: 'none',
        pendingVerification: false,
      },
      childSessionOrigin: {
        ...initial.childSessionOrigin!,
        terminal: {
          status: 'completed',
          resultRef: taskArtifactRef,
          cleanupConfirmed: true,
          cancelRequested: false,
          terminalReceiptId: 'first-child-terminal',
          sealedRevision: 1,
        },
      },
    };
    const checkpointRef = {
      artifactId: `pa_${'d'.repeat(64)}`,
      kind: 'subagent_checkpoint' as const,
      integrityIdentifier: `sha256:${'d'.repeat(64)}`,
      byteLength: 100,
    };
    const prepared = reduceAgentState(terminal, {
      type: 'agent.followup_turn_prepared',
      sourceSessionId: parentSessionId,
      submissionId: 'followup-submission',
      targetRunId: 'followup-run',
      taskId: 'followup-task',
      checkpointRef,
      grantRef: {
        artifactId: `pa_${'a'.repeat(64)}`,
        kind: 'agent_followup_grant',
        integrityIdentifier: grantDigest,
        byteLength: 100,
      },
      grantDigest,
    });
    const startedTask = reduceAgentState(prepared, {
      type: 'task.started',
      taskId: 'followup-task',
      userGoal: 'Continue the delegated task.',
      turnId: 'followup-run',
    });
    const started = reduceAgentState(startedTask, {
      type: 'turn.started',
      turnId: 'followup-run',
    });
    assertAgentStateInvariants(started);
    expect(started.activeTaskId).toBe('followup-task');
    expect(started.terminalOutcome).toBeUndefined();
    expect(started.childSessionOrigin?.terminal).toEqual(terminal.childSessionOrigin?.terminal);
    expect(started.activeFollowupTurn).toMatchObject({
      submissionId: 'followup-submission',
      targetRunId: 'followup-run',
      checkpointRef,
    });
    const legacy = decodeCurrentAgentStateJson(encodeCurrentAgentStateJson(terminal));
    expect(legacy.activeFollowupTurn).toBeUndefined();
    expect(legacy.childSessionOrigin?.terminal).toEqual(terminal.childSessionOrigin?.terminal);
    expect(
      decodeCurrentAgentStateJson(encodeCurrentAgentStateJson(started)).activeFollowupTurn,
    ).toEqual(started.activeFollowupTurn);
    const firstFinished: AgentState = {
      ...started,
      activeTaskId: null,
      tasks: {
        ...started.tasks,
        'followup-task': { ...started.tasks['followup-task']!, status: 'completed' },
      },
      turn: { ...started.turn, status: 'completed' },
      terminalOutcome: terminal.terminalOutcome,
    };
    const settled = reduceAgentState(firstFinished, {
      type: 'agent.followup_turn_settled',
      sourceSessionId: parentSessionId,
      submissionId: 'followup-submission',
      targetRunId: 'followup-run',
      taskId: 'followup-task',
      status: 'completed',
    });
    expect(settled.activeFollowupTurn).toBeUndefined();
    const second = reduceAgentState(settled, {
      type: 'agent.followup_turn_prepared',
      sourceSessionId: parentSessionId,
      submissionId: 'followup-submission-2',
      targetRunId: 'followup-run-2',
      taskId: 'followup-task-2',
      checkpointRef: {
        artifactId: `pa_${'e'.repeat(64)}`,
        kind: 'subagent_checkpoint',
        integrityIdentifier: `sha256:${'e'.repeat(64)}`,
        byteLength: 100,
      },
      grantRef: {
        artifactId: `pa_${'f'.repeat(64)}`,
        kind: 'agent_followup_grant',
        integrityIdentifier: `sha256:${'f'.repeat(64)}`,
        byteLength: 100,
      },
      grantDigest: `sha256:${'f'.repeat(64)}`,
    });
    expect(second.activeFollowupTurn?.submissionId).toBe('followup-submission-2');
    expect(second.childSessionOrigin?.terminal).toEqual(terminal.childSessionOrigin?.terminal);
    const secondTask = reduceAgentState(second, {
      type: 'task.started',
      taskId: 'followup-task-2',
      userGoal: 'Continue the delegated task.',
      turnId: 'followup-run-2',
    });
    const secondTurn = reduceAgentState(secondTask, {
      type: 'turn.started',
      turnId: 'followup-run-2',
    });
    assertAgentStateInvariants(secondTurn);
    expect(secondTurn.activeTaskId).toBe('followup-task-2');
  });

  test('persists only a bounded parent diagnostic for the exact pending child', () => {
    const initial = createInitialAgentState({
      threadId: parentSessionId,
      userId: 'user',
      workspace: '/workspace',
      turnId: 'parent-turn',
      recoveryIdentityKey: '0'.repeat(64),
    });
    const pending = {
      ...initial,
      capabilities: {
        ...initial.capabilities,
        invocations: {
          [parentInvocationId]: {
            toolCallId: parentToolCallId,
            subagentProviderLifecycle: {
              attempt: 1,
              childInvocationId,
              childSession: { childThreadId, grantDigest },
            },
          },
        },
      },
    } as unknown as AgentState;
    const diagnostic: KernelEvent = {
      type: 'subagent.child_recovery_required',
      parentSessionId,
      parentInvocationId,
      childInvocationId,
      childThreadId,
      originToolCallId: parentToolCallId,
      attempt: 1,
      grantDigest,
      diagnosticCode: 'recovery_blocked',
      observedAt: '2026-09-23T00:00:00.000Z',
    };
    const after = reduceCapabilityState(pending, diagnostic);
    expect(
      after.capabilities.invocations[parentInvocationId]?.subagentProviderLifecycle?.childSession
        ?.recoveryDiagnostic,
    ).toEqual({ diagnosticCode: 'recovery_blocked', observedAt: diagnostic.observedAt });
    expect(after.turn).toEqual(pending.turn);
    expect(after.resourceBudget).toEqual(pending.resourceBudget);
    expect(reduceCapabilityState(after, diagnostic)).toEqual(after);
    expect(() =>
      reduceCapabilityState(pending, { ...diagnostic, grantDigest: `sha256:${'e'.repeat(64)}` }),
    ).toThrow('pending exact intent');
    expect(() =>
      reduceCapabilityState(after, { ...diagnostic, diagnosticCode: 'evidence_inconsistent' }),
    ).toThrow('conflicts');
  });
  test('binds every private task-ref field independent of canonical key order', () => {
    const canonical = {
      artifactId: taskArtifactRef.artifactId,
      byteLength: taskArtifactRef.byteLength,
      integrityIdentifier: taskArtifactRef.integrityIdentifier,
      kind: taskArtifactRef.kind,
    };
    expect(sameChildTaskArtifactRef(taskArtifactRef, canonical)).toBe(true);
    expect(sameChildTaskArtifactRef(taskArtifactRef, { ...canonical, byteLength: 101 })).toBe(
      false,
    );
    expect(sameChildTaskArtifactRef(taskArtifactRef, { ...canonical, extra: true })).toBe(false);
  });
  test('derives one stable Session ID per exact parent Tool attempt', () => {
    expect(childThreadId).toBe(
      childThreadIdForToolAttempt({
        parentSessionId,
        parentInvocationId,
        parentToolCallId,
        attempt: 1,
      }),
    );
    expect(childThreadId).not.toBe(
      childThreadIdForToolAttempt({
        parentSessionId,
        parentInvocationId,
        parentToolCallId,
        attempt: 2,
      }),
    );
  });

  test('admits only the prebound grant and private task ref without a human user message', () => {
    const initial = childState();
    const adopted: KernelEvent = {
      type: 'subagent.child_session_adopted',
      parentSessionId,
      parentInvocationId,
      parentToolCallId,
      attempt: 1,
      childInvocationId,
      grantDigest,
      fundingRunId: 'parent-run',
      delegatedReservationId: 'delegated-1',
      delegatedUpperBoundDigest: `sha256:${'d'.repeat(64)}`,
      deadlineAt: '2026-09-23T00:10:00.000Z',
    };
    expect(reduceCapabilityState(initial, adopted)).toEqual(initial);
    const input: KernelEvent = {
      type: 'subagent.child_task_input_admitted',
      childInvocationId,
      taskArtifactRef,
      taskDigest: taskArtifactRef.integrityIdentifier,
      taskTextDigest,
      grantDigest,
    };
    const admitted = reduceCapabilityState(initial, input);
    expect(admitted.childSessionOrigin?.taskInputAdmitted).toBe(true);
    expect(admitted.transcript.messages).toEqual([]);
    expect(reduceCapabilityState(admitted, input)).toEqual(admitted);
    expect(() =>
      reduceCapabilityState(initial, {
        ...input,
        taskTextDigest: `sha256:${'e'.repeat(64)}`,
      }),
    ).toThrow('exact admitted private Artifact');
  });

  test('seals only after a child terminal outcome and retains its exact revision', () => {
    const initial = childState();
    const sealed: KernelEvent = {
      type: 'subagent.child_terminal_sealed',
      status: 'failed',
      resultRef: taskArtifactRef,
      cleanupConfirmed: true,
      cancelRequested: false,
      terminalReceiptId: 'terminal-1',
    };
    expect(() => reduceCapabilityState(initial, sealed)).toThrow('admitted origin and cleanup');
    const terminal: AgentState = {
      ...initial,
      terminalOutcome: {
        version: 1,
        status: 'aborted',
        reasonCode: 'blocked',
        knownExternalEffects: 'none',
        safeRetry: false,
        recoveryEntry: 'none',
        pendingVerification: false,
      },
    };
    const after = reduceCapabilityState(terminal, sealed);
    expect(after.childSessionOrigin?.terminal).toMatchObject({
      status: 'failed',
      terminalReceiptId: 'terminal-1',
      sealedRevision: 1,
    });
  });

  test('seals an unclean unknown only with terminal and external-attempt evidence', () => {
    const initial = childState();
    const unknown: AgentState = {
      ...initial,
      turn: { ...initial.turn, status: 'aborted' },
      terminalOutcome: {
        version: 1,
        status: 'unknown',
        reasonCode: 'unknown',
        knownExternalEffects: 'unknown',
        safeRetry: false,
        recoveryEntry: 'none',
        pendingVerification: false,
      },
      modelInvocations: {
        attempt: { dispatchCertainty: 'unknown' } as AgentState['modelInvocations'][string],
      },
    };
    const seal: KernelEvent = {
      type: 'subagent.child_terminal_sealed',
      status: 'unknown',
      resultRef: taskArtifactRef,
      cleanupConfirmed: false,
      cancelRequested: false,
      terminalReceiptId: 'unknown-recovery-1',
    };
    expect(reduceCapabilityState(unknown, seal).childSessionOrigin?.terminal).toMatchObject({
      status: 'unknown',
      cleanupConfirmed: false,
    });
    expect(() => reduceCapabilityState({ ...unknown, modelInvocations: {} }, seal)).toThrow(
      'admitted origin and cleanup',
    );
    expect(() =>
      reduceCapabilityState({ ...unknown, turn: { ...unknown.turn, status: 'active' } }, seal),
    ).toThrow('admitted origin and cleanup');
    expect(() => reduceCapabilityState(unknown, { ...seal, status: 'completed' })).toThrow(
      'admitted origin and cleanup',
    );
  });

  test('seals a cleaned user cancellation from its aborted Turn without inventing a Run error', () => {
    const initial = childState();
    const cancelled: AgentState = {
      ...initial,
      turn: { ...initial.turn, status: 'aborted', abortCause: 'user' },
    };
    const seal: KernelEvent = {
      type: 'subagent.child_terminal_sealed',
      status: 'cancelled',
      resultRef: taskArtifactRef,
      cleanupConfirmed: true,
      cancelRequested: true,
      terminalReceiptId: 'cancelled-child',
    };
    expect(reduceCapabilityState(cancelled, seal).childSessionOrigin?.terminal?.status).toBe(
      'cancelled',
    );
    expect(() =>
      reduceCapabilityState(
        { ...cancelled, turn: { ...cancelled.turn, abortCause: 'error' } },
        seal,
      ),
    ).toThrow('admitted origin and cleanup');
  });

  test('does not reopen a cancelled parent Run or inject into a newer human Run', () => {
    const initial = createInitialAgentState({
      threadId: parentSessionId,
      userId: 'user',
      workspace: '/workspace',
      turnId: 'new-human-turn',
      recoveryIdentityKey: '0'.repeat(64),
    });
    const result: KernelEvent = {
      type: 'subagent.background_result_persisted',
      taskId: childInvocationId,
      notificationId: 'notification-1',
      artifactIntegrityIdentifier: taskArtifactRef.integrityIdentifier,
      shortReport: 'terminal',
      source: 'subagent',
      modelRole: 'user',
      originRunId: 'old-run',
      originTurnId: 'new-human-turn',
      originToolCallId: parentToolCallId,
      attempt: 1,
    };
    const admitted = {
      ...initial,
      capabilities: {
        ...initial.capabilities,
        invocations: {
          [parentInvocationId]: {
            toolCallId: parentToolCallId,
            subagentProviderLifecycle: {
              backgroundResult: {
                taskId: childInvocationId,
                notificationId: result.notificationId,
                artifactIntegrityIdentifier: result.artifactIntegrityIdentifier,
                originRunId: result.originRunId,
                originTurnId: result.originTurnId,
                originToolCallId: result.originToolCallId,
                attempt: result.attempt,
              },
            },
          },
        },
      },
    } as unknown as AgentState;
    const cancelled: AgentState = {
      ...admitted,
      turn: { ...admitted.turn, status: 'aborted', abortReason: 'cancelled' },
      terminalOutcome: {
        version: 1,
        status: 'aborted',
        reasonCode: 'blocked',
        knownExternalEffects: 'none',
        safeRetry: false,
        recoveryEntry: 'none',
        pendingVerification: false,
      },
    };
    expect(reduceContextState(cancelled, result)).toEqual(cancelled);
    expect(cancelled.transcript.messages).toEqual([]);
    const newer: AgentState = {
      ...admitted,
      turn: { ...admitted.turn, turnId: 'later-human-turn' },
    };
    expect(reduceContextState(newer, result)).toEqual(newer);
  });
});
