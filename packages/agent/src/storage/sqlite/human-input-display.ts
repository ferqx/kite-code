import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import { AgentError, type Json, type MessageRecord } from '../types';
import { messageOriginRow } from './fork-operations';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
const object = (value: unknown): Record<string, Json> => {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};
const digest = (value: Record<string, Json>) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const same = (a: Row, b: Row) =>
  a.session_id === b.session_id &&
  a.origin_store_id === b.origin_store_id &&
  a.subject_id === b.subject_id;
const intact = (row: Row) => digest(object(row.request_json)) === row.request_digest;

/** Presentation proof comes from sealed SQL relations, never message source metadata. */
export function humanInputDisplay(
  db: SqliteOperations,
  message: Row,
  source: Record<string, Json>,
): MessageRecord['humanInput'] {
  if (message.fork_source_message_id === null || message.fork_source_message_id === undefined)
    return originalHumanInputDisplay(db, message, source);
  if (message.role !== 'user' || message.run_id !== null) return;
  const creator = db.row(
    "SELECT c.subject_id FROM session s JOIN command c ON c.session_id=s.root_id AND c.kind='session.create' WHERE s.id=?",
    message.session_id!,
  );
  if (typeof creator?.subject_id !== 'string') return;
  try {
    const original = messageOriginRow(db, message, creator.subject_id);
    const proof = originalHumanInputDisplay(db, original, object(original.source_json));
    if (!proof?.duplicateOfMessageId) return proof;
    const { duplicateOfMessageId, ...identity } = proof;
    // A Fork is a sealed snapshot: the source may acquire its business message
    // later. Only a replacement actually copied into this Fork can hide its input.
    const replacements = db.rows(
      'SELECT * FROM message WHERE session_id=? AND fork_source_message_id=? LIMIT 2',
      message.session_id!,
      duplicateOfMessageId,
    );
    if (replacements.length !== 1) return identity;
    const replacement = replacements[0]!;
    const replacementOrigin = messageOriginRow(db, replacement, creator.subject_id);
    const replacementProof = originalHumanInputDisplay(
      db,
      replacementOrigin,
      object(replacementOrigin.source_json),
    );
    if (
      replacementOrigin.id !== duplicateOfMessageId ||
      replacementOrigin.session_id !== original.session_id ||
      replacementProof?.inputCommandId !== identity.inputCommandId ||
      replacementProof.publicCommandId !== identity.publicCommandId ||
      replacementProof.duplicateOfMessageId !== undefined
    )
      return;
    return { ...identity, duplicateOfMessageId: String(replacement.id) };
  } catch (error) {
    if (
      error instanceof AgentError &&
      ['fork_origin_unverifiable', 'permission_denied', 'session_not_found'].includes(error.code)
    )
      return;
    throw error;
  }
}

function originalHumanInputDisplay(
  db: SqliteOperations,
  message: Row,
  source: Record<string, Json>,
): MessageRecord['humanInput'] {
  if (
    message.role !== 'user' ||
    message.run_id === null ||
    !Array.isArray(source.sourceIds) ||
    source.sourceIds.length !== 1 ||
    typeof source.sourceIds[0] !== 'string'
  )
    return;
  const command = db.row('SELECT * FROM command WHERE id=?', source.sourceIds[0]);
  const run = db.row(
    'SELECT * FROM run WHERE id=? AND session_id=?',
    message.run_id!,
    message.session_id!,
  );
  if (
    !command ||
    !run ||
    !intact(command) ||
    command.session_id !== message.session_id ||
    command.origin_store_id !== run.origin_store_id ||
    command.status !== 'applied'
  )
    return;
  const processing = command.kind === 'run.start' && run.origin_command_id === command.id;
  const decision =
    !processing && ['input.steer', 'input.follow_up'].includes(String(command.kind))
      ? db.row(
          "SELECT * FROM command WHERE id=? AND kind='human.input.decision'",
          command.target_command_id!,
        )
      : undefined;
  const decisionRequest = decision && object(decision.request_json);
  const inputId = processing ? command.target_command_id : decisionRequest?.inputCommandId;
  if (typeof inputId !== 'string') return;
  const raw = db.row("SELECT * FROM command WHERE id=? AND kind='human.input'", inputId);
  if (!raw || !same(command, raw) || !intact(raw)) return;
  const request = object(raw.request_json),
    receipt = object(raw.receipt_json);
  if (
    source.content !== request.content ||
    object(command.request_json).content !== request.content
  )
    return;
  if (processing) {
    const initial = db.row(
      "SELECT id FROM message WHERE session_id=? AND run_id=? AND role='user' ORDER BY seq LIMIT 1",
      message.session_id!,
      run.id!,
    );
    if (
      receipt.processingCommandId !== command.id ||
      object(command.receipt_json).runId !== run.id ||
      initial?.id !== message.id
    )
      return;
  } else if (
    !decision ||
    !same(decision, raw) ||
    !intact(decision) ||
    decision.status !== 'applied' ||
    decisionRequest?.inputDigest !== raw.request_digest ||
    receipt.decisionCommandId !== decision.id ||
    object(decision.receipt_json).businessCommandId !== command.id
  )
    return;

  let publicCommandId: string | undefined;
  if (typeof request.publicCommandId === 'string') {
    const publicCommand = db.row('SELECT * FROM command WHERE id=?', request.publicCommandId);
    if (
      !publicCommand ||
      !same(publicCommand, raw) ||
      !intact(publicCommand) ||
      publicCommand.target_command_id !== raw.id ||
      object(publicCommand.receipt_json).humanInputCommandId !== raw.id ||
      canonicalJson(object(publicCommand.request_json)) !== canonicalJson(request.originalRequest!)
    )
      return;
    publicCommandId = String(publicCommand.id);
  }
  const result: NonNullable<MessageRecord['humanInput']> = {
    inputCommandId: String(raw.id),
    ...(publicCommandId ? { publicCommandId } : {}),
  };
  // A queued/undecided input must remain visible. Only the actual applied business
  // message can replace the processing copy; IDs and receipts must all agree.
  // Later cancellation does not undo a proven application or its saved message.
  const business =
    typeof receipt.businessCommandId === 'string'
      ? db.row('SELECT * FROM command WHERE id=?', receipt.businessCommandId)
      : undefined;
  const appliedDecision =
    typeof receipt.decisionCommandId === 'string'
      ? db.row(
          "SELECT * FROM command WHERE id=? AND kind='human.input.decision'",
          receipt.decisionCommandId,
        )
      : undefined;
  const businessReceipt = business && object(business.receipt_json);
  const businessMessage =
    typeof receipt.messageId === 'string'
      ? db.row('SELECT * FROM message WHERE id=?', receipt.messageId)
      : undefined;
  if (
    !business ||
    !appliedDecision ||
    !businessMessage ||
    !businessReceipt ||
    !same(business, raw) ||
    !same(appliedDecision, raw) ||
    !intact(business) ||
    !intact(appliedDecision) ||
    business.status !== 'applied' ||
    appliedDecision.status !== 'applied' ||
    !['input.steer', 'input.follow_up'].includes(String(business.kind)) ||
    (receipt.state !== 'decided' && receipt.state !== 'cancelled') ||
    receipt.applicationState !== 'applied' ||
    business.target_command_id !== appliedDecision.id ||
    object(appliedDecision.request_json).inputCommandId !== raw.id ||
    object(appliedDecision.request_json).inputDigest !== raw.request_digest ||
    object(appliedDecision.receipt_json).businessCommandId !== business.id ||
    businessReceipt.humanInputCommandId !== raw.id ||
    businessReceipt.decisionCommandId !== appliedDecision.id ||
    businessReceipt.runId !== receipt.runId ||
    businessReceipt.messageId !== receipt.messageId ||
    businessMessage.session_id !== raw.session_id ||
    businessMessage.run_id !== receipt.runId ||
    businessMessage.role !== 'user' ||
    businessMessage.status !== 'complete' ||
    object(business.request_json).content !== request.content
  )
    return processing ? result : undefined;
  const businessSource = object(businessMessage.source_json);
  const businessRun = db.row(
    'SELECT * FROM run WHERE id=? AND session_id=?',
    businessMessage.run_id!,
    raw.session_id!,
  );
  if (
    !businessRun ||
    businessRun.origin_store_id !== raw.origin_store_id ||
    businessSource.content !== request.content ||
    businessSource.originCommandId !== business.id ||
    !Array.isArray(businessSource.sourceIds) ||
    canonicalJson(businessSource.sourceIds) !== canonicalJson([String(business.id)]) ||
    (business.kind === 'input.follow_up' && businessRun.origin_command_id !== business.id) ||
    (business.kind === 'input.steer' && business.input_target_run_id !== businessRun.id)
  )
    return processing ? result : undefined;
  if (publicCommandId) {
    const publicReceipt = object(
      db.row('SELECT receipt_json FROM command WHERE id=?', publicCommandId)!.receipt_json,
    );
    if (
      publicReceipt.outcome !== 'human_input_applied' ||
      publicReceipt.businessCommandId !== business.id ||
      publicReceipt.decisionCommandId !== appliedDecision.id ||
      publicReceipt.runId !== receipt.runId ||
      publicReceipt.messageId !== receipt.messageId
    )
      return processing ? result : undefined;
  }
  if (processing) return { ...result, duplicateOfMessageId: String(businessMessage.id) };
  return businessMessage.id === message.id ? result : undefined;
}
