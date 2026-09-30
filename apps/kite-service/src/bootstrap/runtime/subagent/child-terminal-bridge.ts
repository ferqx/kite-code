import type {
  SubagentResultArtifactAccess,
  SubagentResultArtifactRef,
} from '@kite-ai/builtin-runtime/subagent';
import {
  childTerminalReceiptDigest,
  createZeroResourceUsage,
  type StateRuntimeSession,
} from '@kite-ai/runtime-host/kernel-adapter';
import type { RuntimeEvent, RuntimeState } from '../state-runtime';
import { afterTurnContinuationIdentity } from './after-turn-continuation';
import type { SubAgentResult } from './types';

type TerminalSeal = Extract<RuntimeEvent, { type: 'subagent.child_terminal_sealed' }>;
type TerminalImport = Parameters<StateRuntimeSession['commitChildSessionTerminalImport']>[0];

export type ChildCancellationExecutionFacts = Readonly<{
  localEventChannelClosed: boolean;
  activeRun: boolean;
  unknownRun: boolean;
  pendingEffects: boolean;
  unknownEffects: boolean;
}>;

function hasUnsettledModelInvocation(child: Readonly<RuntimeState>): boolean {
  return Object.values(child.modelInvocations).some(
    (invocation) => invocation.status === 'prepared' || invocation.status === 'dispatching',
  );
}

function cleanCancellationExecutionConfirmed(
  child: Readonly<RuntimeState>,
  readFacts: ((sessionId: string) => ChildCancellationExecutionFacts) | undefined,
): boolean {
  if (!readFacts || hasUnsettledModelInvocation(child)) return false;
  const facts = readFacts(child.session.threadId);
  return (
    facts.localEventChannelClosed &&
    !facts.activeRun &&
    !facts.unknownRun &&
    !facts.pendingEffects &&
    !facts.unknownEffects
  );
}

function sameRef(left: SubagentResultArtifactRef, right: SubagentResultArtifactRef): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.kind === right.kind &&
    left.integrityIdentifier === right.integrityIdentifier &&
    left.byteLength === right.byteLength
  );
}

function readOwnedResult(
  artifacts: SubagentResultArtifactAccess,
  ownerKey: string,
  taskId: string,
  ref: SubagentResultArtifactRef,
): Readonly<Record<string, unknown>> {
  const owned = artifacts.lookup(ownerKey, taskId);
  if (!owned || !sameRef(owned.ref, ref))
    throw new Error('Child terminal result Artifact has no exact owner and reference.');
  return artifacts.read(ref, taskId);
}

/** Seal a cleaned terminal, or a fenced unknown attempt whose cleanup cannot be confirmed. */
export function sealChildTerminalResult(input: {
  readonly getChildState: () => Readonly<RuntimeState>;
  readonly artifacts: SubagentResultArtifactAccess;
  readonly parentOwnerKey: string;
  readonly result: Readonly<SubAgentResult>;
  readonly cleanupConfirmed: boolean;
  readonly cancelRequested: boolean;
  readonly terminalReceiptId: string;
  readonly commitSeal: (event: TerminalSeal) => readonly RuntimeEvent[];
  readonly readCancellationExecutionFacts?: (sessionId: string) => ChildCancellationExecutionFacts;
}): Readonly<{ ref: SubagentResultArtifactRef; sealedRevision: number }> {
  const child = input.getChildState();
  const origin = child.childSessionOrigin;
  const status = input.result.terminalStatus;
  const cancelledExecutionConfirmed =
    status !== 'cancelled' ||
    !input.cleanupConfirmed ||
    cleanCancellationExecutionConfirmed(child, input.readCancellationExecutionFacts);
  const cleanCancellation =
    status === 'cancelled' &&
    input.cleanupConfirmed &&
    child.turn.status === 'aborted' &&
    child.turn.abortCause === 'user' &&
    !child.terminalOutcome &&
    cancelledExecutionConfirmed;
  const unknownRecovery =
    status === 'unknown' &&
    !input.cleanupConfirmed &&
    child.terminalOutcome?.status === 'unknown' &&
    child.terminalOutcome.knownExternalEffects === 'unknown' &&
    child.turn.status !== 'active';
  if (
    !origin?.taskInputAdmitted ||
    origin.terminal ||
    (!child.terminalOutcome && !cleanCancellation) ||
    child.resourceBudget.status !== 'active' ||
    (!input.cleanupConfirmed && !unknownRecovery) ||
    (input.cleanupConfirmed && hasUnsettledModelInvocation(child)) ||
    !cancelledExecutionConfirmed ||
    !input.terminalReceiptId ||
    !status ||
    (status === 'completed') !== input.result.ok ||
    (status === 'completed') !== (child.terminalOutcome?.status === 'completed')
  )
    throw new Error('Child terminal result is not sealed and cleaned up.');

  const ref = input.artifacts.write({
    ownerKey: input.parentOwnerKey,
    taskId: origin.childInvocationId,
    result: input.result,
  });
  const persisted = readOwnedResult(
    input.artifacts,
    input.parentOwnerKey,
    origin.childInvocationId,
    ref,
  );
  if (persisted.terminalStatus !== status || persisted.ok !== input.result.ok)
    throw new Error('Child terminal result Artifact readback conflicts.');
  const event: TerminalSeal = {
    type: 'subagent.child_terminal_sealed',
    status,
    resultRef: ref,
    cleanupConfirmed: input.cleanupConfirmed,
    cancelRequested: input.cancelRequested,
    terminalReceiptId: input.terminalReceiptId,
  };
  const committed = input.commitSeal(event);
  const sealed = input.getChildState().childSessionOrigin?.terminal;
  if (
    committed.length !== 1 ||
    committed[0]?.type !== 'subagent.child_terminal_sealed' ||
    !sealed ||
    sealed.status !== status ||
    sealed.terminalReceiptId !== input.terminalReceiptId ||
    !sameRef(sealed.resultRef, ref)
  )
    throw new Error('Child terminal result seal was not durably committed.');
  return { ref, sealedRevision: sealed.sealedRevision };
}

/** Prepare exact Store reads and events; Host commits all three parent facts in one transaction. */
export function importChildTerminalResult(input: {
  readonly parentState: Readonly<RuntimeState>;
  /** Read strictly from the child Session owner; Host invokes it again at commit. */
  readonly readChildState: (childThreadId: string) => Readonly<RuntimeState>;
  readonly childThreadId: string;
  readonly parentInvocationId: string;
  readonly parentOwnerKey: string;
  readonly artifacts: SubagentResultArtifactAccess;
  readonly afterTurnPhase?: 'planning' | 'building';
  readonly commitImport: (proof: TerminalImport) => readonly RuntimeEvent[];
  readonly readCancellationExecutionFacts?: (sessionId: string) => ChildCancellationExecutionFacts;
}): readonly RuntimeEvent[] {
  const { parentState, childThreadId, parentInvocationId } = input;
  const childState = input.readChildState(childThreadId);
  const invocation = parentState.capabilities.invocations[parentInvocationId];
  const lifecycle = invocation?.subagentProviderLifecycle;
  const link = lifecycle?.childSession;
  const origin = childState.childSessionOrigin;
  const terminal = origin?.terminal;
  const unknownRecovery = terminal?.status === 'unknown' && terminal.cleanupConfirmed === false;
  const cancelledExecutionConfirmed =
    terminal?.status !== 'cancelled' ||
    !terminal.cleanupConfirmed ||
    cleanCancellationExecutionConfirmed(childState, input.readCancellationExecutionFacts);
  const cleanCancellation =
    terminal?.status === 'cancelled' &&
    terminal.cleanupConfirmed &&
    childState.turn.status === 'aborted' &&
    childState.turn.abortCause === 'user' &&
    !childState.terminalOutcome &&
    cancelledExecutionConfirmed;
  if (
    !link ||
    !origin ||
    !terminal ||
    childState.session.threadId !== childThreadId ||
    link.childThreadId !== childThreadId ||
    origin.parentSessionId !== parentState.session.threadId ||
    origin.parentInvocationId !== parentInvocationId ||
    (!terminal.cleanupConfirmed && !unknownRecovery) ||
    (terminal.cleanupConfirmed && hasUnsettledModelInvocation(childState)) ||
    !cancelledExecutionConfirmed ||
    (unknownRecovery &&
      (childState.terminalOutcome?.status !== 'unknown' ||
        childState.terminalOutcome.knownExternalEffects !== 'unknown' ||
        childState.turn.status === 'active')) ||
    (!childState.terminalOutcome && !cleanCancellation) ||
    childState.resourceBudget.status !== 'active'
  )
    throw new Error('Child terminal import lacks an exact sealed Session.');

  const result = readOwnedResult(
    input.artifacts,
    input.parentOwnerKey,
    origin.childInvocationId,
    terminal.resultRef,
  );
  if (
    result.terminalStatus !== terminal.status ||
    (terminal.status === 'completed') !== (result.ok === true)
  )
    throw new Error('Child terminal result Artifact disagrees with its seal.');

  const receiptDigest = childTerminalReceiptDigest({
    childThreadId,
    terminalRevision: terminal.sealedRevision,
    terminalReceiptId: terminal.terminalReceiptId,
    resultIntegrityIdentifier: terminal.resultRef.integrityIdentifier,
    ...(unknownRecovery ? { unknownRecovery: true } : {}),
  });
  const imported: TerminalImport['importEvent'] = {
    type: 'subagent.child_terminal_imported',
    parentInvocationId,
    childInvocationId: origin.childInvocationId,
    childThreadId,
    terminalRevision: terminal.sealedRevision,
    terminalReceiptDigest: receiptDigest,
    status: terminal.status,
    resultRef: terminal.resultRef,
  };
  const resource = childState.resourceBudget;
  const funding =
    parentState.resourceBudget.status === 'active' &&
    parentState.resourceBudget.runId === link.fundingRunId
      ? parentState.resourceBudget
      : parentState.retainedResourceBudgets[link.fundingRunId];
  const durationOnlyChildRun =
    funding?.reservations[link.delegatedReservationId]?.executableUpperBound
      .durationOnlyChildRun === true;
  const unknownUsage = Object.values(resource.reservations).some((reservation) =>
    ['reserved', 'dispatch_started', 'unknown'].includes(reservation.state),
  );
  const resourceEvent: TerminalImport['resourceEvent'] =
    unknownUsage || unknownRecovery
      ? { type: 'resource_budget.unknown', reservationId: link.delegatedReservationId }
      : {
          type: 'resource_budget.reconciled',
          reservationId: link.delegatedReservationId,
          actual: {
            ...resource.reconciledUsage,
            ...(durationOnlyChildRun ? { counters: createZeroResourceUsage().counters } : {}),
            gauges: {
              ...resource.reconciledUsage.gauges,
              // Cleanup is confirmed before import: the child no longer
              // occupies a parent concurrency slot.
              activeSubagents: 0,
            },
          },
        };
  const reportReservation = Object.values(funding?.reservations ?? {}).find(
    (reservation) =>
      reservation.invocationId === `model-invocation:after-turn:${origin.childInvocationId}`,
  );
  if (
    link.disposition === 'after_turn' &&
    terminal.status !== 'unknown' &&
    (!input.afterTurnPhase ||
      !reportReservation ||
      reportReservation.runId !== link.fundingRunId ||
      reportReservation.resourceKind !== 'model' ||
      reportReservation.state !== 'reserved')
  )
    throw new Error('After-turn child terminal has no exact report reservation.');
  const afterTurn =
    link.disposition === 'after_turn' && terminal.status !== 'unknown'
      ? {
          reservationId: reportReservation!.reservationId,
          admissionRevision:
            parentState.revision +
            (resourceEvent.type === 'resource_budget.unknown' &&
            funding?.reservations[link.delegatedReservationId]?.state === 'unknown'
              ? 2
              : 3),
          phase: input.afterTurnPhase!,
          status: terminal.status,
          cancelRequested: terminal.cancelRequested,
          ...afterTurnContinuationIdentity({
            taskId: origin.childInvocationId,
            attempt: lifecycle.attempt,
            resultRevision: terminal.resultRef.integrityIdentifier,
            originRunId: link.originRunId,
          }),
        }
      : undefined;
  const resultEvent: TerminalImport['resultEvent'] = {
    type: 'subagent.background_result_persisted',
    taskId: origin.childInvocationId,
    notificationId: `subagent:${origin.childInvocationId}:${terminal.resultRef.integrityIdentifier}`,
    artifactIntegrityIdentifier: terminal.resultRef.integrityIdentifier,
    shortReport: typeof result.summary === 'string' ? result.summary : '',
    source: 'subagent',
    modelRole: 'user',
    originRunId: link.originRunId,
    originTurnId: link.originTurnId,
    originToolCallId: link.originToolCallId,
    attempt: lifecycle.attempt,
    childTerminalStatus: terminal.status,
    ...(afterTurn ? { afterTurn } : {}),
  };
  return input.commitImport({
    importEvent: imported,
    resourceEvent,
    resultEvent,
    readChildState: (id) => {
      if (id !== childThreadId) throw new Error('Child terminal State read changed identity.');
      return input.readChildState(id);
    },
    readResultArtifact: (ref, taskId) =>
      readOwnedResult(input.artifacts, input.parentOwnerKey, taskId, ref),
  });
}
