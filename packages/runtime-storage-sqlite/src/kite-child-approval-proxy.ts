import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  readAcceptedIndependentFollowupSourcePolicyProof,
  readCrossSessionFollowupGrant,
  readIndependentCrossSessionFollowupActivation,
  verifyPersistedCrossSessionFollowupRunStart,
} from './kite-cross-session-followup';

const FOLLOWUP_PROXY_PARENT_TOOL_PREFIX = 'followup-approval:v2:';

export interface FollowupChildApprovalParentToolIdentity {
  readonly submissionId: string;
  readonly targetRunId: string;
  readonly sourceToolCallId: string;
}

export function followupChildApprovalParentToolCallId(
  input: FollowupChildApprovalParentToolIdentity,
): string {
  const parts = [input.submissionId, input.targetRunId, input.sourceToolCallId];
  if (parts.some((part) => !part || part.length > 4096))
    throw new Error('Followup approval source identity is invalid.');
  return `${FOLLOWUP_PROXY_PARENT_TOOL_PREFIX}${Buffer.from(JSON.stringify(parts)).toString('base64url')}`;
}

export function parseFollowupChildApprovalParentToolCallId(
  value: string,
): FollowupChildApprovalParentToolIdentity | null {
  if (!value.startsWith(FOLLOWUP_PROXY_PARENT_TOOL_PREFIX)) return null;
  try {
    const parts = JSON.parse(
      Buffer.from(value.slice(FOLLOWUP_PROXY_PARENT_TOOL_PREFIX.length), 'base64url').toString(
        'utf8',
      ),
    ) as unknown;
    if (
      !Array.isArray(parts) ||
      parts.length !== 3 ||
      parts.some((part) => typeof part !== 'string' || !part || part.length > 4096)
    )
      return null;
    const identity = {
      submissionId: parts[0] as string,
      targetRunId: parts[1] as string,
      sourceToolCallId: parts[2] as string,
    };
    return followupChildApprovalParentToolCallId(identity) === value ? identity : null;
  } catch {
    return null;
  }
}

/** Private parent-visible approval routing facts. No client query may return a row. */
export const KITE_CHILD_APPROVAL_PROXY_COLUMNS = [
  'proxy_interaction_id',
  'parent_session_id',
  'child_thread_id',
  'child_invocation_id',
  'parent_tool_call_id',
  'child_tool_call_id',
  'grant_digest',
  'child_interaction_id',
  'child_generation',
  'child_request_revision',
  'approval_digest',
  'status',
  'decision',
  'parent_command_id',
  'parent_command_digest',
  'parent_decision_revision',
  'child_applied_revision',
] as const;

export const KITE_CHILD_APPROVAL_PROXY_DDL = `CREATE TABLE child_approval_proxies (
  proxy_interaction_id TEXT PRIMARY KEY NOT NULL,
  parent_session_id TEXT NOT NULL REFERENCES runtime_sessions(session_id),
  child_thread_id TEXT NOT NULL REFERENCES runtime_sessions(session_id),
  child_invocation_id TEXT NOT NULL,
  parent_tool_call_id TEXT NOT NULL,
  child_tool_call_id TEXT NOT NULL,
  grant_digest TEXT NOT NULL,
  child_interaction_id TEXT NOT NULL,
  child_generation INTEGER NOT NULL CHECK (child_generation >= 0),
  child_request_revision INTEGER NOT NULL CHECK (child_request_revision >= 1),
  approval_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','decided','applied','unknown')),
  decision TEXT CHECK (decision IN ('approve_once','reject')),
  parent_command_id TEXT,
  parent_command_digest TEXT,
  parent_decision_revision INTEGER CHECK (parent_decision_revision >= 0),
  child_applied_revision INTEGER CHECK (child_applied_revision >= 1),
  UNIQUE(child_thread_id,child_interaction_id,child_generation),
  CHECK ((status = 'pending' AND decision IS NULL AND parent_command_id IS NULL AND parent_command_digest IS NULL AND parent_decision_revision IS NULL AND child_applied_revision IS NULL)
    OR (status = 'decided' AND decision IS NOT NULL AND parent_command_id IS NOT NULL AND parent_command_digest IS NOT NULL AND parent_decision_revision IS NOT NULL AND child_applied_revision IS NULL)
    OR (status = 'applied' AND decision IS NOT NULL AND parent_command_id IS NOT NULL AND parent_command_digest IS NOT NULL AND parent_decision_revision IS NOT NULL AND child_applied_revision IS NOT NULL)
    OR status = 'unknown')
) STRICT`;

export const KITE_CHILD_APPROVAL_PROXY_PARENT_INDEX = `CREATE INDEX child_approval_proxies_parent_pending
  ON child_approval_proxies(parent_session_id,proxy_interaction_id)
  WHERE status IN ('pending','decided')`;

export interface KiteChildApprovalProxyRecord {
  readonly proxyInteractionId: string;
  readonly parentSessionId: string;
  readonly childThreadId: string;
  readonly childInvocationId: string;
  readonly parentToolCallId: string;
  readonly childToolCallId: string;
  readonly grantDigest: string;
  readonly childInteractionId: string;
  readonly childGeneration: number;
  readonly childRequestRevision: number;
  readonly approvalDigest: string;
  readonly status: 'pending' | 'decided' | 'applied' | 'unknown';
  readonly decision: 'approve_once' | 'reject' | null;
  readonly parentCommandId: string | null;
  readonly parentCommandDigest: string | null;
  readonly parentDecisionRevision: number | null;
  readonly childAppliedRevision: number | null;
}

interface Row {
  proxy_interaction_id: string;
  parent_session_id: string;
  child_thread_id: string;
  child_invocation_id: string;
  parent_tool_call_id: string;
  child_tool_call_id: string;
  grant_digest: string;
  child_interaction_id: string;
  child_generation: number;
  child_request_revision: number;
  approval_digest: string;
  status: KiteChildApprovalProxyRecord['status'];
  decision: KiteChildApprovalProxyRecord['decision'];
  parent_command_id: string | null;
  parent_command_digest: string | null;
  parent_decision_revision: number | null;
  child_applied_revision: number | null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function activeFollowupApprovalIdentity(
  database: Database,
  childThreadId: string,
  postState: unknown,
  toolCallId: string,
  interactionId: string,
  generation: number,
  requestRevision: number,
): Readonly<{
  parentSessionId: string;
  childInvocationId: string;
  parentToolCallId: string;
  grantDigest: string;
}> | null {
  const state = record(postState);
  const session = record(state.session);
  const origin = record(state.childSessionOrigin);
  const terminal = record(origin.terminal);
  const active = record(state.activeFollowupTurn);
  const turn = record(state.turn);
  const budget = record(state.resourceBudget);
  const tool = record(record(record(state.tools).calls)[toolCallId]);
  const pending =
    state.pendingApprovals instanceof Map ? record(state.pendingApprovals.get(interactionId)) : {};
  const parentSessionId = String(active.sourceSessionId ?? '');
  const submissionId = String(active.submissionId ?? '');
  const targetRunId = String(active.targetRunId ?? '');
  const grantDigest = String(active.grantDigest ?? '');
  if (
    session.threadId !== childThreadId ||
    origin.parentSessionId !== parentSessionId ||
    !origin.childInvocationId ||
    terminal.status !== 'completed' ||
    terminal.cleanupConfirmed !== true ||
    turn.turnId !== targetRunId ||
    turn.status !== 'active' ||
    budget.runId !== targetRunId ||
    budget.status !== 'active' ||
    tool.toolCallId !== toolCallId ||
    tool.createdAtTurnId !== targetRunId ||
    pending.toolCallId !== toolCallId ||
    pending.generation !== generation ||
    pending.route !== 'user' ||
    pending.status !== 'awaiting_user' ||
    !Number.isSafeInteger(state.revision) ||
    (state.revision as number) < requestRevision ||
    !parentSessionId ||
    !submissionId ||
    !targetRunId ||
    !/^sha256:[a-f0-9]{64}$/u.test(grantDigest)
  )
    return null;
  const activation = readIndependentCrossSessionFollowupActivation(
    database,
    parentSessionId,
    submissionId,
  );
  const accepted = readAcceptedIndependentFollowupSourcePolicyProof(
    database,
    childThreadId,
    parentSessionId,
    submissionId,
  );
  const grantRef = record(active.grantRef);
  const grant = readCrossSessionFollowupGrant(database, String(grantRef.artifactId ?? ''));
  const payload = grant ? record(JSON.parse(grant.canonicalJson)) : {};
  const sourceToolCallId = accepted?.admission.sourceToolCallId;
  if (
    !activation ||
    !accepted ||
    !grant ||
    accepted.policy.targetGrantDigest !== origin.grantDigest ||
    accepted.policy.targetRole !== origin.role ||
    activation.targetSessionId !== childThreadId ||
    activation.targetRunId !== targetRunId ||
    activation.grantDigest !== grantDigest ||
    grant.ref.integrityIdentifier !== grantDigest ||
    payload.schema !== 'kite.child-followup-grant.v2' ||
    payload.sourceSessionId !== parentSessionId ||
    payload.targetSessionId !== childThreadId ||
    payload.submissionId !== submissionId ||
    payload.targetRunId !== targetRunId ||
    payload.originRole !== origin.role ||
    payload.denyTools !== false ||
    !Array.isArray(payload.allowedTools) ||
    !payload.allowedTools.includes(tool.name) ||
    typeof sourceToolCallId !== 'string' ||
    !sourceToolCallId
  )
    return null;
  return Object.freeze({
    parentSessionId,
    childInvocationId: String(origin.childInvocationId),
    parentToolCallId: followupChildApprovalParentToolCallId({
      submissionId,
      targetRunId,
      sourceToolCallId,
    }),
    grantDigest,
  });
}

function validHistoricalFollowupApprovalIdentity(
  database: Database,
  proxy: Readonly<KiteChildApprovalProxyRecord>,
): boolean {
  const identity = parseFollowupChildApprovalParentToolCallId(proxy.parentToolCallId);
  if (!identity) return false;
  const run = database
    .query<{ created_revision: number; start_command_id: string }, [string, string]>(
      'SELECT created_revision,start_command_id FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(proxy.childThreadId, identity.targetRunId);
  if (
    !run ||
    run.start_command_id !== `followup:${identity.submissionId}` ||
    run.created_revision >= proxy.childRequestRevision ||
    !verifyPersistedCrossSessionFollowupRunStart(database, {
      sessionId: proxy.childThreadId,
      runId: identity.targetRunId,
      startCommandId: run.start_command_id,
      createdRevision: run.created_revision,
      originSessionId: undefined,
    })
  )
    return false;
  const intervening = database
    .query<{ count: number }, [string, number, number]>(
      `SELECT count(*) AS count FROM runtime_runs WHERE session_id=?
       AND created_revision>? AND created_revision<=?`,
    )
    .get(proxy.childThreadId, run.created_revision, proxy.childRequestRevision)?.count;
  if (intervening !== 0) return false;
  const preparedRows = database
    .query<{ event_json: string }, [string, string, string]>(
      `SELECT event_json FROM runtime_events WHERE session_id=?
       AND json_extract(event_json,'$.type')='agent.followup_turn_prepared'
       AND json_extract(event_json,'$.submissionId')=?
       AND json_extract(event_json,'$.targetRunId')=?`,
    )
    .all(proxy.childThreadId, identity.submissionId, identity.targetRunId);
  if (preparedRows.length !== 1) return false;
  const prepared = record(JSON.parse(preparedRows[0]!.event_json));
  const grant = readCrossSessionFollowupGrant(
    database,
    String(record(prepared.grantRef).artifactId ?? ''),
  );
  const payload = grant ? record(JSON.parse(grant.canonicalJson)) : {};
  const outbox = database
    .query<
      { source_tool_call_id: string; followup_admission_artifact_id: string | null },
      [string, string, string]
    >(
      `SELECT source_tool_call_id,followup_admission_artifact_id FROM agent_mail_outbox
       WHERE source_session_id=? AND target_session_id=? AND submission_id=? AND mode='trigger_turn'`,
    )
    .get(proxy.parentSessionId, proxy.childThreadId, identity.submissionId);
  const admissionRow = outbox?.followup_admission_artifact_id
    ? database
        .query<{ canonical_json: string }, [string]>(
          'SELECT canonical_json FROM agent_followup_admission_artifacts WHERE artifact_id=?',
        )
        .get(outbox.followup_admission_artifact_id)
    : null;
  const admission = admissionRow ? record(JSON.parse(admissionRow.canonical_json)) : {};
  const request = database
    .query<{ event_json: string }, [string, number]>(
      'SELECT event_json FROM runtime_events WHERE session_id=? AND sequence=?',
    )
    .get(proxy.childThreadId, proxy.childRequestRevision);
  const approval = request ? record(record(JSON.parse(request.event_json)).approval) : {};
  const dispatches = admission.backupReservationId
    ? database
        .query<{ count: number }, [string, string]>(
          `SELECT count(*) AS count FROM runtime_events WHERE session_id=?
           AND json_extract(event_json,'$.type')='resource_budget.dispatch_started'
           AND json_extract(event_json,'$.reservationId')=?`,
        )
        .get(proxy.parentSessionId, String(admission.backupReservationId))?.count
    : 0;
  return Boolean(
    prepared.sourceSessionId === proxy.parentSessionId &&
      prepared.grantDigest === proxy.grantDigest &&
      grant?.ref.integrityIdentifier === proxy.grantDigest &&
      payload.schema === 'kite.child-followup-grant.v2' &&
      payload.sourceSessionId === proxy.parentSessionId &&
      payload.targetSessionId === proxy.childThreadId &&
      payload.submissionId === identity.submissionId &&
      payload.targetRunId === identity.targetRunId &&
      payload.denyTools === false &&
      Array.isArray(payload.allowedTools) &&
      payload.allowedTools.includes(approval.tool) &&
      outbox?.source_tool_call_id === identity.sourceToolCallId &&
      admission.sourceToolCallId === identity.sourceToolCallId &&
      admission.schema === 'kite.cross-session-followup-admission.v2' &&
      dispatches === 1,
  );
}

function rowToRecord(row: Row): KiteChildApprovalProxyRecord {
  return Object.freeze({
    proxyInteractionId: row.proxy_interaction_id,
    parentSessionId: row.parent_session_id,
    childThreadId: row.child_thread_id,
    childInvocationId: row.child_invocation_id,
    parentToolCallId: row.parent_tool_call_id,
    childToolCallId: row.child_tool_call_id,
    grantDigest: row.grant_digest,
    childInteractionId: row.child_interaction_id,
    childGeneration: row.child_generation,
    childRequestRevision: row.child_request_revision,
    approvalDigest: row.approval_digest,
    status: row.status,
    decision: row.decision,
    parentCommandId: row.parent_command_id,
    parentCommandDigest: row.parent_command_digest,
    parentDecisionRevision: row.parent_decision_revision,
    childAppliedRevision: row.child_applied_revision,
  });
}

export function childApprovalProxyId(input: {
  childThreadId: string;
  childInteractionId: string;
  childGeneration: number;
}): string {
  return `child-approval:${createHash('sha256')
    .update(
      JSON.stringify([
        'kite.child-approval-proxy.v1',
        input.childThreadId,
        input.childInteractionId,
        input.childGeneration,
      ]),
    )
    .digest('hex')}`;
}

/** Called only inside the child canonical approval.requested Event transaction. */
export function openChildApprovalProxyInTransaction(
  database: Database,
  input: {
    readonly childThreadId: string;
    readonly childInteractionId: string;
    readonly childGeneration: number;
    readonly childRequestRevision: number;
    readonly childToolCallId: string;
    readonly approvalDigest: string;
    readonly postState?: unknown;
  },
): KiteChildApprovalProxyRecord {
  if (
    !input.childThreadId ||
    !input.childInteractionId ||
    !input.childToolCallId ||
    !Number.isSafeInteger(input.childGeneration) ||
    input.childGeneration < 0 ||
    !Number.isSafeInteger(input.childRequestRevision) ||
    input.childRequestRevision < 1 ||
    !/^sha256:[a-f0-9]{64}$/u.test(input.approvalDigest)
  )
    throw new Error('Child approval proxy identity is invalid.');
  const intent = database
    .query<
      {
        parent_session_id: string;
        child_invocation_id: string;
        origin_tool_call_id: string;
        grant_digest: string;
      },
      [string]
    >(`SELECT parent_session_id,child_invocation_id,origin_tool_call_id,grant_digest
    FROM child_session_intents WHERE child_thread_id=? AND dispatch_ack_event_id IS NOT NULL
      AND failure_receipt_digest IS NULL LIMIT 1`)
    .get(input.childThreadId);
  if (!intent) throw new Error('Child approval proxy lacks an acknowledged child intent.');
  const followup = activeFollowupApprovalIdentity(
    database,
    input.childThreadId,
    input.postState,
    input.childToolCallId,
    input.childInteractionId,
    input.childGeneration,
    input.childRequestRevision,
  );
  if (
    followup &&
    (followup.parentSessionId !== intent.parent_session_id ||
      followup.childInvocationId !== intent.child_invocation_id ||
      record(record(input.postState).childSessionOrigin).grantDigest !== intent.grant_digest)
  )
    throw new Error('Followup approval changed the original parent lineage.');
  if (record(input.postState).activeFollowupTurn && !followup)
    throw new Error('Followup approval lacks its exact active Run and source activation.');
  if (!followup) {
    const unsettled = database
      .query<{ count: number }, [string]>(
        `SELECT count(*) AS count FROM child_session_intents WHERE child_thread_id=?
         AND parent_claim_settled_event_id IS NULL`,
      )
      .get(input.childThreadId)?.count;
    if (unsettled !== 1)
      throw new Error('Child approval proxy lacks an active acknowledged child intent.');
  }
  const parentSessionId = followup?.parentSessionId ?? intent.parent_session_id;
  const parentToolCallId = followup?.parentToolCallId ?? intent.origin_tool_call_id;
  const grantDigest = followup?.grantDigest ?? intent.grant_digest;
  const event = database
    .query<{ event_json: string }, [string, number]>(
      'SELECT event_json FROM runtime_events WHERE session_id=? AND sequence=? LIMIT 1',
    )
    .get(input.childThreadId, input.childRequestRevision);
  if (!event) throw new Error('Child approval request has no canonical Event.');
  const parsed = JSON.parse(event.event_json) as Record<string, unknown>;
  const eventDigest = `sha256:${createHash('sha256').update(event.event_json).digest('hex')}`;
  if (
    parsed.type !== 'approval.requested' ||
    parsed.interactionId !== input.childInteractionId ||
    parsed.toolCallId !== input.childToolCallId ||
    eventDigest !== input.approvalDigest
  )
    throw new Error('Child approval request differs from the canonical Event.');
  const proxyInteractionId = childApprovalProxyId(input);
  const existing = readChildApprovalProxy(database, parentSessionId, proxyInteractionId);
  if (existing) {
    if (
      existing.childThreadId !== input.childThreadId ||
      existing.childInteractionId !== input.childInteractionId ||
      existing.childGeneration !== input.childGeneration ||
      existing.childRequestRevision !== input.childRequestRevision ||
      existing.childToolCallId !== input.childToolCallId ||
      existing.approvalDigest !== input.approvalDigest ||
      existing.grantDigest !== grantDigest ||
      existing.parentToolCallId !== parentToolCallId
    )
      throw new Error('Child approval proxy replay conflicts with its original request.');
    return existing;
  }
  database
    .query(`INSERT INTO child_approval_proxies (
    proxy_interaction_id,parent_session_id,child_thread_id,child_invocation_id,parent_tool_call_id,
    child_tool_call_id,grant_digest,child_interaction_id,child_generation,child_request_revision,
    approval_digest,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending')`)
    .run(
      proxyInteractionId,
      parentSessionId,
      input.childThreadId,
      intent.child_invocation_id,
      parentToolCallId,
      input.childToolCallId,
      grantDigest,
      input.childInteractionId,
      input.childGeneration,
      input.childRequestRevision,
      input.approvalDigest,
    );
  return readChildApprovalProxy(database, parentSessionId, proxyInteractionId)!;
}

export function readChildApprovalProxy(
  database: Database,
  parentSessionId: string,
  proxyInteractionId: string,
): KiteChildApprovalProxyRecord | null {
  if (!parentSessionId || !proxyInteractionId) return null;
  const row = database
    .query<Row, [string, string]>(
      'SELECT * FROM child_approval_proxies WHERE parent_session_id=? AND proxy_interaction_id=? LIMIT 1',
    )
    .get(parentSessionId, proxyInteractionId);
  return row ? rowToRecord(row) : null;
}

export function listPendingChildApprovalProxies(
  database: Database,
  parentSessionId: string,
  limit: number,
  afterProxyInteractionId = '',
): readonly KiteChildApprovalProxyRecord[] {
  if (!parentSessionId || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Child approval proxy listing requires a bounded parent scope.');
  return Object.freeze(
    database
      .query<Row, [string, string, number]>(
        `SELECT * FROM child_approval_proxies WHERE parent_session_id=?
      AND proxy_interaction_id>? AND status IN ('pending','decided')
      ORDER BY proxy_interaction_id LIMIT ?`,
      )
      .all(parentSessionId, afterProxyInteractionId, limit)
      .map(rowToRecord),
  );
}

/** Parent command receipt and this CAS must share the same enclosing SQLite transaction. */
export function decideChildApprovalProxyInTransaction(
  database: Database,
  input: {
    readonly parentSessionId: string;
    readonly proxyInteractionId: string;
    readonly childRequestRevision: number;
    readonly childGeneration: number;
    readonly approvalDigest: string;
    readonly decision: 'approve_once' | 'reject';
    readonly parentCommandId: string;
    readonly parentCommandDigest: string;
    readonly parentDecisionRevision: number;
  },
): KiteChildApprovalProxyRecord {
  const current = readChildApprovalProxy(database, input.parentSessionId, input.proxyInteractionId);
  if (
    !current ||
    current.childRequestRevision !== input.childRequestRevision ||
    current.childGeneration !== input.childGeneration ||
    current.approvalDigest !== input.approvalDigest
  )
    throw new Error('Child approval proxy decision identity is stale.');
  if (current.status !== 'pending') {
    if (
      current.decision === input.decision &&
      current.parentCommandId === input.parentCommandId &&
      current.parentCommandDigest === input.parentCommandDigest &&
      current.parentDecisionRevision === input.parentDecisionRevision
    )
      return current;
    throw new Error('Child approval proxy has already been decided.');
  }
  if (
    !input.parentCommandId ||
    !/^[a-f0-9]{64}$/u.test(input.parentCommandDigest) ||
    !Number.isSafeInteger(input.parentDecisionRevision) ||
    input.parentDecisionRevision < 0
  )
    throw new Error('Child approval parent command evidence is invalid.');
  const receipt = database
    .query<
      {
        request_digest: string;
        target_session_id: string;
        committed_revision: number;
      },
      [string, string]
    >(`SELECT request_digest,target_session_id,committed_revision
    FROM runtime_command_receipts WHERE scope_session_id=? AND command_id=? LIMIT 1`)
    .get(input.parentSessionId, input.parentCommandId);
  if (
    !receipt ||
    receipt.target_session_id !== input.parentSessionId ||
    receipt.request_digest !== input.parentCommandDigest ||
    receipt.committed_revision !== input.parentDecisionRevision
  )
    throw new Error('Child approval decision lacks its exact parent command receipt.');
  const changed = database
    .query(`UPDATE child_approval_proxies SET status='decided', decision=?,
    parent_command_id=?,parent_command_digest=?,parent_decision_revision=?
    WHERE parent_session_id=? AND proxy_interaction_id=? AND status='pending'`)
    .run(
      input.decision,
      input.parentCommandId,
      input.parentCommandDigest,
      input.parentDecisionRevision,
      input.parentSessionId,
      input.proxyInteractionId,
    );
  if (changed.changes !== 1) throw new Error('Child approval proxy decision lost its CAS.');
  return readChildApprovalProxy(database, input.parentSessionId, input.proxyInteractionId)!;
}

/** Called after the child approval.granted/rejected fact is durably admitted. */
export function markChildApprovalAppliedInTransaction(
  database: Database,
  input: {
    readonly parentSessionId: string;
    readonly proxyInteractionId: string;
    readonly decision: 'approve_once' | 'reject';
    readonly childAppliedRevision: number;
  },
): KiteChildApprovalProxyRecord {
  const current = readChildApprovalProxy(database, input.parentSessionId, input.proxyInteractionId);
  if (!current || current.decision !== input.decision || current.status === 'pending')
    throw new Error('Child approval application has no exact parent decision.');
  if (current.status === 'applied') {
    if (current.childAppliedRevision === input.childAppliedRevision) return current;
    throw new Error('Child approval was applied at a different revision.');
  }
  if (
    current.status !== 'decided' ||
    !Number.isSafeInteger(input.childAppliedRevision) ||
    input.childAppliedRevision <= current.childRequestRevision
  )
    throw new Error('Child approval application revision is invalid.');
  const event = database
    .query<{ event_json: string }, [string, number]>(
      'SELECT event_json FROM runtime_events WHERE session_id=? AND sequence=? LIMIT 1',
    )
    .get(current.childThreadId, input.childAppliedRevision);
  const parsed = event ? (JSON.parse(event.event_json) as Record<string, unknown>) : null;
  if (
    !parsed ||
    parsed.type !==
      (input.decision === 'approve_once' ? 'approval.granted' : 'approval.rejected') ||
    parsed.interactionId !== current.childInteractionId ||
    parsed.toolCallId !== current.childToolCallId ||
    parsed.generation !== current.childGeneration
  )
    throw new Error('Child approval application lacks an exact canonical decision Event.');
  const changed = database
    .query(`UPDATE child_approval_proxies SET status='applied', child_applied_revision=?
    WHERE parent_session_id=? AND proxy_interaction_id=? AND status='decided'`)
    .run(input.childAppliedRevision, input.parentSessionId, input.proxyInteractionId);
  if (changed.changes !== 1) throw new Error('Child approval application lost its CAS.');
  return readChildApprovalProxy(database, input.parentSessionId, input.proxyInteractionId)!;
}

/** Follow canonical child approval facts inside their existing fenced Session transaction. */
export function synchronizeChildApprovalProxyInTransaction(
  database: Database,
  transaction: {
    readonly sessionId: string;
    readonly events: readonly unknown[];
    readonly snapshot: unknown;
  },
  committedRevision: number,
): void {
  if (
    !transaction.events.some((event) => {
      const value = event as { type?: unknown } | null;
      return (
        value?.type === 'approval.requested' ||
        value?.type === 'approval.granted' ||
        value?.type === 'approval.rejected'
      );
    })
  )
    return;
  const child = database
    .query<{ parent_session_id: string }, [string]>(
      'SELECT parent_session_id FROM child_session_intents WHERE child_thread_id=? LIMIT 1',
    )
    .get(transaction.sessionId);
  if (!child) return;
  const snapshot = transaction.snapshot as {
    pendingApprovals?: ReadonlyMap<string, { toolCallId?: string; generation?: number }>;
  } | null;
  if (!snapshot || !(snapshot.pendingApprovals instanceof Map))
    throw new Error('Child approval proxy requires the exact post-transaction approval State.');
  const firstRevision = committedRevision - transaction.events.length + 1;
  for (const [index, raw] of transaction.events.entries()) {
    const event = raw as {
      type?: unknown;
      interactionId?: unknown;
      toolCallId?: unknown;
      generation?: unknown;
      owner?: { kind?: unknown };
    } | null;
    if (!event || typeof event.interactionId !== 'string' || typeof event.toolCallId !== 'string')
      continue;
    const revision = firstRevision + index;
    if (event.type === 'approval.requested') {
      if (event.owner?.kind !== 'root_tool')
        throw new Error('Independent child approval has an unexpected owner.');
      const pending = snapshot.pendingApprovals.get(event.interactionId);
      if (
        pending?.toolCallId !== event.toolCallId ||
        !Number.isSafeInteger(pending.generation) ||
        pending.generation! < 0
      )
        throw new Error('Child approval proxy lacks the exact post-event pending request.');
      const canonical = database
        .query<{ event_json: string }, [string, number]>(
          'SELECT event_json FROM runtime_events WHERE session_id=? AND sequence=? LIMIT 1',
        )
        .get(transaction.sessionId, revision);
      if (!canonical) throw new Error('Child approval proxy Event is unavailable.');
      openChildApprovalProxyInTransaction(database, {
        childThreadId: transaction.sessionId,
        childInteractionId: event.interactionId,
        childGeneration: pending.generation!,
        childRequestRevision: revision,
        childToolCallId: event.toolCallId,
        approvalDigest: `sha256:${createHash('sha256').update(canonical.event_json).digest('hex')}`,
        postState: transaction.snapshot,
      });
    } else if (event.type === 'approval.granted' || event.type === 'approval.rejected') {
      if (!Number.isSafeInteger(event.generation))
        throw new Error('Child approval application generation is missing.');
      const proxyId = childApprovalProxyId({
        childThreadId: transaction.sessionId,
        childInteractionId: event.interactionId,
        childGeneration: event.generation as number,
      });
      const proxy = readChildApprovalProxy(database, child.parent_session_id, proxyId);
      if (!proxy) throw new Error('Independent child approval was applied without a parent proxy.');
      if (
        event.type === 'approval.rejected' &&
        (proxy.status === 'pending' || (proxy.status === 'decided' && proxy.decision !== 'reject'))
      ) {
        // A cancelled child can reject a pending approval without a parent
        // decision. Preserve the unknown/aborted route; never claim user approval.
        database
          .query(`UPDATE child_approval_proxies SET status='unknown'
          WHERE parent_session_id=? AND proxy_interaction_id=? AND status=?`)
          .run(child.parent_session_id, proxyId, proxy.status);
        continue;
      }
      markChildApprovalAppliedInTransaction(database, {
        parentSessionId: child.parent_session_id,
        proxyInteractionId: proxyId,
        decision: event.type === 'approval.granted' ? 'approve_once' : 'reject',
        childAppliedRevision: revision,
      });
    }
  }
}

/** Offline publication check; never used in the ordinary startup reader. */
export function validateChildApprovalProxyContinuity(database: Database): void {
  const rows = database
    .query<Row, []>('SELECT * FROM child_approval_proxies ORDER BY proxy_interaction_id')
    .all();
  for (const row of rows) {
    const proxy = rowToRecord(row);
    if (proxy.proxyInteractionId !== childApprovalProxyId(proxy))
      throw new Error('Child approval proxy identifier differs from its child request.');
    const intent = database
      .query<
        {
          parent_session_id: string;
          child_invocation_id: string;
          origin_tool_call_id: string;
          grant_digest: string;
          dispatch_ack_event_id: string | null;
        },
        [string]
      >(`SELECT parent_session_id,child_invocation_id,origin_tool_call_id,grant_digest,
      dispatch_ack_event_id FROM child_session_intents WHERE child_thread_id=? LIMIT 1`)
      .get(proxy.childThreadId);
    if (
      !intent ||
      intent.parent_session_id !== proxy.parentSessionId ||
      intent.child_invocation_id !== proxy.childInvocationId ||
      (parseFollowupChildApprovalParentToolCallId(proxy.parentToolCallId)
        ? !validHistoricalFollowupApprovalIdentity(database, proxy)
        : intent.origin_tool_call_id !== proxy.parentToolCallId ||
          intent.grant_digest !== proxy.grantDigest) ||
      !intent.dispatch_ack_event_id
    )
      throw new Error('Child approval proxy lost its acknowledged parent intent.');
    const request = database
      .query<{ event_json: string }, [string, number]>(
        'SELECT event_json FROM runtime_events WHERE session_id=? AND sequence=? LIMIT 1',
      )
      .get(proxy.childThreadId, proxy.childRequestRevision);
    const requestEvent = request
      ? (JSON.parse(request.event_json) as Record<string, unknown>)
      : null;
    if (
      !request ||
      requestEvent?.type !== 'approval.requested' ||
      requestEvent.interactionId !== proxy.childInteractionId ||
      requestEvent.toolCallId !== proxy.childToolCallId ||
      `sha256:${createHash('sha256').update(request.event_json).digest('hex')}` !==
        proxy.approvalDigest
    )
      throw new Error('Child approval proxy lost its exact request Event.');
    if (proxy.status === 'decided' || proxy.status === 'applied') {
      const receipt = database
        .query<
          {
            request_digest: string;
            target_session_id: string;
            committed_revision: number;
          },
          [string, string]
        >(`SELECT request_digest,target_session_id,committed_revision
        FROM runtime_command_receipts WHERE scope_session_id=? AND command_id=? LIMIT 1`)
        .get(proxy.parentSessionId, proxy.parentCommandId!);
      if (
        !receipt ||
        receipt.request_digest !== proxy.parentCommandDigest ||
        receipt.target_session_id !== proxy.parentSessionId ||
        receipt.committed_revision !== proxy.parentDecisionRevision
      )
        throw new Error('Child approval proxy lost its parent decision receipt.');
    }
    if (proxy.status === 'applied') {
      const application = database
        .query<{ event_json: string }, [string, number]>(
          'SELECT event_json FROM runtime_events WHERE session_id=? AND sequence=? LIMIT 1',
        )
        .get(proxy.childThreadId, proxy.childAppliedRevision!);
      const applied = application
        ? (JSON.parse(application.event_json) as Record<string, unknown>)
        : null;
      if (
        !applied ||
        applied.type !==
          (proxy.decision === 'approve_once' ? 'approval.granted' : 'approval.rejected') ||
        applied.interactionId !== proxy.childInteractionId ||
        applied.toolCallId !== proxy.childToolCallId ||
        applied.generation !== proxy.childGeneration
      )
        throw new Error('Child approval proxy lost its child application Event.');
    }
  }
}
