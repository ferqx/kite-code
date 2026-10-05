import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { Store } from '../port';
import { AgentError, type AgentMessage, type ArtifactReference, type Json } from '../types';
import { getAgentSummary } from './child-query-operations';
import { verifyNamespace } from './extension-operations';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
const parse = (value: Row[string] | undefined) => JSON.parse(String(value));
const hash = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function decimal(value = '0'): bigint {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new AgentError('invalid_mail_cursor');
  return BigInt(value);
}
function query(db: SqliteOperations, id: string): Row | null {
  return db.row(
    `SELECT c.*,c.rowid AS mail_seq,e.state AS source_state,e.completed_cursor AS source_completed_cursor FROM command c JOIN execution e ON e.id=c.agent_source_execution_id WHERE c.id=? AND c.kind='agent.message'`,
    id,
  );
}
function project(row: Row): AgentMessage {
  const value = parse(row.request_json) as { body: ArtifactReference };
  const state = row.mail_received_message_id
    ? 'received'
    : row.status === 'rejected'
      ? 'rejected'
      : row.source_state === 'outcome_unknown'
        ? 'outcome_unknown'
        : row.mail_confirmed
          ? 'accepted'
          : 'pending_sender';
  return {
    id: String(row.id),
    seq: String(row.mail_seq),
    originStoreId: String(row.origin_store_id),
    sourceSessionId: String(row.session_id),
    sourceExecutionId: String(row.agent_source_execution_id),
    targetSessionId: String(row.mail_target_session_id),
    targetRunId: row.mail_target_run_id === null ? null : String(row.mail_target_run_id),
    contextSelectionId: String(row.mail_selection_id),
    body: value.body,
    receivedMessageId:
      row.mail_received_message_id === null ? null : String(row.mail_received_message_id),
    receivedRunId: row.mail_received_run_id === null ? null : String(row.mail_received_run_id),
    receivedContextSelectionId:
      row.mail_received_selection_id === null ? null : String(row.mail_received_selection_id),
    state,
  };
}
/** Only the exact internally sealed follow-up can adopt old unbound intent. */
function adoption(db: SqliteOperations, runId: string, sessionId: string) {
  const row = db.row(
    `SELECT r.origin_store_id,r.root_work_command_id,r.root_work_seq,c.id,c.kind,c.session_id,c.subject_id,c.origin_store_id AS start_store,c.root_work_command_id AS start_work,c.root_work_seq AS start_seq,c.agent_carrier_execution_id,c.input_context_selection_id,c.mail_adoption_upper_seq,c.mail_adoption_cursor,e.child_session_id,e.origin_store_id AS carrier_store,e.root_work_command_id AS carrier_work,e.root_work_seq AS carrier_seq,e.predecessor_execution_id FROM run r JOIN command c ON c.id=r.origin_command_id JOIN execution e ON e.id=c.agent_carrier_execution_id WHERE r.id=? AND r.session_id=?`,
    runId,
    sessionId,
  );
  if (
    row?.kind !== 'input.follow_up' ||
    row.mail_adoption_upper_seq === null ||
    row.mail_adoption_cursor === null
  )
    return null;
  if (
    row.id !== `child-start-${row.agent_carrier_execution_id}` ||
    row.session_id !== sessionId ||
    row.child_session_id !== sessionId ||
    row.origin_store_id !== row.carrier_store ||
    row.origin_store_id !== row.start_store ||
    row.root_work_command_id !== row.start_work ||
    String(row.root_work_seq) !== String(row.start_seq) ||
    row.root_work_command_id !== row.carrier_work ||
    String(row.root_work_seq) !== String(row.carrier_seq) ||
    row.predecessor_execution_id === null
  )
    throw new AgentError('agent_message_unverifiable');
  return row;
}
function eligibleAdoption(mail: Row, binding: Row | null): boolean {
  if (
    !binding ||
    mail.mail_target_run_id !== null ||
    mail.mail_selection_id !== binding.input_context_selection_id ||
    mail.subject_id !== binding.subject_id ||
    mail.origin_store_id !== binding.origin_store_id ||
    !mail.mail_confirmed ||
    mail.source_state !== 'succeeded' ||
    mail.source_completed_cursor === null ||
    BigInt(mail.mail_seq!) > BigInt(binding.mail_adoption_upper_seq!) ||
    BigInt(mail.source_completed_cursor!) > BigInt(binding.mail_adoption_cursor!)
  )
    return false;
  const request = parse(mail.request_json) as { carrierExecutionId: string };
  return request.carrierExecutionId === binding.predecessor_execution_id;
}
function runPredicate(db: SqliteOperations, runId: string, sessionId: string) {
  const binding = adoption(db, runId, sessionId);
  return binding
    ? {
        sql: `(c.mail_target_run_id=? OR (c.mail_target_run_id IS NULL AND c.rowid<=? AND e.completed_cursor IS NOT NULL AND e.completed_cursor<=? AND c.mail_selection_id=? AND c.origin_store_id=? AND json_extract(c.request_json,'$.carrierExecutionId')=?))`,
        args: [
          runId,
          binding.mail_adoption_upper_seq!,
          binding.mail_adoption_cursor!,
          binding.input_context_selection_id!,
          binding.origin_store_id!,
          binding.predecessor_execution_id!,
        ],
      }
    : { sql: 'c.mail_target_run_id=?', args: [runId] };
}
export function hasPendingAgentMail(
  db: SqliteOperations,
  runId: string,
  sessionId: string,
): boolean {
  const filter = runPredicate(db, runId, sessionId);
  return !!db.row(
    `SELECT c.id FROM command c JOIN execution e ON e.id=c.agent_source_execution_id WHERE c.kind='agent.message' AND c.mail_target_session_id=? AND c.mail_confirmed=1 AND c.status='applied' AND c.cancelled=0 AND c.mail_received_message_id IS NULL AND e.state='succeeded' AND ${filter.sql} LIMIT 1`,
    sessionId,
    ...filter.args,
  );
}
function reader(db: SqliteOperations, sessionId: string, subjectId: string): Row {
  const session = db.row('SELECT * FROM session WHERE id=?', sessionId);
  const creator = db.row(
    "SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'",
    sessionId,
  );
  if (!session || creator?.subject_id !== subjectId) throw new AgentError('permission_denied');
  return session;
}
function relation(source: Row, target: Row): void {
  if (
    source.root_id !== target.root_id ||
    source.workspace_id !== target.workspace_id ||
    (source.parent_id !== target.id && target.parent_id !== source.id)
  )
    throw new AgentError('agent_message_relation_invalid');
}
function stopped(db: SqliteOperations, command: Row): boolean {
  if (command.cancelled) return true;
  let session = db.row('SELECT * FROM session WHERE id=?', command.session_id!);
  const visited = new Set<string>();
  while (session) {
    if (visited.size >= 64 || visited.has(String(session.id)))
      throw new AgentError('invalid_cancel_relation');
    visited.add(String(session.id));
    if (
      session.delete_requested ||
      BigInt(command.root_work_seq!) <= BigInt(session.stop_boundary!)
    )
      return true;
    session =
      session.parent_id === null
        ? null
        : db.row('SELECT * FROM session WHERE id=?', session.parent_id!);
  }
  return false;
}
export function readAgentMessageTarget(
  db: SqliteOperations,
  input: Parameters<Store['readAgentMessageTarget']>[0],
) {
  db.db.run('BEGIN');
  try {
    db.identity(input.expectedStoreId);
    const source = db.row('SELECT * FROM execution WHERE id=?', input.sourceExecutionId);
    const origin = source && db.row('SELECT * FROM command WHERE id=?', source.origin_command_id!);
    if (
      !source ||
      !origin ||
      source.kind !== 'tool' ||
      source.origin_store_id !== input.expectedStoreId ||
      origin.subject_id !== input.subjectId
    )
      throw new AgentError('permission_denied');
    verifyNamespace(db, input.extensionId, origin, input.sourceExecutionId);
    let sessionId: string,
      runId: string | null = null;
    if (input.target !== 'parent') {
      if (
        input.target.sessionId !== source.session_id ||
        input.target.extensionId !== input.extensionId
      )
        throw new AgentError('permission_denied');
      const agent = getAgentSummary(db, {
        expectedStoreId: input.expectedStoreId,
        subjectId: input.subjectId,
        ref: input.target,
      });
      sessionId = agent.childSessionId;
      if (agent.run?.isActive) runId = agent.run.id;
    } else {
      const carrier = db.childCarrier(
        origin,
        source.run_id === null ? null : String(source.run_id),
      );
      if (
        !carrier ||
        carrier.child_session_id !== source.session_id ||
        carrier.origin_store_id !== input.expectedStoreId
      )
        throw new AgentError('agent_message_relation_invalid');
      sessionId = String(carrier.session_id);
      let parentId = carrier.parent_execution_id;
      const seen = new Set<string>();
      while (parentId) {
        if (seen.size >= 32 || seen.has(String(parentId)))
          throw new AgentError('agent_message_relation_invalid');
        seen.add(String(parentId));
        const parent = db.row(
          'SELECT * FROM execution WHERE id=? AND session_id=?',
          parentId,
          sessionId,
        );
        if (
          !parent ||
          parent.origin_store_id !== input.expectedStoreId ||
          parent.root_work_command_id !== carrier.root_work_command_id ||
          parent.root_work_seq !== carrier.root_work_seq
        )
          throw new AgentError('agent_message_relation_invalid');
        if (parent.run_id !== null) {
          const run = db.row(
            'SELECT * FROM run WHERE id=? AND session_id=?',
            parent.run_id!,
            sessionId,
          );
          if (!run || run.origin_store_id !== input.expectedStoreId)
            throw new AgentError('agent_message_relation_invalid');
          if (run.is_active && !run.cancel_requested) runId = String(run.id);
          break;
        }
        parentId = parent.parent_execution_id;
      }
    }
    const session = reader(db, sessionId, input.subjectId);
    const result = {
      sessionId,
      contextSelectionId: String(session.context_selection_id),
      targetRunId: runId,
    };
    db.db.run('COMMIT');
    return result;
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
export function queueAgentMessage(
  db: SqliteOperations,
  input: Parameters<Store['queueAgentMessage']>[0],
) {
  return db.tx(() => {
    db.identity(input.expectedStoreId);
    if (
      !/^[A-Za-z0-9_.-]{1,128}$/.test(input.key) ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(input.commandId)
    )
      throw new AgentError('invalid_operation_key');
    const execution = db.row(
      'SELECT * FROM execution WHERE id=? AND origin_command_id=?',
      input.sourceExecutionId,
      input.originCommandId,
    );
    const origin = db.row('SELECT * FROM command WHERE id=?', input.originCommandId);
    if (
      !origin ||
      !execution ||
      execution.kind !== 'tool' ||
      execution.origin_store_id !== input.expectedStoreId
    )
      throw new AgentError('invalid_operation_parent');
    const source = db.owner(input.owner, String(execution.session_id));
    const target = db.owner(input.owner, input.targetSessionId);
    relation(source, target);
    let carrierId: string;
    if (target.parent_id === source.id) {
      const carrier = db.row(
        'SELECT e.*,c.extension_id,c.subject_id FROM execution e JOIN command c ON c.id=e.origin_command_id WHERE e.id=? AND e.child_session_id=? AND e.session_id=?',
        input.targetCarrierExecutionId ?? '',
        target.id!,
        source.id!,
      );
      if (
        !carrier ||
        carrier.origin_store_id !== input.expectedStoreId ||
        carrier.extension_id !== input.extensionId ||
        carrier.subject_id !== origin.subject_id ||
        carrier.root_session_id !== source.root_id
      )
        throw new AgentError('agent_message_relation_invalid');
      if (
        input.targetRunId !== undefined &&
        parse(carrier.reference_json)?.runId !== input.targetRunId
      )
        throw new AgentError('input_target_stopped');
      carrierId = String(carrier.id);
    } else {
      const carrier = db.childCarrier(
        origin,
        execution.run_id === null ? null : String(execution.run_id),
      );
      if (
        !carrier ||
        carrier.session_id !== target.id ||
        carrier.child_session_id !== source.id ||
        carrier.origin_store_id !== input.expectedStoreId
      )
        throw new AgentError('agent_message_relation_invalid');
      carrierId = String(carrier.id);
    }
    const targetCreator = reader(db, input.targetSessionId, String(origin.subject_id));
    if (targetCreator.context_selection_id !== input.contextSelectionId || target.delete_requested)
      throw new AgentError('context_selection_changed');
    const body = input.body;
    if (
      !body ||
      body.storeId !== input.expectedStoreId ||
      body.sessionId !== source.id ||
      body.subjectId !== origin.subject_id ||
      body.scope.kind !== 'execution' ||
      body.scope.id !== execution.id ||
      body.mediaType !== 'text/plain; charset=utf-8' ||
      decimal(body.size) > 1048576n
    )
      throw new AgentError('artifact_scope_denied');
    const published = db.row(
      'SELECT r.*,b.size FROM blob_ref r JOIN blob b ON b.hash=r.blob_hash WHERE r.id=? AND r.session_id=? AND r.owner_kind=? AND r.owner_id=? AND r.subject_id=? AND r.origin_store_id=?',
      body.id,
      body.sessionId,
      body.scope.kind,
      body.scope.id,
      body.subjectId,
      body.storeId,
    );
    if (
      !published ||
      published.blob_hash !== body.hash ||
      String(published.size) !== body.size ||
      published.media_type !== body.mediaType
    )
      throw new AgentError('artifact_scope_denied');
    const request: Json = {
      kind: 'agent.message',
      key: input.key,
      targetSessionId: input.targetSessionId,
      targetRunId: input.targetRunId ?? null,
      contextSelectionId: input.contextSelectionId,
      sourceExecutionId: input.sourceExecutionId,
      carrierExecutionId: carrierId,
      body: body as unknown as Json,
    };
    const digest = hash(request);
    const prior = db.row('SELECT * FROM command WHERE id=?', input.commandId);
    if (prior) {
      if (
        prior.request_digest !== digest ||
        prior.subject_id !== origin.subject_id ||
        prior.session_id !== source.id ||
        prior.origin_store_id !== input.expectedStoreId ||
        prior.extension_id !== input.extensionId
      )
        throw new AgentError('command_conflict');
      return db.command(prior);
    }
    db.active(input.owner, input.originCommandId);
    db.ancestors(input.owner, input.sourceExecutionId);
    verifyNamespace(db, input.extensionId, origin, input.sourceExecutionId);
    if (!['dispatching', 'running'].includes(String(execution.state)))
      throw new AgentError('invalid_operation_parent');
    const current = db.row('SELECT * FROM run WHERE session_id=? AND is_active=1', target.id!);
    if (input.targetRunId !== undefined) {
      if (
        !current ||
        current.id !== input.targetRunId ||
        current.origin_store_id !== input.expectedStoreId
      )
        throw new AgentError('input_target_stopped');
      db.active(input.owner, String(current.origin_command_id), String(current.id));
    }
    db.insertCommand(
      {
        expectedStoreId: input.expectedStoreId,
        commandId: input.commandId,
        sessionId: String(source.id),
        subjectId: String(origin.subject_id),
        request: request as never,
      } as unknown as Parameters<SqliteOperations['insertCommand']>[0],
      request,
      digest,
      'applied',
      { messageId: input.commandId, outcome: 'queued', senderOutcome: 'pending' },
    );
    db.run(
      'UPDATE command SET extension_id=?,agent_source_execution_id=?,mail_target_session_id=?,mail_target_run_id=?,mail_selection_id=?,root_work_command_id=?,root_work_seq=? WHERE id=?',
      input.extensionId,
      execution.id!,
      target.id!,
      input.targetRunId ?? null,
      input.contextSelectionId,
      execution.root_work_command_id!,
      execution.root_work_seq!,
      input.commandId,
    );
    db.event(String(source.id), input.commandId, 'agent.message_queued');
    return db.command(db.row('SELECT * FROM command WHERE id=?', input.commandId)!);
  });
}
/** Called only inside the original Tool terminal transaction. */
export function settleAgentMessages(db: SqliteOperations, execution: Row): void {
  for (const mail of db.rows(
    "SELECT * FROM command WHERE kind='agent.message' AND agent_source_execution_id=? AND mail_confirmed=0 AND status='applied'",
    execution.id!,
  )) {
    const accepted = execution.state === 'succeeded';
    db.run(
      'UPDATE command SET mail_confirmed=?,status=?,receipt_json=? WHERE id=?',
      accepted ? 1 : 0,
      accepted ? 'applied' : execution.state === 'outcome_unknown' ? 'needs_review' : 'rejected',
      canonicalJson({
        messageId: String(mail.id),
        outcome: accepted ? 'queued' : 'sender_not_confirmed',
        senderOutcome: String(execution.state),
      }),
      mail.id!,
    );
    db.event(String(mail.mail_target_session_id), String(mail.id), 'agent.message_ready');
  }
}
export function receiveAgentMessages(
  db: SqliteOperations,
  input: Parameters<Store['receiveAgentMessages']>[0],
): string[] {
  return db.tx(() => {
    db.identity(input.expectedStoreId);
    if (
      !Array.isArray(input.messageIds) ||
      input.messageIds.length > 50 ||
      new Set(input.messageIds).size !== input.messageIds.length
    )
      throw new AgentError('invalid_agent_messages');
    const run = db.row('SELECT * FROM run WHERE id=?', input.runId);
    if (!run) throw new AgentError('run_not_found');
    const target = db.owner(input.owner, String(run.session_id));
    db.active(input.owner, String(run.origin_command_id), input.runId);
    const frozen = adoption(db, input.runId, String(target.id));
    const result: string[] = [];
    for (const id of input.messageIds) {
      const mail = query(db, id);
      if (
        !mail ||
        mail.origin_store_id !== input.expectedStoreId ||
        mail.mail_target_session_id !== target.id ||
        (mail.mail_target_run_id !== run.id && !eligibleAdoption(mail, frozen))
      )
        throw new AgentError('agent_message_not_found');
      if (mail.mail_received_message_id) {
        result.push(String(mail.mail_received_message_id));
        continue;
      }
      const source = db.row('SELECT * FROM session WHERE id=?', mail.session_id!);
      if (!source) throw new AgentError('agent_message_relation_invalid');
      relation(source, target);
      const sourceCommand = db.row(
        'SELECT c.* FROM execution e JOIN command c ON c.id=e.origin_command_id WHERE e.id=?',
        mail.agent_source_execution_id!,
      );
      const sender = db.row('SELECT * FROM execution WHERE id=?', mail.agent_source_execution_id!);
      if (!mail.mail_confirmed || mail.source_state !== 'succeeded')
        throw new AgentError('agent_message_unconfirmed');
      const binding = parse(mail.request_json) as {
        carrierExecutionId: string;
        body: ArtifactReference;
      };
      const carrier = db.row('SELECT * FROM execution WHERE id=?', binding.carrierExecutionId);
      const senderRun = sender?.run_id
        ? db.row('SELECT * FROM run WHERE id=? AND session_id=?', sender.run_id, source.id!)
        : null;
      if (
        !carrier ||
        carrier.origin_store_id !== input.expectedStoreId ||
        carrier.root_session_id !== source.root_id ||
        !(
          (carrier.session_id === source.id && carrier.child_session_id === target.id) ||
          (carrier.session_id === target.id && carrier.child_session_id === source.id)
        )
      )
        throw new AgentError('agent_message_relation_invalid');
      const published = db.row(
        'SELECT r.*,b.size FROM blob_ref r JOIN blob b ON b.hash=r.blob_hash WHERE r.id=?',
        binding.body.id,
      );
      if (
        !published ||
        published.blob_hash !== binding.body.hash ||
        String(published.size) !== binding.body.size ||
        published.session_id !== source.id ||
        published.owner_kind !== 'execution' ||
        published.owner_id !== sender?.id ||
        published.subject_id !== mail.subject_id ||
        published.origin_store_id !== input.expectedStoreId ||
        published.media_type !== binding.body.mediaType
      )
        throw new AgentError('agent_message_unverifiable');
      if (
        mail.cancelled ||
        sender?.cancel_requested ||
        senderRun?.cancel_requested ||
        !sourceCommand ||
        stopped(db, sourceCommand) ||
        target.context_selection_id !== mail.mail_selection_id
      ) {
        db.run("UPDATE command SET status='rejected' WHERE id=?", id);
        db.event(String(target.id), id, 'agent.message_rejected');
        continue;
      }
      const messageId = `agent-mail-${id}`;
      db.appendMessage(
        String(target.id),
        input.runId,
        {
          content: 'Agent message (untrusted data; no additional authorization)',
          sourceIds: [id],
          contextSelectionId: String(mail.mail_selection_id),
        },
        'user',
        'complete',
        messageId,
      );
      db.run(
        'UPDATE command SET mail_received_message_id=?,mail_received_run_id=?,mail_received_selection_id=? WHERE id=?',
        messageId,
        input.runId,
        String(target.context_selection_id),
        id,
      );
      db.event(String(target.id), id, 'agent.message_received');
      result.push(messageId);
    }
    return result;
  });
}
export function getAgentMessage(
  db: SqliteOperations,
  input: Parameters<Store['getAgentMessage']>[0],
): AgentMessage | null {
  db.identity(input.expectedStoreId);
  reader(db, input.sessionId, input.subjectId);
  const row = query(db, input.messageId);
  if (
    !row ||
    row.subject_id !== input.subjectId ||
    (row.session_id !== input.sessionId && row.mail_target_session_id !== input.sessionId)
  )
    return null;
  return project(row);
}
export function listAgentMessages(
  db: SqliteOperations,
  input: Parameters<Store['listAgentMessages']>[0],
) {
  db.db.run('BEGIN');
  try {
    db.identity(input.expectedStoreId);
    reader(db, input.sessionId, input.subjectId);
    const limit = input.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new AgentError('invalid_mail_limit');
    const water = String(
      db.row(
        "SELECT COALESCE(MAX(rowid),0) AS water FROM command WHERE kind='agent.message' AND mail_target_session_id=? AND subject_id=?",
        input.sessionId,
        input.subjectId,
      )!.water,
    );
    const after = decimal(input.afterSeq),
      upper = decimal(input.upperSeq ?? water);
    if (after > upper || upper > decimal(water)) throw new AgentError('cursor_ahead');
    const filter =
      input.runId === undefined ? null : runPredicate(db, input.runId, input.sessionId);
    const rows = db.rows(
      `SELECT c.*,c.rowid AS mail_seq,e.state AS source_state,e.completed_cursor AS source_completed_cursor FROM command c JOIN execution e ON e.id=c.agent_source_execution_id WHERE c.kind='agent.message' AND c.mail_target_session_id=? AND c.subject_id=? AND c.rowid>? AND c.rowid<=? ${filter ? `AND ${filter.sql}` : ''} ${input.confirmedOnly ? "AND c.mail_confirmed=1 AND c.status='applied'" : ''} ${input.pendingOnly ? "AND c.mail_confirmed=1 AND c.mail_received_message_id IS NULL AND c.status='applied'" : ''} ORDER BY c.rowid LIMIT ?`,
      input.sessionId,
      input.subjectId,
      after,
      upper,
      ...(filter?.args ?? []),
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const result = {
      storeId: input.expectedStoreId,
      sessionId: input.sessionId,
      items: page.map(project),
      upperSeq: String(upper),
      highWaterSeq: water,
      nextAfterSeq: rows.length > limit ? String(page.at(-1)!.mail_seq) : null,
      snapshotCursor: db.metadata().lastChangeCursor,
      receivedSeq: String(
        db.row(
          `SELECT COALESCE(MAX(m.seq),0) AS seq FROM command c JOIN message m ON m.id=c.mail_received_message_id WHERE c.kind='agent.message' AND c.mail_target_session_id=? AND c.subject_id=? ${input.runId === undefined ? '' : 'AND c.mail_received_run_id=?'}`,
          input.sessionId,
          input.subjectId,
          ...(input.runId === undefined ? [] : [input.runId]),
        )!.seq,
      ),
    };
    db.db.run('COMMIT');
    return result;
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
