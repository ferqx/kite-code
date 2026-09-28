import { childTerminalReceiptDigest } from '@kite-ai/runtime-host/kernel-adapter';
import type { RuntimeStoredRun } from '@kite-ai/runtime-host/storage';
import type { RuntimeState } from './state-runtime';

/**
 * An interrupted HTTP model request can leave its usage unknown after local
 * execution has stopped. The parent imports that exact unknown child allotment
 * and may finish with a reconciliation-required Run. Keep this exception tied
 * to the cancelled child receipt, not to arbitrary unknown external work.
 */
export function isUnknownRunOnlyCancelledChildModelUsage(input: {
  readonly parent: Readonly<RuntimeState>;
  readonly unknownRuns: readonly RuntimeStoredRun[];
  readonly readSettledChild: (sessionId: string) => Readonly<RuntimeState> | undefined;
}): boolean {
  const { parent, unknownRuns } = input;
  const budget = parent.resourceBudget;
  if (
    parent.turn.status !== 'aborted' ||
    parent.turn.abortReason !== 'Runtime resource admission denied: reconciliation_required.' ||
    parent.terminalOutcome?.status !== 'unknown' ||
    parent.terminalOutcome.reasonCode !== 'unknown' ||
    parent.terminalOutcome.knownExternalEffects !== 'unknown' ||
    parent.terminalOutcome.recoveryEntry !== 'reconcile' ||
    budget.status !== 'active' ||
    budget.runId !== parent.turn.turnId ||
    unknownRuns.length !== 1 ||
    unknownRuns[0]?.runId !== parent.turn.turnId ||
    unknownRuns[0].terminal?.reasonCode !== 'unknown' ||
    unknownRuns[0].terminal?.recoveryEntry !== 'reconcile'
  )
    return false;

  const unknown = Object.values(budget.reservations).filter(
    (reservation) => reservation.state === 'unknown',
  );
  if (unknown.length === 0) return false;
  const linked = Object.entries(parent.capabilities.invocations).flatMap(
    ([parentInvocationId, invocation]) => {
      const link = invocation.subagentProviderLifecycle?.childSession;
      return link ? [{ parentInvocationId, link }] : [];
    },
  );
  const seenChildren = new Set<string>();
  return unknown.every((reservation) => {
    if (reservation.resourceKind !== 'subagent' || reservation.runId !== budget.runId) return false;
    const matches = linked.filter(
      ({ link }) =>
        link.delegatedReservationId === reservation.reservationId &&
        link.fundingRunId === budget.runId &&
        link.terminalImport?.status === 'cancelled',
    );
    if (matches.length !== 1) return false;
    const { parentInvocationId, link } = matches[0]!;
    if (seenChildren.has(link.childThreadId)) return false;
    seenChildren.add(link.childThreadId);
    const child = input.readSettledChild(link.childThreadId);
    const origin = child?.childSessionOrigin;
    const terminal = origin?.terminal;
    if (
      !child ||
      !origin ||
      !terminal ||
      child.session.threadId !== link.childThreadId ||
      origin.parentSessionId !== parent.session.threadId ||
      origin.parentInvocationId !== parentInvocationId ||
      origin.delegatedReservationId !== reservation.reservationId ||
      terminal.status !== 'cancelled' ||
      !terminal.cleanupConfirmed ||
      child.turn.status !== 'aborted' ||
      child.turn.abortCause !== 'user' ||
      child.terminalOutcome ||
      child.resourceBudget.status !== 'active' ||
      link.terminalImport?.terminalRevision !== terminal.sealedRevision ||
      link.terminalImport.terminalReceiptDigest !==
        childTerminalReceiptDigest({
          childThreadId: link.childThreadId,
          terminalRevision: terminal.sealedRevision,
          terminalReceiptId: terminal.terminalReceiptId,
          resultIntegrityIdentifier: terminal.resultRef.integrityIdentifier,
        })
    )
      return false;
    const childUnknown = Object.values(child.resourceBudget.reservations).filter(
      (item) => item.state === 'unknown',
    );
    if (childUnknown.length === 0) return false;
    return childUnknown.every(
      (item) =>
        item.resourceKind === 'model' &&
        Object.values(child.modelInvocations).some(
          (model) =>
            model.status === 'interrupted' &&
            model.dispatchCertainty === 'attempted' &&
            model.interruptionReason === 'cancelled' &&
            model.budget.kind === 'reservation' &&
            model.budget.reservationId === item.reservationId &&
            item.invocationId === `model-invocation:${model.invocationId}`,
        ),
    );
  });
}
