import { expect, test } from 'bun:test';
import { childThreadIdForToolAttempt, createInitialAgentState } from '@kite-ai/agent-kernel';
import type {
  PrivateImmutableArtifactRef,
  PrivateImmutableArtifactStorageBackend,
} from '@kite-ai/builtin-runtime/model';
import { SubagentResultArtifactStore } from '@kite-ai/builtin-runtime/subagent';
import {
  childTerminalReceiptDigest,
  createZeroResourceUsage,
  LIMITED_RESOURCE_BUDGET_,
} from '@kite-ai/runtime-host/kernel-adapter';
import type { RuntimeState } from '../../src/bootstrap/runtime/state-runtime';
import {
  importChildTerminalResult,
  sealChildTerminalResult,
} from '../../src/bootstrap/runtime/subagent/child-terminal-bridge';

const parentSessionId = 'parent';
const parentInvocationId = 'invocation';
const parentToolCallId = 'tool';
const childInvocationId = 'child-task';
const childThreadId = childThreadIdForToolAttempt({
  parentSessionId,
  parentInvocationId,
  parentToolCallId,
  attempt: 1,
});
const taskRef = {
  artifactId: `pa_${'a'.repeat(64)}`,
  kind: 'subagent_task' as const,
  integrityIdentifier: `sha256:${'a'.repeat(64)}`,
  byteLength: 100,
};

function childState(): RuntimeState {
  return {
    ...createInitialAgentState({
      threadId: childThreadId,
      userId: 'user',
      workspace: '/workspace',
      turnId: 'child-turn',
      recoveryIdentityKey: '0'.repeat(64),
    }),
    resourceBudget: {
      status: 'active',
      runId: 'child-run',
      budget: LIMITED_RESOURCE_BUDGET_,
      startedAt: '2026-09-25T00:00:00.000Z',
      deadlineAt: '2026-09-25T00:10:00.000Z',
      reconciledUsage: createZeroResourceUsage(),
      reservations: {},
      waiters: {},
      nextWaiterSequence: 1,
    },
    terminalOutcome: {
      version: 1,
      status: 'completed',
      reasonCode: 'completed',
      knownExternalEffects: 'none',
      safeRetry: false,
      recoveryEntry: 'none',
      pendingVerification: false,
    },
    childSessionOrigin: {
      parentSessionId,
      parentInvocationId,
      parentToolCallId,
      attempt: 1,
      childInvocationId,
      grantDigest: `sha256:${'b'.repeat(64)}`,
      taskArtifactRef: taskRef,
      taskArtifactDigest: taskRef.integrityIdentifier,
      taskTextDigest: `sha256:${'c'.repeat(64)}`,
      taskInputAdmitted: true,
      role: 'explore',
      fundingRunId: 'parent-run',
      delegatedReservationId: 'delegated',
      delegatedUpperBoundDigest: `sha256:${'d'.repeat(64)}`,
      deadlineAt: '2026-09-25T00:10:00.000Z',
    },
  };
}

test('child seal persists exact result and parent import presents one terminal claim settlement', () => {
  const rows = new Map<
    string,
    {
      ref: PrivateImmutableArtifactRef<'subagent_task'>;
      payload: Uint8Array;
      ownerKey: string;
      taskId: string;
    }
  >();
  const backend: PrivateImmutableArtifactStorageBackend<'subagent_task'> = {
    write(ref, payload) {
      const value = JSON.parse(new TextDecoder().decode(payload)) as {
        ownerKey: string;
        taskId: string;
      };
      rows.set(ref.artifactId, { ref, payload, ownerKey: value.ownerKey, taskId: value.taskId });
    },
    read: (ref) => rows.get(ref.artifactId)!.payload,
    findByOwnerTask: (ownerKey, taskId) =>
      [...rows.values()].find((row) => row.ownerKey === ownerKey && row.taskId === taskId)?.ref,
    listByOwner: (ownerKey) =>
      [...rows.values()].filter((row) => row.ownerKey === ownerKey).map((row) => row.ref),
    collectGarbage: () => ({
      scannedEntries: rows.size,
      retainedArtifacts: rows.size,
      deletedArtifacts: 0,
      deletedTemporaryFiles: 0,
    }),
  };
  {
    const artifacts = new SubagentResultArtifactStore({ backend });
    const ownerKey = 'parent-owner';
    let child = childState();
    const terminalReceiptId = 'terminal-receipt';
    const result = {
      ok: true,
      summary: 'Finished the delegated task. '.repeat(100),
      terminalStatus: 'completed' as const,
      toolCallCount: 2,
      durationMs: 15,
    };
    const sealed = sealChildTerminalResult({
      getChildState: () => child,
      artifacts,
      parentOwnerKey: ownerKey,
      result,
      cleanupConfirmed: true,
      cancelRequested: false,
      terminalReceiptId,
      commitSeal: (event) => {
        child = {
          ...child,
          revision: child.revision + 1,
          childSessionOrigin: {
            ...child.childSessionOrigin!,
            terminal: { ...event, sealedRevision: child.revision + 1 },
          },
        };
        return [event];
      },
    });
    expect(artifacts.read(sealed.ref, childInvocationId)).toEqual(result);
    const parent: RuntimeState = {
      ...createInitialAgentState({
        threadId: parentSessionId,
        userId: 'user',
        workspace: '/workspace',
        turnId: 'parent-turn',
        recoveryIdentityKey: '1'.repeat(64),
      }),
      capabilities: {
        ...createInitialAgentState({
          threadId: parentSessionId,
          userId: 'user',
          workspace: '/workspace',
          turnId: 'parent-turn',
          recoveryIdentityKey: '1'.repeat(64),
        }).capabilities,
        invocations: {
          [parentInvocationId]: {
            invocationId: parentInvocationId,
            toolCallId: parentToolCallId,
            capabilityId: 'task',
            capabilityRevision: 'v1',
            argumentsDigest: `sha256:${'e'.repeat(64)}`,
            authorizationDigest: `sha256:${'f'.repeat(64)}`,
            effectiveEffectsDigest: `sha256:${'0'.repeat(64)}`,
            status: 'running',
            recordedAt: '2026-09-25T00:00:00.000Z',
            subagentProviderLifecycle: {
              attempt: 1,
              purpose: 'start',
              childInvocationId,
              taskArtifact: taskRef,
              dispatchIntentDigest: `sha256:${'1'.repeat(64)}`,
              status: 'intent_recorded',
              recordedAt: '2026-09-25T00:00:00.000Z',
              childSession: {
                childThreadId,
                grantDigest: child.childSessionOrigin!.grantDigest,
                taskArtifactRef: taskRef,
                taskArtifactDigest: taskRef.integrityIdentifier,
                taskTextDigest: child.childSessionOrigin!.taskTextDigest,
                originRunId: 'parent-run',
                originTurnId: 'parent-turn',
                originToolCallId: parentToolCallId,
                disposition: 'required',
                role: 'explore',
                fundingRunId: 'parent-run',
                delegatedReservationId: 'delegated',
                delegatedUpperBoundDigest: child.childSessionOrigin!.delegatedUpperBoundDigest,
                deadlineAt: child.childSessionOrigin!.deadlineAt,
              },
            },
          },
        },
      },
    };
    let captured: Parameters<typeof importChildTerminalResult>[0]['commitImport'] extends (
      proof: infer T,
    ) => unknown
      ? T
      : never;
    const events = importChildTerminalResult({
      parentState: parent,
      readChildState: () => child,
      childThreadId,
      parentInvocationId,
      parentOwnerKey: ownerKey,
      artifacts,
      commitImport: (proof) => {
        captured = proof;
        return [proof.resourceEvent, proof.importEvent, proof.resultEvent];
      },
    });
    expect(events.map((event) => event.type)).toEqual([
      'resource_budget.reconciled',
      'subagent.child_terminal_imported',
      'subagent.background_result_persisted',
    ]);
    expect(captured!.importEvent.terminalReceiptDigest).toBe(
      childTerminalReceiptDigest({
        childThreadId,
        terminalRevision: sealed.sealedRevision,
        terminalReceiptId,
        resultIntegrityIdentifier: sealed.ref.integrityIdentifier,
      }),
    );
    expect(captured!.resultEvent.notificationId).toBe(
      `subagent:${childInvocationId}:${sealed.ref.integrityIdentifier}`,
    );
    expect(captured!.resultEvent.shortReport).toBe(result.summary);
    expect(captured!.readResultArtifact(sealed.ref, childInvocationId)).toEqual(result);
    expect(() =>
      captured!.readResultArtifact({ ...sealed.ref, artifactId: 'wrong' }, childInvocationId),
    ).toThrow('exact owner');
    expect(() =>
      importChildTerminalResult({
        parentState: parent,
        readChildState: () => child,
        childThreadId,
        parentInvocationId,
        parentOwnerKey: 'other-owner',
        artifacts,
        commitImport: () => {
          throw new Error('must not commit');
        },
      }),
    ).toThrow('exact owner');

    const initialUnknown = childState();
    if (initialUnknown.resourceBudget.status !== 'active')
      throw new Error('Unknown child budget fixture is inactive.');
    child = {
      ...initialUnknown,
      turn: { ...initialUnknown.turn, status: 'aborted', abortCause: 'error' },
      terminalOutcome: {
        version: 1,
        status: 'unknown',
        reasonCode: 'unknown',
        knownExternalEffects: 'unknown',
        safeRetry: false,
        recoveryEntry: 'reconcile',
        pendingVerification: false,
      },
      modelInvocations: {
        model: { dispatchCertainty: 'unknown' } as RuntimeState['modelInvocations'][string],
      },
      resourceBudget: {
        ...initialUnknown.resourceBudget,
        reservations: {
          model: {
            state: 'unknown',
          } as (typeof initialUnknown.resourceBudget.reservations)[string],
        },
      },
    };
    const unknownResult = {
      ok: false,
      summary: 'External effects could not be confirmed.',
      terminalStatus: 'unknown' as const,
      toolCallCount: 0,
      durationMs: 0,
    };
    const unknownSeal = sealChildTerminalResult({
      getChildState: () => child,
      artifacts,
      parentOwnerKey: 'parent-unknown',
      result: unknownResult,
      cleanupConfirmed: false,
      cancelRequested: false,
      terminalReceiptId: 'unknown-recovery',
      commitSeal: (event) => {
        child = {
          ...child,
          revision: child.revision + 1,
          childSessionOrigin: {
            ...child.childSessionOrigin!,
            terminal: { ...event, sealedRevision: child.revision + 1 },
          },
        };
        return [event];
      },
    });
    const unknownEvents = importChildTerminalResult({
      parentState: parent,
      readChildState: () => child,
      childThreadId,
      parentInvocationId,
      parentOwnerKey: 'parent-unknown',
      artifacts,
      commitImport: (proof) => [proof.resourceEvent, proof.importEvent, proof.resultEvent],
    });
    expect(unknownEvents.map((event) => event.type)).toEqual([
      'resource_budget.unknown',
      'subagent.child_terminal_imported',
      'subagent.background_result_persisted',
    ]);
    expect(unknownEvents[1]).toMatchObject({
      terminalReceiptDigest: childTerminalReceiptDigest({
        childThreadId,
        terminalRevision: unknownSeal.sealedRevision,
        terminalReceiptId: 'unknown-recovery',
        resultIntegrityIdentifier: unknownSeal.ref.integrityIdentifier,
        unknownRecovery: true,
      }),
    });

    const cancelledBase = childState();
    child = {
      ...cancelledBase,
      turn: {
        ...cancelledBase.turn,
        status: 'aborted',
        abortCause: 'user',
        abortReason: 'Cancelled by user.',
      },
      terminalOutcome: undefined,
      modelInvocations: {
        model: { status: 'dispatching' } as RuntimeState['modelInvocations'][string],
      },
    };
    const cancelledResult = {
      ok: false,
      summary: 'Child Session cancelled.',
      terminalStatus: 'cancelled' as const,
      toolCallCount: 0,
      durationMs: 0,
    };
    const settledFacts = {
      localEventChannelClosed: true,
      activeRun: false,
      unknownRun: false,
      pendingEffects: false,
      unknownEffects: false,
    };
    const sealCancelled = () =>
      sealChildTerminalResult({
        getChildState: () => child,
        artifacts,
        parentOwnerKey: 'parent-cancelled',
        result: cancelledResult,
        cleanupConfirmed: true,
        cancelRequested: true,
        terminalReceiptId: 'cancelled-terminal',
        readCancellationExecutionFacts: () => settledFacts,
        commitSeal: (event) => {
          child = {
            ...child,
            revision: child.revision + 1,
            childSessionOrigin: {
              ...child.childSessionOrigin!,
              terminal: { ...event, sealedRevision: child.revision + 1 },
            },
          };
          return [event];
        },
      });
    expect(sealCancelled).toThrow('not sealed and cleaned up');
    expect(child.childSessionOrigin?.terminal).toBeUndefined();

    child = {
      ...child,
      modelInvocations: {
        model: { status: 'interrupted' } as RuntimeState['modelInvocations'][string],
      },
    };
    expect(() =>
      sealChildTerminalResult({
        getChildState: () => child,
        artifacts,
        parentOwnerKey: 'parent-cancelled',
        result: cancelledResult,
        cleanupConfirmed: true,
        cancelRequested: true,
        terminalReceiptId: 'cancelled-terminal',
        commitSeal: () => {
          throw new Error('must not commit');
        },
      }),
    ).toThrow('not sealed and cleaned up');
    for (const outstanding of [
      'localEventChannelClosed',
      'activeRun',
      'unknownRun',
      'pendingEffects',
      'unknownEffects',
    ] as const) {
      expect(() =>
        sealChildTerminalResult({
          getChildState: () => child,
          artifacts,
          parentOwnerKey: 'parent-cancelled',
          result: cancelledResult,
          cleanupConfirmed: true,
          cancelRequested: true,
          terminalReceiptId: 'cancelled-terminal',
          readCancellationExecutionFacts: () => ({
            ...settledFacts,
            [outstanding]: outstanding === 'localEventChannelClosed' ? false : true,
          }),
          commitSeal: () => {
            throw new Error('must not commit');
          },
        }),
      ).toThrow('not sealed and cleaned up');
    }
    sealCancelled();
    const cancelledSealed = child;
    child = {
      ...child,
      modelInvocations: {
        model: { status: 'dispatching' } as RuntimeState['modelInvocations'][string],
      },
    };
    const importCancelled = () =>
      importChildTerminalResult({
        parentState: parent,
        readChildState: () => child,
        childThreadId,
        parentInvocationId,
        parentOwnerKey: 'parent-cancelled',
        artifacts,
        readCancellationExecutionFacts: () => settledFacts,
        commitImport: (proof) => [proof.resourceEvent, proof.importEvent, proof.resultEvent],
      });
    expect(importCancelled).toThrow('exact sealed Session');
    child = cancelledSealed;
    expect(() =>
      importChildTerminalResult({
        parentState: parent,
        readChildState: () => child,
        childThreadId,
        parentInvocationId,
        parentOwnerKey: 'parent-cancelled',
        artifacts,
        commitImport: () => {
          throw new Error('must not commit');
        },
      }),
    ).toThrow('exact sealed Session');
    expect(importCancelled().map((event) => event.type)).toEqual([
      'resource_budget.reconciled',
      'subagent.child_terminal_imported',
      'subagent.background_result_persisted',
    ]);
  }
});
