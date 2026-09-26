import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { CROSS_SESSION_FOLLOWUP_PRE_DISPATCH_EXPIRED } from '@kite-ai/runtime-host/storage';

type RecordValue = Record<string, unknown>;
const parse = (json: string): RecordValue => JSON.parse(json) as RecordValue;
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};

/** Historical proof uses immutable Events and the source release receipt, not the latest State. */
export function readProvenUnfundedExpiredFollowupRelease(
  database: Database,
  sourceSessionId: string,
  targetSessionId: string,
  submissionId: string,
): Readonly<{ targetRunId: string }> | null {
  const row = database
    .query<
      {
        message_id: string;
        source_revision: number;
        release_revision: number;
        release_digest: string;
        released_at_ms: number;
        admission_artifact_id: string;
        admission_digest: string;
        admission_json: string;
        admission_bytes: number;
        source_current_revision: number;
      },
      [string, string, string]
    >(
      `SELECT o.message_id,o.source_revision,
        o.accepted_release_source_revision AS release_revision,
        o.accepted_release_evidence_digest AS release_digest,
        o.accepted_released_at_ms AS released_at_ms,
        o.followup_admission_artifact_id AS admission_artifact_id,
        o.followup_admission_digest AS admission_digest,
        a.canonical_json AS admission_json,a.byte_length AS admission_bytes,
        source.revision AS source_current_revision
       FROM agent_mail_outbox o
       JOIN runtime_sessions source ON source.session_id=o.source_session_id
       JOIN runtime_sessions target ON target.session_id=o.target_session_id
       JOIN agent_followup_admission_artifacts a ON a.artifact_id=o.followup_admission_artifact_id
       WHERE o.source_session_id=? AND o.target_session_id=? AND o.submission_id=?
         AND o.mode='trigger_turn' AND o.accepted_release_reason='expired'
         AND target.parent_session_id=source.session_id
         AND target.workspace_id=source.workspace_id AND target.project_id=source.project_id
         AND target.workspace_digest=source.workspace_digest`,
    )
    .get(sourceSessionId, targetSessionId, submissionId);
  if (
    !row ||
    row.release_revision < row.source_revision ||
    row.source_current_revision < row.release_revision ||
    !/^sha256:[a-f0-9]{64}$/u.test(row.release_digest) ||
    `sha256:${createHash('sha256').update(row.admission_json).digest('hex')}` !==
      row.admission_digest ||
    row.admission_artifact_id !== `pa_${row.admission_digest.slice(7)}` ||
    row.admission_bytes !== Buffer.byteLength(row.admission_json, 'utf8')
  )
    return null;
  const admission = parse(row.admission_json);
  if (
    admission.sourceSessionId !== sourceSessionId ||
    admission.targetSessionId !== targetSessionId ||
    admission.submissionId !== submissionId ||
    admission.messageId !== row.message_id ||
    !Number.isSafeInteger(admission.deadlineAt) ||
    row.released_at_ms < Number(admission.deadlineAt)
  )
    return null;
  const run = database
    .query<{ run_id: string; status: string; created_revision: number }, [string, string]>(
      'SELECT run_id,status,created_revision FROM runtime_runs WHERE session_id=? AND start_command_id=?',
    )
    .get(targetSessionId, `followup:${submissionId}`);
  if (!run || run.status !== 'failed') return null;
  const latestRun = database
    .query<{ run_id: string }, [string]>(
      'SELECT run_id FROM runtime_runs WHERE session_id=? ORDER BY created_revision DESC LIMIT 1',
    )
    .get(targetSessionId);
  if (
    latestRun?.run_id === run.run_id &&
    database
      .query<{ found: number }, [string]>(
        'SELECT 1 AS found FROM runtime_effect_leases WHERE session_id=? LIMIT 1',
      )
      .get(targetSessionId)
  )
    return null;
  if (
    database
      .query<{ found: number }, [string, string]>(
        'SELECT 1 AS found FROM agent_followup_funding_receipts WHERE source_session_id=? AND submission_id=?',
      )
      .get(sourceSessionId, submissionId) ||
    database
      .query<{ found: number }, [string, string]>(
        'SELECT 1 AS found FROM agent_followup_routes WHERE target_session_id=? AND submission_id=?',
      )
      .get(targetSessionId, submissionId)
  )
    return null;
  const sourceReleaseCount =
    database
      .query<{ count: number }, [string, string]>(
        `SELECT count(*) AS count FROM runtime_events WHERE session_id=?
       AND json_extract(event_json,'$.type')='resource_budget.released'
       AND json_extract(event_json,'$.reservationId')=?`,
      )
      .get(sourceSessionId, String(admission.backupReservationId))?.count ?? 0;
  if (sourceReleaseCount !== 1) return null;
  const events = database
    .query<{ sequence: number; event_json: string }, [string]>(
      'SELECT sequence,event_json FROM runtime_events WHERE session_id=? ORDER BY sequence',
    )
    .all(targetSessionId)
    .map((item) => ({ sequence: item.sequence, event: parse(item.event_json) }));
  const prepared = events.filter(
    ({ event, sequence }) =>
      event.type === 'agent.followup_turn_prepared' &&
      event.sourceSessionId === sourceSessionId &&
      event.submissionId === submissionId &&
      event.targetRunId === run.run_id &&
      typeof event.taskId === 'string' &&
      sequence <= run.created_revision,
  );
  if (prepared.length !== 1) return null;
  const taskId = prepared[0]!.event.taskId;
  const terminal = events.filter(
    ({ event }) =>
      event.type === 'run.error' &&
      event.turnId === run.run_id &&
      event.message === CROSS_SESSION_FOLLOWUP_PRE_DISPATCH_EXPIRED,
  );
  if (terminal.length !== 1) return null;
  const bounded = events.filter(
    ({ sequence }) => sequence >= prepared[0]!.sequence && sequence <= terminal[0]!.sequence,
  );
  const count = (type: string, match: (event: RecordValue) => boolean): number =>
    bounded.filter(({ event }) => event.type === type && match(event)).length;
  const models = bounded.filter(
    ({ event }) => event.type === 'model.invocation_prepared' && event.purpose === 'primary_agent',
  );
  if (models.length !== 1) return null;
  const model = models[0]!.event;
  const invocationId = model.invocationId;
  const reservationId = record(model.budget).reservationId;
  if (
    typeof invocationId !== 'string' ||
    !invocationId ||
    typeof reservationId !== 'string' ||
    !reservationId ||
    count(
      'task.failed',
      (event) =>
        event.taskId === taskId && event.reason === CROSS_SESSION_FOLLOWUP_PRE_DISPATCH_EXPIRED,
    ) !== 1 ||
    count(
      'turn.aborted',
      (event) =>
        event.turnId === run.run_id &&
        event.cause === 'error' &&
        event.reason === CROSS_SESSION_FOLLOWUP_PRE_DISPATCH_EXPIRED,
    ) !== 1 ||
    count(
      'resource_budget.released',
      (event) =>
        event.reservationId === reservationId && event.proof === 'local_pre_dispatch_failure',
    ) !== 1 ||
    events.some(
      ({ event }) =>
        event.type === 'model.invocation_attempt_started' && event.invocationId === invocationId,
    ) ||
    events.some(
      ({ event }) =>
        event.type === 'resource_budget.dispatch_started' && event.reservationId === reservationId,
    )
  )
    return null;
  return Object.freeze({ targetRunId: run.run_id });
}
