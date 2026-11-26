import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../../json';
import { coveredFileEdit, fileEditBatchSeal } from '../file-edit-batch';
import type { CancelCommandInput, CancelWorkInput } from '../port';
import type { StoppedModelProof } from '../recovery-history';
import { AgentError, type Json, USER_STOPPED_UNDISPATCHED_TOOL } from '../types';
import { cancelHumanCommandBindings } from './human-work-control';
import { savedApprovalDenial } from './interaction-operations';
import { verifyModelOutput } from './model-output';
import type { SqliteOperations } from './operations';
import { cancelOutputCollectionCommand, outputCollectionWorkSequence } from './output-collection';

/** Page a complete effect set inside the caller's single cancellation transaction. */
function* rows(db: SqliteOperations, sql: string, ...args: (string | number | bigint | null)[]) {
  const statement = db.db.prepare<
    ReturnType<SqliteOperations['rows']>[number],
    (string | number | bigint | null)[]
  >(`SELECT * FROM (${sql}) WHERE id>? ORDER BY id LIMIT 256`);
  (statement as typeof statement & { safeIntegers(value: boolean): typeof statement }).safeIntegers(
    true,
  );
  try {
    let after = '';
    for (;;) {
      const page = statement.all(...args, after);
      for (const row of page) yield row;
      if (page.length < 256) return;
      after = String(page.at(-1)!.id);
    }
  } finally {
    statement.finalize();
  }
}
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
  cancelOutputCollectionCommand(db, id);
}
/** Exact durable seeds and attached edges, including terminal parents with live descendants. */
function expand(db: SqliteOperations, rootId: string, seeds: string[]): string[] {
  const seen = new Set<string>();
  const pending = [...seeds];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const id = pending[cursor]!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const child of rows(
      db,
      'SELECT id FROM execution WHERE parent_execution_id=? AND root_session_id=? AND cancel_with_parent=1 ORDER BY id',
      id,
      rootId,
    ))
      pending.push(String(child.id));
  }
  return [...seen];
}
export function cancel(db: SqliteOperations, input: CancelCommandInput | CancelWorkInput) {
  return db.tx(() => cancelWorkBody(db, input));
}

export function userStopCommand(db: SqliteOperations, runId: string): string | undefined {
  const row = db.row(
    `SELECT stop.id FROM run r JOIN change_event e ON e.object_id=r.id AND e.scope_session_id=r.session_id
     JOIN command stop ON stop.id=json_extract(e.payload_json,'$.payload.userStopCommandId')
     JOIN command origin ON origin.id=r.origin_command_id
     WHERE r.id=? AND r.cancel_requested=1 AND e.type='run.cancel_requested'
       AND stop.status='applied' AND stop.origin_store_id=r.origin_store_id
       AND stop.subject_id=origin.subject_id LIMIT 1`,
    runId,
  );
  return row ? String(row.id) : undefined;
}

/** A confirmed refusal survives a later stop, whichever path closes the call. */
export function undispatchedToolSettlement(
  db: SqliteOperations,
  stoppedContent: string,
  execution?: ReturnType<SqliteOperations['rows']>[number],
) {
  const denied = execution !== undefined && savedApprovalDenial(db, execution);
  return {
    outcome: denied ? ('failed' as const) : ('cancelled' as const),
    content: denied ? 'approval_denied' : stoppedContent,
    details: {
      code: denied ? 'approval_denied' : 'cancelled_before_dispatch',
      dispatchCommitted: Boolean(execution?.dispatched),
      adapterAttempted: false,
    },
  };
}

/** Close the exact stopped batch without reissuing a call or disturbing its saved results. */
export function recordStoppedTools(
  db: SqliteOperations,
  expectedStoreId: string,
  batch: StoppedModelProof,
  recoveryCommandId?: string,
) {
  const callIds = new Set(batch.calls.map(({ id }) => id));
  const model = db.row(
    "SELECT e.*,r.config_json AS run_configuration FROM execution e JOIN run r ON r.id=e.run_id WHERE e.id=? AND r.id=? AND e.kind='model' AND e.state='succeeded' AND e.session_id=r.session_id AND e.origin_store_id=r.origin_store_id AND e.origin_command_id=r.origin_command_id",
    batch.executionId,
    batch.runId,
  );
  if (
    !model ||
    model.origin_store_id !== expectedStoreId ||
    model.session_id !== batch.sessionId ||
    callIds.size !== batch.calls.length
  )
    throw new AgentError('model_output_invalid');
  const result = JSON.parse(String(model.result_json)) as {
    toolCalls?: typeof batch.calls;
    modelOutput?: unknown;
  };
  if (result.modelOutput !== undefined) {
    // The Core obtained the exact pairs while committing or reading the immutable output.
    const output = verifyModelOutput(db, result.modelOutput, model);
    if (!output.complete || output.toolCallCount !== batch.calls.length)
      throw new AgentError('model_output_invalid');
  } else if (
    canonicalJson(result.toolCalls?.map(({ id, name }) => ({ id, name })) ?? []) !==
    canonicalJson(batch.calls)
  )
    throw new AgentError('model_output_invalid');

  const executions = db.rows(
    "SELECT * FROM execution WHERE run_id=? AND kind='tool' AND json_extract(decision_source_json,'$.modelExecutionId')=?",
    batch.runId,
    batch.executionId,
  );
  const existing = new Map(executions.map((row) => [String(row.call_id), row]));
  if (existing.size !== executions.length || [...existing.keys()].some((id) => !callIds.has(id)))
    throw new AgentError('recovery_tool_history_unverifiable');
  const stoppedContent = userStopCommand(db, batch.runId)
    ? USER_STOPPED_UNDISPATCHED_TOOL
    : '上一轮已停止，此工具未执行';
  // Compute all companion receipts while the exact original group is still
  // planned. A saved human denial belongs to the whole batch, not just its card.
  const deniedCompanions = new Map<string, ReturnType<typeof coveredFileEdit>>();
  if (recoveryCommandId === undefined) {
    for (const leader of executions) {
      if (leader.state !== 'planned' || !savedApprovalDenial(db, leader)) continue;
      const seal = fileEditBatchSeal(JSON.parse(String(leader.decision_source_json)) as Json);
      if (!seal || leader.id !== seal.leaderExecutionId) continue;
      const group = db.fileEditBatchRows(leader, 'settlement')!;
      const refusal = undispatchedToolSettlement(db, stoppedContent, leader);
      for (const member of group.members)
        deniedCompanions.set(
          member.id,
          coveredFileEdit(group.leader, member, group.model, {
            status: refusal.outcome,
            result: refusal,
          }),
        );
    }
  }
  const recoveredDenials: string[] = [];
  const source = canonicalJson({ kind: 'model_decision', modelExecutionId: batch.executionId });
  const { tools = [] } = JSON.parse(String(model.run_configuration)) as {
    tools?: { id: string; version: string }[];
  };
  const versions = new Map(tools.map(({ id, version }) => [id, version]));
  const stoppedAt = Date.now();
  for (const call of batch.calls) {
    const tool = existing.get(call.id);
    const id = tool ? String(tool.id) : randomUUID();
    if (tool) {
      if (
        tool.session_id !== model.session_id ||
        tool.origin_store_id !== model.origin_store_id ||
        tool.origin_command_id !== model.origin_command_id ||
        tool.root_session_id !== model.root_session_id ||
        tool.root_work_command_id !== model.root_work_command_id ||
        tool.root_work_seq !== model.root_work_seq ||
        tool.step_id !== model.step_id ||
        JSON.parse(String(tool.decision_source_json)).kind !== 'model_decision' ||
        tool.adapter_id !== call.name
      )
        throw new AgentError('recovery_tool_history_unverifiable');
      const messages = db.rows(
        `SELECT source_json FROM message WHERE session_id=? AND run_id=? AND role='tool'
         AND json_extract(source_json,'$.sourceIds[0]')=? LIMIT 2`,
        batch.sessionId,
        batch.runId,
        id,
      );
      if (messages.length) {
        const message = JSON.parse(String(messages[0]!.source_json));
        if (
          messages.length !== 1 ||
          message.toolCallId !== call.id ||
          message.sourceIds?.length !== 1
        )
          throw new AgentError('recovery_tool_history_unverifiable');
        continue;
      }
      const result = tool.result_json ? JSON.parse(String(tool.result_json)) : null;
      const reconciled =
        recoveryCommandId !== undefined &&
        tool.state === 'cancelled' &&
        ((result?.code === 'owner_lost_before_dispatch' &&
          result.reconciliationCommandId === recoveryCommandId) ||
          (result?.code === 'recovery_cancelled_unstarted' &&
            result.recoveryCommandId === recoveryCommandId));
      if (
        recoveryCommandId !== undefined &&
        tool.state === 'outcome_unknown' &&
        result?.code === 'recovery_outcome_unknown' &&
        result.recoveryCommandId === recoveryCommandId
      ) {
        db.appendMessage(
          batch.sessionId,
          batch.runId,
          {
            content: canonicalJson(result),
            toolCallId: call.id,
            sourceIds: [id],
          },
          'tool',
        );
        continue;
      }
      if (tool.dispatched !== 0n || (tool.state !== 'planned' && !reconciled))
        throw new AgentError('recovery_tool_history_unverifiable');
    }
    const result = deniedCompanions.get(id) ?? undispatchedToolSettlement(db, stoppedContent, tool);
    if (tool) {
      if (tool.state === 'cancelled' && result.outcome === 'failed') recoveredDenials.push(id);
      if (tool.state !== 'cancelled' || result.outcome === 'failed') {
        if (BigInt(tool.result_revision!) >= 9223372036854775807n)
          throw new AgentError('sequence_exhausted');
        db.run(
          'UPDATE execution SET state=?,cancel_requested=1,cancel_requested_at=COALESCE(cancel_requested_at,?),result_json=?,result_revision=result_revision+1 WHERE id=?',
          result.outcome,
          stoppedAt,
          canonicalJson(result),
          id,
        );
      }
    } else
      db.run(
        `INSERT INTO execution(id,session_id,run_id,kind,origin_command_id,origin_store_id,root_work_command_id,root_work_seq,root_session_id,step_id,call_id,attempt,adapter_id,definition_version,state,intent_json,decision_source_json,owner_generation,parent_execution_id,cancel_with_parent,cancel_requested,cancel_requested_at,result_json,result_revision)
       VALUES(?,?,?,'tool',?,?,?,?,?,?,?,1,?,?,'cancelled','null',?,?,?,1,1,?,?,1)`,
        id,
        model.session_id!,
        batch.runId,
        model.origin_command_id!,
        model.origin_store_id!,
        model.root_work_command_id!,
        model.root_work_seq!,
        model.root_session_id!,
        model.step_id!,
        call.id,
        call.name,
        versions.get(call.name) ?? 'unavailable',
        source,
        model.owner_generation!,
        model.parent_execution_id ?? null,
        stoppedAt,
        canonicalJson(result),
      );
    db.appendMessage(
      batch.sessionId,
      batch.runId,
      { content: result.content, toolCallId: call.id, sourceIds: [id] },
      'tool',
    );
    if (tool?.state !== 'cancelled' || result.outcome === 'failed') {
      db.event(batch.sessionId, id, 'execution.finished');
      db.run(
        'UPDATE execution SET completed_cursor=(SELECT last_change_cursor FROM storage_meta WHERE singleton=1) WHERE id=?',
        id,
      );
    }
  }
  return recoveredDenials;
}

/** Complete cancellation body; callers hold the same final transaction. */
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
    for (const execution of rows(
      db,
      "SELECT id FROM execution e WHERE run_id=? AND session_id=? AND (state IN ('planned','dispatching','running','outcome_unknown') OR EXISTS(SELECT 1 FROM execution child WHERE child.parent_execution_id=e.id AND child.cancel_with_parent=1)) ORDER BY id",
      runId,
      run.session_id!,
    ))
      seedIds.push(String(execution.id));
  };
  if (isCommand) {
    subject(input.targetCommandId);
    commandIds.add(input.targetCommandId);
    const related = cancelHumanCommandBindings(db, input.targetCommandId, Date.now());
    for (const commandId of related.commandIds) commandIds.add(commandId);
    for (const runId of related.runIds) runSeed(runId, false);
    for (const run of rows(
      db,
      'SELECT id FROM run WHERE origin_command_id=? AND session_id=?',
      input.targetCommandId,
      input.sessionId,
    ))
      runSeed(String(run.id));
    for (const execution of rows(
      db,
      'SELECT id FROM execution WHERE origin_command_id=? AND session_id=?',
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
      const scopes = rows(
        db,
        'WITH RECURSIVE subtree(id) AS (SELECT id FROM session WHERE id=? AND root_id=? AND workspace_id=? UNION SELECT s.id FROM session s JOIN subtree t ON s.parent_id=t.id WHERE s.root_id=? AND s.workspace_id=?) SELECT id FROM subtree',
        input.sessionId,
        session.root_id!,
        session.workspace_id!,
        session.root_id!,
        session.workspace_id!,
      );
      for (const current of scopes) {
        stopBoundaries.push({ id: String(current.id), seq: String(root.next_seq) });
        for (const command of rows(
          db,
          "SELECT id FROM command WHERE session_id=? AND root_work_seq<=? AND status='accepted'",
          current.id!,
          root.next_seq!,
        ))
          commandIds.add(String(command.id));
        for (const execution of rows(
          db,
          "SELECT id FROM execution WHERE session_id=? AND root_work_seq<=? AND state IN ('planned','dispatching','running','outcome_unknown')",
          current.id!,
          root.next_seq!,
        ))
          seedIds.push(String(execution.id));
        // Internal output commands have their own child-local sequence. Select
        // only proven collectors whose original producer is inside this root stop.
        for (const command of rows(
          db,
          "SELECT * FROM command WHERE session_id=? AND root_work_seq>? AND status='accepted' AND kind='extension.invoke'",
          current.id!,
          root.next_seq!,
        )) {
          const sequence = outputCollectionWorkSequence(db, command);
          if (sequence !== null && BigInt(sequence) <= BigInt(root.next_seq!))
            commandIds.add(String(command.id));
        }
        for (const execution of rows(
          db,
          "SELECT * FROM execution WHERE session_id=? AND root_work_seq>? AND state IN ('planned','dispatching','running','outcome_unknown') AND kind='job' AND adapter_id IN ('builtin.files/collect-outputs','builtin.files/collect')",
          current.id!,
          root.next_seq!,
        )) {
          const command = db.row('SELECT * FROM command WHERE id=?', execution.origin_command_id!);
          const sequence = command && outputCollectionWorkSequence(db, command);
          if (
            sequence !== null &&
            sequence !== undefined &&
            BigInt(sequence) <= BigInt(root.next_seq!)
          )
            seedIds.push(String(execution.id));
        }
        for (const run of rows(
          db,
          'SELECT id FROM run WHERE session_id=? AND is_active=1',
          current.id!,
        ))
          runSeed(String(run.id), false);
      }
    } else
      for (const run of rows(
        db,
        'SELECT id FROM run WHERE session_id=? AND is_active=1',
        input.sessionId,
      ))
        runSeed(String(run.id));
  }
  const uniqueSeeds = [...new Set(seedIds)];
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
      for (const childRun of rows(
        db,
        'SELECT id,origin_command_id FROM run WHERE session_id=? AND origin_command_id=? AND is_active=1',
        execution.child_session_id!,
        `child-start-${execution.id}`,
      )) {
        if (!runIds.includes(String(childRun.id))) runIds.push(String(childRun.id));
        commandIds.add(String(childRun.origin_command_id));
      }
      for (const childCommand of rows(
        db,
        "SELECT id FROM command WHERE session_id=? AND id=? AND status='accepted'",
        execution.child_session_id!,
        `child-start-${execution.id}`,
      ))
        commandIds.add(String(childCommand.id));
    }
    // Queued guidance belongs to one exact carrier even before its Run exists.
    for (const queuedInput of rows(
      db,
      "SELECT id FROM command WHERE kind='agent.queued_input' AND agent_carrier_execution_id=? AND status='accepted'",
      id,
    ))
      commandIds.add(String(queuedInput.id));
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
    const pending = rows(
      db,
      "SELECT id FROM command WHERE kind IN ('input.steer','result.include') AND input_target_run_id=? AND status IN ('accepted','applied')",
      id,
    );
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
    const interactions = [
      ...rows(
        db,
        "SELECT id,presentation_session_id FROM interaction WHERE execution_id=? AND state IN ('pending','answered') AND accepted_decision_revision IS NULL",
        id,
      ),
    ];
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
    const inputs = rows(
      db,
      "SELECT id FROM command WHERE kind IN ('input.steer','result.include') AND input_target_run_id=? AND status IN ('accepted','applied')",
      id,
    );
    for (const pending of inputs) {
      commandCancelled(db, String(pending.id), now);
      db.event(String(session.id), String(pending.id), 'input.cancel_requested');
    }
    const run = db.row('SELECT session_id,is_active,cancel_requested FROM run WHERE id=?', id)!;
    db.run(
      'UPDATE run SET cancel_requested=1,cancel_requested_at=COALESCE(cancel_requested_at,?) WHERE id=?',
      now,
      id,
    );
    db.event(
      String(run.session_id),
      id,
      'run.cancel_requested',
      input.userInitiated && run.is_active && !run.cancel_requested
        ? { userStopCommandId: input.commandId }
        : null,
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
