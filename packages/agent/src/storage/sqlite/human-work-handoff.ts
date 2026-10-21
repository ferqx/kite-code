import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { HandoffHumanRunInput, HandoffHumanRunResult } from '../human-work-handoff';
import type { OwnedWrite } from '../port';
import { AgentError, type Json, type RequirementRef } from '../types';
import { assertNoExecutionGroupFence } from './execution-group-safety';
import { readWorkEligibility } from './human-work-control';
import { assertInputBoundary } from './input-operations';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
const parse = (value: Row[string] | undefined): Record<string, Json> => JSON.parse(String(value));
const digest = (value: Json): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const handoffId = (storeId: string, runId: string, inputId: string) =>
  `human-handoff-${digest([storeId, runId, inputId])}`;

function publishInputHandoff(
  db: SqliteOperations,
  raw: Row,
  run: Row,
  controlRevision: string,
  state: 'queued' | 'handed_off',
  reason: string | null,
): void {
  const original = parse(raw.receipt_json),
    request = parse(raw.request_json);
  const waitState = digest({
    state,
    reason,
    controlRevision,
    runId: String(run.id),
    waiting: String(run.waiting_results_json),
    requirements: String(run.requirements_json),
    frontier: db.rows(
      "SELECT id,state,CAST(result_revision AS TEXT) AS resultRevision FROM execution WHERE run_id=? AND state IN('planned','dispatching','running','outcome_unknown') ORDER BY id",
      run.id!,
    ) as unknown as Json,
  });
  const previous = original.handoff as Record<string, Json> | undefined;
  if (previous?.waitState === waitState) return;
  const handoff: Json = {
    state,
    reason,
    runId: String(run.id),
    inputCommandId: String(raw.id),
    controlRevision,
    observedChangeCursor: db.metadata().lastChangeCursor,
    waitState,
  };
  const ids = [String(raw.id), request.publicCommandId, original.businessCommandId];
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    const command = db.row('SELECT * FROM command WHERE id=?', id);
    if (
      !command ||
      command.origin_store_id !== raw.origin_store_id ||
      command.session_id !== raw.session_id ||
      command.subject_id !== raw.subject_id
    )
      throw new AgentError('input_handoff_scope_unverifiable');
    db.run(
      'UPDATE command SET receipt_json=? WHERE id=?',
      canonicalJson({ ...parse(command.receipt_json), handoff }),
      id,
    );
  }
  db.event(String(raw.session_id), String(raw.id), 'human.handoff_status_changed', {
    state,
    reason,
    runId: String(run.id),
    controlRevision,
  });
}

/** Recheck the raw input, never infer a change of work from a notification or UI label. */
function boundary(
  db: SqliteOperations,
  input: OwnedWrite & { runId: string; inputCommandId: string },
) {
  db.identity(input.expectedStoreId);
  const run = db.row('SELECT * FROM run WHERE id=?', input.runId);
  if (!run || run.origin_store_id !== input.expectedStoreId) throw new AgentError('run_not_found');
  const session = db.owner(input.owner, String(run.session_id));
  const origin = db.row('SELECT * FROM command WHERE id=?', run.origin_command_id!);
  const raw = db.row(
    "SELECT * FROM command WHERE id=? AND kind='human.input'",
    input.inputCommandId,
  );
  if (
    session.parent_id !== null ||
    session.id !== input.owner.sessionId ||
    session.root_id !== session.id
  )
    throw new AgentError('group_root_required');
  if (
    !origin ||
    !raw ||
    raw.origin_store_id !== input.expectedStoreId ||
    raw.session_id !== run.session_id ||
    raw.subject_id !== origin.subject_id ||
    raw.input_context_selection_id !== session.context_selection_id ||
    run.context_selection_id !== session.context_selection_id
  )
    throw new AgentError('input_handoff_scope_unverifiable');
  const request = parse(raw.request_json),
    receipt = parse(raw.receipt_json);
  const candidates = receipt.candidateWorkCommandIds;
  if (!Array.isArray(candidates) || !candidates.includes(String(run.root_work_command_id)))
    throw new AgentError('input_handoff_scope_unverifiable');
  const observed =
    typeof request.observedRunId === 'string'
      ? db.row(
          'SELECT * FROM run WHERE id=? AND session_id=?',
          request.observedRunId,
          run.session_id!,
        )
      : null;
  if (
    request.observedRunId !== null &&
    (!observed || observed.origin_store_id !== input.expectedStoreId)
  )
    throw new AgentError('input_handoff_scope_unverifiable');
  const cancelledSelection =
    !!raw.cancelled &&
    receipt.state === 'cancelled' &&
    receipt.applicationState === 'queued' &&
    typeof receipt.decisionCommandId === 'string';
  if (origin.cancelled || run.cancel_requested || (raw.cancelled && !cancelledSelection))
    return { run, session, origin, raw, request, receipt, reason: 'input_or_work_cancelled' };
  if (!cancelledSelection && !['pending', 'unresolved', 'decided'].includes(String(receipt.state)))
    return { run, session, origin, raw, request, receipt, reason: 'input_handoff_unavailable' };
  if (receipt.state === 'decided' || cancelledSelection) {
    const decision =
      typeof receipt.decisionCommandId === 'string'
        ? db.row(
            "SELECT * FROM command WHERE id=? AND kind='human.input.decision' AND status='applied'",
            receipt.decisionCommandId,
          )
        : null;
    const sealed = decision && parse(decision.request_json);
    const proposal = sealed?.proposal as Record<string, Json> | undefined;
    if (
      !decision ||
      decision.session_id !== raw.session_id ||
      decision.subject_id !== raw.subject_id ||
      decision.origin_store_id !== raw.origin_store_id ||
      sealed?.inputCommandId !== raw.id ||
      sealed?.inputDigest !== raw.request_digest
    )
      throw new AgentError('input_handoff_scope_unverifiable');
    if (cancelledSelection) {
      const eligibility = readWorkEligibility(db, {
        sessionId: String(run.session_id),
        rootWorkCommandId: String(run.root_work_command_id),
        rootWorkSeq: String(run.root_work_seq),
        contextSelectionId: String(run.context_selection_id),
      });
      const business =
        typeof receipt.businessCommandId === 'string'
          ? db.row('SELECT * FROM command WHERE id=?', receipt.businessCommandId)
          : null;
      // Cancelling queued B does not undo its saved selection. This proof only
      // releases A's technical Run; B's cancelled input still cannot dispatch.
      if (
        decision.cancelled ||
        proposal?.relation !== 'independent_work' ||
        proposal.purpose !== 'work' ||
        proposal.selectionEffect !== 'select_work' ||
        parse(decision.receipt_json).selectionEffect !== 'select_work' ||
        parse(decision.receipt_json).businessCommandId !== business?.id ||
        !business?.cancelled ||
        business.status !== 'rejected' ||
        business.target_command_id !== decision.id ||
        business.origin_store_id !== raw.origin_store_id ||
        business.session_id !== raw.session_id ||
        business.subject_id !== raw.subject_id ||
        business.root_work_command_id !== decision.root_work_command_id ||
        String(business.root_work_seq) !== String(decision.root_work_seq) ||
        parse(business.receipt_json).outcome !== 'cancelled_before_apply' ||
        db.row('SELECT id FROM run WHERE origin_command_id=? LIMIT 1', business.id!) ||
        eligibility.state !== 'deferred' ||
        eligibility.reason !== 'work_not_selected' ||
        eligibility.latestInputCommandId !== raw.id ||
        eligibility.selectedWork?.rootWorkCommandId !== decision.root_work_command_id ||
        eligibility.selectedWork?.rootWorkSeq !== String(decision.root_work_seq)
      )
        return { run, session, origin, raw, request, receipt, reason: 'input_or_work_cancelled' };
    }
    if (
      proposal?.relation !== 'independent_work' &&
      !['pause', 'replace', 'stop'].includes(String(proposal?.purpose))
    )
      return {
        run,
        session,
        origin,
        raw,
        request,
        receipt,
        reason: 'input_does_not_require_handoff',
      };
  }
  return { run, session, origin, raw, request, receipt, reason: null };
}

/** Used only by finishRun inside the same writer transaction as the prepared handoff. */
export function assertHumanRunHandoff(
  db: SqliteOperations,
  input: OwnedWrite & {
    runId: string;
    inputHandoffCommandId: string;
  },
): string {
  const handoff = db.row(
    "SELECT * FROM command WHERE id=? AND kind='human.handoff' AND status='applied'",
    input.inputHandoffCommandId,
  );
  if (!handoff || handoff.origin_store_id !== input.expectedStoreId || handoff.cancelled)
    throw new AgentError('input_handoff_unverifiable');
  const request = parse(handoff.request_json),
    receipt = parse(handoff.receipt_json);
  if (
    typeof request.inputCommandId !== 'string' ||
    request.runId !== input.runId ||
    receipt.outcome !== 'human_handoff_prepared'
  )
    throw new AgentError('input_handoff_unverifiable');
  const checked = boundary(db, { ...input, inputCommandId: request.inputCommandId });
  if (
    checked.reason ||
    !checked.run.is_active ||
    handoff.session_id !== checked.run.session_id ||
    handoff.subject_id !== checked.origin.subject_id ||
    handoff.root_work_command_id !== checked.run.root_work_command_id ||
    String(handoff.root_work_seq) !== String(checked.run.root_work_seq) ||
    request.inputDigest !== checked.raw.request_digest ||
    request.controlRevision !== String(checked.session.control_revision) ||
    input.inputHandoffCommandId !==
      handoffId(input.expectedStoreId, input.runId, request.inputCommandId)
  )
    throw new AgentError('input_handoff_unverifiable');
  return request.inputCommandId;
}

/** Technical release of the Session, with original work and children left durable. */
export function handoffHumanRun(
  db: SqliteOperations,
  input: HandoffHumanRunInput,
): HandoffHumanRunResult {
  return db.tx(() => {
    const id = handoffId(input.expectedStoreId, input.runId, input.inputCommandId);
    const previous = db.row("SELECT * FROM command WHERE id=? AND kind='human.handoff'", id);
    if (previous) {
      db.identity(input.expectedStoreId);
      const saved = db.row('SELECT * FROM run WHERE id=?', input.runId);
      const original = db.row(
        "SELECT * FROM command WHERE id=? AND kind='human.input'",
        input.inputCommandId,
      );
      const fact = parse(previous.request_json),
        receipt = parse(previous.receipt_json);
      if (
        !saved ||
        !original ||
        previous.origin_store_id !== input.expectedStoreId ||
        previous.session_id !== saved.session_id ||
        previous.subject_id !== original.subject_id ||
        previous.root_work_command_id !== saved.root_work_command_id ||
        String(previous.root_work_seq) !== String(saved.root_work_seq) ||
        fact.runId !== input.runId ||
        fact.inputCommandId !== input.inputCommandId ||
        fact.inputDigest !== original.request_digest
      )
        throw new AgentError('input_handoff_unverifiable');
      db.owner(input.owner, String(saved.session_id));
      if (
        !saved.is_active &&
        saved.status === 'completed' &&
        saved.reason === 'human_work_deferred' &&
        receipt.outcome === 'human_handed_off'
      )
        return { run: db.runRecord(saved), handedOff: true, reason: 'human_work_deferred' };
      throw new AgentError('input_handoff_unverifiable');
    }
    const checked = boundary(db, input),
      { run, session, origin, raw } = checked;
    if (!run.is_active) {
      return { run: db.runRecord(run), handedOff: false, reason: 'run_not_active' };
    }
    const blocked = (reason: string): HandoffHumanRunResult => {
      publishInputHandoff(db, raw, run, String(session.control_revision), 'queued', reason);
      return { run: db.runRecord(run), handedOff: false, reason };
    };
    if (String(session.control_revision) !== input.expectedControlRevision)
      return blocked('human_control_changed');
    if (checked.reason) return blocked(checked.reason);
    db.active(input.owner, String(run.origin_command_id), input.runId);
    try {
      assertInputBoundary(db, input.runId, input.inputCommandId);
      assertNoExecutionGroupFence(db, String(run.session_id));
      db.requirements(
        JSON.parse(String(run.requirements_json)) as RequirementRef[],
        input.requirements,
        'completion',
      );
    } catch (error) {
      if (!(error instanceof AgentError)) throw error;
      return blocked(error.code);
    }
    const waiting = JSON.parse(String(run.waiting_results_json)) as unknown;
    if (!Array.isArray(waiting)) throw new AgentError('required_result_unverifiable');
    if (waiting.length) return blocked('required_results_pending');
    const unsettled = db.row(
      "SELECT state FROM execution WHERE run_id=? AND state IN('dispatching','running','outcome_unknown') LIMIT 1",
      input.runId,
    );
    if (unsettled)
      return blocked(
        unsettled.state === 'outcome_unknown' ? 'outcome_unknown' : 'execution_unsettled',
      );
    // A mandatory carrier still belongs to A even when it is not one of A's direct Tools.
    if (
      db.row(
        `SELECT e.id FROM execution e JOIN command c ON c.id=e.origin_command_id
      WHERE e.parent_execution_id IN(SELECT id FROM execution WHERE run_id=?)
        AND json_type(c.request_json,'$.resultRequirement') IS NOT NULL
        AND json_type(c.request_json,'$.resultRequirement')<>'null'
        AND (e.state IN('planned','dispatching','running','outcome_unknown') OR NOT EXISTS(
          SELECT 1 FROM context_snapshot s WHERE s.kind='result_ref' AND s.execution_id=e.id
            AND s.result_revision=e.result_revision AND s.selection_id=?
            AND json_extract(s.request_json,'$.targetRunId')=?
            AND COALESCE(json_extract(s.request_json,'$.diagnostic'),0)=0
            AND COALESCE(json_extract(s.request_json,'$.pendingInput'),0)=0)) LIMIT 1`,
        input.runId,
        session.context_selection_id!,
        input.runId,
      )
    )
      return blocked('required_results_pending');
    const planned = db.rows(
      "SELECT * FROM execution WHERE run_id=? AND state='planned' AND dispatched=0 AND kind IN('model','tool') ORDER BY id LIMIT 4097",
      input.runId,
    );
    if (planned.length > 4096) return blocked('input_scope_too_large');
    if (
      db.row(
        "SELECT id FROM execution WHERE run_id=? AND state='planned' AND (dispatched<>0 OR kind NOT IN('model','tool')) LIMIT 1",
        input.runId,
      )
    )
      return blocked('execution_unsettled');
    for (const execution of planned) {
      if (BigInt(execution.result_revision!) >= 9223372036854775807n)
        throw new AgentError('sequence_exhausted');
      db.run(
        "UPDATE execution SET state='cancelled',result_json=?,result_revision=result_revision+1 WHERE id=?",
        canonicalJson({
          outcome: 'cancelled',
          content: 'human_work_deferred',
          details: {
            code: 'human_work_deferred',
            adapterAttempted: false,
            inputCommandId: input.inputCommandId,
          },
        }),
        execution.id!,
      );
      for (const card of db.rows(
        "SELECT id,presentation_session_id,revision FROM interaction WHERE execution_id=? AND state IN('pending','answered')",
        execution.id!,
      )) {
        if (BigInt(card.revision!) >= 9223372036854775807n)
          throw new AgentError('sequence_exhausted');
        db.run("UPDATE interaction SET state='cancelled',revision=revision+1 WHERE id=?", card.id!);
        if (
          db.row('SELECT id FROM permission_grant WHERE id=? AND revoked_seq IS NULL', card.id!)
        ) {
          db.run(
            "INSERT INTO permission_grant_change(origin_store_id,subject_id,session_id,kind) VALUES(?,?,?,'clear')",
            input.expectedStoreId,
            origin.subject_id!,
            run.session_id!,
          );
          const revision = db.row(
            'SELECT CAST(MAX(seq) AS TEXT) AS revision FROM permission_grant_change',
          )!.revision!;
          db.run(
            'UPDATE permission_grant SET revoked_seq=? WHERE id=? AND revoked_seq IS NULL',
            revision,
            card.id!,
          );
        }
        db.event(String(card.presentation_session_id), String(card.id), 'interaction.superseded', {
          inputCommandId: input.inputCommandId,
          reason: 'human_work_deferred',
        });
      }
      if (execution.kind === 'tool')
        db.appendMessage(
          String(run.session_id),
          input.runId,
          {
            content: 'human_work_deferred',
            toolCallId: String(execution.call_id),
            sourceIds: [String(execution.id)],
          },
          'tool',
        );
      db.event(String(run.session_id), String(execution.id), 'execution.superseded', {
        inputCommandId: input.inputCommandId,
      });
    }
    const request: Json = {
      kind: 'human.handoff',
      runId: input.runId,
      inputCommandId: input.inputCommandId,
      inputDigest: String(raw.request_digest),
      controlRevision: input.expectedControlRevision,
      rootWorkCommandId: String(run.root_work_command_id),
      rootWorkSeq: String(run.root_work_seq),
      source: { kind: 'human_input', commandId: input.inputCommandId },
    };
    db.insertCommand(
      {
        expectedStoreId: input.expectedStoreId,
        sessionId: String(run.session_id),
        subjectId: String(origin.subject_id),
        commandId: id,
      },
      request,
      digest(request),
      'applied',
      {
        outcome: 'human_handoff_prepared',
        runId: input.runId,
        inputCommandId: input.inputCommandId,
      },
    );
    db.run(
      'UPDATE command SET root_work_command_id=?,root_work_seq=? WHERE id=?',
      run.root_work_command_id!,
      run.root_work_seq!,
      id,
    );
    const finished = db.finishRun({
      ...input,
      status: 'completed',
      reason: 'human_work_deferred',
      inputHandoffCommandId: id,
    });
    db.run(
      'UPDATE command SET receipt_json=? WHERE id=?',
      canonicalJson({
        outcome: 'human_handed_off',
        runId: input.runId,
        inputCommandId: input.inputCommandId,
        reason: 'human_work_deferred',
        controlRevision: input.expectedControlRevision,
      }),
      id,
    );
    publishInputHandoff(
      db,
      raw,
      db.row('SELECT * FROM run WHERE id=?', input.runId)!,
      input.expectedControlRevision,
      'handed_off',
      null,
    );
    db.event(String(run.session_id), id, 'human.run_handed_off');
    return { run: finished, handedOff: true, reason: 'human_work_deferred' };
  });
}
