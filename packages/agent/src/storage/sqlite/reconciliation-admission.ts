import { canonicalJson } from '../../json';
import type { AcceptCommandInput } from '../port';
import { AgentError } from '../types';
import type { SqliteOperations } from './operations';
import { recoveryToolHistory } from './recovery-history';
import { withReconciledFrontier } from './session-reconciliation';

/** A newly accepted ordinary task retires only a proven, effect-free old frontier. */
export function closeReconciledHistory(db: SqliteOperations, input: AcceptCommandInput): void {
  if (input.request.kind !== 'run.start' && input.request.kind !== 'input.follow_up') return;
  const saved = db.row(
    'SELECT * FROM session_reconciliation WHERE root_session_id=?',
    input.sessionId,
  );
  if (!saved) return;
  const admission = input.reconciliationAdmission;
  const root = db.row('SELECT * FROM session WHERE id=?', input.sessionId);
  if (
    !admission ||
    root?.owner_instance !== null ||
    db.row(
      "SELECT id FROM execution WHERE root_session_id=? AND state='outcome_unknown'",
      input.sessionId,
    )
  )
    throw new AgentError('session_recovery_required');
  const histories = withReconciledFrontier(
    db,
    { ...input, expectedOwnerGeneration: admission.expectedOwnerGeneration },
    () =>
      db
        .rows(
          "SELECT * FROM execution WHERE root_session_id=? AND kind='tool' AND state='planned' AND dispatched=0 ORDER BY id LIMIT 4097",
          input.sessionId,
        )
        .map((tool) => recoveryToolHistory(db, tool))
        .filter((history) => history !== null),
  );
  if (histories.length > 4096) throw new AgentError('recovery_too_large');
  const proofs = admission.toolHistoryProofs;
  if (
    !Array.isArray(proofs) ||
    proofs.length !== histories.length ||
    new Set(proofs.map((proof) => proof.executionId)).size !== proofs.length ||
    histories.some(
      (history) =>
        !proofs.some(
          (proof) =>
            proof.executionId === history.executionId &&
            proof.bindingDigest === history.bindingDigest,
        ),
    )
  )
    throw new AgentError('recovery_tool_history_changed');
  for (const history of histories) {
    const tool = db.row('SELECT * FROM execution WHERE id=?', history.executionId);
    if (tool?.state !== 'cancelled') throw new AgentError('session_recovery_required');
    const result = JSON.parse(String(tool.result_json));
    if (
      result.code !== 'owner_lost_before_dispatch' ||
      result.reconciliationCommandId !== saved.command_id
    )
      throw new AgentError('session_recovery_required');
    db.appendMessage(
      history.sessionId,
      history.runId,
      {
        content: canonicalJson(result),
        toolCallId: history.callId,
        sourceIds: [history.executionId],
      },
      'tool',
    );
  }
  db.run('DELETE FROM session_reconciliation WHERE root_session_id=?', input.sessionId);
}
