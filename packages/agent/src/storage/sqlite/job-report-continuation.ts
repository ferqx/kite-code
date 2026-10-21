import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { ContinueHumanWorkInput } from '../job-report-continuation';
import { AgentError, type Json } from '../types';
import { verifyFirstActivation } from './child-first-activation';
import { assertNoExecutionGroupFence } from './execution-group-safety';
import { readWorkEligibility } from './human-work-control';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
const parse = (value: Row[string] | undefined) => JSON.parse(String(value)) as Record<string, Json>;
const hash = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const originalReportId = (execution: Row) =>
  `report-${hash([String(execution.origin_store_id), String(execution.id), String(execution.result_revision)])}`;

function decision(db: SqliteOperations, id: string, subjectId: string) {
  const value = db.row(
    "SELECT * FROM command WHERE id=? AND kind='human.input.decision' AND status='applied'",
    id,
  );
  const request = value && parse(value.request_json),
    receipt = value && parse(value.receipt_json);
  const raw =
    request &&
    db.row(
      "SELECT * FROM command WHERE id=? AND kind='human.input' AND status='applied'",
      String(request.inputCommandId),
    );
  const rawReceipt = raw && parse(raw.receipt_json);
  const session = value && db.row('SELECT * FROM session WHERE id=?', value.session_id!);
  if (
    !value ||
    !request ||
    !receipt ||
    !raw ||
    !session ||
    value.cancelled ||
    raw.cancelled ||
    value.origin_store_id !== db.metadata().storeId ||
    value.subject_id !== subjectId ||
    raw.subject_id !== subjectId ||
    raw.session_id !== value.session_id ||
    session.parent_id !== null ||
    receipt.purpose !== 'continue' ||
    receipt.selectionEffect !== 'select_work' ||
    receipt.targetRootWorkCommandId !== value.root_work_command_id ||
    request.inputDigest !== raw.request_digest ||
    rawReceipt?.decisionCommandId !== value.id ||
    !['decided', 'clarified'].includes(String(rawReceipt?.state))
  )
    throw new AgentError('work_continuation_unverifiable');
  return { value, receipt, session };
}
function exactCarrierStart(db: SqliteOperations, start: Row, carrier: Row): boolean {
  const request = parse(start.request_json);
  if (
    start.id !== `child-start-${carrier.id}` ||
    start.session_id !== carrier.child_session_id ||
    start.origin_store_id !== carrier.origin_store_id ||
    start.root_work_command_id !== carrier.root_work_command_id ||
    String(start.root_work_seq) !== String(carrier.root_work_seq)
  )
    return false;
  if (start.kind === 'child.start') {
    verifyFirstActivation(db, carrier, start);
    return request.parentExecutionId === carrier.id;
  }
  if (
    start.kind !== 'input.follow_up' ||
    start.agent_carrier_execution_id !== carrier.id ||
    start.agent_source_execution_id !== carrier.parent_execution_id ||
    !carrier.predecessor_execution_id
  )
    return false;
  const predecessor = db.row(
    `SELECT r.id,r.context_selection_id FROM run r JOIN execution previous
    ON previous.id=? AND previous.child_session_id=r.session_id
    WHERE r.id=? AND r.session_id=? AND r.origin_command_id='child-start-'||previous.id
      AND r.origin_store_id=? AND previous.origin_store_id=r.origin_store_id
      AND previous.session_id=? AND previous.root_session_id=?`,
    carrier.predecessor_execution_id,
    start.after_run_id!,
    carrier.child_session_id!,
    carrier.origin_store_id!,
    carrier.session_id!,
    carrier.root_session_id!,
  );
  return Boolean(
    predecessor &&
      request.afterRunId === predecessor.id &&
      request.contextSelectionId === predecessor.context_selection_id &&
      start.input_context_selection_id === predecessor.context_selection_id,
  );
}
function validQualification(
  db: SqliteOperations,
  qualification: Row,
  execution: Row,
  historical = false,
): boolean {
  try {
    const request = parse(qualification.request_json),
      receipt = parse(qualification.receipt_json);
    const d = decision(
      db,
      String(request.continueDecisionCommandId),
      String(qualification.subject_id),
    );
    const binding = parse(execution.after_turn_json);
    const start = db.row(
      "SELECT * FROM command WHERE id=? AND kind IN('child.start','input.follow_up')",
      String(request.startCommandId),
    );
    const source = db.row('SELECT * FROM execution WHERE id=?', String(binding.sourceExecutionId));
    const local = db.row('SELECT * FROM session WHERE id=?', execution.session_id!);
    if (
      qualification.kind !== 'job.report.qualification' ||
      qualification.status !== 'applied' ||
      qualification.cancelled ||
      qualification.id !==
        `report-qualification-${hash([String(d.value.id), String(execution.id)])}` ||
      qualification.origin_store_id !== execution.origin_store_id ||
      qualification.session_id !== execution.session_id ||
      qualification.root_work_command_id !== execution.root_work_command_id ||
      String(qualification.root_work_seq) !== String(execution.root_work_seq) ||
      request.carrierExecutionId !== execution.id ||
      request.subscriptionDigest !== hash(binding) ||
      request.controlRevision !== d.receipt.controlRevision ||
      receipt.outcome !== 'future_result_eligible' ||
      !start ||
      !exactCarrierStart(db, start, execution) ||
      start.request_digest !== request.startRequestDigest ||
      start.origin_store_id !== execution.origin_store_id ||
      start.subject_id !== qualification.subject_id ||
      start.cancelled ||
      !source ||
      source.id !== execution.parent_execution_id ||
      source.state !== 'succeeded' ||
      source.cancel_requested ||
      !local ||
      local.context_selection_id !== binding.contextSelectionId ||
      binding.kind !== 'agent_completion' ||
      execution.cancel_requested ||
      execution.state === 'outcome_unknown' ||
      (execution.delivery === 'consumed' && !historical)
    )
      return false;
    if (historical) return true;
    if (
      db.row(
        `SELECT id FROM command WHERE session_id=? AND kind='human.input.decision' AND status='applied' AND seq>?
      AND json_extract(receipt_json,'$.targetRootWorkCommandId')=?
      AND json_extract(receipt_json,'$.purpose') IN('pause','replace','stop') LIMIT 1`,
        d.value.session_id!,
        d.value.seq!,
        execution.root_work_command_id!,
      )
    )
      return false;
    const eligibility = readWorkEligibility(db, {
      sessionId: String(execution.session_id),
      rootWorkCommandId: String(execution.root_work_command_id),
      rootWorkSeq: String(execution.root_work_seq),
      contextSelectionId: String(binding.contextSelectionId),
    });
    if (eligibility.state === 'revoked') return false;
    assertNoExecutionGroupFence(db, String(d.value.session_id));
    return true;
  } catch (error) {
    if (error instanceof AgentError) return false;
    throw error;
  }
}
/** Exact private proof for a new admission. Original reports and their receipts stay historical. */
export function continuationReportProof(
  db: SqliteOperations,
  report: Row,
  execution: Row,
): Row | null {
  if (report.kind !== 'job.report.continue') return null;
  const request = parse(report.request_json);
  const original = db.row(
    "SELECT * FROM command WHERE id=? AND kind='job.report'",
    String(request.originalReportCommandId),
  );
  const qualification = db.row(
    "SELECT * FROM command WHERE id=? AND kind='job.report.qualification'",
    String(request.continuationCommandId),
  );
  const receipt = parse(report.receipt_json);
  const historical =
    report.status === 'applied' &&
    execution.delivery === 'consumed' &&
    typeof receipt.sourceId === 'string' &&
    Boolean(
      db.row(
        "SELECT id FROM context_snapshot WHERE id=? AND kind='result_ref' AND session_id=? AND execution_id=? AND result_revision=?",
        receipt.sourceId,
        report.session_id!,
        execution.id!,
        execution.result_revision!,
      ),
    );
  if (
    !original ||
    !qualification ||
    original.id !== originalReportId(execution) ||
    report.id !== `report-continue-${hash([String(qualification.id), String(original.id)])}` ||
    original.origin_store_id !== report.origin_store_id ||
    original.session_id !== report.session_id ||
    original.subject_id !== report.subject_id ||
    original.root_work_command_id !== report.root_work_command_id ||
    String(original.root_work_seq) !== String(report.root_work_seq) ||
    request.continueDecisionCommandId !==
      parse(qualification.request_json).continueDecisionCommandId ||
    canonicalJson(parse(original.request_json)) !==
      canonicalJson(
        Object.fromEntries(
          Object.entries(request)
            .filter(
              ([key]) =>
                ![
                  'originalReportCommandId',
                  'continuationCommandId',
                  'continueDecisionCommandId',
                ].includes(key),
            )
            .map(([key, value]) => [key, key === 'kind' ? 'job.report' : value]),
        ),
      ) ||
    !validQualification(db, qualification, execution, historical)
  )
    throw new AgentError('report_continuation_unverifiable');
  return original;
}
/** A revoked original subscription never obtains fresh admission merely from a later control state. */
export function reportRequiresContinuation(
  db: SqliteOperations,
  execution: Row,
  binding: Record<string, Json>,
): boolean {
  if (binding.kind !== 'agent_completion') return false;
  const local = db.row('SELECT root_id FROM session WHERE id=?', execution.session_id!);
  return Boolean(
    local &&
      db.row(
        `SELECT id FROM command WHERE session_id=? AND kind='human.input.decision' AND status='applied'
    AND json_extract(receipt_json,'$.targetRootWorkCommandId')=?
    AND json_extract(receipt_json,'$.purpose') IN('pause','replace','stop')
    AND CAST(json_extract(receipt_json,'$.controlRevision') AS INTEGER)>CAST(? AS INTEGER) LIMIT 1`,
        local.root_id!,
        execution.root_work_command_id!,
        typeof binding.workControlRevision === 'string' ? binding.workControlRevision : '0',
      ),
  );
}
/** Called in the original carrier terminal-result transaction after its unique report is saved. */
export function registerContinuedReport(db: SqliteOperations, execution: Row): void {
  const original = db.row(
    "SELECT * FROM command WHERE id=? AND kind='job.report'",
    originalReportId(execution),
  );
  if (!original || execution.delivery === 'consumed') return;
  const qualifications = db.rows(
    "SELECT * FROM command WHERE kind='job.report.qualification' AND session_id=? AND json_extract(request_json,'$.carrierExecutionId')=? ORDER BY seq DESC",
    execution.session_id!,
    execution.id!,
  );
  const qualification = qualifications.find((value) => validQualification(db, value, execution));
  if (!qualification) return;
  const oldReceipt = parse(original.receipt_json);
  if (
    original.status === 'applied' ||
    (original.status === 'rejected' &&
      ![
        'work_paused',
        'result_not_pending',
        'continuation_admission',
        'continuation_required',
      ].includes(String(oldReceipt.reason)))
  )
    return;
  const request: Json = {
    ...parse(original.request_json),
    kind: 'job.report.continue',
    originalReportCommandId: String(original.id),
    continuationCommandId: String(qualification.id),
    continueDecisionCommandId: parse(qualification.request_json).continueDecisionCommandId!,
  };
  const id = `report-continue-${hash([String(qualification.id), String(original.id)])}`;
  if (db.row('SELECT id FROM command WHERE id=?', id)) return;
  db.insertCommand(
    {
      expectedStoreId: String(original.origin_store_id),
      commandId: id,
      sessionId: String(original.session_id),
      subjectId: String(original.subject_id),
    },
    request,
    hash(request),
    'accepted',
    {
      outcome: 'report_pending',
      executionId: String(execution.id),
      originalReportCommandId: String(original.id),
      continuationCommandId: String(qualification.id),
    },
  );
  db.run(
    'UPDATE command SET root_work_command_id=?,root_work_seq=? WHERE id=?',
    execution.root_work_command_id!,
    execution.root_work_seq!,
    id,
  );
  if (original.status === 'accepted')
    db.run(
      "UPDATE command SET status='rejected',receipt_json=? WHERE id=?",
      canonicalJson({
        outcome: 'suppressed',
        reason: 'continuation_admission',
        executionId: String(execution.id),
        continuationCommandId: id,
      }),
      original.id!,
    );
  db.event(String(original.session_id), id, 'job.report_continuation_registered');
}
/** Check before recording a continue decision; no unknown original effects gain a new business Run. */
export function assertHumanWorkContinuable(
  db: SqliteOperations,
  input: {
    sessionId: string;
    rootWorkCommandId: string;
    rootWorkSeq: string;
  },
): void {
  assertNoExecutionGroupFence(db, input.sessionId);
  const eligibility = readWorkEligibility(db, input);
  if (eligibility.state === 'revoked' && eligibility.reason !== 'work_paused')
    throw new AgentError('work_resume_unavailable');
  const root = db.row('SELECT root_id FROM session WHERE id=?', input.sessionId);
  if (
    !root ||
    db.row(
      `SELECT e.id FROM execution e JOIN session s ON s.id=e.session_id
    WHERE s.root_id=? AND e.root_work_command_id=? AND e.root_work_seq=? AND e.state='outcome_unknown' LIMIT 1`,
      root.root_id!,
      input.rootWorkCommandId,
      input.rootWorkSeq,
    )
  )
    throw new AgentError('work_resume_outcome_unknown');
}
/** Run inside decideHumanInput after the raw input and exact continue decision are durable in this transaction. */
export function continueHumanWork(db: SqliteOperations, input: ContinueHumanWorkInput): void {
  const d = decision(db, input.decisionCommandId, input.subjectId);
  if (
    String(d.session.control_revision) !== input.controlRevision ||
    d.receipt.controlRevision !== input.controlRevision
  )
    throw new AgentError('human_control_changed');
  assertHumanWorkContinuable(db, {
    sessionId: String(d.session.id),
    rootWorkCommandId: String(d.value.root_work_command_id),
    rootWorkSeq: String(d.value.root_work_seq),
  });
  const previous = db.row(
    `SELECT receipt_json FROM command WHERE session_id=? AND kind='human.input.decision' AND status='applied' AND seq<?
    AND json_extract(receipt_json,'$.targetRootWorkCommandId')=? AND json_extract(receipt_json,'$.purpose') IN('pause','continue','replace','stop') ORDER BY seq DESC LIMIT 1`,
    d.value.session_id!,
    d.value.seq!,
    d.value.root_work_command_id!,
  );
  if (!previous || parse(previous.receipt_json).purpose !== 'pause') return;
  const carriers = db.rows(
    `SELECT e.* FROM execution e JOIN session s ON s.id=e.session_id WHERE s.root_id=?
    AND e.root_work_command_id=? AND e.root_work_seq=? AND e.kind='job' AND e.after_turn_json IS NOT NULL
    AND (e.delivery IN('pending','suppressed') OR (e.delivery IS NULL AND e.state IN('planned','dispatching','running'))) AND e.cancel_requested=0`,
    d.session.id!,
    d.value.root_work_command_id!,
    d.value.root_work_seq!,
  );
  for (const carrier of carriers) {
    if (
      parse(carrier.after_turn_json).kind !== 'agent_completion' ||
      carrier.state === 'outcome_unknown' ||
      carrier.state === 'cancelled'
    )
      continue;
    if (carrier.delivery === 'suppressed' && carrier.delivery_reason !== 'work_paused') continue;
    const start = db.row(
      "SELECT * FROM command WHERE id=? AND kind IN('child.start','input.follow_up')",
      `child-start-${carrier.id}`,
    );
    if (!start || start.cancelled || !exactCarrierStart(db, start, carrier)) continue;
    const request: Json = {
      kind: 'job.report.qualification',
      continueDecisionCommandId: input.decisionCommandId,
      carrierExecutionId: String(carrier.id),
      startCommandId: String(start.id),
      startRequestDigest: String(start.request_digest),
      subscriptionDigest: hash(parse(carrier.after_turn_json)),
      controlRevision: input.controlRevision,
    };
    const id = `report-qualification-${hash([input.decisionCommandId, String(carrier.id)])}`;
    if (!db.row('SELECT id FROM command WHERE id=?', id)) {
      db.insertCommand(
        {
          expectedStoreId: String(carrier.origin_store_id),
          commandId: id,
          sessionId: String(carrier.session_id),
          subjectId: input.subjectId,
        },
        request,
        hash(request),
        'applied',
        { outcome: 'future_result_eligible' },
      );
      db.run(
        'UPDATE command SET root_work_command_id=?,root_work_seq=? WHERE id=?',
        carrier.root_work_command_id!,
        carrier.root_work_seq!,
        id,
      );
      db.event(String(carrier.session_id), id, 'job.report_qualification_saved');
    }
    if (['succeeded', 'failed'].includes(String(carrier.state)))
      registerContinuedReport(db, carrier);
  }
}
