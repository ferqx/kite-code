import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import { AgentError, type Json } from '../types';
import { verifyFirstActivation } from './child-first-activation';
import { messageOriginRow } from './fork-operations';
import { humanInputDisplay } from './human-input-display';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
const object = (value: Row[string] | undefined): Record<string, Json> => {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
};
const same = (a: unknown, b: unknown) =>
  canonicalJson((a ?? null) as Json) === canonicalJson((b ?? null) as Json);
const intact = (row: Row) =>
  createHash('sha256')
    .update(canonicalJson(object(row.request_json)))
    .digest('hex') === row.request_digest;
const sameWork = (a: Row, b: Row) =>
  a.root_work_command_id === b.root_work_command_id &&
  String(a.root_work_seq) === String(b.root_work_seq);
function delegationContent(input: Json): string {
  if (typeof input === 'string') return input;
  if (
    input &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    Object.keys(input).every((key) => key === 'content' || key === 'name') &&
    typeof input.content === 'string' &&
    (input.name === undefined ||
      (typeof input.name === 'string' && input.name.length > 0 && input.name.length <= 120))
  )
    return input.content;
  return canonicalJson(input);
}

/** Retention is context, not authorization. Follow the sealed downward delegation only. */
function agentCompressionInput(db: SqliteOperations, row: Row, subjectId: string): boolean {
  const body = object(row.source_json);
  if (!Array.isArray(body.sourceIds) || typeof body.sourceIds[0] !== 'string') return false;
  const command = db.row('SELECT * FROM command WHERE id=?', body.sourceIds[0]);
  const run = db.row('SELECT * FROM run WHERE id=? AND session_id=?', row.run_id!, row.session_id!);
  const child = db.row('SELECT * FROM session WHERE id=?', row.session_id!);
  if (
    !command ||
    !run ||
    !child ||
    child.parent_id === null ||
    command.status !== 'applied' ||
    !intact(command) ||
    command.session_id !== child.id ||
    command.subject_id !== subjectId ||
    !sameWork(command, run) ||
    command.origin_store_id !== run.origin_store_id
  )
    return false;
  if (
    command.kind === 'child.start' &&
    (body.sourceIds.length !== 2 || typeof body.sourceIds[1] !== 'string')
  )
    return false;
  const start = db.row('SELECT * FROM command WHERE id=?', run.origin_command_id!);
  const carrier = db.row(
    'SELECT * FROM execution WHERE child_session_id=? AND id=?',
    child.id!,
    command.kind === 'child.start'
      ? (body.sourceIds[1] as string)
      : command.agent_carrier_execution_id!,
  );
  if (
    !start ||
    !carrier ||
    !intact(start) ||
    start.status !== 'applied' ||
    start.id !== `child-start-${carrier.id}` ||
    start.session_id !== child.id ||
    start.subject_id !== subjectId ||
    start.origin_store_id !== run.origin_store_id ||
    !sameWork(start, run) ||
    !sameWork(carrier, run) ||
    carrier.kind !== 'job' ||
    carrier.dispatched !== 1n ||
    carrier.session_id !== child.parent_id ||
    carrier.root_session_id !== child.root_id ||
    carrier.origin_store_id !== run.origin_store_id
  )
    return false;
  const operation = db.row('SELECT * FROM command WHERE id=?', carrier.origin_command_id!);
  const source = db.row(
    'SELECT * FROM execution WHERE id=?',
    command.kind === 'child.start'
      ? carrier.parent_execution_id!
      : command.agent_source_execution_id!,
  );
  const sourceCommand =
    source && db.row('SELECT * FROM command WHERE id=?', source.origin_command_id!);
  if (
    !operation ||
    !intact(operation) ||
    !source ||
    !sourceCommand ||
    !intact(sourceCommand) ||
    operation.session_id !== child.parent_id ||
    operation.subject_id !== subjectId ||
    operation.origin_store_id !== run.origin_store_id ||
    !sameWork(operation, carrier) ||
    source.kind !== 'tool' ||
    source.dispatched !== 1n ||
    source.session_id !== child.parent_id ||
    source.root_session_id !== child.root_id ||
    source.origin_store_id !== run.origin_store_id ||
    sourceCommand.session_id !== child.parent_id ||
    sourceCommand.subject_id !== subjectId ||
    sourceCommand.origin_store_id !== run.origin_store_id
  )
    return false;
  // The parent may deliberately address an older collaborator from newer work.
  // Compare each side to its own sealed Run/Command, never the two works together.
  const sourceRun =
    source.run_id === null ? null : db.row('SELECT * FROM run WHERE id=?', source.run_id!);
  if (
    !sameWork(source, sourceCommand) ||
    (source.run_id !== null &&
      (!sourceRun ||
        sourceRun.session_id !== source.session_id ||
        sourceRun.origin_store_id !== source.origin_store_id ||
        !sameWork(source, sourceRun)))
  )
    return false;
  const delegation = object(operation.request_json);
  const configuration = object(carrier.child_configuration_json);
  if (
    operation.kind !== 'operation.agent' ||
    delegation.kind !== 'operation.agent' ||
    delegation.parentExecutionId !== carrier.parent_execution_id ||
    delegation.configurationId !== configuration.id ||
    !same(delegation.childConfiguration, configuration) ||
    canonicalJson(delegation.input ?? null) !== carrier.intent_json
  )
    return false;
  const request = object(command.request_json),
    receipt = object(command.receipt_json);
  if (request.kind !== command.kind || receipt.runId !== run.id) return false;
  let assignment: Json;
  try {
    assignment = JSON.parse(String(carrier.intent_json)) as Json;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
  if (command.kind === 'child.start') {
    try {
      verifyFirstActivation(db, carrier, start);
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error instanceof AgentError && error.code === 'operation_unverifiable')
      )
        return false;
      throw error;
    }
    return (
      body.sourceIds.length === 2 &&
      command.id === start.id &&
      receipt.executionId === carrier.id &&
      receipt.childSessionId === child.id &&
      request.parentExecutionId === carrier.id &&
      (command.agent_source_execution_id === null ||
        command.agent_source_execution_id === source.id) &&
      (command.agent_carrier_execution_id === null ||
        command.agent_carrier_execution_id === carrier.id) &&
      request.configurationId === configuration.id &&
      request.configurationVersion === configuration.version &&
      same(request.input, assignment) &&
      body.content === delegationContent(assignment) &&
      db.row(
        "SELECT id FROM message WHERE session_id=? AND run_id=? AND role='user' AND json_extract(source_json,'$.sourceIds')=? ORDER BY seq LIMIT 1",
        child.id!,
        run.id!,
        canonicalJson(body.sourceIds),
      )?.id === row.id
    );
  }
  if (
    !['input.steer', 'input.follow_up'].includes(String(command.kind)) ||
    body.sourceIds.length !== 1 ||
    command.agent_source_execution_id !== source.id ||
    command.agent_carrier_execution_id !== carrier.id ||
    body.content !== request.content ||
    !same(body.images, request.images) ||
    !same(body.files, request.files) ||
    receipt.messageId !== row.id ||
    receipt.contextSelectionId !== command.input_context_selection_id ||
    receipt.outcome !== 'input_applied' ||
    request.contextSelectionId !== run.context_selection_id ||
    command.input_context_selection_id !== run.context_selection_id ||
    body.contextSelectionId !== run.context_selection_id ||
    body.originCommandId !== command.id ||
    body.inputKind !== command.kind
  )
    return false;
  if (command.kind === 'input.follow_up')
    return command.id === start.id && body.content === delegationContent(assignment);
  if (request.targetRunId !== run.id || command.input_target_run_id !== run.id) return false;
  const envelope = object(request.content as string);
  return (
    envelope.kind === 'agent_message' &&
    envelope.sourceSessionId === child.parent_id &&
    envelope.sourceExecutionId === source.id &&
    envelope.carrierExecutionId === carrier.id &&
    typeof envelope.content === 'string'
  );
}

/** Preserve proven human input and downward tasks without changing their original authority. */
export function originalCompressionInput(
  db: SqliteOperations,
  selected: Row,
  subjectId: string,
): { duplicateOfMessageId?: string } | null {
  if (selected.role !== 'user' || selected.status !== 'complete') return null;
  try {
    const row = selected.fork_source_message_id
      ? messageOriginRow(db, selected, subjectId)
      : selected;
    if (agentCompressionInput(db, row, subjectId)) return {};
    // Public human admission belongs to a group root. A damaged Agent marker
    // must not downgrade a child-local command to the direct human protocol.
    if (db.row('SELECT parent_id FROM session WHERE id=?', row.session_id!)?.parent_id !== null)
      return null;
    const body = object(row.source_json);
    if (
      !Array.isArray(body.sourceIds) ||
      body.sourceIds.length !== 1 ||
      typeof body.sourceIds[0] !== 'string'
    )
      return null;
    const command = db.row('SELECT * FROM command WHERE id=?', body.sourceIds[0]);
    const run = db.row(
      'SELECT * FROM run WHERE id=? AND session_id=?',
      row.run_id!,
      row.session_id!,
    );
    if (
      !command ||
      !run ||
      command.status !== 'applied' ||
      command.agent_source_execution_id !== null ||
      command.agent_carrier_execution_id !== null ||
      command.session_id !== row.session_id ||
      command.origin_store_id !== run.origin_store_id ||
      command.subject_id !== subjectId ||
      !['run.start', 'input.steer', 'input.follow_up'].includes(String(command.kind))
    )
      return null;
    const request = object(command.request_json);
    if (
      createHash('sha256').update(canonicalJson(request)).digest('hex') !==
        command.request_digest ||
      request.kind !== command.kind ||
      body.content !== (request.content ?? '') ||
      !same(body.images, request.images) ||
      !same(body.files, request.files)
    )
      return null;
    const legacy = humanInputDisplay(db, selected, object(selected.source_json));
    if (legacy)
      return legacy.duplicateOfMessageId
        ? { duplicateOfMessageId: legacy.duplicateOfMessageId }
        : {};
    // Historical interpretation commands need their original proof, not a
    // fallback to the modern direct-admission protocol.
    if (command.target_command_id !== null) return null;
    const runOrigin = db.row('SELECT * FROM command WHERE id=?', run.origin_command_id!);
    if (
      !runOrigin ||
      runOrigin.session_id !== row.session_id ||
      runOrigin.origin_store_id !== run.origin_store_id ||
      runOrigin.subject_id !== subjectId
    )
      return null;
    const receipt = object(command.receipt_json);
    if (
      receipt.runId !== run.id ||
      (body.originCommandId !== undefined && body.originCommandId !== command.id)
    )
      return null;
    if (command.kind === 'run.start') {
      if (
        run.origin_command_id !== command.id ||
        db.row(
          "SELECT id FROM message WHERE session_id=? AND run_id=? AND role='user' ORDER BY seq LIMIT 1",
          row.session_id!,
          run.id!,
        )?.id !== row.id
      )
        return null;
    } else if (
      receipt.messageId !== row.id ||
      receipt.contextSelectionId !== command.input_context_selection_id ||
      receipt.outcome !== 'input_applied' ||
      request.contextSelectionId !== command.input_context_selection_id ||
      body.contextSelectionId !== command.input_context_selection_id ||
      command.input_context_selection_id !== run.context_selection_id ||
      body.originCommandId !== command.id ||
      body.inputKind !== command.kind ||
      (command.kind === 'input.steer'
        ? command.input_target_run_id !== run.id || request.targetRunId !== run.id
        : run.origin_command_id !== command.id)
    )
      return null;
    return {};
  } catch (error) {
    if (
      error instanceof AgentError &&
      ['fork_origin_unverifiable', 'permission_denied', 'session_not_found'].includes(error.code)
    )
      return null;
    throw error;
  }
}
