import type { Store } from '../port';
import { AgentError, type AgentSummary, type AgentSummaryPage } from '../types';
import type { SqliteOperations } from './operations';

const decimal = (value: string) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new AgentError('invalid_cursor');
  return BigInt(value);
};
const columns = `SELECT c.id AS command_id,c.session_id,c.operation_key,c.extension_id,c.origin_store_id,c.seq,c.subject_id,c.root_work_command_id AS command_root_work,c.root_work_seq AS command_root_seq,
 (SELECT i.id FROM interaction i JOIN execution ie ON ie.id=i.execution_id JOIN command ic ON ic.id=ie.origin_command_id
 WHERE i.origin_store_id=c.origin_store_id AND ie.root_work_command_id=e.root_work_command_id AND ie.root_work_seq=e.root_work_seq
 AND i.state='pending' AND ie.state IN ('planned','dispatching','running') AND ie.cancel_requested=0 AND ic.cancelled=0
 AND (i.execution_id=e.id OR EXISTS(SELECT 1 FROM json_each(i.ancestry_json) a WHERE a.value=e.child_session_id)) ORDER BY i.rowid LIMIT 1) AS waiting_interaction_id,
 e.id AS execution_id,e.origin_store_id AS execution_store,e.state,e.attempt,e.parent_execution_id,e.root_work_command_id,e.root_work_seq,e.child_session_id,e.root_session_id,
 child.context_selection_id,child.parent_id,r.id AS run_id,r.status AS run_status,r.is_active,r.deadline_at,
 r.origin_store_id AS run_store,r.root_work_command_id AS run_root_work,r.root_work_seq AS run_root_seq
 FROM command c JOIN execution e ON e.origin_command_id=c.id JOIN session child ON child.id=e.child_session_id
 LEFT JOIN run r ON r.id=json_extract(e.reference_json,'$.runId') AND r.origin_command_id=('child-start-'||e.id) AND r.session_id=child.id
 WHERE c.kind='operation.agent' AND e.kind='job' AND c.session_id=? AND c.extension_id=? AND c.subject_id=?`;
function project(
  row: Record<string, string | number | bigint | null>,
  storeId: string,
): AgentSummary {
  if (
    row.origin_store_id !== storeId ||
    row.execution_store !== storeId ||
    row.command_root_work !== row.root_work_command_id ||
    String(row.command_root_seq) !== String(row.root_work_seq) ||
    row.parent_id !== row.session_id ||
    (row.run_id !== null &&
      (row.run_store !== storeId ||
        row.run_root_work !== row.root_work_command_id ||
        String(row.run_root_seq) !== String(row.root_work_seq)))
  )
    throw new AgentError('operation_unverifiable');
  return {
    ref: {
      commandId: String(row.command_id),
      sessionId: String(row.session_id),
      extensionId: String(row.extension_id),
      originStoreId: storeId,
      key: String(row.operation_key),
      executionId: String(row.execution_id),
      childSessionId: String(row.child_session_id),
    },
    seq: String(row.seq),
    executionId: String(row.execution_id),
    waitingInteractionId:
      row.waiting_interaction_id === null ? null : String(row.waiting_interaction_id),
    status: String(row.state) as AgentSummary['status'],
    attempt: Number(row.attempt),
    originCommandId: String(row.command_id),
    parentExecutionId: row.parent_execution_id === null ? null : String(row.parent_execution_id),
    rootSessionId: String(row.root_session_id),
    rootWorkCommandId: String(row.root_work_command_id),
    rootWorkSeq: String(row.root_work_seq),
    childSessionId: String(row.child_session_id),
    contextSelectionId: String(row.context_selection_id),
    run:
      row.run_id === null
        ? null
        : {
            id: String(row.run_id),
            status: String(row.run_status) as NonNullable<AgentSummary['run']>['status'],
            isActive: !!row.is_active,
            deadlineAt: row.deadline_at === null ? null : Number(row.deadline_at),
          },
  };
}
export function getAgentSummary(
  db: SqliteOperations,
  input: Parameters<Store['getAgentSummary']>[0],
): AgentSummary {
  db.identity(input.expectedStoreId);
  const ref = input.ref;
  if (ref.originStoreId !== input.expectedStoreId) throw new AgentError('store_identity_mismatch');
  const row = db.row(
    `${columns} AND c.id=? AND c.operation_key=?`,
    ref.sessionId,
    ref.extensionId,
    input.subjectId,
    ref.commandId,
    ref.key,
  );
  if (
    !row ||
    row.execution_id !== ref.executionId ||
    (ref.childSessionId !== undefined && row.child_session_id !== ref.childSessionId)
  )
    throw new AgentError('operation_not_found');
  return project(row, input.expectedStoreId);
}
export function listAgentSummaries(
  db: SqliteOperations,
  input: Parameters<Store['listAgentSummaries']>[0],
): AgentSummaryPage {
  db.db.run('BEGIN');
  try {
    db.identity(input.expectedStoreId);
    const session = db.row('SELECT root_id FROM session WHERE id=?', input.sessionId);
    if (!session) throw new AgentError('session_not_found');
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new AgentError('invalid_page_limit');
    const after = decimal(input.afterSeq ?? '0');
    const water = BigInt(
      db.row(
        "SELECT COALESCE(MAX(seq),0) AS water FROM command WHERE kind='operation.agent' AND session_id=? AND extension_id=? AND subject_id=?",
        input.sessionId,
        input.extensionId,
        input.subjectId,
      )!.water!,
    );
    const upper = decimal(input.upperSeq ?? String(water));
    if (after > upper || upper > water) throw new AgentError('cursor_ahead');
    const rows = db.rows(
      `${columns} AND c.seq>? AND c.seq<=? ORDER BY c.seq LIMIT ?`,
      input.sessionId,
      input.extensionId,
      input.subjectId,
      after,
      upper,
      limit,
    );
    const items = rows.map((row) => project(row, input.expectedStoreId));
    const snapshotCursor = db.metadata().lastChangeCursor;
    db.db.run('COMMIT');
    return {
      storeId: input.expectedStoreId,
      sessionId: input.sessionId,
      rootSessionId: String(session.root_id),
      extensionId: input.extensionId,
      items,
      upperSeq: String(upper),
      highWaterSeq: String(water),
      nextAfterSeq: items.length === limit ? items.at(-1)!.seq : null,
      snapshotCursor,
    };
  } catch (error) {
    return db.rollback(error);
  }
}

/** Stable collaborators are ordinary child Sessions, anchored at their first operation Command. */
export function listStableAgents(
  db: SqliteOperations,
  input: import('../agent-collaboration').ListStableAgentsInput,
): import('../agent-collaboration').StableAgentPage {
  db.db.run('BEGIN');
  try {
    const page = stableAgentsBody(db, input);
    db.db.run('COMMIT');
    return page;
  } catch (error) {
    return db.rollback(error);
  }
}
export function stableAgentsBody(
  db: SqliteOperations,
  input: import('../agent-collaboration').ListStableAgentsInput,
): import('../agent-collaboration').StableAgentPage {
  db.identity(input.expectedStoreId);
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new AgentError('invalid_request');
  if (
    input.agentIds !== undefined &&
    (!Array.isArray(input.agentIds) ||
      !input.agentIds.length ||
      input.agentIds.length > 200 ||
      input.agentIds.some((id) => typeof id !== 'string' || !id) ||
      new Set(input.agentIds).size !== input.agentIds.length)
  )
    throw new AgentError('invalid_request');
  const base = `FROM command c JOIN execution e ON e.origin_command_id=c.id
    JOIN session s ON s.id=e.child_session_id
    WHERE c.kind='operation.agent' AND c.session_id=? AND c.extension_id=? AND c.subject_id=?
    AND c.origin_store_id=? AND e.origin_store_id=c.origin_store_id AND s.parent_id=c.session_id`;
  const args = [input.sessionId, input.extensionId, input.subjectId, input.expectedStoreId];
  if (input.agentIds) {
    for (const id of input.agentIds) {
      if (!db.row(`SELECT s.id ${base} AND s.id=? LIMIT 1`, ...args, id))
        throw new AgentError('agent_unavailable');
    }
  }
  const anchors = `SELECT s.id,MIN(c.seq) AS anchor ${base} GROUP BY s.id`;
  const water = String(
    db.row(`SELECT COALESCE(MAX(anchor),0) AS water FROM (${anchors})`, ...args)!.water,
  );
  const after = decimal(input.afterSeq ?? '0');
  const upper = decimal(input.upperSeq ?? water);
  if (after > upper || upper > BigInt(water)) throw new AgentError('invalid_cursor');
  const filter = input.agentIds ? ` AND id IN (${input.agentIds.map(() => '?').join(',')})` : '';
  const identities = db.rows(
    `SELECT * FROM (${anchors}) WHERE anchor>? AND anchor<=?${filter} ORDER BY anchor LIMIT ?`,
    ...args,
    after,
    upper,
    ...(input.agentIds ?? []),
    limit + 1,
  );
  const items = identities.slice(0, limit).map((identity) => {
    const first = db.row(
      `SELECT c.request_json ${base} AND s.id=? ORDER BY c.seq LIMIT 1`,
      ...args,
      identity.id!,
    )!;
    const current = db.row(
      `SELECT c.*,e.id AS carrier_id,e.state AS carrier_state,e.reference_json,e.result_json,
      e.child_configuration_json,e.child_session_id,s.context_selection_id ${base} AND s.id=? ORDER BY c.seq DESC LIMIT 1`,
      ...args,
      identity.id!,
    )!;
    const original = JSON.parse(String(first.request_json)) as { input?: unknown };
    const request = JSON.parse(String(current.request_json)) as { input?: unknown };
    const display = (value: unknown): { content: string; name: string | null } => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const body = value as { content?: unknown; name?: unknown };
        if (typeof body.content === 'string') {
          const content = body.content;
          return { content, name: typeof body.name === 'string' ? body.name : null };
        }
      }
      return { content: JSON.stringify(value ?? null), name: null };
    };
    const assignment = display(original.input);
    let work = display(request.input);
    const recent = db.row(
      `SELECT request_json FROM command WHERE session_id=? AND extension_id=?
      AND kind='agent.control' AND agent_carrier_execution_id=? AND json_extract(request_json,'$.action')='follow_up'
      ORDER BY seq DESC LIMIT 1`,
      input.sessionId,
      input.extensionId,
      current.carrier_id!,
    );
    if (recent) {
      const update = JSON.parse(String(recent.request_json)) as { content?: unknown };
      if (typeof update.content === 'string') work = { content: update.content, name: null };
    }
    const state = String(current.carrier_state);
    const ref = JSON.parse(String(current.reference_json)) as { runId?: string } | null;
    const run = ref?.runId
      ? db.row(
          'SELECT * FROM run WHERE id=? AND session_id=? AND origin_command_id=?',
          ref.runId,
          identity.id!,
          `child-start-${current.carrier_id}`,
        )
      : null;
    if (ref?.runId && (!run || run.origin_store_id !== input.expectedStoreId))
      throw new AgentError('operation_unverifiable');
    const last = db.row(
      `SELECT e.state,e.result_json ${base} AND s.id=? AND e.state IN ('succeeded','failed','cancelled','outcome_unknown') ORDER BY c.seq DESC LIMIT 1`,
      ...args,
      identity.id!,
    );
    const terminal = ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(state);
    const pending =
      !terminal &&
      db.row(
        `SELECT i.id FROM interaction i JOIN execution ie ON ie.id=i.execution_id
      WHERE ie.session_id=? AND ie.run_id=? AND i.state='pending' AND ie.cancel_requested=0 LIMIT 1`,
        identity.id!,
        run?.id ?? null,
      );
    return {
      agentId: String(identity.id),
      seq: String(identity.anchor),
      taskName: assignment.name,
      assignmentSummary: assignment.content.slice(0, 512),
      assignmentSource: { content: assignment.content },
      currentWorkSummary: work.content.slice(0, 512),
      currentWorkSource: { content: work.content },
      workRelation:
        input.callerRootWorkCommandId === undefined
          ? ('unknown' as const)
          : current.root_work_command_id === input.callerRootWorkCommandId &&
              String(current.root_work_seq) === input.callerRootWorkSeq
            ? ('same_work' as const)
            : ('other_work' as const),
      state: (state === 'outcome_unknown'
        ? 'waiting'
        : terminal
          ? 'idle'
          : state === 'planned'
            ? 'queued'
            : pending ||
                run?.status === 'waiting_interaction' ||
                run?.status === 'waiting_execution'
              ? 'waiting'
              : 'running') as import('../agent-collaboration').AgentState,
      lastOutcome: last
        ? (String(last.state) as import('../agent-collaboration').StableAgentSummary['lastOutcome'])
        : null,
      lastResultSource: last ? { content: String(last.result_json) } : null,
      ref: {
        commandId: String(current.id),
        sessionId: input.sessionId,
        extensionId: input.extensionId,
        originStoreId: input.expectedStoreId,
        key: String(current.operation_key),
        executionId: String(current.carrier_id),
        childSessionId: String(identity.id),
      },
      runId: run ? String(run.id) : null,
      contextSelectionId: String(current.context_selection_id),
      configurationId: String(
        (JSON.parse(String(current.child_configuration_json)) as { id: string }).id,
      ),
    };
  });
  return {
    items,
    upperSeq: String(upper),
    nextAfterSeq: identities.length > limit ? items.at(-1)!.seq : null,
  };
}

/** A bounded read of durable mailbox/completion facts; observing never acknowledges a result. */
export function listAgentEvents(
  db: SqliteOperations,
  input: import('../agent-collaboration').ListAgentEventsInput,
): import('../agent-collaboration').AgentEventPage {
  db.db.run('BEGIN');
  try {
    db.identity(input.expectedStoreId);
    const session = db.row('SELECT id FROM session WHERE id=?', input.sessionId);
    const creator = db.row(
      "SELECT subject_id FROM command WHERE session_id=? AND kind='session.create' LIMIT 1",
      input.sessionId,
    );
    if (!session || creator?.subject_id !== input.subjectId)
      throw new AgentError('permission_denied');
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new AgentError('invalid_request');
    const after = decimal(input.afterSeq ?? '0');
    const metadata = db.metadata();
    if (after < BigInt(metadata.replayFloor))
      throw new AgentError('cursor_expired', metadata.replayFloor);
    const predicate = `FROM change_event v LEFT JOIN execution e ON e.id=v.object_id
      LEFT JOIN command c ON c.id=e.origin_command_id
      LEFT JOIN command m ON m.id=v.object_id AND m.kind='agent.message'
      WHERE v.scope_session_id=? AND (
       (v.type='execution.finished' AND e.child_session_id IS NOT NULL AND c.kind='operation.agent'
        AND c.extension_id=? AND c.subject_id=? AND c.origin_store_id=? AND e.origin_store_id=c.origin_store_id)
       OR (v.type='agent.message_ready' AND m.mail_target_session_id=? AND m.subject_id=? AND m.origin_store_id=?
        AND m.mail_confirmed=1 AND m.status='applied'))`;
    const args = [
      input.sessionId,
      input.extensionId,
      input.subjectId,
      input.expectedStoreId,
      input.sessionId,
      input.subjectId,
      input.expectedStoreId,
    ];
    const observedWater = BigInt(
      db.row(`SELECT COALESCE(MAX(v.cursor),0) AS water ${predicate}`, ...args)!.water!,
    );
    const water = String(
      observedWater > BigInt(metadata.replayFloor) ? observedWater : BigInt(metadata.replayFloor),
    );
    if (after > BigInt(water)) throw new AgentError('invalid_cursor');
    const rows = db.rows(
      `SELECT v.cursor,v.type,e.child_session_id,e.state,m.session_id AS sender_session ${predicate} AND v.cursor>? ORDER BY v.cursor LIMIT ?`,
      ...args,
      after,
      limit,
    );
    const events = rows.map((row) => ({
      seq: String(row.cursor),
      agentId: String(
        row.type === 'execution.finished' ? row.child_session_id : row.sender_session,
      ),
      kind: row.type === 'execution.finished' ? ('completed' as const) : ('message' as const),
      ...(row.type === 'execution.finished' ? { outcome: String(row.state) } : {}),
      summary:
        row.type === 'execution.finished'
          ? `Child execution ended: ${row.state}. Full result remains in its original source.`
          : 'A complete Agent message is available at the next safe checkpoint.',
    }));
    db.db.run('COMMIT');
    return { events, nextSeq: events.at(-1)?.seq ?? String(after), highWaterSeq: water };
  } catch (error) {
    return db.rollback(error);
  }
}
