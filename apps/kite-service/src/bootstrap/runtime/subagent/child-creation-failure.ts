import { canonicalModelJson } from '@kite-ai/builtin-runtime/model';
import type {
  SubagentResultArtifactAccess,
  SubagentResultArtifactRef,
} from '@kite-ai/builtin-runtime/subagent';
import type { StateRuntimeSession } from '@kite-ai/runtime-host/kernel-adapter';
import type { KiteSessionAppServerStorageOwner } from '../../kite-session-app-server-storage';
import type { RuntimeEvent, RuntimeState } from '../state-runtime';
import { afterTurnContinuationIdentity } from './after-turn-continuation';
import type { SubAgentResult } from './types';

type ChildIntent = NonNullable<
  ReturnType<KiteSessionAppServerStorageOwner['readChildSessionIntent']>
>;
type FailureCommit = Parameters<StateRuntimeSession['commitChildCreationFailure']>[0];
type PreDispatchProof = NonNullable<FailureCommit['readPreDispatchChildProof']>;

function sameRef(left: SubagentResultArtifactRef, right: SubagentResultArtifactRef): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.kind === right.kind &&
    left.integrityIdentifier === right.integrityIdentifier &&
    left.byteLength === right.byteLength
  );
}

/**
 * Settle only a child whose dispatch ACK never committed. The
 * Store repeats the child-presence/abandonment test inside the parent receipt
 * CAS, so a competing activation cannot turn this preflight into authority.
 */
export function settleAcceptedChildCreationFailure(input: {
  readonly parentState: Readonly<RuntimeState>;
  readonly childThreadId: string;
  readonly parentOwnerKey: string;
  readonly readIntent: (childThreadId: string) => ChildIntent | null;
  /** A Store-backed presence read; null proves absence at preflight only. */
  readonly readPreDispatchChildProof: PreDispatchProof;
  readonly artifacts: SubagentResultArtifactAccess;
  readonly commitFailure: (proof: FailureCommit) => readonly RuntimeEvent[];
  readonly cancelled?: boolean;
  /** Parent user cancellation already released this exact, never-dispatched child allotment. */
  readonly alreadyReleasedAfterParentCancel?: boolean;
  readonly hasCancelledParentRunProof?: (runId: string) => boolean;
  readonly readCompletedReservation?: (
    reservationId: string,
  ) => Readonly<Record<string, unknown>> | null;
  readonly afterTurnPhase?: 'planning' | 'building';
}): readonly RuntimeEvent[] {
  const { parentState, childThreadId } = input;
  const intent = input.readIntent(childThreadId);
  if (
    !intent ||
    intent.childThreadId !== childThreadId ||
    intent.parentSessionId !== parentState.session.threadId ||
    (intent.disposition !== 'required' && intent.disposition !== 'after_turn') ||
    intent.failureReceiptDigest ||
    intent.parentClaimSettledEventId ||
    intent.dispatchAckEventId
  )
    throw new Error('Child creation failure has no unsettled pre-dispatch intent.');

  const invocation = parentState.capabilities.invocations[intent.parentInvocationId];
  const lifecycle = invocation?.subagentProviderLifecycle;
  const link = lifecycle?.childSession;
  const call = parentState.tools.calls[intent.originToolCallId];
  const ledger =
    parentState.resourceBudget.status === 'active' &&
    parentState.resourceBudget.runId === intent.fundingRunId
      ? parentState.resourceBudget
      : parentState.retainedResourceBudgets[intent.fundingRunId];
  const released =
    ledger?.reservations[intent.delegatedReservationId] ??
    input.readCompletedReservation?.(intent.delegatedReservationId);
  if (
    !link ||
    link.childThreadId !== childThreadId ||
    link.terminalImport ||
    lifecycle?.childInvocationId !== intent.childInvocationId ||
    lifecycle.attempt !== intent.attempt ||
    link.originRunId !== intent.originRunId ||
    link.originTurnId !== intent.originTurnId ||
    link.originToolCallId !== intent.originToolCallId ||
    link.delegatedReservationId !== intent.delegatedReservationId ||
    call?.result?.resultMeta?.taskId !== intent.childInvocationId ||
    call.result.resultMeta.taskStatus !== 'running' ||
    (input.alreadyReleasedAfterParentCancel
      ? !input.cancelled ||
        intent.disposition !== 'required' ||
        intent.fundingRunId !== intent.originRunId ||
        input.hasCancelledParentRunProof?.(intent.originRunId) !== true ||
        released?.state !== 'released' ||
        released.runId !== intent.fundingRunId ||
        released.reservationId !== intent.delegatedReservationId
      : ledger?.reservations[intent.delegatedReservationId]?.state !== 'reserved' &&
        ledger?.reservations[intent.delegatedReservationId]?.state !== 'queued')
  )
    throw new Error('Child creation failure lost its exact parent claim.');

  const child = input.readPreDispatchChildProof(childThreadId);
  const mode: FailureCommit['mode'] =
    child === null
      ? 'absent_child'
      : intent.childBudgetActivatedRunId
        ? 'activated_no_ack'
        : 'created_unactivated';
  if (
    (mode === 'absent_child') !== !intent.childSessionCreated ||
    Boolean(intent.childBudgetActivatedRunId) !== Boolean(intent.childBudgetActivatedEventId) ||
    (mode === 'absent_child' && Boolean(intent.childBudgetActivatedRunId)) ||
    (child &&
      (child.childRevision !== (mode === 'activated_no_ack' ? 5 : 0) ||
        child.ownerStatus !== 'idle' ||
        child.cleanupConfirmed !== true)) ||
    (mode === 'activated_no_ack') !==
      Boolean(intent.childBudgetActivatedRunId && intent.childBudgetActivatedEventId) ||
    (input.alreadyReleasedAfterParentCancel && mode !== 'created_unactivated')
  )
    throw new Error('Child Session is not safely absent or abandoned before dispatch.');

  const result: Readonly<SubAgentResult> = {
    ok: false,
    terminalStatus: input.cancelled ? 'cancelled' : 'failed',
    summary: input.cancelled
      ? 'Child Session was cancelled before dispatch.'
      : 'Child Session could not be started.',
    ...(input.cancelled ? {} : { error: 'child_creation_failed' }),
    toolCallCount: 0,
    durationMs: 0,
  };
  const existing = input.artifacts.lookup(input.parentOwnerKey, intent.childInvocationId);
  if (existing && canonicalModelJson(existing.result) !== canonicalModelJson(result))
    throw new Error('Child creation failure Artifact conflicts with a prior result.');
  const ref =
    existing?.ref ??
    input.artifacts.write({
      ownerKey: input.parentOwnerKey,
      taskId: intent.childInvocationId,
      result,
    });
  const owned = input.artifacts.lookup(input.parentOwnerKey, intent.childInvocationId);
  if (!owned || !sameRef(owned.ref, ref))
    throw new Error('Child creation failure Artifact has no exact owner.');
  const readOwned: FailureCommit['readFailureArtifact'] = (candidate, taskId) => {
    if (taskId !== intent.childInvocationId || !sameRef(candidate, ref))
      throw new Error('Child creation failure Artifact identity changed.');
    const latest = input.artifacts.lookup(input.parentOwnerKey, taskId);
    if (!latest || !sameRef(latest.ref, ref))
      throw new Error('Child creation failure Artifact owner changed.');
    return input.artifacts.read(candidate, taskId);
  };
  const persisted = readOwned(ref, intent.childInvocationId);
  if (canonicalModelJson(persisted) !== canonicalModelJson(result))
    throw new Error('Child creation failure Artifact readback conflicts.');

  const eventTuple = {
    parentInvocationId: intent.parentInvocationId,
    childInvocationId: intent.childInvocationId,
    childThreadId,
    mode,
    resultRef: ref,
  };
  const failureEvent: FailureCommit['failureEvent'] = input.cancelled
    ? {
        type: 'subagent.child_pre_dispatch_cancelled',
        ...eventTuple,
        terminalReceiptDigest: ref.integrityIdentifier,
      }
    : {
        type: 'subagent.child_creation_failed',
        ...eventTuple,
        failureReceiptDigest: ref.integrityIdentifier,
      };
  const resultEvent: FailureCommit['resultEvent'] = {
    type: 'subagent.background_result_persisted',
    taskId: intent.childInvocationId,
    notificationId: `subagent:${intent.childInvocationId}:${ref.integrityIdentifier}`,
    artifactIntegrityIdentifier: ref.integrityIdentifier,
    shortReport: result.summary,
    source: 'subagent',
    modelRole: 'user',
    originRunId: intent.originRunId,
    originTurnId: intent.originTurnId,
    originToolCallId: intent.originToolCallId,
    attempt: intent.attempt,
    childTerminalStatus: input.cancelled ? 'cancelled' : 'failed',
    ...(intent.disposition === 'after_turn'
      ? (() => {
          const report = Object.values(ledger?.reservations ?? {}).find(
            (reservation) =>
              reservation.invocationId ===
              `model-invocation:after-turn:${intent.childInvocationId}`,
          );
          if (
            !input.afterTurnPhase ||
            !report ||
            report.runId !== intent.fundingRunId ||
            report.resourceKind !== 'model' ||
            report.state !== 'reserved'
          )
            throw new Error('After-turn child failure has no exact report reservation.');
          return {
            afterTurn: {
              reservationId: report.reservationId,
              admissionRevision: parentState.revision + 3,
              phase: input.afterTurnPhase,
              status: input.cancelled ? ('cancelled' as const) : ('failed' as const),
              cancelRequested: input.cancelled === true,
              ...afterTurnContinuationIdentity({
                taskId: intent.childInvocationId,
                attempt: intent.attempt,
                resultRevision: ref.integrityIdentifier,
                originRunId: intent.originRunId,
              }),
            },
          };
        })()
      : {}),
  };
  return input.commitFailure({
    mode,
    ...(input.alreadyReleasedAfterParentCancel
      ? {
          alreadyReleasedAfterParentCancel: true as const,
          hasCancelledParentRunProof: input.hasCancelledParentRunProof!,
          readCompletedReservation: input.readCompletedReservation!,
        }
      : {
          releaseEvent: {
            type: 'resource_budget.released' as const,
            reservationId: intent.delegatedReservationId,
          },
        }),
    failureEvent,
    resultEvent,
    readFailureArtifact: readOwned,
    readPreDispatchChildProof: (id) => {
      if (id !== childThreadId) throw new Error('Child proof identity changed.');
      return input.readPreDispatchChildProof(id);
    },
  });
}
