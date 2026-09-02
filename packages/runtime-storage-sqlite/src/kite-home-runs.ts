import type { Database } from 'bun:sqlite';
import {
  assertRuntimeStoredRun,
  decodeRuntimeRunTerminal,
  encodeRuntimeRunTerminal,
  type RuntimeRunForkInput,
  type RuntimeRunPageRequest,
  type RuntimeRunStorePort,
  type RuntimeRunTransition,
  type RuntimeStoredRun,
} from '@kite-ai/runtime-host/storage';
import { assertKiteHomeStoreSchema } from './kite-home-store';
import type { KiteHomeWorkspaceAdmission } from './kite-home-workspaces';
import type { KiteHomeWriteTransactionPort } from './kite-home-write';

interface RunRow {
  readonly session_id: string;
  readonly run_id: string;
  readonly origin_session_id: string | null;
  readonly origin_run_id: string | null;
  readonly start_command_id: string;
  readonly phase: RuntimeStoredRun['phase'];
  readonly status: RuntimeStoredRun['status'];
  readonly created_revision: number;
  readonly last_revision: number;
  readonly created_at_ms: number;
  readonly started_at_ms: number | null;
  readonly finished_at_ms: number | null;
  readonly terminal_json: string | null;
}

interface RunSessionRow {
  readonly workspace_id: string;
  readonly project_id: string;
  readonly workspace_digest: string;
  readonly state_schema: number;
  readonly format_epoch: string;
  readonly revision: number;
  readonly run_index_from_revision: number;
}

/** Canonical Run port for one Workspace scope inside the shared Store 9 connection. */
export function createKiteHomeRuntimeRunStore(input: {
  readonly database: Database;
  readonly writer: KiteHomeWriteTransactionPort;
  readonly assertStoreSchema?: (database: Database) => void;
  readonly workspace: KiteHomeWorkspaceAdmission;
  readonly stateSchemaVersion: number;
  readonly formatEpoch: string;
  readonly isClosed: () => boolean;
}): RuntimeRunStorePort {
  (input.assertStoreSchema ?? assertKiteHomeStoreSchema)(input.database);
  const selectSession = input.database.query<RunSessionRow, [string]>(
    `SELECT workspace_id, project_id, workspace_digest, state_schema, format_epoch,
            revision, run_index_from_revision
       FROM runtime_sessions WHERE session_id = ? LIMIT 1`,
  );
  const getRun = input.database.query<RunRow, [string, string]>(
    `SELECT session_id, run_id, origin_session_id, origin_run_id, start_command_id,
            phase, status, created_revision, last_revision, created_at_ms,
            started_at_ms, finished_at_ms, terminal_json
       FROM runtime_runs WHERE session_id = ? AND run_id = ? LIMIT 1`,
  );
  const getActiveRun = input.database.query<RunRow, [string]>(
    `SELECT session_id, run_id, origin_session_id, origin_run_id, start_command_id,
            phase, status, created_revision, last_revision, created_at_ms,
            started_at_ms, finished_at_ms, terminal_json
       FROM runtime_runs WHERE session_id = ?
        AND status IN ('queued', 'running', 'waiting') LIMIT 1`,
  );
  const insertRun = input.database.query(
    `INSERT INTO runtime_runs(
      session_id, run_id, origin_session_id, origin_run_id, start_command_id,
      phase, status, created_revision, last_revision, created_at_ms,
      started_at_ms, finished_at_ms, terminal_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateRun = input.database.query(
    `UPDATE runtime_runs SET status = ?, last_revision = ?, started_at_ms = ?,
      finished_at_ms = ?, terminal_json = ?
      WHERE session_id = ? AND run_id = ? AND last_revision = ?`,
  );
  const selectRunsThrough = input.database.query<RunRow, [string, number]>(
    `SELECT session_id, run_id, origin_session_id, origin_run_id, start_command_id,
            phase, status, created_revision, last_revision, created_at_ms,
            started_at_ms, finished_at_ms, terminal_json
       FROM runtime_runs WHERE session_id = ? AND created_revision <= ?
      ORDER BY created_revision ASC, run_id ASC`,
  );
  const countRuns = input.database.query<{ count: number }, [string]>(
    'SELECT count(*) AS count FROM runtime_runs WHERE session_id = ?',
  );
  const deleteRunsAfter = input.database.query(
    'DELETE FROM runtime_runs WHERE session_id = ? AND created_revision > ?',
  );
  const updateCoverageBoundary = input.database.query(
    'UPDATE runtime_sessions SET run_index_from_revision = ? WHERE session_id = ?',
  );

  const port: RuntimeRunStorePort = {
    get(sessionId, runId) {
      assertOpen(input.isClosed);
      assertIdentity(sessionId, 'Session');
      assertIdentity(runId, 'Run');
      const row = getRun.get(sessionId, runId);
      if (!row) {
        assertSessionScope(selectSession.get(sessionId), input);
        return null;
      }
      const run = runFromRow(row);
      assertRunWithinSession(selectSession.get(sessionId), run, input);
      return run;
    },
    getActive(sessionId) {
      assertOpen(input.isClosed);
      assertIdentity(sessionId, 'Session');
      const row = getActiveRun.get(sessionId);
      if (!row) {
        assertSessionScope(selectSession.get(sessionId), input);
        return null;
      }
      const run = runFromRow(row);
      assertRunWithinSession(selectSession.get(sessionId), run, input);
      return run;
    },
    list(request) {
      assertOpen(input.isClosed);
      assertPageRequest(request);
      const session = selectSession.get(request.sessionId);
      assertSessionScope(session, input);
      const filters = ['session_id = ?'];
      const values: (string | number)[] = [request.sessionId];
      if (request.status !== undefined) {
        filters.push('status = ?');
        values.push(request.status);
      }
      if (request.phase !== undefined) {
        filters.push('phase = ?');
        values.push(request.phase);
      }
      if (request.cursor !== undefined) {
        filters.push('(created_revision > ? OR (created_revision = ? AND run_id > ?))');
        values.push(
          request.cursor.createdRevision,
          request.cursor.createdRevision,
          request.cursor.runId,
        );
      }
      values.push(request.limit + 1);
      const rows = input.database
        .query<RunRow, (string | number)[]>(
          `SELECT session_id, run_id, origin_session_id, origin_run_id, start_command_id,
                  phase, status, created_revision, last_revision, created_at_ms,
                  started_at_ms, finished_at_ms, terminal_json
             FROM runtime_runs WHERE ${filters.join(' AND ')}
            ORDER BY created_revision ASC, run_id ASC LIMIT ?`,
        )
        .all(...values);
      const hasMore = rows.length > request.limit;
      const entries = rows.slice(0, request.limit).map(runFromRow);
      for (const run of entries) assertRunWithinSession(session, run, input);
      const last = entries.at(-1);
      return Object.freeze({
        entries: Object.freeze(entries),
        hasMore,
        ...(hasMore && last
          ? { nextCursor: { createdRevision: last.createdRevision, runId: last.runId } }
          : {}),
      });
    },
    insert(run) {
      assertMutation(input.writer);
      assertOpen(input.isClosed);
      assertRuntimeStoredRun(run);
      assertRunWithinSession(selectSession.get(run.sessionId), run, input);
      const active = getActiveRun.get(run.sessionId);
      if (active && active.run_id !== run.runId) {
        throw new Error(`Runtime Session ${run.sessionId} already has an active Run.`);
      }
      insertRun.run(
        run.sessionId,
        run.runId,
        run.originSessionId ?? null,
        run.originRunId ?? null,
        run.startCommandId,
        run.phase,
        run.status,
        run.createdRevision,
        run.lastRevision,
        run.createdAtMs,
        run.startedAtMs ?? null,
        run.finishedAtMs ?? null,
        run.terminal ? encodeRuntimeRunTerminal(run.terminal) : null,
      );
    },
    transition(transition) {
      assertMutation(input.writer);
      assertOpen(input.isClosed);
      assertTransition(transition);
      const current = getRun.get(transition.sessionId, transition.runId);
      if (!current) {
        assertSessionScope(selectSession.get(transition.sessionId), input);
        return 'missing';
      }
      if (current.last_revision !== transition.expectedLastRevision) return 'conflict';
      const existing = runFromRow(current);
      assertImmutableRunIdentity(existing, transition.next);
      assertLifecycleTransition(existing, transition.next);
      if (
        transition.next.lastRevision === transition.expectedLastRevision &&
        !(
          existing.status === 'queued' &&
          transition.next.status === 'running' &&
          existing.phase === transition.next.phase
        )
      ) {
        throw new Error('Runtime Run may reuse a revision only for queued activation.');
      }
      assertRunWithinSession(selectSession.get(transition.sessionId), transition.next, input);
      const result = updateRun.run(
        transition.next.status,
        transition.next.lastRevision,
        transition.next.startedAtMs ?? null,
        transition.next.finishedAtMs ?? null,
        transition.next.terminal ? encodeRuntimeRunTerminal(transition.next.terminal) : null,
        transition.sessionId,
        transition.runId,
        transition.expectedLastRevision,
      );
      return result.changes === 1 ? 'applied' : 'conflict';
    },
    rewindSession(sessionId, targetRevision) {
      assertMutation(input.writer);
      assertOpen(input.isClosed);
      assertIdentity(sessionId, 'Session');
      assertRevision(targetRevision, 'rewind target');
      const session = selectSession.get(sessionId);
      if (
        !sessionMatches(session, input) ||
        targetRevision < session.run_index_from_revision ||
        targetRevision > session.revision
      ) {
        return { status: 'invalid_boundary' };
      }
      const retained = selectRunsThrough.all(sessionId, targetRevision).map(runFromRow);
      if (retained.some((run) => !isSettledRunThrough(run, targetRevision))) {
        return { status: 'invalid_boundary' };
      }
      const result = deleteRunsAfter.run(sessionId, targetRevision);
      return { status: 'applied', deletedCount: result.changes };
    },
    forkSession(forkInput) {
      assertMutation(input.writer);
      assertOpen(input.isClosed);
      assertForkInput(forkInput);
      const source = selectSession.get(forkInput.sourceSessionId);
      const target = selectSession.get(forkInput.targetSessionId);
      if (
        forkInput.sourceSessionId === forkInput.targetSessionId ||
        !sessionMatches(source, input) ||
        !sessionMatches(target, input) ||
        forkInput.throughRevision < source.run_index_from_revision ||
        forkInput.throughRevision > source.revision ||
        target.revision !== forkInput.throughRevision ||
        (countRuns.get(forkInput.targetSessionId)?.count ?? 0) !== 0
      ) {
        return { status: 'invalid_boundary' };
      }
      const sourceRuns = selectRunsThrough
        .all(forkInput.sourceSessionId, forkInput.throughRevision)
        .map(runFromRow);
      if (sourceRuns.some((run) => !isSettledRunThrough(run, forkInput.throughRevision))) {
        return { status: 'invalid_boundary' };
      }
      const boundaryUpdate = updateCoverageBoundary.run(
        source.run_index_from_revision,
        forkInput.targetSessionId,
      );
      if (boundaryUpdate.changes !== 1) return { status: 'invalid_boundary' };
      for (const run of sourceRuns) {
        insertRun.run(
          forkInput.targetSessionId,
          run.runId,
          forkInput.sourceSessionId,
          run.runId,
          run.startCommandId,
          run.phase,
          run.status,
          run.createdRevision,
          run.lastRevision,
          run.createdAtMs,
          run.startedAtMs ?? null,
          run.finishedAtMs ?? null,
          run.terminal ? encodeRuntimeRunTerminal(run.terminal) : null,
        );
      }
      return { status: 'applied', copiedCount: sourceRuns.length };
    },
  };
  return Object.freeze(port);
}

function runFromRow(row: RunRow): RuntimeStoredRun {
  const run: RuntimeStoredRun = {
    sessionId: row.session_id,
    runId: row.run_id,
    ...(row.origin_session_id === null ? {} : { originSessionId: row.origin_session_id }),
    ...(row.origin_run_id === null ? {} : { originRunId: row.origin_run_id }),
    startCommandId: row.start_command_id,
    phase: row.phase,
    status: row.status,
    createdRevision: row.created_revision,
    lastRevision: row.last_revision,
    createdAtMs: row.created_at_ms,
    ...(row.started_at_ms === null ? {} : { startedAtMs: row.started_at_ms }),
    ...(row.finished_at_ms === null ? {} : { finishedAtMs: row.finished_at_ms }),
    ...(row.terminal_json === null
      ? {}
      : { terminal: decodeRuntimeRunTerminal(row.terminal_json) }),
  };
  assertRuntimeStoredRun(run);
  return Object.freeze(run);
}

function assertRunWithinSession(
  session: RunSessionRow | null,
  run: RuntimeStoredRun,
  input: Parameters<typeof createKiteHomeRuntimeRunStore>[0],
): void {
  if (
    !sessionMatches(session, input) ||
    run.createdRevision <= session.run_index_from_revision ||
    run.lastRevision > session.revision
  ) {
    throw new Error('Runtime Run is outside its Session coverage/revision boundary.');
  }
}

function assertSessionScope(
  session: RunSessionRow | null,
  input: Parameters<typeof createKiteHomeRuntimeRunStore>[0],
): asserts session is RunSessionRow {
  if (!sessionMatches(session, input)) {
    throw new Error('Runtime Run Session is not admitted to this Workspace.');
  }
}

function sessionMatches(
  session: RunSessionRow | null,
  input: Parameters<typeof createKiteHomeRuntimeRunStore>[0],
): session is RunSessionRow {
  return Boolean(
    session &&
      session.workspace_id === input.workspace.workspaceId &&
      session.project_id === input.workspace.projectId &&
      session.workspace_digest === input.workspace.workspaceDigest &&
      session.state_schema === input.stateSchemaVersion &&
      session.format_epoch === input.formatEpoch &&
      Number.isSafeInteger(session.revision) &&
      Number.isSafeInteger(session.run_index_from_revision) &&
      session.run_index_from_revision >= 0 &&
      session.run_index_from_revision <= session.revision,
  );
}

function assertPageRequest(request: RuntimeRunPageRequest): void {
  assertIdentity(request.sessionId, 'Session');
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 200) {
    throw new RangeError('Runtime Run page limit is invalid.');
  }
  if (request.cursor) {
    assertRevision(request.cursor.createdRevision, 'cursor revision');
    assertIdentity(request.cursor.runId, 'Run cursor');
  }
}

function assertTransition(transition: RuntimeRunTransition): void {
  assertIdentity(transition.sessionId, 'Session');
  assertIdentity(transition.runId, 'Run');
  assertRevision(transition.expectedLastRevision, 'expected revision');
  assertRuntimeStoredRun(transition.next);
  if (
    transition.next.sessionId !== transition.sessionId ||
    transition.next.runId !== transition.runId ||
    transition.next.lastRevision < transition.expectedLastRevision
  ) {
    throw new Error('Runtime Run transition identity or revision is invalid.');
  }
}

function assertForkInput(input: RuntimeRunForkInput): void {
  assertIdentity(input.sourceSessionId, 'source Session');
  assertIdentity(input.targetSessionId, 'target Session');
  assertRevision(input.throughRevision, 'fork revision');
}

function assertImmutableRunIdentity(current: RuntimeStoredRun, next: RuntimeStoredRun): void {
  if (
    current.sessionId !== next.sessionId ||
    current.runId !== next.runId ||
    current.originSessionId !== next.originSessionId ||
    current.originRunId !== next.originRunId ||
    current.startCommandId !== next.startCommandId ||
    current.phase !== next.phase ||
    current.createdRevision !== next.createdRevision ||
    current.createdAtMs !== next.createdAtMs
  ) {
    throw new Error('Runtime Run transition changed immutable identity.');
  }
}

function assertLifecycleTransition(current: RuntimeStoredRun, next: RuntimeStoredRun): void {
  const allowed: Readonly<
    Record<RuntimeStoredRun['status'], readonly RuntimeStoredRun['status'][]>
  > = {
    queued: ['running', 'completed', 'failed', 'cancelled', 'unknown'],
    running: ['waiting', 'completed', 'failed', 'cancelled', 'unknown'],
    waiting: ['running', 'completed', 'failed', 'cancelled', 'unknown'],
    unknown: ['completed', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
  };
  if (!allowed[current.status].includes(next.status)) {
    throw new Error(`Runtime Run lifecycle is invalid: ${current.status} -> ${next.status}.`);
  }
  if (
    (current.startedAtMs !== undefined && current.startedAtMs !== next.startedAtMs) ||
    (current.finishedAtMs !== undefined && current.finishedAtMs !== next.finishedAtMs)
  ) {
    throw new Error('Runtime Run lifecycle changed a durable timestamp.');
  }
}

function isSettledRunThrough(run: RuntimeStoredRun, revision: number): boolean {
  return (
    run.lastRevision <= revision &&
    (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled')
  );
}

function assertMutation(writer: KiteHomeWriteTransactionPort): void {
  if (!writer.inTransaction) {
    throw new Error('Runtime Run mutation requires the single Store writer transaction.');
  }
}

function assertOpen(isClosed: () => boolean): void {
  if (isClosed()) throw new Error('Kite Home Runtime Run Store is closed.');
}

function assertIdentity(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 512 ||
    value.includes('\0')
  ) {
    throw new Error(`Runtime Run ${label} identity is invalid.`);
  }
}

function assertRevision(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Runtime Run ${label} is invalid.`);
  }
}
