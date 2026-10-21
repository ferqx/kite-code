import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import { AgentError, type Json } from '../types';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
const body = (row: Row) => JSON.parse(String(row.request_json)) as Record<string, Json>;
const hash = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Private provenance for a new first start, never a substitute predecessor Run. */
export interface FirstActivationProof {
  previousCommandId: string;
  previousExecutionId: string;
  childSessionId: string;
  contextSelectionId: string;
  background: { commandId: string; executionId: string; requestDigest: string } | null;
}

function unstarted(db: SqliteOperations, carrier: Row, subjectId: string) {
  const origin = db.row('SELECT * FROM command WHERE id=?', carrier.origin_command_id!);
  const start = db.row('SELECT * FROM command WHERE id=?', `child-start-${carrier.id}`);
  const operation = origin && body(origin);
  const request = start && body(start);
  const receipt = start && (JSON.parse(String(start.receipt_json)) as Record<string, Json>);
  const configuration = JSON.parse(String(carrier.child_configuration_json)) as {
    id: string;
    version: string;
  };
  if (
    carrier.kind !== 'job' ||
    carrier.state !== 'cancelled' ||
    carrier.dispatched !== 0n ||
    carrier.reference_json !== null ||
    !origin ||
    !start ||
    !operation ||
    !request ||
    origin.kind !== 'operation.agent' ||
    origin.session_id !== carrier.session_id ||
    origin.subject_id !== subjectId ||
    origin.origin_store_id !== carrier.origin_store_id ||
    origin.root_work_command_id !== carrier.root_work_command_id ||
    String(origin.root_work_seq) !== String(carrier.root_work_seq) ||
    operation?.parentExecutionId !== carrier.parent_execution_id ||
    operation.configurationId !== configuration.id ||
    canonicalJson(operation.childConfiguration!) !== carrier.child_configuration_json ||
    canonicalJson(operation.input!) !== carrier.intent_json ||
    origin.request_digest !== hash(operation) ||
    start.kind !== 'child.start' ||
    start.session_id !== carrier.child_session_id ||
    start.subject_id !== subjectId ||
    start.origin_store_id !== carrier.origin_store_id ||
    start.root_work_command_id !== carrier.root_work_command_id ||
    String(start.root_work_seq) !== String(carrier.root_work_seq) ||
    start.status !== 'rejected' ||
    request?.parentExecutionId !== carrier.id ||
    request.configurationId !== configuration.id ||
    request.configurationVersion !== configuration.version ||
    canonicalJson(request.input!) !== carrier.intent_json ||
    start.request_digest !== hash(request) ||
    !(
      (receipt?.outcome === 'cancelled_before_apply' && start.cancelled === 1n) ||
      (receipt?.outcome === 'not_activated' &&
        receipt.executionId === carrier.id &&
        receipt.reason === 'child_carrier_ended')
    ) ||
    db.row('SELECT id FROM run WHERE origin_command_id=?', start.id!)
  )
    throw new AgentError('operation_needs_review');
  return { origin, start };
}

/** Select only background from this same work; other-work cancelled instructions stay historical. */
function background(db: SqliteOperations, previous: Row, current: Row, subjectId: string) {
  if (
    previous.root_work_command_id !== current.root_work_command_id ||
    String(previous.root_work_seq) !== String(current.root_work_seq)
  )
    return null;
  const carrier = db.row(
    `SELECT e.* FROM execution e JOIN command c ON c.id=e.origin_command_id
     WHERE e.child_session_id=? AND e.session_id=? AND e.origin_store_id=?
       AND e.root_work_command_id=? AND e.root_work_seq=? AND c.subject_id=?
       AND c.kind='operation.agent' ORDER BY c.seq LIMIT 1`,
    previous.child_session_id!,
    previous.session_id!,
    previous.origin_store_id!,
    current.root_work_command_id!,
    current.root_work_seq!,
    subjectId,
  );
  if (!carrier) throw new AgentError('operation_unverifiable');
  const { start } = unstarted(db, carrier, subjectId);
  return {
    commandId: String(start.id),
    executionId: String(carrier.id),
    requestDigest: String(start.request_digest),
  };
}

/** Called inside the final admission transaction, before any new carrier is written. */
export function prepareFirstActivation(
  db: SqliteOperations,
  previous: Row,
  child: Row,
  current: Row,
): FirstActivationProof {
  const { origin } = unstarted(db, previous, String(current.subject_id));
  if (
    origin.origin_store_id !== current.origin_store_id ||
    previous.session_id !== current.session_id ||
    child.id !== previous.child_session_id ||
    child.parent_id !== previous.session_id ||
    child.root_id !== previous.root_session_id ||
    db.row('SELECT id FROM run WHERE session_id=? LIMIT 1', child.id!) ||
    db.row(
      "SELECT id FROM execution WHERE (session_id=? OR child_session_id=?) AND state='outcome_unknown' LIMIT 1",
      child.id!,
      child.id!,
    )
  )
    throw new AgentError('operation_needs_review');
  return {
    previousCommandId: String(origin.id),
    previousExecutionId: String(previous.id),
    childSessionId: String(child.id),
    contextSelectionId: String(child.context_selection_id),
    background: background(db, previous, current, String(current.subject_id)),
  };
}

/** Exact read-only proof, shared by activation, mailbox adoption and cold recovery. */
export function verifyFirstActivation(db: SqliteOperations, carrier: Row, start: Row) {
  const request = body(start);
  const origin = db.row('SELECT * FROM command WHERE id=?', carrier.origin_command_id!);
  const operation = origin && body(origin);
  if (
    request.firstActivation === undefined &&
    operation?.firstActivation === undefined &&
    !(start.kind === 'child.start' && carrier.predecessor_execution_id !== null)
  )
    return null;
  const proof = request.firstActivation as unknown as FirstActivationProof | undefined;
  const previous = proof && db.row('SELECT * FROM execution WHERE id=?', proof.previousExecutionId);
  const child = db.row('SELECT * FROM session WHERE id=?', carrier.child_session_id!);
  if (
    !proof ||
    !previous ||
    !origin ||
    !child ||
    start.kind !== 'child.start' ||
    Object.keys(proof).sort().join(',') !==
      'background,childSessionId,contextSelectionId,previousCommandId,previousExecutionId' ||
    canonicalJson(request.firstActivation!) !== canonicalJson(operation!.firstActivation!) ||
    start.id !== `child-start-${carrier.id}` ||
    request.parentExecutionId !== carrier.id ||
    origin.kind !== 'operation.agent' ||
    origin.request_digest !== hash(operation!) ||
    start.request_digest !== hash(request) ||
    operation!.parentExecutionId !== carrier.parent_execution_id ||
    operation!.configurationId !== JSON.parse(String(carrier.child_configuration_json)).id ||
    request.configurationId !== operation!.configurationId ||
    request.configurationVersion !== JSON.parse(String(carrier.child_configuration_json)).version ||
    canonicalJson(operation!.childConfiguration!) !== carrier.child_configuration_json ||
    canonicalJson(operation!.input!) !== carrier.intent_json ||
    canonicalJson(request.input!) !== carrier.intent_json ||
    start.agent_carrier_execution_id !== carrier.id ||
    start.agent_source_execution_id !== carrier.parent_execution_id ||
    start.after_run_id !== null ||
    start.input_context_selection_id !== proof.contextSelectionId ||
    carrier.predecessor_execution_id !== previous.id ||
    previous.origin_command_id !== proof.previousCommandId ||
    carrier.child_session_id !== proof.childSessionId ||
    previous.child_session_id !== child.id ||
    start.session_id !== child.id ||
    origin.session_id !== carrier.session_id ||
    child.parent_id !== carrier.session_id ||
    previous.session_id !== carrier.session_id ||
    child.root_id !== carrier.root_session_id ||
    previous.root_session_id !== carrier.root_session_id ||
    previous.origin_store_id !== carrier.origin_store_id ||
    start.origin_store_id !== carrier.origin_store_id ||
    origin.origin_store_id !== carrier.origin_store_id ||
    start.subject_id !== origin.subject_id ||
    start.root_work_command_id !== carrier.root_work_command_id ||
    origin.root_work_command_id !== carrier.root_work_command_id ||
    String(start.root_work_seq) !== String(carrier.root_work_seq) ||
    String(origin.root_work_seq) !== String(carrier.root_work_seq) ||
    JSON.parse(String(previous.child_configuration_json)).id !==
      JSON.parse(String(carrier.child_configuration_json)).id ||
    db.row(
      `SELECT r.id FROM run r JOIN command c ON c.id=r.origin_command_id WHERE r.session_id=? AND c.seq<? LIMIT 1`,
      child.id!,
      start.seq!,
    )
  )
    throw new AgentError('operation_unverifiable');
  const prior = unstarted(db, previous, String(origin.subject_id));
  if (
    BigInt(prior.origin.seq!) >= BigInt(origin.seq!) ||
    canonicalJson(proof.background as unknown as Json) !==
      canonicalJson(background(db, previous, origin, String(origin.subject_id)) as unknown as Json)
  )
    throw new AgentError('operation_unverifiable');
  const backgroundStart =
    proof.background && db.row('SELECT * FROM command WHERE id=?', proof.background.commandId);
  return {
    proof,
    previous,
    previousOrigin: prior.origin,
    previousStart: prior.start,
    backgroundStart,
  };
}
