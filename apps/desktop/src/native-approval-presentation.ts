import type { Interaction } from '@kite-ai/client';
import type { InteractionSubmission } from '@kite-ai/ui';
import { useRef, useState } from 'react';
import { isOrdinaryNativeApproval } from './native-approval-group';
import type { NativeAnswerMetadata, NativeState } from './native-bridge';

export const nativeApprovalKey = (card: Interaction) =>
  JSON.stringify([card.originStoreId, card.presentationSessionId, card.id, card.revision]);

function journalSubmission(row: NativeAnswerMetadata, state: NativeState) {
  const live = state.interactionSubmissions.find(
    (entry) =>
      entry.interaction.originStoreId === row.scope.storeId &&
      entry.interaction.presentationSessionId === row.scope.sessionId &&
      entry.interaction.id === row.interaction.id &&
      entry.interaction.revision === row.interaction.revision &&
      entry.intent.commandId === row.request.commandId,
  );
  // The journal restores submitting as unknown. An exact live POST is still in
  // flight, not an unknown result. Terminal journal proofs continue to win.
  const phase =
    row.phase === 'unknown' && (live?.phase === 'saved' || live?.phase === 'submitting')
      ? live.phase
      : row.phase;
  return { phase, commandId: row.request.commandId };
}

/** Display only: neither dismissal nor a saved answer proves approval or execution. */
export function nativeApprovalSubmission(card: Interaction, state: NativeState | undefined) {
  const saved = state?.answerSubmissions?.find(
    (row) =>
      row.scope.storeId === card.originStoreId &&
      row.scope.sessionId === card.presentationSessionId &&
      row.interaction.id === card.id &&
      row.interaction.revision === card.revision,
  );
  if (saved) return journalSubmission(saved, state!);
  const current = state?.interactionSubmissions.find(
    (row) => nativeApprovalKey(row.interaction) === nativeApprovalKey(card),
  );
  return current
    ? { phase: current.phase, commandId: current.intent.commandId, error: current.error }
    : undefined;
}

// These errors are raised by Main admission before answer registration/transport.
// Generic IPC failures and any error after registration never permit another POST.
const notSubmitted = new Set([
  'interaction_observation_changed',
  'interaction_scope_mismatch',
  'attachment_not_loaded',
  'attachment_invalid',
  'view_not_ready',
  'workspace_identity_unavailable',
  'native_selection_changed',
]);
type Attempt = { card: Interaction; phase: 'submitting' | 'unknown' | 'failed' | 'accepted' };

export function useNativeApprovalPresentation(state: NativeState | undefined) {
  const attempts = useRef(new Map<string, Attempt>());
  const [, changed] = useState(0);
  const publish = () => changed((value) => value + 1);
  const hidden = (card: Interaction) => {
    if (!isOrdinaryNativeApproval(card)) return false;
    const attempt = attempts.current.get(nativeApprovalKey(card));
    return !!nativeApprovalSubmission(card, state) || (!!attempt && attempt.phase !== 'failed');
  };
  async function submit(card: Interaction, action: () => void | Promise<void>) {
    const key = nativeApprovalKey(card);
    const previous = attempts.current.get(key);
    if (nativeApprovalSubmission(card, state) || (previous && previous.phase !== 'failed')) return;
    const attempt: Attempt = { card, phase: 'submitting' };
    attempts.current.set(key, attempt);
    publish(); // Synchronous lock, before IPC, receipt, execution or observation refresh.
    try {
      await action();
      attempt.phase = 'accepted';
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      attempt.phase = typeof code === 'string' && notSubmitted.has(code) ? 'failed' : 'unknown';
    }
    publish();
  }
  const notices = new Map<
    string,
    { key: string; phase: 'unknown' | 'failed'; commandId?: string; retryable: boolean }
  >();
  const selection = state?.selection;
  if (selection) {
    const add = (card: Interaction, submission?: InteractionSubmission, attempt?: Attempt) => {
      if (
        !isOrdinaryNativeApproval(card) ||
        card.originStoreId !== selection.storeId ||
        card.presentationSessionId !== selection.session.id
      )
        return;
      const phase = submission?.phase ?? attempt?.phase;
      if (phase !== 'unknown' && phase !== 'failed') return;
      const key = nativeApprovalKey(card);
      if (
        !submission &&
        phase === 'failed' &&
        !selection.interactions.some(
          (current) => current.state === 'pending' && nativeApprovalKey(current) === key,
        )
      )
        return;
      notices.set(key, {
        key,
        phase,
        commandId: submission?.commandId,
        retryable: !submission && phase === 'failed',
      });
    };
    for (const attempt of attempts.current.values())
      add(attempt.card, nativeApprovalSubmission(attempt.card, state), attempt);
    for (const card of selection.interactions) add(card, nativeApprovalSubmission(card, state));
    for (const row of state.interactionSubmissions)
      add(row.interaction, nativeApprovalSubmission(row.interaction, state));
    // A cold reopen may retain the original journal even after its card left the pending page.
    for (const row of state.answerSubmissions ?? []) {
      if (
        row.interaction.kind !== 'approval' ||
        row.scope.storeId !== selection.storeId ||
        row.scope.sessionId !== selection.session.id ||
        (row.phase !== 'unknown' && row.phase !== 'failed')
      )
        continue;
      const submission = journalSubmission(row, state);
      if (submission.phase !== 'unknown' && submission.phase !== 'failed') continue;
      const key = JSON.stringify([
        row.scope.storeId,
        row.scope.sessionId,
        row.interaction.id,
        row.interaction.revision,
      ]);
      notices.set(key, {
        key,
        phase: submission.phase,
        commandId: submission.commandId,
        retryable: false,
      });
    }
  }
  return { hidden, submit, notices: [...notices.values()] };
}
