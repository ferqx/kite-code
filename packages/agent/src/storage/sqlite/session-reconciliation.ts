import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { Store } from '../port';
import { AgentError, type Json, type RecoveryReport, type SessionReconciliation } from '../types';
import type { SqliteOperations } from './operations';

type Input = Parameters<Store['reconcileSession']>[0];
type Row = Record<string, string | number | bigint | null>;
type SavedRow = { id: string; original: Record<string, string | number | null>; after: string };
type Checkpoint = {
  version: 1;
  digest: string;
  runs: SavedRow[];
  executions: SavedRow[];
  interactions: SavedRow[];
  commands: SavedRow[];
  sessions: string;
  runIds: string;
  commandSequences: Record<string, string>;
};
const jsonRow = (row: Row): Record<string, string | number | null> =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'bigint' ? String(value) : value,
    ]),
  );
const hash = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const rowHash = (row: Row) => hash(jsonRow(row));
const request = (input: Input): Json => ({
  kind: 'session.reconcile',
  expectedOwnerGeneration: input.expectedOwnerGeneration,
});
function readCheckpoint(db: SqliteOperations, text: string): Checkpoint {
  const invalid = () =>
    new AgentError('run_resume_checkpoint_unavailable', 'reconciliation_checkpoint_invalid');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid();
  }
  const object = (item: unknown): item is Record<string, unknown> =>
    typeof item === 'object' && item !== null && !Array.isArray(item);
  const keys = (item: Record<string, unknown>, expected: readonly string[]) =>
    Object.keys(item).sort().join(',') === [...expected].sort().join(',');
  const hexadecimal = (item: unknown): item is string =>
    typeof item === 'string' && /^[a-f0-9]{64}$/.test(item);
  if (
    !object(value) ||
    !keys(value, [
      'version',
      'digest',
      'runs',
      'executions',
      'interactions',
      'commands',
      'sessions',
      'runIds',
      'commandSequences',
    ]) ||
    value.version !== 1 ||
    !hexadecimal(value.digest) ||
    !hexadecimal(value.sessions) ||
    !hexadecimal(value.runIds) ||
    !object(value.commandSequences) ||
    !Object.keys(value.commandSequences).length ||
    Object.entries(value.commandSequences).some(
      ([id, seq]) =>
        !id ||
        typeof seq !== 'string' ||
        !/^(0|[1-9][0-9]*)$/.test(seq) ||
        BigInt(seq) > 9223372036854775807n,
    )
  )
    throw invalid();
  for (const [table, rows] of [
    ['run', value.runs],
    ['execution', value.executions],
    ['interaction', value.interactions],
    ['command', value.commands],
  ] as const) {
    if (!Array.isArray(rows) || rows.length > 4096) throw invalid();
    const columns = db.rows(`PRAGMA table_info(${table})`);
    const seen = new Set<string>();
    for (const row of rows) {
      if (
        !object(row) ||
        !keys(row, ['id', 'original', 'after']) ||
        typeof row.id !== 'string' ||
        !row.id ||
        seen.has(row.id) ||
        !hexadecimal(row.after) ||
        !object(row.original) ||
        !keys(
          row.original,
          columns.map((column) => String(column.name)),
        ) ||
        row.original.id !== row.id
      )
        throw invalid();
      seen.add(row.id);
      for (const column of columns) {
        const field = row.original[String(column.name)];
        if (field === null) {
          if (column.notnull === 1n) throw invalid();
          continue;
        }
        if (
          typeof field !== 'string' &&
          (typeof field !== 'number' || !Number.isSafeInteger(field))
        )
          throw invalid();
        if (
          column.type === 'INTEGER' &&
          (typeof field !== 'string' ||
            !/^-?(0|[1-9][0-9]*)$/.test(field) ||
            BigInt(field) < -9223372036854775808n ||
            BigInt(field) > 9223372036854775807n)
        )
          throw invalid();
      }
    }
  }
  const checkpoint = value as unknown as Checkpoint;
  const { digest, ...body } = checkpoint;
  if (hash(body as unknown as Json) !== digest) throw invalid();
  return checkpoint;
}
function sessions(db: SqliteOperations, root: string) {
  return hash(
    db
      .rows(
        'SELECT id,context_selection_id,control_revision,stop_boundary,delete_requested FROM session WHERE root_id=? ORDER BY id',
        root,
      )
      .map(jsonRow),
  );
}
function runIds(db: SqliteOperations, root: string) {
  return hash(
    db
      .rows(
        'SELECT r.id FROM run r JOIN session s ON s.id=r.session_id WHERE s.root_id=? ORDER BY r.id',
        root,
      )
      .map(jsonRow),
  );
}
/** Identity and original receipt are checked even while the real owner is held. */
export function inspectSessionReconciliation(
  db: SqliteOperations,
  input: Input,
): SessionReconciliation | null {
  db.db.run('BEGIN');
  try {
    db.identity(input.expectedStoreId);
    const prior = db.row('SELECT * FROM command WHERE id=?', input.commandId);
    if (prior) {
      if (
        prior.kind !== 'session.reconcile' ||
        prior.session_id !== input.sessionId ||
        prior.subject_id !== input.subjectId ||
        prior.origin_store_id !== input.expectedStoreId ||
        prior.request_digest !== hash(request(input)) ||
        prior.status !== 'applied'
      )
        throw new AgentError('command_conflict');
      const result: SessionReconciliation = {
        storeId: input.expectedStoreId,
        sessionId: input.sessionId,
        outcome: 'reconciled',
        commandId: input.commandId,
        report: JSON.parse(String(prior.receipt_json)) as RecoveryReport,
      };
      db.db.run('COMMIT');
      return result;
    }
    const session = db.row('SELECT * FROM session WHERE id=?', input.sessionId);
    if (!session || session.delete_requested) throw new AgentError('session_not_found');
    if (session.parent_id !== null || session.root_id !== session.id)
      throw new AgentError('group_root_required');
    if (
      db.row(
        "SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'",
        input.sessionId,
      )?.subject_id !== input.subjectId
    )
      throw new AgentError('permission_denied');
    if (String(session.owner_generation) !== input.expectedOwnerGeneration)
      throw new AgentError('owner_changed');
    const needsReconciliation = !!(
      db.row(
        'SELECT r.id FROM run r JOIN session s ON s.id=r.session_id WHERE s.root_id=? AND r.is_active=1',
        input.sessionId,
      ) ||
      db.row(
        "SELECT id FROM execution WHERE root_session_id=? AND owner_generation=? AND state IN('planned','dispatching','running')",
        input.sessionId,
        BigInt(input.expectedOwnerGeneration),
      )
    );
    db.db.run('COMMIT');
    return needsReconciliation
      ? null
      : {
          storeId: input.expectedStoreId,
          sessionId: input.sessionId,
          outcome: 'unchanged',
          commandId: null,
          report: null,
        };
  } catch (error) {
    return db.rollback(error);
  }
}
/** The adapter holds the actual root OS lock throughout this transaction. */
export function reconcileSession(db: SqliteOperations, input: Input): SessionReconciliation {
  return db.tx(() => {
    db.identity(input.expectedStoreId);
    const prior = db.row('SELECT * FROM command WHERE id=?', input.commandId);
    if (prior) {
      if (
        prior.kind !== 'session.reconcile' ||
        prior.session_id !== input.sessionId ||
        prior.subject_id !== input.subjectId ||
        prior.origin_store_id !== input.expectedStoreId ||
        prior.request_digest !== hash(request(input)) ||
        prior.status !== 'applied'
      )
        throw new AgentError('command_conflict');
      return {
        storeId: input.expectedStoreId,
        sessionId: input.sessionId,
        outcome: 'reconciled',
        commandId: input.commandId,
        report: JSON.parse(String(prior.receipt_json)) as RecoveryReport,
      };
    }
    const session = db.row('SELECT * FROM session WHERE id=?', input.sessionId);
    if (!session || session.delete_requested) throw new AgentError('session_not_found');
    if (session.parent_id !== null || session.root_id !== session.id)
      throw new AgentError('group_root_required');
    if (
      db.row(
        "SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'",
        input.sessionId,
      )?.subject_id !== input.subjectId
    )
      throw new AgentError('permission_denied');
    if (String(session.owner_generation) !== input.expectedOwnerGeneration)
      throw new AgentError('owner_changed');
    const runs = db.rows(
      'SELECT r.* FROM run r JOIN session s ON s.id=r.session_id WHERE s.root_id=? AND r.is_active=1 ORDER BY r.id LIMIT 4097',
      input.sessionId,
    );
    const executions = db.rows(
      "SELECT * FROM execution WHERE root_session_id=? AND owner_generation=? AND state IN('planned','dispatching','running') ORDER BY id LIMIT 4097",
      input.sessionId,
      BigInt(input.expectedOwnerGeneration),
    );
    if (runs.length > 4096 || executions.length > 4096) throw new AgentError('recovery_too_large');
    if (!runs.length && !executions.length)
      return {
        storeId: input.expectedStoreId,
        sessionId: input.sessionId,
        outcome: 'unchanged',
        commandId: null,
        report: null,
      };
    if (BigInt(session.owner_generation!) >= 9223372036854775807n)
      throw new AgentError('sequence_exhausted');
    const generation = String(BigInt(session.owner_generation!) + 1n);
    const unknowns = db.rows(
      "SELECT id FROM execution WHERE root_session_id=? AND state='outcome_unknown' ORDER BY id LIMIT 4097",
      input.sessionId,
    );
    const partials = db.rows(
      "SELECT m.id FROM message m JOIN session s ON s.id=m.session_id WHERE s.root_id=? AND m.status='incomplete' ORDER BY m.id LIMIT 4097",
      input.sessionId,
    );
    if (unknowns.length > 4096 || partials.length > 4096)
      throw new AgentError('recovery_too_large');
    const report: RecoveryReport = {
      storeId: input.expectedStoreId,
      sessionId: input.sessionId,
      previousGeneration: String(session.owner_generation),
      generation,
      interruptedRunIds: runs.map((row) => String(row.id)),
      settledExecutionIds: [],
      unknownExecutionIds: unknowns.map((row) => String(row.id)),
      cancelledExecutionIds: [],
      partialMessageIds: partials.map((row) => String(row.id)),
      snapshotCursor: '',
    };
    const checkpoint: Checkpoint = {
      version: 1,
      digest: '',
      runs: [],
      executions: [],
      interactions: [],
      commands: [],
      sessions: sessions(db, input.sessionId),
      runIds: runIds(db, input.sessionId),
      commandSequences: Object.fromEntries(
        db
          .rows('SELECT id,next_seq FROM session WHERE root_id=? ORDER BY id', input.sessionId)
          .map((row) => [String(row.id), String(row.next_seq)]),
      ),
    };
    for (const run of runs) {
      db.run(
        "UPDATE run SET status='interrupted',is_active=0,finished_at=?,reason='owner_lost' WHERE id=?",
        Date.now(),
        run.id!,
      );
      checkpoint.runs.push({
        id: String(run.id),
        original: jsonRow(run),
        after: rowHash(db.row('SELECT * FROM run WHERE id=?', run.id!)!),
      });
      db.event(String(run.session_id), String(run.id), 'run.interrupted', { reason: 'owner_lost' });
    }
    for (const execution of executions) {
      if (BigInt(execution.result_revision!) >= 9223372036854775807n)
        throw new AgentError('sequence_exhausted');
      const model = execution.kind === 'model';
      const unstarted = execution.state === 'planned' && execution.dispatched === 0n;
      db.run(
        'UPDATE execution SET state=?,result_json=?,result_revision=result_revision+1 WHERE id=?',
        unstarted ? 'cancelled' : model ? 'failed' : 'outcome_unknown',
        canonicalJson({
          code: unstarted
            ? 'owner_lost_before_dispatch'
            : model
              ? 'model_interrupted'
              : 'recovery_outcome_unknown',
          incomplete: model,
          reconciliationCommandId: input.commandId,
          evidenceSource: 'owner_lost',
        }),
        execution.id!,
      );
      checkpoint.executions.push({
        id: String(execution.id),
        original: jsonRow(execution),
        after: rowHash(db.row('SELECT * FROM execution WHERE id=?', execution.id!)!),
      });
      (unstarted
        ? report.cancelledExecutionIds
        : model
          ? report.settledExecutionIds
          : report.unknownExecutionIds
      ).push(String(execution.id));
      db.event(String(execution.session_id), String(execution.id), 'execution.reconciled', {
        reason: 'owner_lost',
      });
    }
    // Settle only interactions and accepted work tied to this original frontier.
    // Answers and accepted decision facts remain immutable; only unconsumed
    // presentation state changes, and exact resume can restore that state.
    const executionIds = new Set(executions.map((row) => String(row.id)));
    const runIdsChanged = new Set(runs.map((row) => String(row.id)));
    for (const interaction of db.rows(
      "SELECT i.* FROM interaction i JOIN session s ON s.id=i.session_id WHERE s.root_id=? AND i.state IN('pending','answered') AND i.accepted_decision_revision IS NULL ORDER BY i.id",
      input.sessionId,
    )) {
      if (!executionIds.has(String(interaction.execution_id))) continue;
      if (checkpoint.interactions.length >= 4096) throw new AgentError('recovery_too_large');
      db.run("UPDATE interaction SET state='cancelled' WHERE id=?", interaction.id!);
      checkpoint.interactions.push({
        id: String(interaction.id),
        original: jsonRow(interaction),
        after: rowHash(db.row('SELECT * FROM interaction WHERE id=?', interaction.id!)!),
      });
      db.event(String(interaction.session_id), String(interaction.id), 'interaction.cancelled', {
        reason: 'owner_lost',
      });
    }
    for (const command of db.rows(
      "SELECT c.* FROM command c JOIN session s ON s.id=c.session_id WHERE s.root_id=? AND c.status='accepted' ORDER BY c.rowid",
      input.sessionId,
    )) {
      const source = JSON.parse(String(command.request_json)) as Record<string, Json>;
      const associated =
        executions.some((execution) => execution.origin_command_id === command.id) ||
        executionIds.has(String(command.agent_carrier_execution_id)) ||
        (command.kind === 'child.start' && executionIds.has(String(source.parentExecutionId))) ||
        runIdsChanged.has(String(command.input_target_run_id));
      if (!associated) continue;
      if (checkpoint.commands.length >= 4096) throw new AgentError('recovery_too_large');
      db.run("UPDATE command SET status='needs_review' WHERE id=?", command.id!);
      checkpoint.commands.push({
        id: String(command.id),
        original: jsonRow(command),
        after: rowHash(db.row('SELECT * FROM command WHERE id=?', command.id!)!),
      });
      db.event(String(command.session_id), String(command.id), 'command.needs_review', {
        reason: 'owner_lost',
      });
    }
    // No synthetic Tool message or rewritten successful result is produced.
    db.run(
      'UPDATE session SET owner_generation=?,owner_instance=NULL WHERE id=?',
      BigInt(generation),
      input.sessionId,
    );
    db.insertCommand(input, request(input), hash(request(input)), 'applied', null);
    db.event(input.sessionId, input.commandId, 'session.reconciled');
    report.snapshotCursor = String(db.metadata().lastChangeCursor);
    db.run(
      'UPDATE command SET receipt_json=? WHERE id=?',
      canonicalJson(report as unknown as Json),
      input.commandId,
    );
    const { digest: _digest, ...checkpointBody } = checkpoint;
    checkpoint.digest = hash(checkpointBody as unknown as Json);
    db.run(
      'INSERT OR REPLACE INTO session_reconciliation(root_session_id,command_id,store_id,generation,checkpoint_json) VALUES(?,?,?,?,?)',
      input.sessionId,
      input.commandId,
      input.expectedStoreId,
      BigInt(generation),
      canonicalJson(checkpoint as unknown as Json),
    );
    return {
      storeId: input.expectedStoreId,
      sessionId: input.sessionId,
      outcome: 'reconciled',
      commandId: input.commandId,
      report,
    };
  });
}

/** Private original frontier overlay; GET view never enters this path. */
export function withReconciledFrontier<T>(
  db: SqliteOperations,
  input: {
    expectedStoreId: string;
    sessionId: string;
    subjectId: string;
    expectedOwnerGeneration?: string;
  },
  read: () => T,
  persist = false,
): T {
  if (
    !db.row("SELECT name FROM sqlite_schema WHERE type='table' AND name='session_reconciliation'")
  )
    return read();
  const selected = db.row('SELECT root_id FROM session WHERE id=?', input.sessionId);
  const rootId = String(selected?.root_id ?? input.sessionId);
  const saved = db.row('SELECT * FROM session_reconciliation WHERE root_session_id=?', rootId);
  if (!saved) return read();
  const root = db.row('SELECT * FROM session WHERE id=?', rootId);
  if (
    saved.store_id !== input.expectedStoreId ||
    !root ||
    String(saved.generation) !== String(root.owner_generation) ||
    (input.expectedOwnerGeneration !== undefined &&
      input.expectedOwnerGeneration !== String(saved.generation)) ||
    db.row("SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'", rootId)
      ?.subject_id !== input.subjectId
  )
    throw new AgentError('run_resume_checkpoint_changed');
  const checkpoint = readCheckpoint(db, String(saved.checkpoint_json));
  if (
    sessions(db, rootId) !== checkpoint.sessions ||
    runIds(db, rootId) !== checkpoint.runIds ||
    Object.entries(checkpoint.commandSequences).some(([sessionId, sequence]) =>
      db.row(
        "SELECT id FROM command WHERE session_id=? AND seq>? AND kind NOT IN('session.reconcile','run.resume')",
        sessionId,
        BigInt(sequence),
      ),
    )
  )
    throw new AgentError('run_resume_checkpoint_changed');
  for (const [table, rows] of [
    ['run', checkpoint.runs],
    ['execution', checkpoint.executions],
    ['interaction', checkpoint.interactions],
    ['command', checkpoint.commands],
  ] as const)
    for (const row of rows) {
      const actual = db.row(`SELECT * FROM ${table} WHERE id=?`, row.id);
      if (!actual || rowHash(actual) !== row.after)
        throw new AgentError('run_resume_checkpoint_changed');
    }
  db.db.run('SAVEPOINT original_reconciliation_frontier');
  try {
    for (const [table, rows, columns] of [
      ['run', checkpoint.runs, ['status', 'is_active', 'finished_at', 'reason']],
      ['execution', checkpoint.executions, ['state', 'result_json', 'result_revision']],
      ['interaction', checkpoint.interactions, ['state']],
      ['command', checkpoint.commands, ['status']],
    ] as const)
      for (const row of rows)
        db.run(
          `UPDATE ${table} SET ${columns.map((column) => `${column}=?`).join(',')} WHERE id=?`,
          ...columns.map((column) => row.original[column] ?? null),
          row.id,
        );
    const result = read();
    if (persist) db.run('DELETE FROM session_reconciliation WHERE root_session_id=?', rootId);
    else db.db.run('ROLLBACK TO original_reconciliation_frontier');
    db.db.run('RELEASE original_reconciliation_frontier');
    return result;
  } catch (error) {
    db.db.run('ROLLBACK TO original_reconciliation_frontier');
    db.db.run('RELEASE original_reconciliation_frontier');
    throw error;
  }
}
