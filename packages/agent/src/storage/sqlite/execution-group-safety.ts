import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { Store } from '../port';
import {
  AgentError,
  type ExecutionGroupGuard,
  type ExecutionGroupSafety,
  type Json,
} from '../types';
import {
  authorizationReviewContextSession,
  authorizationReviewSourceTarget,
} from './authorization-review';
import { verifiedJobProofPredicate } from './job-reconcile-operations';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
const hash = (value: unknown) =>
  createHash('sha256')
    .update(canonicalJson(value as Json))
    .digest('hex');
const finite = (rows: Row[]) => {
  if (rows.length > 8192) throw new AgentError('execution_group_safety_unavailable');
  return rows;
};
export function actualRoot(db: SqliteOperations, sessionId: string) {
  const session = db.row('SELECT * FROM session WHERE id=?', sessionId);
  const root = session && db.row('SELECT * FROM session WHERE id=?', session.root_id!);
  if (
    !session ||
    !root ||
    root.parent_id !== null ||
    root.root_id !== root.id ||
    root.workspace_id !== session.workspace_id
  )
    throw new AgentError('execution_group_scope_denied');
  let node = session;
  const seen = new Set<string>();
  while (node.id !== root.id) {
    if (!node.parent_id || seen.has(String(node.id)) || seen.size >= 32)
      throw new AgentError('execution_group_scope_denied');
    seen.add(String(node.id));
    const parent = db.row('SELECT * FROM session WHERE id=?', node.parent_id);
    if (!parent || parent.root_id !== root.id || parent.workspace_id !== root.workspace_id)
      throw new AgentError('execution_group_scope_denied');
    node = parent;
  }
  return { session, root };
}
/** Inherited provenance never gives an operation the original Action's collector or guard. */
export function inheritsActionSource(
  db: SqliteOperations,
  execution: Row,
  source: Record<string, unknown>,
): boolean {
  if (
    source.kind !== 'action_decision' ||
    typeof source.commandId !== 'string' ||
    source.commandId === execution.origin_command_id ||
    !execution.parent_execution_id ||
    execution.run_id !== null
  )
    return false;
  const { root } = actualRoot(db, String(execution.session_id));
  if (execution.root_session_id !== root.id) return false;
  // A sealed reviewer is the one purpose allowed to observe an undispatched parent.
  const reviewTarget = authorizationReviewSourceTarget(db, execution);
  let node = execution;
  let subject: Row[string] | undefined;
  const seen = new Set<string>();
  for (let depth = 0; depth < 64; depth++) {
    if (
      seen.has(String(node.id)) ||
      node.run_id !== null ||
      !['tool', 'job'].includes(String(node.kind)) ||
      node.decision_source_json !== execution.decision_source_json ||
      node.session_id !== execution.session_id ||
      node.origin_store_id !== execution.origin_store_id ||
      node.root_session_id !== execution.root_session_id ||
      node.root_work_command_id !== execution.root_work_command_id ||
      node.root_work_seq !== execution.root_work_seq ||
      (depth > 0 &&
        !(depth === 1 && node.id === reviewTarget?.id) &&
        (!node.dispatched || node.dispatch_authorization_json === null))
    )
      return false;
    seen.add(String(node.id));
    const command = db.row('SELECT * FROM command WHERE id=?', node.origin_command_id!);
    if (
      !command ||
      command.session_id !== node.session_id ||
      command.origin_store_id !== node.origin_store_id ||
      command.root_work_command_id !== node.root_work_command_id ||
      command.root_work_seq !== node.root_work_seq ||
      (subject !== undefined && command.subject_id !== subject)
    )
      return false;
    subject = command.subject_id;
    const request = JSON.parse(String(command.request_json));
    if (!request || typeof request !== 'object' || Array.isArray(request)) return false;
    if (node.origin_command_id === source.commandId)
      return (
        depth > 0 &&
        node.kind === 'job' &&
        command.kind === 'extension.invoke' &&
        request.kind === command.kind &&
        request.extensionId === source.extensionId &&
        request.actionId === source.actionId &&
        request.definitionVersion === source.definitionVersion &&
        node.definition_version === source.definitionVersion &&
        node.adapter_id === `${source.extensionId}/${source.actionId}` &&
        source.preparedDigest === hash(JSON.parse(String(node.intent_json)))
      );
    if (
      !node.parent_execution_id ||
      (!(depth === 0 && reviewTarget) &&
        (![`operation.${node.kind}`, ...(node.kind === 'job' ? ['operation.agent'] : [])].includes(
          String(command.kind),
        ) ||
          request.kind !== command.kind ||
          request.parentExecutionId !== node.parent_execution_id ||
          request.definitionId !== node.adapter_id ||
          request.definitionVersion !== node.definition_version ||
          canonicalJson(request.input as Json) !== node.intent_json ||
          (request.cancellation === 'detached') !== !node.cancel_with_parent))
    )
      return false;
    const parent = db.row('SELECT * FROM execution WHERE id=?', node.parent_execution_id);
    if (!parent) return false;
    node = parent;
  }
  return false;
}
/** Only a Host-created ordinary Action source can declare a persistent group fence. */
export function executionGuard(db: SqliteOperations, execution: Row): ExecutionGroupGuard | null {
  const value = JSON.parse(String(execution.decision_source_json));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.guard === undefined) return null;
  // A child operation keeps the parent's provenance, not its Action authority.
  if (inheritsActionSource(db, execution, source)) return null;
  const guard = source.guard as ExecutionGroupGuard;
  const command = db.row('SELECT * FROM command WHERE id=?', execution.origin_command_id!);
  const { root } = actualRoot(db, String(execution.session_id));
  const request = command && (JSON.parse(String(command.request_json)) as Record<string, unknown>);
  if (
    !guard ||
    Object.keys(guard).some(
      (key) => !['kind', 'version', 'rootSessionId', 'originCommandId'].includes(key),
    ) ||
    guard.kind !== 'execution_group_quiescence' ||
    guard.version !== 1 ||
    guard.rootSessionId !== root.id ||
    guard.originCommandId !== execution.origin_command_id ||
    execution.kind !== 'job' ||
    execution.run_id !== null ||
    !command ||
    command.kind !== 'extension.invoke' ||
    request?.extensionId !== source.extensionId ||
    request?.actionId !== source.actionId ||
    source.kind !== 'action_decision' ||
    source.commandId !== command.id ||
    source.definitionVersion !== execution.definition_version ||
    execution.adapter_id !== `${source.extensionId}/${source.actionId}` ||
    execution.origin_store_id !== command.origin_store_id
  )
    throw new AgentError('execution_group_guard_invalid');
  return guard;
}
/** A committed guarded carrier remains a fence through crash/unknown, not just while hot. */
export function assertNoExecutionGroupFence(
  db: SqliteOperations,
  sessionId: string,
  excludeExecutionId?: string,
) {
  const { root } = actualRoot(db, sessionId);
  const rows = finite(
    db.rows(
      `SELECT e.* FROM execution e JOIN session s ON s.id=e.session_id
    WHERE s.root_id=? AND e.state IN ('dispatching','running','outcome_unknown') AND json_type(e.decision_source_json,'$.guard') IS NOT NULL ORDER BY e.id LIMIT 8193`,
      root.id!,
    ),
  );
  for (const row of rows) {
    const guard = executionGuard(db, row);
    if (guard && row.id !== excludeExecutionId) throw new AgentError('execution_group_fenced');
  }
}
export function readExecutionGroupSafety(
  db: SqliteOperations,
  input: Parameters<Store['readExecutionGroupSafety']>[0],
): ExecutionGroupSafety {
  db.identity(input.expectedStoreId);
  const { session, root } = actualRoot(db, input.sessionId);
  const creator = db.row(
    "SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'",
    root.id!,
  );
  if (creator?.subject_id !== input.subjectId) throw new AgentError('execution_group_scope_denied');
  if (input.boundaryCommandId) {
    const command = db.row('SELECT * FROM command WHERE id=?', input.boundaryCommandId);
    if (
      !command ||
      command.session_id !== input.sessionId ||
      command.subject_id !== input.subjectId ||
      command.origin_store_id !== input.expectedStoreId
    )
      throw new AgentError('execution_group_scope_denied');
  }
  if (input.excludeExecutionId) {
    const execution = db.row('SELECT * FROM execution WHERE id=?', input.excludeExecutionId);
    if (
      !execution ||
      execution.session_id !== input.sessionId ||
      execution.origin_command_id !== input.boundaryCommandId ||
      execution.origin_store_id !== input.expectedStoreId ||
      !['planned', 'dispatching', 'running'].includes(String(execution.state)) ||
      !executionGuard(db, execution)
    )
      throw new AgentError('execution_group_boundary_invalid');
  }
  const sessions = finite(
    db.rows(
      `WITH RECURSIVE descendants(id) AS (SELECT id FROM session WHERE id=? UNION SELECT s.id FROM session s JOIN descendants d ON s.parent_id=d.id)
      SELECT s.id,s.parent_id,s.root_id,s.workspace_id,s.delete_requested,s.context_selection_id,c.request_json AS selection_json
      FROM session s LEFT JOIN context_snapshot c ON c.id=s.context_selection_id AND c.session_id=s.id AND c.kind='selection'
      WHERE s.root_id=? OR s.id IN (SELECT id FROM descendants) ORDER BY s.id LIMIT 8193`,
      root.id!,
      root.id!,
    ),
  );
  const byId = new Map(sessions.map((row) => [String(row.id), row]));
  for (const row of sessions) {
    if (row.workspace_id !== session.workspace_id || row.root_id !== root.id)
      throw new AgentError('execution_group_scope_denied');
    let node = row;
    const seen = new Set<string>();
    while (node.id !== root.id) {
      if (seen.size >= 32 || seen.has(String(node.id)) || !node.parent_id)
        throw new AgentError('execution_group_scope_denied');
      seen.add(String(node.id));
      const parent = byId.get(String(node.parent_id));
      if (!parent) throw new AgentError('execution_group_scope_denied');
      node = parent;
    }
  }
  // Complete messages and their parts are the neutral lineage facts. Session.next_seq also
  // allocates Action/answer Commands, so it cannot represent a Message boundary dependency.
  const messages = finite(
    db.rows(
      `SELECT m.id,m.session_id,m.seq,m.role,m.status FROM message m JOIN session s ON s.id=m.session_id
      WHERE s.root_id=? AND m.status='complete' ORDER BY m.id LIMIT 8193`,
      root.id!,
    ),
  );
  const messageParts = finite(
    db.rows(
      `SELECT p.message_id,p.ordinal,p.revision,p.kind,p.content_version FROM message_part p
      JOIN message m ON m.id=p.message_id JOIN session s ON s.id=m.session_id
      WHERE s.root_id=? AND m.status='complete' ORDER BY p.message_id,p.ordinal LIMIT 8193`,
      root.id!,
    ),
  );
  // Only this Action's sealed, tools-free reviewer has no business context to consume.
  // Its work still participates in all group safety and final reviewer proof checks.
  const reviewContextSessions = new Set<string>();
  if (input.boundaryCommandId) {
    const reviews = finite(
      db.rows(
        `SELECT e.* FROM execution e JOIN command c ON c.id=e.origin_command_id
        JOIN execution target ON target.id=e.parent_execution_id
        WHERE c.kind='authorization.review' AND e.session_id=? AND e.origin_store_id=?
        AND target.origin_command_id=? ORDER BY e.id LIMIT 8193`,
        input.sessionId,
        input.expectedStoreId,
        input.boundaryCommandId,
      ),
    );
    for (const review of reviews) {
      const target = authorizationReviewSourceTarget(db, review);
      if (
        target &&
        target.origin_command_id === input.boundaryCommandId &&
        target.session_id === input.sessionId &&
        target.run_id === null &&
        target.kind === 'job' &&
        executionGuard(db, target)?.rootSessionId === root.id
      ) {
        const child = authorizationReviewContextSession(db, review);
        if (child) reviewContextSessions.add(child);
      }
    }
  }
  const contextMessages = messages.filter(
    (message) => !reviewContextSessions.has(String(message.session_id)),
  );
  const contextMessageIds = new Set(contextMessages.map((message) => String(message.id)));
  const contextRevision = hash(
    JSON.parse(
      JSON.stringify(
        {
          sessions: sessions.filter((session) => !reviewContextSessions.has(String(session.id))),
          messages: contextMessages,
          messageParts: messageParts.filter((part) =>
            contextMessageIds.has(String(part.message_id)),
          ),
        },
        (_, value) => (typeof value === 'bigint' ? String(value) : value),
      ),
    ),
  );
  const runs = finite(
    db.rows(
      `SELECT r.id,r.session_id,r.origin_store_id,r.origin_command_id,r.status,r.is_active
    FROM run r JOIN session s ON s.id=r.session_id WHERE s.root_id=? AND r.is_active=1 ORDER BY r.id LIMIT 8193`,
      root.id!,
    ),
  );
  const commands = finite(
    db.rows(
      `SELECT c.id,c.session_id,c.origin_store_id,c.subject_id,c.status,c.cancelled FROM command c JOIN session s ON s.id=c.session_id
    WHERE s.root_id=? AND c.status IN ('accepted','needs_review') AND c.id<>? ORDER BY c.id LIMIT 8193`,
      root.id!,
      input.boundaryCommandId ?? '',
    ),
  );
  const executions = finite(
    db.rows(
      `SELECT e.id,e.session_id,e.run_id,e.kind,e.state,e.origin_store_id,e.origin_command_id,e.root_session_id,e.parent_execution_id,e.child_session_id,e.result_revision,
    CASE WHEN ${verifiedJobProofPredicate('e')} THEN 0 ELSE 1 END AS reconciled
    FROM execution e JOIN session s ON s.id=e.session_id WHERE s.root_id=? AND e.state IN ('planned','dispatching','running','outcome_unknown') AND e.id<>?
    ORDER BY e.id LIMIT 8193`,
      root.id!,
      input.excludeExecutionId ?? '',
    ),
  );
  for (const row of [...runs, ...commands, ...executions])
    if (row.origin_store_id !== input.expectedStoreId)
      throw new AgentError('execution_group_scope_denied');
  for (const row of executions)
    if (
      row.root_session_id !== root.id ||
      (row.parent_execution_id &&
        !db.row(
          'SELECT e.id FROM execution e JOIN session s ON s.id=e.session_id WHERE e.id=? AND s.root_id=?',
          row.parent_execution_id,
          root.id!,
        ))
    )
      throw new AgentError('execution_group_scope_denied');
  const unconfirmed = executions.filter((row) => row.reconciled !== 1n && row.reconciled !== 1);
  const facts = JSON.parse(
    JSON.stringify(
      {
        storeId: input.expectedStoreId,
        sessionId: input.sessionId,
        rootSessionId: root.id,
        boundaryCommandId: input.boundaryCommandId ?? null,
        excludedExecutionId: input.excludeExecutionId ?? null,
        sessions,
        contextRevision,
        runs,
        commands,
        executions,
      },
      (_, value) => (typeof value === 'bigint' ? String(value) : value),
    ),
  );
  return {
    originStoreId: input.expectedStoreId,
    sessionId: input.sessionId,
    rootSessionId: String(root.id),
    revision: hash(facts),
    contextRevision,
    excludedExecutionId: input.excludeExecutionId ?? null,
    quiescent: runs.length === 0 && commands.length === 0 && unconfirmed.length === 0,
    activeRunIds: runs.map((row) => String(row.id)),
    pendingCommandIds: commands.map((row) => String(row.id)),
    unconfirmedExecutionIds: unconfirmed.map((row) => String(row.id)),
  };
}
export function readExecutionGroupSafetySnapshot(
  db: SqliteOperations,
  input: Parameters<Store['readExecutionGroupSafety']>[0],
) {
  db.db.run('BEGIN');
  try {
    const value = readExecutionGroupSafety(db, input);
    db.db.run('COMMIT');
    return value;
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
