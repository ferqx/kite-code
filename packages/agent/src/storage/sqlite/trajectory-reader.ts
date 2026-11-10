import { createHash } from 'node:crypto';
import {
  decodeTrajectoryEvent,
  evidenceOpenSchema,
  type HistoryCoverage,
  type TrajectoryEvent,
  type TrajectoryIntegrity,
  type TrajectoryPage,
  type TrajectoryScope,
  trajectoryIdentityPayload,
  trajectoryReadRequestSchema,
  trajectoryScopeSchema,
} from '@kite-ai/trajectory';
import { canonicalJson } from '../../json';
import type { Store } from '../port';
import { AgentError, type Json } from '../types';
import type { SqliteOperations } from './operations';
import type { TrajectoryBinding } from './trajectory-facts';
import { sessionHistoryCollectedAt } from './workspace-removal';

type Row = Record<string, string | number | bigint | null>;
type Reason = TrajectoryIntegrity['reasons'][number];
const maxPageBytes = 512 * 1024;
const recordedStatuses = new Set([
  'accepted',
  'applied',
  'rejected',
  'needs_review',
  'running',
  'waiting_interaction',
  'waiting_execution',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'planned',
  'dispatching',
  'succeeded',
  'outcome_unknown',
  'pending',
  'answered',
  'complete',
  'incomplete',
]);
const digest = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const eventId = (storeId: string, cursor: string, legacy = false) =>
  `te_${createHash('sha256')
    .update(trajectoryIdentityPayload({ storeId, cursor }, legacy ? storeId : undefined))
    .digest('hex')}`;

function request<T>(
  input: T & { subjectId: string },
  schema: { parse(value: unknown): T },
): { subjectId: string; query: T } {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    typeof input.subjectId !== 'string' ||
    input.subjectId.length < 1 ||
    input.subjectId.length > 256
  )
    throw new AgentError('trajectory_scope_denied');
  const { subjectId, ...value } = input;
  try {
    return { subjectId, query: schema.parse(value) };
  } catch {
    throw new AgentError('invalid_trajectory_request');
  }
}

/** An observation never needs a live owner or executable permission. */
function authorize(db: SqliteOperations, scope: TrajectoryScope, subjectId: string) {
  db.identity(scope.storeId);
  const session = db.row('SELECT * FROM session WHERE id=?', scope.sessionId);
  if (!session) throw new AgentError('history_unavailable');
  const creator = db.row(
    `SELECT c.subject_id FROM command c JOIN session root ON root.id=c.session_id
     WHERE root.id=? AND root.parent_id IS NULL AND c.kind='session.create'`,
    session.root_id!,
  );
  if (!creator || creator.subject_id !== subjectId) throw new AgentError('trajectory_scope_denied');
  const workspace = db.row('SELECT metadata_json FROM workspace WHERE id=?', session.workspace_id!);
  if (!workspace) throw new AgentError('history_unavailable');
  if (sessionHistoryCollectedAt(workspace.metadata_json, String(session.root_id)) !== null)
    throw new AgentError('history_unavailable');
  if (
    scope.runId !== undefined &&
    !db.row('SELECT id FROM run WHERE id=? AND session_id=?', scope.runId, scope.sessionId)
  )
    throw new AgentError('trajectory_scope_denied');
  if (scope.executionId !== undefined) {
    const execution = db.row(
      'SELECT run_id FROM execution WHERE id=? AND session_id=?',
      scope.executionId,
      scope.sessionId,
    );
    if (!execution || (scope.runId !== undefined && execution.run_id !== scope.runId))
      throw new AgentError('trajectory_scope_denied');
  }
  const meta = db.row('SELECT * FROM storage_meta WHERE singleton=1')!;
  const enabled = meta.trajectory_enabled_after_cursor;
  return {
    workspaceId: String(session.workspace_id),
    upper: String(meta.last_change_cursor),
    hasFacts: enabled !== undefined,
    enabledAfter: enabled === undefined ? String(meta.last_change_cursor) : String(enabled),
  };
}

function bounds(after: string, upper: string, current: string): void {
  if (BigInt(after) > BigInt(upper) || BigInt(upper) > BigInt(current))
    throw new AgentError('cursor_ahead');
}
function initialIntegrity(): TrajectoryIntegrity {
  return { facts: 'complete', identityConfidence: 'verified_origin', reasons: [] };
}
function reason(integrity: TrajectoryIntegrity, code: Reason, affectsFacts = true): void {
  if (!integrity.reasons.includes(code)) integrity.reasons.push(code);
  if (affectsFacts) integrity.facts = 'partial';
  if (code === 'legacy_format' || code === 'identity_unverified')
    integrity.identityConfidence = 'legacy_local';
}

/** Only the event envelope and finite old log metadata leave SQLite for event scanning.
 * Private material checkpoints are extracted only by the separate Evidence read. */
function columns(hasFacts: boolean): string {
  const fact = hasFacts ? 'trajectory_fact_json' : 'NULL';
  return `cursor,scope_session_id,revision,type,
    ${hasFacts ? 'trajectory_fact_json IS NOT NULL' : '0'} AS fact_present,
    CASE WHEN json_valid(${fact}) THEN json_extract(${fact},'$.format') END AS fact_format,
    CASE WHEN json_valid(${fact}) THEN json_extract(${fact},'$.version') END AS fact_version,
    CASE WHEN json_valid(${fact}) THEN json_extract(${fact},'$.event') END AS event_json,
    CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.format') END AS log_format,
    CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.version') END AS log_version,
    CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.occurredAt') END AS occurred_at,
    CASE WHEN json_valid(payload_json) AND length(json_extract(payload_json,'$.snapshot'))<=4096
      THEN json_extract(payload_json,'$.snapshot') END AS log_snapshot`;
}
function scan(
  db: SqliteOperations,
  hasFacts: boolean,
  after: string,
  upper: string,
  count: number,
  sessionId?: string,
): Row[] {
  return db.rows(
    `SELECT ${columns(hasFacts)} FROM change_event WHERE cursor>? AND cursor<=?${sessionId === undefined ? '' : ' AND scope_session_id=?'} ORDER BY cursor LIMIT ?`,
    after,
    upper,
    ...(sessionId === undefined ? [] : [sessionId]),
    count,
  );
}

function fallback(
  row: Row,
  scope: TrajectoryScope,
  workspaceId: string,
  integrity: TrajectoryIntegrity,
  code: Reason,
): TrajectoryEvent {
  reason(integrity, code);
  const sequence = String(row.cursor);
  if (code === 'unknown_version' && typeof row.event_json === 'string') {
    try {
      const value = decodeTrajectoryEvent(JSON.parse(row.event_json));
      const envelope =
        value.status === 'supported'
          ? value.event
          : value.status === 'unsupported_version'
            ? value.envelope
            : null;
      if (
        envelope &&
        envelope.sequence === sequence &&
        envelope.origin.cursor === sequence &&
        envelope.sessionId === scope.sessionId &&
        envelope.workspaceId === workspaceId &&
        envelope.sourceEventType === row.type &&
        envelope.eventId === eventId(envelope.origin.storeId, envelope.origin.cursor)
      ) {
        return {
          schema: 'kite.trajectory',
          schemaVersion: 1,
          eventId: envelope.eventId,
          sequence,
          origin: envelope.origin,
          sessionId: scope.sessionId,
          workspaceId,
          sourceEventType: envelope.sourceEventType,
          sourceRecordRevision: String(row.revision),
          identityConfidence: 'verified_origin',
          kind: 'unknown',
          phase: 'observed',
          recordedStatus: null,
          occurredAt: null,
          evidenceRefs: [],
          attributes: { reason: 'unsupported_version' },
        };
      }
    } catch {
      /* Unknown versions retain only an independently validated safe identity. */
    }
  }
  reason(integrity, 'identity_unverified');
  let recordedStatus: string | null = null,
    occurredAt: number | null = null;
  // Only the old bounded snapshot is evidence; never query a current business state here.
  if (
    row.log_format === 'kite.session-log' &&
    row.log_version === 1n &&
    typeof row.log_snapshot === 'string'
  ) {
    try {
      const snapshot = JSON.parse(row.log_snapshot) as { recordedStatus?: unknown };
      if (
        typeof snapshot.recordedStatus === 'string' &&
        recordedStatuses.has(snapshot.recordedStatus)
      )
        recordedStatus = snapshot.recordedStatus;
      if (
        typeof row.occurred_at === 'bigint' &&
        row.occurred_at >= 0n &&
        row.occurred_at <= BigInt(Number.MAX_SAFE_INTEGER)
      )
        occurredAt = Number(row.occurred_at);
    } catch {
      /* Bad optional old metadata does not expose payload or current rows. */
    }
  }
  return {
    schema: 'kite.trajectory',
    schemaVersion: 1,
    eventId: eventId(scope.storeId, sequence, true),
    sequence,
    origin: { storeId: scope.storeId, cursor: sequence },
    sessionId: scope.sessionId,
    workspaceId,
    sourceEventType:
      typeof row.type === 'string' && /^[a-z][a-z0-9_.]{0,255}$/.test(row.type)
        ? row.type
        : 'unavailable',
    sourceRecordRevision: String(row.revision),
    identityConfidence: 'legacy_local',
    kind: 'unknown',
    phase: 'observed',
    recordedStatus,
    occurredAt,
    evidenceRefs: [],
    attributes: {
      reason: code === 'unknown_version' ? 'unsupported_version' : 'legacy_fields_missing',
    },
  };
}

function decode(
  row: Row,
  scope: TrajectoryScope,
  workspaceId: string,
  enabledAfter: string,
  integrity: TrajectoryIntegrity,
): TrajectoryEvent {
  if (!row.fact_present)
    return fallback(
      row,
      scope,
      workspaceId,
      integrity,
      BigInt(String(row.cursor)) <= BigInt(enabledAfter) ? 'legacy_format' : 'missing_fact',
    );
  if (row.fact_format !== 'kite.trajectory-fact')
    return fallback(row, scope, workspaceId, integrity, 'corrupt_fact');
  if (row.fact_version !== 1n)
    return fallback(row, scope, workspaceId, integrity, 'unknown_version');
  let decoded: ReturnType<typeof decodeTrajectoryEvent>;
  try {
    decoded = decodeTrajectoryEvent(
      typeof row.event_json === 'string' ? JSON.parse(row.event_json) : null,
    );
  } catch {
    return fallback(row, scope, workspaceId, integrity, 'corrupt_fact');
  }
  if (decoded.status !== 'supported')
    return fallback(
      row,
      scope,
      workspaceId,
      integrity,
      decoded.status === 'unsupported_version' ? 'unknown_version' : 'corrupt_fact',
    );
  const event = decoded.event;
  if (
    event.sequence !== String(row.cursor) ||
    event.origin.cursor !== String(row.cursor) ||
    event.sessionId !== scope.sessionId ||
    event.workspaceId !== workspaceId ||
    event.sourceEventType !== row.type ||
    event.eventId !==
      eventId(
        event.origin.storeId,
        event.origin.cursor,
        event.identityConfidence === 'legacy_local',
      )
  )
    return fallback(row, scope, workspaceId, integrity, 'corrupt_fact');
  if (event.kind === 'unknown') reason(integrity, 'unknown_event');
  if (event.identityConfidence === 'legacy_local') reason(integrity, 'identity_unverified');
  for (const ref of event.evidenceRefs) {
    if (ref.availability === 'missing' || ref.availability === 'unavailable')
      reason(integrity, 'missing_material', false);
    if (ref.availability === 'partial' || ref.availability === 'truncated')
      reason(integrity, 'truncated_material', false);
  }
  return event;
}
function matches(event: TrajectoryEvent, scope: TrajectoryScope): boolean {
  return (
    (scope.runId === undefined || scope.runId === event.runId) &&
    (scope.executionId === undefined || scope.executionId === event.executionId) &&
    (scope.eventKinds === undefined || scope.eventKinds.some((kind) => kind === event.kind))
  );
}

export function openTrajectory(
  db: SqliteOperations,
  input: Parameters<Store['openTrajectory']>[0],
): ReturnType<Store['openTrajectory']> extends Promise<infer T> ? T : never {
  const { subjectId, query } = request(input, trajectoryScopeSchema);
  db.db.run('BEGIN');
  try {
    const source = authorize(db, query, subjectId),
      integrity = initialIntegrity();
    // Coverage is a finite SQL summary of retained format/provenance, not an eager replay.
    // Semantic validation belongs to each bounded event page; no reader or coverage ledger is stored.
    const fact = source.hasFacts ? 'trajectory_fact_json' : 'NULL';
    const filterSql: string[] = [];
    const filterValues: string[] = [];
    if (query.runId !== undefined) {
      filterSql.push('run_id=?');
      filterValues.push(query.runId);
    }
    if (query.executionId !== undefined) {
      filterSql.push('execution_id=?');
      filterValues.push(query.executionId);
    }
    if (query.eventKinds !== undefined) {
      filterSql.push(
        query.eventKinds.length ? `kind IN (${query.eventKinds.map(() => '?').join(',')})` : '0',
      );
      filterValues.push(...query.eventKinds);
    }
    const summary = db.row(
      `WITH retained AS (
      SELECT cursor,${fact} AS fact FROM change_event WHERE scope_session_id=? AND cursor<=?
    ), classified AS (
      SELECT cursor,fact,json_valid(fact) AS valid,
        CASE WHEN json_valid(fact) THEN json_extract(fact,'$.format') END AS format,
        CASE WHEN json_valid(fact) THEN json_extract(fact,'$.version') END AS version,
        CASE WHEN json_valid(fact) THEN json_extract(fact,'$.event.schema') END AS event_schema,
        CASE WHEN json_valid(fact) THEN json_extract(fact,'$.event.schemaVersion') END AS event_version,
        CASE WHEN json_valid(fact) THEN json_extract(fact,'$.event.runId') END AS run_id,
        CASE WHEN json_valid(fact) THEN json_extract(fact,'$.event.executionId') END AS execution_id,
        CASE WHEN json_valid(fact) THEN json_extract(fact,'$.event.kind') END AS kind
      FROM retained
    ) SELECT COUNT(*) AS count,
      SUM(CASE WHEN fact IS NULL AND cursor<=? THEN 1 ELSE 0 END) AS legacy,
      SUM(CASE WHEN fact IS NULL AND cursor>? THEN 1 ELSE 0 END) AS missing,
      SUM(CASE WHEN fact IS NOT NULL AND (NOT valid OR format IS NOT 'kite.trajectory-fact' OR event_schema IS NOT 'kite.trajectory') THEN 1 ELSE 0 END) AS corrupt,
      SUM(CASE WHEN valid AND format='kite.trajectory-fact' AND (version IS NOT 1 OR event_version IS NOT 1) THEN 1 ELSE 0 END) AS future,
      SUM(CASE WHEN kind='unknown' THEN 1 ELSE 0 END) AS unknown
      FROM classified ${filterSql.length ? `WHERE (fact IS NULL OR NOT valid OR format IS NOT 'kite.trajectory-fact' OR version IS NOT 1 OR event_schema IS NOT 'kite.trajectory' OR event_version IS NOT 1) OR (${filterSql.join(' AND ')})` : ''}`,
      query.sessionId,
      source.upper,
      source.enabledAfter,
      source.enabledAfter,
      ...filterValues,
    )!;
    if (BigInt(summary.count ?? 0) > 0n) integrity.facts = 'unknown';
    if (BigInt(summary.legacy ?? 0) > 0n || (!source.hasFacts && !summary.count))
      reason(integrity, 'legacy_format');
    if (BigInt(summary.missing ?? 0) > 0n) reason(integrity, 'missing_fact');
    if (BigInt(summary.corrupt ?? 0) > 0n) reason(integrity, 'corrupt_fact');
    if (BigInt(summary.future ?? 0) > 0n) reason(integrity, 'unknown_version');
    if (BigInt(summary.unknown ?? 0) > 0n) reason(integrity, 'unknown_event');
    const historyCoverage: HistoryCoverage = {
      enabledAfterCursor: source.enabledAfter,
      upperCursor: source.upper,
      status: integrity.reasons.includes('legacy_format')
        ? 'legacy'
        : integrity.reasons.some((code) =>
              ['missing_fact', 'corrupt_fact', 'unknown_version'].includes(code),
            )
          ? 'unknown'
          : 'retained',
      integrity,
    };
    const snapshot = {
      ...query,
      upperCursor: source.upper,
      formatVersion: 1 as const,
      historyCoverage,
    };
    db.db.run('COMMIT');
    return snapshot;
  } catch (error) {
    return db.rollback(error);
  }
}

export function readTrajectoryEvents(
  db: SqliteOperations,
  input: Parameters<Store['readTrajectoryEvents']>[0],
): TrajectoryPage {
  const { subjectId, query } = request(input, trajectoryReadRequestSchema);
  db.db.run('BEGIN');
  try {
    const source = authorize(db, query, subjectId);
    bounds(query.afterCursor, query.upperCursor, source.upper);
    const { afterCursor, upperCursor, limit: _limit, ...scope } = query;
    const rows = scan(db, source.hasFacts, afterCursor, upperCursor, query.limit ?? 200);
    const integrity = initialIntegrity(),
      events: TrajectoryEvent[] = [];
    let through = afterCursor,
      bytes = 2048;
    for (const row of rows) {
      if (row.scope_session_id === scope.sessionId) {
        const eventIntegrity = initialIntegrity();
        const event = decode(row, scope, source.workspaceId, source.enabledAfter, eventIntegrity);
        const selected = matches(event, scope);
        // Invalid envelopes cannot prove that they were outside the requested scope.
        if (
          selected ||
          eventIntegrity.reasons.some((code) =>
            ['legacy_format', 'missing_fact', 'corrupt_fact', 'unknown_version'].includes(code),
          )
        ) {
          for (const code of eventIntegrity.reasons)
            reason(integrity, code, !['missing_material', 'truncated_material'].includes(code));
        }
        if (selected) {
          const eventBytes = Buffer.byteLength(canonicalJson(event as unknown as Json));
          if (bytes + eventBytes > maxPageBytes) {
            if (through === afterCursor) throw new AgentError('trajectory_event_too_large');
            break;
          }
          bytes += eventBytes;
          events.push(event);
        }
      }
      through = String(row.cursor);
    }
    if (
      rows.length < (query.limit ?? 200) &&
      through === String(rows.at(-1)?.cursor ?? afterCursor)
    )
      through = upperCursor;
    const page: TrajectoryPage = {
      ...scope,
      afterCursor,
      upperCursor,
      scannedThrough: through,
      exhausted: through === upperCursor,
      events,
      integrity,
    };
    if (Buffer.byteLength(canonicalJson(page as unknown as Json)) > maxPageBytes)
      throw new AgentError('trajectory_page_too_large');
    db.db.run('COMMIT');
    return page;
  } catch (error) {
    return db.rollback(error);
  }
}

export function readTrajectoryBinding(
  db: SqliteOperations,
  input: Parameters<Store['readTrajectoryBinding']>[0],
): Awaited<ReturnType<Store['readTrajectoryBinding']>> {
  const { subjectId, query } = request(input, evidenceOpenSchema);
  db.db.run('BEGIN');
  try {
    const source = authorize(db, query, subjectId);
    bounds(query.atCursor, query.upperCursor, source.upper);
    if (!source.hasFacts) throw new AgentError('trajectory_evidence_unavailable');
    const rows = db.rows(
      `SELECT ${columns(true)},trajectory_fact_json FROM change_event
       WHERE scope_session_id=? AND cursor<=? AND json_valid(trajectory_fact_json)
       AND json_extract(trajectory_fact_json,'$.event.eventId')=? LIMIT 2`,
      query.sessionId,
      query.atCursor,
      query.eventId,
    );
    if (rows.length !== 1) throw new AgentError('trajectory_evidence_unavailable');
    const row = rows[0]!,
      integrity = initialIntegrity();
    const event = decode(row, query, source.workspaceId, source.enabledAfter, integrity);
    if (
      event.eventId !== query.eventId ||
      integrity.reasons.some((code) =>
        ['corrupt_fact', 'unknown_version', 'identity_unverified'].includes(code),
      )
    )
      throw new AgentError('trajectory_evidence_unavailable');
    const fact = JSON.parse(String(row.trajectory_fact_json)) as { bindings?: TrajectoryBinding[] };
    const refs = event.evidenceRefs.filter(
      (ref) => ref.evidenceId === query.evidenceId && ref.contentVersion === query.contentVersion,
    );
    const bindings = Array.isArray(fact.bindings)
      ? fact.bindings.filter(
          (binding) =>
            binding &&
            binding.evidenceId === query.evidenceId &&
            binding.contentVersion === query.contentVersion,
        )
      : [];
    if (refs.length !== 1 || bindings.length !== 1)
      throw new AgentError('trajectory_evidence_unavailable');
    const binding = bindings[0]!;
    if (
      binding.kind !== refs[0]!.kind ||
      digest(binding.value) !== binding.contentVersion ||
      `ev_${digest([event.eventId, binding.kind, binding.contentVersion])}` !== binding.evidenceId
    )
      throw new AgentError('trajectory_evidence_unavailable');
    const result = {
      event,
      binding: {
        evidenceId: binding.evidenceId,
        contentVersion: binding.contentVersion,
        kind: binding.kind,
        value: binding.value,
      },
    };
    db.db.run('COMMIT');
    return result;
  } catch (error) {
    return db.rollback(error);
  }
}
