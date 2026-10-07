import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { CancelCommandInput, CancelWorkInput } from '../port';
import { AgentError, type Json } from '../types';
import type { SqliteOperations } from './operations';

const bound = 4096;
function digest(request: Json) {
  return createHash('sha256').update(canonicalJson(request)).digest('hex');
}
function commandCancelled(db: SqliteOperations, id: string, now: number) {
  db.run(
    "UPDATE command SET cancelled=1,cancel_requested_at=COALESCE(cancel_requested_at,?),status=CASE WHEN status='accepted' AND kind NOT IN('job.reconcile','run.resume') THEN 'rejected' ELSE status END,receipt_json=CASE WHEN status='accepted' AND kind NOT IN('job.reconcile','run.resume') THEN ? ELSE receipt_json END WHERE id=?",
    now,
    canonicalJson({ outcome: 'cancelled_before_apply' }),
    id,
  );
}
/** Exact durable seeds and attached edges, including terminal parents with live descendants. */
function expand(db: SqliteOperations, rootId: string, seeds: string[]): string[] {
  const seen = new Set<string>();
  const pending = [...seeds];
  while (pending.length) {
    const id = pending.shift()!;
    if (seen.has(id)) continue;
    if (seen.size >= bound) throw new AgentError('cancel_scope_too_large');
    seen.add(id);
    for (const child of db.rows(
      'SELECT id FROM execution WHERE parent_execution_id=? AND root_session_id=? AND cancel_with_parent=1 ORDER BY id LIMIT 4097',
      id,
      rootId,
    ))
      pending.push(String(child.id));
    if (pending.length > bound) throw new AgentError('cancel_scope_too_large');
  }
  return [...seen];
}
export function cancel(db: SqliteOperations, input: CancelCommandInput | CancelWorkInput) {
  return db.tx(() => cancelWorkBody(db, input));
}
/** Internal finite cancellation body; callers hold the same final transaction. */
export function cancelWorkBody(db: SqliteOperations, input: CancelCommandInput | CancelWorkInput) {
  db.identity(input.expectedStoreId);
  const isCommand = 'targetCommandId' in input;
  const request: Json = isCommand
    ? { kind: 'command.cancel', targetCommandId: input.targetCommandId }
    : input.kind === 'run.cancel'
      ? { kind: input.kind, runId: input.runId }
      : input.kind === 'execution.cancel'
        ? { kind: input.kind, executionId: input.executionId }
        : { kind: input.kind, includeBackground: input.includeBackground };
  const requestDigest = digest(request);
  const prior = db.row('SELECT * FROM command WHERE id=?', input.commandId);
  if (prior) {
    if (
      prior.request_digest !== requestDigest ||
      prior.session_id !== input.sessionId ||
      prior.subject_id !== input.subjectId
    )
      throw new AgentError('command_conflict');
    return db.command(prior);
  }
  const session = db.row('SELECT * FROM session WHERE id=?', input.sessionId);
  if (!session || session.delete_requested) throw new AgentError('session_not_found');
  const runIds: string[] = [];
  const stopBoundaries: { id: string; seq: string }[] = [];
  const seedIds: string[] = [];
  const commandIds = new Set<string>();
  const subject = (commandId: string, exact = true, current = true) => {
    const command = db.row(
      'SELECT c.* FROM command c JOIN session s ON s.id=c.session_id WHERE c.id=? AND s.root_id=?',
      commandId,
      session.root_id!,
    );
    if (!command || (exact && command.session_id !== input.sessionId))
      throw new AgentError('command_not_found');
    if (
      command.subject_id !== input.subjectId ||
      (current && command.origin_store_id !== input.expectedStoreId)
    )
      throw new AgentError('permission_denied');
    return command;
  };
  const runSeed = (runId: string, exact = true) => {
    const run = db.row(
      'SELECT r.* FROM run r JOIN session s ON s.id=r.session_id WHERE r.id=? AND s.root_id=?',
      runId,
      session.root_id!,
    );
    if (!run || (exact && run.session_id !== input.sessionId))
      throw new AgentError('run_not_found');
    if (run.origin_store_id !== input.expectedStoreId) throw new AgentError('permission_denied');
    subject(String(run.origin_command_id), exact);
    commandIds.add(String(run.origin_command_id));
    runIds.push(runId);
    for (const execution of db.rows(
      "SELECT id FROM execution e WHERE run_id=? AND session_id=? AND (state IN ('planned','dispatching','running','outcome_unknown') OR EXISTS(SELECT 1 FROM execution child WHERE child.parent_execution_id=e.id AND child.cancel_with_parent=1)) ORDER BY id LIMIT 4097",
      runId,
      run.session_id!,
    ))
      seedIds.push(String(execution.id));
  };
  if (isCommand) {
    subject(input.targetCommandId);
    commandIds.add(input.targetCommandId);
    for (const run of db.rows(
      'SELECT id FROM run WHERE origin_command_id=? AND session_id=?',
      input.targetCommandId,
      input.sessionId,
    ))
      runSeed(String(run.id));
    for (const execution of db.rows(
      'SELECT id FROM execution WHERE origin_command_id=? AND session_id=? LIMIT 4097',
      input.targetCommandId,
      input.sessionId,
    ))
      seedIds.push(String(execution.id));
  } else if (input.kind === 'run.cancel') runSeed(input.runId);
  else if (input.kind === 'execution.cancel') {
    const execution = db.row(
      'SELECT * FROM execution WHERE id=? AND session_id=?',
      input.executionId,
      input.sessionId,
    );
    if (!execution) throw new AgentError('execution_not_found');
    subject(String(execution.origin_command_id));
    seedIds.push(input.executionId);
  } else {
    const creator = db.row(
      "SELECT id FROM command WHERE session_id=? AND kind='session.create' ORDER BY seq LIMIT 1",
      input.sessionId,
    );
    if (!creator) throw new AgentError('session_subject_unverifiable');
    subject(String(creator.id), true, false);
    if (input.includeBackground) {
      const root = db.row('SELECT next_seq FROM session WHERE id=?', session.root_id!)!;
      const scopes = db.rows(
        'WITH RECURSIVE subtree(id) AS (SELECT id FROM session WHERE id=? UNION ALL SELECT s.id FROM session s JOIN subtree t ON s.parent_id=t.id) SELECT id FROM subtree LIMIT 257',
        input.sessionId,
      );
      if (scopes.length > 256) throw new AgentError('cancel_scope_too_large');
      for (const current of scopes) {
        stopBoundaries.push({ id: String(current.id), seq: String(root.next_seq) });
        for (const command of db.rows(
          "SELECT id FROM command WHERE session_id=? AND root_work_seq<=? AND status='accepted' LIMIT 4097",
          current.id!,
          root.next_seq!,
        ))
          commandIds.add(String(command.id));
        for (const execution of db.rows(
          "SELECT id FROM execution WHERE session_id=? AND root_work_seq<=? AND state IN ('planned','dispatching','running','outcome_unknown') LIMIT 4097",
          current.id!,
          root.next_seq!,
        ))
          seedIds.push(String(execution.id));
        for (const run of db.rows(
          'SELECT id FROM run WHERE session_id=? AND is_active=1',
          current.id!,
        ))
          runSeed(String(run.id), false);
      }
    } else
      for (const run of db.rows(
        'SELECT id FROM run WHERE session_id=? AND is_active=1',
        input.sessionId,
      ))
        runSeed(String(run.id));
  }
  const uniqueSeeds = [...new Set(seedIds)];
  if (uniqueSeeds.length > bound || commandIds.size > bound)
    throw new AgentError('cancel_scope_too_large');
  const executions = expand(db, String(session.root_id), uniqueSeeds);
  // Resolve the entire effect set before the first write. Prior receipts above stay read-only.
  for (const id of executions) {
    const execution = db.row(
      'SELECT * FROM execution WHERE id=? AND root_session_id=?',
      id,
      session.root_id!,
    )!;
    if (execution.origin_store_id !== input.expectedStoreId)
      throw new AgentError('permission_denied');
    const own = subject(String(execution.origin_command_id), false);
    if (execution.child_session_id !== null) {
      for (const childRun of db.rows(
        'SELECT id,origin_command_id FROM run WHERE session_id=? AND origin_command_id=? AND is_active=1',
        execution.child_session_id!,
        `child-start-${execution.id}`,
      )) {
        if (!runIds.includes(String(childRun.id))) runIds.push(String(childRun.id));
        commandIds.add(String(childRun.origin_command_id));
      }
      for (const childCommand of db.rows(
        "SELECT id FROM command WHERE session_id=? AND id=? AND status='accepted'",
        execution.child_session_id!,
        `child-start-${execution.id}`,
      ))
        commandIds.add(String(childCommand.id));
    }
    const receipt = own.receipt_json
      ? (JSON.parse(String(own.receipt_json)) as { executionId?: string })
      : {};
    if (receipt.executionId === id) commandIds.add(String(own.id));
  }
  for (const id of commandIds) subject(id, false);
  for (const id of runIds) {
    const run = db.row('SELECT origin_store_id FROM run WHERE id=?', id);
    if (!run || run.origin_store_id !== input.expectedStoreId)
      throw new AgentError('permission_denied');
    const pending = db.rows(
      "SELECT id FROM command WHERE kind IN ('input.steer','result.include') AND input_target_run_id=? AND status IN ('accepted','applied') LIMIT 4097",
      id,
    );
    if (pending.length > bound) throw new AgentError('cancel_scope_too_large');
    for (const command of pending) subject(String(command.id), false);
  }
  const now = Date.now();
  for (const boundary of stopBoundaries)
    db.run(
      'UPDATE session SET stop_boundary=max(stop_boundary,?) WHERE id=?',
      boundary.seq,
      boundary.id,
    );
  for (const id of executions) {
    const execution = db.row('SELECT * FROM execution WHERE id=?', id)!;
    db.run(
      'UPDATE execution SET cancel_requested=1,cancel_requested_at=COALESCE(cancel_requested_at,?) WHERE id=?',
      now,
      id,
    );
    const interactions = db.rows(
      "SELECT id,presentation_session_id FROM interaction WHERE execution_id=? AND state IN ('pending','answered') AND accepted_decision_revision IS NULL",
      id,
    );
    db.run(
      "UPDATE interaction SET state='cancelled' WHERE execution_id=? AND state IN ('pending','answered') AND accepted_decision_revision IS NULL",
      id,
    );
    for (const interaction of interactions)
      db.event(
        String(interaction.presentation_session_id),
        String(interaction.id),
        'interaction.cancelled',
      );
    db.event(String(execution.session_id), id, 'execution.cancel_requested');
  }
  for (const id of commandIds) {
    subject(id, false);
    commandCancelled(db, id, now);
  }
  for (const id of runIds) {
    const inputs = db.rows(
      "SELECT id FROM command WHERE kind IN ('input.steer','result.include') AND input_target_run_id=? AND status IN ('accepted','applied') LIMIT 4097",
      id,
    );
    if (inputs.length > 4096) throw new AgentError('cancel_scope_too_large');
    for (const pending of inputs) {
      commandCancelled(db, String(pending.id), now);
      db.event(String(session.id), String(pending.id), 'input.cancel_requested');
    }
    db.run(
      'UPDATE run SET cancel_requested=1,cancel_requested_at=COALESCE(cancel_requested_at,?) WHERE id=?',
      now,
      id,
    );
    db.event(
      String(db.row('SELECT session_id FROM run WHERE id=?', id)!.session_id),
      id,
      'run.cancel_requested',
    );
  }
  const receipt: Json = {
    ...(request as { [key: string]: Json }),
    outcome: 'cancel_requested',
    affectedCount: executions.length + commandIds.size + runIds.length,
  };
  db.allocateSessionSequence(input.sessionId);
  const seq = db.row('SELECT next_seq FROM session WHERE id=?', input.sessionId)!.next_seq;
  db.run(
    "INSERT INTO command(id,session_id,seq,kind,subject_id,request_digest,request_json,status,receipt_json,origin_store_id,root_work_command_id,root_work_seq,target_command_id) VALUES(?,?,?,?,?,?,?,'applied',?,?,?,?,?)",
    input.commandId,
    input.sessionId,
    seq,
    isCommand ? 'command.cancel' : input.kind,
    input.subjectId,
    requestDigest,
    canonicalJson(request),
    canonicalJson(receipt),
    input.expectedStoreId,
    input.commandId,
    seq,
    isCommand ? input.targetCommandId : null,
  );
  db.event(
    input.sessionId,
    isCommand ? input.targetCommandId : input.commandId,
    'command.cancel_requested',
    receipt,
  );
  return db.command(db.row('SELECT * FROM command WHERE id=?', input.commandId)!);
}
