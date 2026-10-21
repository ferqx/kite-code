import { createHash } from 'node:crypto';
import { inputFileReferences } from '../../input-files';
import { canonicalJson } from '../../json';
import type {
  BeginHumanInputProcessing,
  DecideHumanInput,
  HumanInputDecision,
  HumanWorkEligibility,
  HumanWorkIdentity,
  HumanWorkScope,
  HumanWorkState,
  RegisterHumanInput,
} from '../human-work-control';
import { AgentError, type CommandRecord, type Json } from '../types';
import { assertInputImages } from './artifact-operations';
import { cancelWorkBody } from './cancel-operations';
import { validateInputAdmission } from './input-operations';
import { assertHumanWorkContinuable, continueHumanWork } from './job-report-continuation';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;

export type {
  BeginHumanInputProcessing,
  DecideHumanInput,
  HumanInputDecision,
  HumanInputProposal,
  HumanWorkEligibility,
  HumanWorkIdentity,
  HumanWorkScope,
  HumanWorkState,
  RegisterHumanInput,
} from '../human-work-control';

const parse = (value: Row[string] | undefined): Record<string, Json> => JSON.parse(String(value));
const hash = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function decimal(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 9223372036854775807n)
    throw new AgentError('invalid_control_revision');
  return BigInt(value);
}
function id(value: string): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,256}$/.test(value))
    throw new AgentError('invalid_command_id');
}
function root(db: SqliteOperations, input: HumanWorkScope): Row {
  db.identity(input.expectedStoreId);
  const session = db.row('SELECT * FROM session WHERE id=?', input.sessionId);
  const creator = db.row(
    "SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'",
    input.sessionId,
  );
  if (!session || session.delete_requested) throw new AgentError('session_not_found');
  if (session.parent_id !== null || session.root_id !== session.id)
    throw new AgentError('group_root_required');
  if (creator?.subject_id !== input.subjectId) throw new AgentError('permission_denied');
  return session;
}
function work(db: SqliteOperations, scope: HumanWorkScope, commandId: string): Row {
  const command = db.row(
    'SELECT * FROM command WHERE id=? AND session_id=?',
    commandId,
    scope.sessionId,
  );
  if (
    !command ||
    command.subject_id !== scope.subjectId ||
    command.origin_store_id !== scope.expectedStoreId ||
    command.root_work_command_id !== command.id ||
    !['run.start', 'input.steer', 'input.follow_up', 'human.input'].includes(String(command.kind))
  )
    throw new AgentError('work_scope_unverifiable');
  return command;
}
function bump(db: SqliteOperations, sessionId: string): string {
  const revision = String(
    db.row('SELECT control_revision FROM session WHERE id=?', sessionId)!.control_revision,
  );
  if (decimal(revision) === 9223372036854775807n)
    throw new AgentError('control_revision_exhausted');
  db.run('UPDATE session SET control_revision=control_revision+1 WHERE id=?', sessionId);
  return String(BigInt(revision) + 1n);
}
function selected(db: SqliteOperations, sessionId: string): HumanWorkIdentity | null {
  // Cancellation never erases the last human selection boundary.
  // Restored records retain their origin, but cannot control work in a new Store.
  const selection = db.row(
    `SELECT root_work_command_id,root_work_seq,seq FROM command WHERE session_id=? AND origin_store_id=? AND
      ((kind IN ('run.start','input.follow_up') AND agent_source_execution_id IS NULL AND target_command_id IS NULL)
       OR (kind='human.input.decision' AND status='applied' AND json_extract(receipt_json,'$.selectionEffect')='select_work'))
      ORDER BY seq DESC LIMIT 1`,
    sessionId,
    db.metadata().storeId,
  );
  return selection
    ? {
        rootWorkCommandId: String(selection.root_work_command_id),
        rootWorkSeq: String(selection.root_work_seq),
      }
    : null;
}
function pending(db: SqliteOperations, sessionId: string): Row[] {
  return db.rows(
    "SELECT * FROM command WHERE session_id=? AND origin_store_id=? AND kind='human.input' AND cancelled=0 AND json_extract(receipt_json,'$.state') IN ('pending','unresolved') ORDER BY seq",
    sessionId,
    db.metadata().storeId,
  );
}
function state(db: SqliteOperations, sessionId: string): HumanWorkState {
  return {
    latestInputCommandId:
      (db.row(
        "SELECT id FROM command WHERE session_id=? AND origin_store_id=? AND kind='human.input' ORDER BY seq DESC LIMIT 1",
        sessionId,
        db.metadata().storeId,
      )?.id as string | undefined) ?? null,
    controlRevision: String(
      db.row('SELECT control_revision FROM session WHERE id=?', sessionId)!.control_revision,
    ),
    selectedWork: selected(db, sessionId),
    pendingInputIds: pending(db, sessionId).map((row) => String(row.id)),
  };
}
export function readHumanWorkState(db: SqliteOperations, input: HumanWorkScope): HumanWorkState {
  db.db.run('BEGIN');
  try {
    root(db, input);
    const result = state(db, input.sessionId);
    db.db.run('COMMIT');
    return result;
  } catch (error) {
    return db.rollback(error);
  }
}
export function readHumanWorkEligibility(
  db: SqliteOperations,
  input: import('../human-work-control').ReadHumanWorkEligibility,
) {
  db.db.run('BEGIN');
  try {
    db.identity(input.expectedStoreId);
    const local = db.row('SELECT root_id FROM session WHERE id=?', input.sessionId);
    if (!local) throw new AgentError('session_not_found');
    root(db, { ...input, sessionId: String(local.root_id) });
    const result = { ...readWorkEligibility(db, input), cursor: db.metadata().lastChangeCursor };
    db.db.run('COMMIT');
    return result;
  } catch (error) {
    return db.rollback(error);
  }
}
/** Raw text and its original observation are durable before any interpretation. */
export function registerHumanInput(db: SqliteOperations, input: RegisterHumanInput): CommandRecord {
  return db.tx(() => registerHumanInputWork(db, input));
}
/** Public invocation and private input priority are committed with no runnable window. */
export function registerHumanCommand(
  db: SqliteOperations,
  input: import('../human-work-control').RegisterHumanCommand,
): CommandRecord {
  return db.tx(() => {
    const session = root(db, input);
    id(input.commandId);
    const request = input.request;
    if (
      !['run.start', 'input.steer', 'input.follow_up'].includes(request.kind) ||
      !('content' in request)
    )
      throw new AgentError('invalid_input_request');
    const digest = hash(request as unknown as Json);
    const previous = db.row('SELECT * FROM command WHERE id=?', input.commandId);
    if (previous) {
      if (
        previous.request_digest !== digest ||
        previous.session_id !== input.sessionId ||
        previous.subject_id !== input.subjectId ||
        previous.origin_store_id !== input.expectedStoreId
      )
        throw new AgentError('command_conflict');
      return db.command(previous);
    }
    validateInputAdmission(db, input);
    const inputId = `human-input-${hash([input.expectedStoreId, input.commandId])}`;
    const active = db.row('SELECT id FROM run WHERE session_id=? AND is_active=1', input.sessionId);
    const observedRunId =
      request.kind === 'input.steer'
        ? request.targetRunId
        : active
          ? String(active.id)
          : request.kind === 'input.follow_up'
            ? request.afterRunId
            : null;
    db.insertCommand(input, request as unknown as Json, digest, 'accepted', {
      outcome: 'human_input_pending',
      humanInputCommandId: inputId,
      runId: null,
    });
    // This pointer distinguishes the public invocation from an ordinary runnable start.
    db.run(
      'UPDATE command SET target_command_id=?,input_context_selection_id=? WHERE id=?',
      inputId,
      session.context_selection_id!,
      input.commandId,
    );
    registerHumanInputWork(
      db,
      {
        ...input,
        commandId: inputId,
        content: request.content,
        originalRequest: request,
        contextSelectionId:
          request.kind === 'run.start'
            ? String(session.context_selection_id)
            : request.contextSelectionId,
        observedRunId,
        ...(input.candidateWorkCommandIds
          ? { candidateWorkCommandIds: input.candidateWorkCommandIds }
          : {}),
        ...(input.clarifiesInputId ? { clarifiesInputId: input.clarifiesInputId } : {}),
      },
      input.commandId,
    );
    db.event(input.sessionId, input.commandId, 'human.command_registered');
    return db.command(db.row('SELECT * FROM command WHERE id=?', input.commandId)!);
  });
}
function registerHumanInputWork(
  db: SqliteOperations,
  input: RegisterHumanInput,
  publicCommandId: string | null = null,
): CommandRecord {
  const session = root(db, input);
  id(input.commandId);
  const hasAttachments =
    input.originalRequest &&
    (('images' in input.originalRequest && input.originalRequest.images?.length) ||
      ('files' in input.originalRequest && input.originalRequest.files?.length));
  if (
    typeof input.content !== 'string' ||
    (!input.content.trim() && publicCommandId === null) ||
    (input.content.length === 0 && !hasAttachments) ||
    Buffer.byteLength(input.content) > 1024 * 1024
  )
    throw new AgentError('invalid_input_request');
  const request = {
    kind: 'human.input',
    content: input.content,
    contextSelectionId: input.contextSelectionId,
    observedRunId: input.observedRunId,
    originalRequest: input.originalRequest ?? null,
    publicCommandId,
    candidateWorkCommandIds: [...(input.candidateWorkCommandIds ?? [])],
    clarifiesInputId: input.clarifiesInputId ?? null,
  } as unknown as Json;
  const digest = hash(request);
  const previous = db.row('SELECT * FROM command WHERE id=?', input.commandId);
  if (previous) {
    if (
      previous.request_digest !== digest ||
      previous.kind !== 'human.input' ||
      previous.session_id !== input.sessionId ||
      previous.subject_id !== input.subjectId ||
      previous.origin_store_id !== input.expectedStoreId
    )
      throw new AgentError('command_conflict');
    return db.command(previous);
  }
  if (input.contextSelectionId !== session.context_selection_id)
    throw new AgentError('context_selection_changed');
  if (input.originalRequest) {
    const raw = input.originalRequest;
    if (
      !['run.start', 'input.steer', 'input.follow_up'].includes(raw.kind) ||
      !('content' in raw) ||
      raw.content !== input.content ||
      Object.keys(raw).some(
        (key) =>
          ![
            'kind',
            'content',
            'images',
            'files',
            'targetRunId',
            'afterRunId',
            'contextSelectionId',
            'modelId',
            'reasoningEffort',
            'selectedSkills',
            'extensionInputs',
          ].includes(key),
      )
    )
      throw new AgentError('invalid_input_request');
    if ('images' in raw && raw.images !== undefined)
      assertInputImages(db, { ...input, images: raw.images });
    if ('files' in raw && raw.files !== undefined) inputFileReferences(raw.files);
  }
  const observed =
    input.observedRunId === null
      ? null
      : db.row(
          'SELECT * FROM run WHERE id=? AND session_id=?',
          input.observedRunId,
          input.sessionId,
        );
  if (
    input.observedRunId !== null &&
    (!observed || observed.origin_store_id !== input.expectedStoreId)
  )
    throw new AgentError('input_target_changed');
  const candidates = input.candidateWorkCommandIds ?? [];
  if (
    !Array.isArray(candidates) ||
    candidates.length > 16 ||
    new Set(candidates).size !== candidates.length
  )
    throw new AgentError('invalid_input_candidates');
  for (const candidate of candidates) work(db, input, candidate);
  if (input.clarifiesInputId) {
    const original = db.row(
      "SELECT * FROM command WHERE id=? AND kind='human.input'",
      input.clarifiesInputId,
    );
    if (
      !original ||
      original.session_id !== input.sessionId ||
      original.subject_id !== input.subjectId ||
      original.origin_store_id !== input.expectedStoreId ||
      !['pending', 'unresolved'].includes(String(parse(original.receipt_json).state))
    )
      throw new AgentError('input_clarification_unverifiable');
  }
  const originalSelection = selected(db, input.sessionId);
  const candidateIds = candidates.length
    ? [...candidates]
    : observed
      ? [String(observed.root_work_command_id)]
      : originalSelection
        ? [originalSelection.rootWorkCommandId]
        : [];
  db.insertCommand(input, request, digest, 'applied', {
    state: 'pending',
    observedControlRevision: String(session.control_revision),
    originalSelection: originalSelection as unknown as Json,
    candidateWorkCommandIds: candidateIds,
  });
  db.run(
    'UPDATE command SET input_context_selection_id=? WHERE id=?',
    input.contextSelectionId,
    input.commandId,
  );
  bump(db, input.sessionId);
  db.event(input.sessionId, input.commandId, 'human.input_registered');
  return db.command(db.row('SELECT * FROM command WHERE id=?', input.commandId)!);
}
/** A queued ordinary Run, with its own causality, that cannot grant business effects. */
export function beginHumanInputProcessing(
  db: SqliteOperations,
  input: BeginHumanInputProcessing,
): CommandRecord {
  return db.tx(() => {
    const session = root(db, input);
    const original = db.row(
      "SELECT * FROM command WHERE id=? AND kind='human.input'",
      input.inputCommandId,
    );
    if (
      !original ||
      original.session_id !== input.sessionId ||
      original.subject_id !== input.subjectId ||
      original.origin_store_id !== input.expectedStoreId ||
      original.request_digest !== input.inputDigest
    )
      throw new AgentError('input_proposal_unverifiable');
    const tools = input.readOnlyTools ?? [];
    if (
      !Array.isArray(tools) ||
      tools.length > 256 ||
      tools.some(
        (tool) =>
          !tool ||
          typeof tool.id !== 'string' ||
          !tool.id ||
          tool.id.length > 256 ||
          typeof tool.version !== 'string' ||
          !tool.version ||
          tool.version.length > 128,
      ) ||
      new Set(tools.map((tool) => tool.id)).size !== tools.length
    )
      throw new AgentError('invalid_processing_tools');
    const commandId = `human-processing-${hash([input.expectedStoreId, input.inputCommandId])}`;
    const request: Json = {
      kind: 'run.start',
      content: String(parse(original.request_json).content),
    };
    const receipt: Json = {
      outcome: 'human_input_processing',
      inputCommandId: input.inputCommandId,
      inputDigest: input.inputDigest,
      readOnlyTools: tools as unknown as Json,
    };
    const previous = db.row('SELECT * FROM command WHERE id=?', commandId);
    if (previous) {
      const old = parse(original.receipt_json);
      if (
        previous.target_command_id !== input.inputCommandId ||
        previous.session_id !== input.sessionId ||
        previous.subject_id !== input.subjectId ||
        old.processingCommandId !== commandId ||
        canonicalJson(old.processingReadOnlyTools!) !== canonicalJson(tools as unknown as Json)
      )
        throw new AgentError('command_conflict');
      return db.command(previous);
    }
    if (
      !['pending', 'unresolved'].includes(String(parse(original.receipt_json).state)) ||
      original.cancelled ||
      original.input_context_selection_id !== session.context_selection_id
    )
      throw new AgentError('input_processing_unavailable');
    if (db.row('SELECT id FROM run WHERE session_id=? AND is_active=1', input.sessionId))
      throw new AgentError('session_busy');
    db.insertCommand({ ...input, commandId }, request, hash(request), 'accepted', receipt);
    db.run(
      'UPDATE command SET target_command_id=?,input_context_selection_id=? WHERE id=?',
      input.inputCommandId,
      session.context_selection_id!,
      commandId,
    );
    const old = parse(original.receipt_json);
    db.run(
      'UPDATE command SET receipt_json=? WHERE id=?',
      canonicalJson({
        ...old,
        processingCommandId: commandId,
        processingReadOnlyTools: tools as unknown as Json,
      }),
      original.id!,
    );
    db.event(input.sessionId, commandId, 'human.input_processing_queued');
    return db.command(db.row('SELECT * FROM command WHERE id=?', commandId)!);
  });
}
/** Remains discoverable after startRun replaces the Command's queued receipt. */
export function humanInputProcessing(
  db: SqliteOperations,
  runId: string,
): {
  inputCommandId: string;
  processingCommandId: string;
  readOnlyTools: readonly { id: string; version: string }[];
} | null {
  const row = db.row(
    "SELECT c.*,i.request_digest AS input_digest,i.receipt_json AS input_receipt FROM run r JOIN command c ON c.id=r.origin_command_id JOIN command i ON i.id=c.target_command_id AND i.kind='human.input' WHERE r.id=? AND c.kind='run.start'",
    runId,
  );
  if (!row) return null;
  const inputReceipt = parse(row.input_receipt);
  if (inputReceipt.processingCommandId !== row.id)
    throw new AgentError('input_proposal_unverifiable');
  // The immutable processing capability is stored on the raw input too; Run activation
  // is permitted to replace the ordinary run.start receipt with its own result.
  const tools = inputReceipt.processingReadOnlyTools;
  return {
    inputCommandId: String(row.target_command_id),
    processingCommandId: String(row.id),
    readOnlyTools: Array.isArray(tools)
      ? (tools as unknown as { id: string; version: string }[])
      : [],
  };
}
function decisionResult(db: SqliteOperations, original: Row, decision: Row): HumanInputDecision {
  const receipt = parse(decision.receipt_json);
  const business =
    typeof receipt.businessCommandId === 'string'
      ? db.row('SELECT * FROM command WHERE id=?', receipt.businessCommandId)
      : null;
  return {
    input: db.command(original),
    decision: db.command(decision),
    businessCommand: business ? db.command(business) : null,
    controlRevision: String(receipt.controlRevision),
    requiresReadOnlyProcessing: receipt.requiresReadOnlyProcessing === true,
    configuration: receipt.configuration ?? null,
  };
}
/** Trusted Host seals a bounded proposal; this entry is never a model/client tool. */
export function decideHumanInput(
  db: SqliteOperations,
  input: DecideHumanInput,
): HumanInputDecision {
  return db.tx(() => {
    const session = root(db, input);
    id(input.decisionId);
    const original = db.row(
      "SELECT * FROM command WHERE id=? AND kind='human.input'",
      input.inputCommandId,
    );
    if (
      !original ||
      original.session_id !== input.sessionId ||
      original.subject_id !== input.subjectId ||
      original.origin_store_id !== input.expectedStoreId ||
      original.request_digest !== input.inputDigest
    )
      throw new AgentError('input_proposal_unverifiable');
    const proposal = input.proposal;
    const request = {
      kind: 'human.input.decision',
      inputCommandId: input.inputCommandId,
      inputDigest: input.inputDigest,
      expectedControlRevision: input.expectedControlRevision,
      proposal,
      ...(input.interpretation ? { interpretation: input.interpretation } : {}),
      ...(input.clarifiesInputId ? { clarifiesInputId: input.clarifiesInputId } : {}),
    } as unknown as Json;
    const prior = db.row('SELECT * FROM command WHERE id=?', input.decisionId);
    if (prior) {
      if (
        prior.kind !== 'human.input.decision' ||
        prior.session_id !== input.sessionId ||
        prior.subject_id !== input.subjectId ||
        prior.request_digest !== hash(request)
      )
        throw new AgentError('command_conflict');
      return decisionResult(db, original, prior);
    }
    const oldReceipt = parse(original.receipt_json);
    if (
      oldReceipt.state === 'decided' ||
      oldReceipt.state === 'clarified' ||
      oldReceipt.decisionCommandId !== undefined
    )
      throw new AgentError('input_already_decided');
    if (String(session.control_revision) !== input.expectedControlRevision)
      throw new AgentError('human_control_changed');
    decimal(input.expectedControlRevision);
    if (original.input_context_selection_id !== session.context_selection_id || original.cancelled)
      throw new AgentError('input_target_stopped');
    let observation: Json | undefined;
    if (input.interpretation) {
      const interpreted = db.row(
        "SELECT * FROM execution WHERE id=? AND kind='model' AND state='succeeded'",
        input.interpretation.executionId,
      );
      const source = interpreted && parse(interpreted.decision_source_json);
      const marker = source?.humanInputInterpretation as Record<string, Json> | undefined;
      const message =
        interpreted &&
        db.row(
          "SELECT id FROM message WHERE session_id=? AND run_id=? AND status='complete' AND role='assistant' AND json_extract(source_json,'$.sourceIds[0]')=? ORDER BY seq LIMIT 1",
          input.sessionId,
          interpreted.run_id!,
          interpreted.id!,
        );
      if (
        !interpreted ||
        !message ||
        interpreted.origin_store_id !== input.expectedStoreId ||
        interpreted.session_id !== input.sessionId ||
        marker?.inputCommandId !== original.id ||
        marker?.inputDigest !== original.request_digest ||
        !Array.isArray(source?.toolBindings) ||
        source.toolBindings.length !== 0 ||
        Object.keys(input.interpretation).some(
          (key) => !['executionId', 'answer', 'clarification'].includes(key),
        ) ||
        [input.interpretation.answer, input.interpretation.clarification].some(
          (value) => value !== null && (typeof value !== 'string' || value.length > 32768),
        )
      )
        throw new AgentError('input_interpretation_unverifiable');
      observation = {
        ...input.interpretation,
        runId: String(interpreted.run_id),
        messageId: String(message.id),
      };
    }
    if (
      !proposal ||
      !['same_work', 'independent_work', 'unresolved'].includes(proposal.relation) ||
      !['work', 'progress', 'clarify', 'continue', 'pause', 'replace', 'stop'].includes(
        proposal.purpose,
      ) ||
      !['keep', 'select_work'].includes(proposal.selectionEffect) ||
      !proposal.basis ||
      !['explicit_target', 'explicit_text', 'model_proposal'].includes(proposal.basis.kind) ||
      proposal.basis.instruction !== parse(original.request_json).content
    )
      throw new AgentError('input_proposal_unverifiable');
    if (
      (['progress', 'clarify', 'pause', 'stop'].includes(proposal.purpose) ||
        proposal.relation === 'unresolved') &&
      proposal.selectionEffect !== 'keep'
    )
      throw new AgentError('invalid_work_selection');
    if (
      ['continue', 'replace'].includes(proposal.purpose) &&
      proposal.selectionEffect !== 'select_work'
    )
      throw new AgentError('invalid_work_selection');
    if (proposal.relation === 'unresolved' && proposal.targetRootWorkCommandId !== null)
      throw new AgentError('input_proposal_unverifiable');
    if (proposal.relation === 'independent_work' && !['work', 'replace'].includes(proposal.purpose))
      throw new AgentError('input_proposal_unverifiable');
    if (proposal.relation === 'independent_work' && proposal.selectionEffect !== 'select_work')
      throw new AgentError('invalid_work_selection');
    const target =
      proposal.targetRootWorkCommandId === null
        ? null
        : work(db, input, proposal.targetRootWorkCommandId);
    if ((proposal.relation === 'same_work' || proposal.purpose === 'replace') && !target)
      throw new AgentError('work_scope_unverifiable');
    const originalBody = parse(original.request_json);
    const publicCommand =
      typeof originalBody.publicCommandId === 'string'
        ? db.row('SELECT * FROM command WHERE id=?', originalBody.publicCommandId)
        : null;
    if (
      publicCommand &&
      (publicCommand.cancelled ||
        publicCommand.subject_id !== original.subject_id ||
        publicCommand.session_id !== original.session_id ||
        publicCommand.target_command_id !== original.id)
    )
      throw new AgentError('input_cancelled');
    const actualWork =
      proposal.relation === 'independent_work' ? (publicCommand ?? original) : target;
    if (proposal.selectionEffect === 'select_work' && !actualWork)
      throw new AgentError('invalid_work_selection');
    if (proposal.purpose === 'continue' && target) {
      const eligibility = readWorkEligibility(db, {
        sessionId: input.sessionId,
        rootWorkCommandId: String(target.id),
        rootWorkSeq: String(target.root_work_seq),
        ignoreInputCommandId: String(original.id),
      });
      let rejectionReason: string | null =
        eligibility.state === 'revoked' && eligibility.reason !== 'work_paused'
          ? 'work_resume_unavailable'
          : null;
      if (rejectionReason === null) {
        try {
          // This synchronous Store-only check reads the final durable safety gate.
          // Invalid guards, unavailable reads and arbitrary host errors still throw.
          assertHumanWorkContinuable(db, {
            sessionId: input.sessionId,
            rootWorkCommandId: String(target.id),
            rootWorkSeq: String(target.root_work_seq),
          });
        } catch (error) {
          if (
            !(error instanceof AgentError) ||
            !['work_resume_outcome_unknown', 'execution_group_fenced'].includes(error.code)
          )
            throw error;
          rejectionReason = error.code;
        }
      }
      if (rejectionReason !== null) {
        // A determined refusal is a sealed input outcome, not pending work. Keep
        // the requested proposal intact, while recording that it selected nothing.
        const proof: Json = {
          outcome: 'human_input_rejected',
          reason: rejectionReason,
          ...(rejectionReason === 'work_resume_unavailable'
            ? { revocationReason: eligibility.reason }
            : {}),
          humanInputCommandId: String(original.id),
          decisionCommandId: input.decisionId,
          businessCommandId: null,
          controlRevision: String(session.control_revision),
          runId: null,
          ...(observation ? { observation } : {}),
        };
        db.insertCommand(
          { ...input, commandId: input.decisionId },
          request,
          hash(request),
          'rejected',
          {
            ...proof,
            purpose: proposal.purpose,
            targetRootWorkCommandId: String(target.id),
            selectionEffect: 'keep',
            requiresReadOnlyProcessing: false,
            configuration: null,
            rejection: proof,
          },
        );
        db.run(
          'UPDATE command SET root_work_command_id=?,root_work_seq=? WHERE id=?',
          target.root_work_command_id!,
          target.root_work_seq!,
          input.decisionId,
        );
        db.run(
          'UPDATE command SET receipt_json=? WHERE id=?',
          canonicalJson({
            ...oldReceipt,
            state: 'decided',
            applicationState: 'rejected',
            decisionCommandId: input.decisionId,
            businessCommandId: null,
            controlRevision: String(session.control_revision),
            rejection: proof,
            ...(observation ? { observation } : {}),
          }),
          original.id!,
        );
        if (publicCommand) {
          db.run(
            "UPDATE command SET status='rejected',receipt_json=? WHERE id=?",
            canonicalJson(proof),
            publicCommand.id!,
          );
          db.event(input.sessionId, String(publicCommand.id), 'human.command_rejected');
        }
        db.event(input.sessionId, input.decisionId, 'human.input_decided');
        return decisionResult(
          db,
          db.row('SELECT * FROM command WHERE id=?', original.id!)!,
          db.row('SELECT * FROM command WHERE id=?', input.decisionId)!,
        );
      }
    }
    const controlRevision = bump(db, input.sessionId);
    const needsBusiness =
      proposal.relation !== 'unresolved' &&
      ['work', 'continue', 'replace'].includes(proposal.purpose);
    const businessId = needsBusiness
      ? `human-business-${hash([input.expectedStoreId, input.inputCommandId, input.decisionId])}`
      : null;
    const active = db.row('SELECT * FROM run WHERE session_id=? AND is_active=1', input.sessionId);
    const sameActive =
      needsBusiness &&
      active &&
      actualWork &&
      active.root_work_command_id === actualWork.root_work_command_id &&
      String(active.root_work_seq) === String(actualWork.root_work_seq) &&
      proposal.purpose !== 'continue';
    const originalRun =
      proposal.relation === 'same_work' && target
        ? db.row(
            'SELECT * FROM run WHERE session_id=? AND root_work_command_id=? AND root_work_seq=? ORDER BY rowid DESC LIMIT 1',
            input.sessionId,
            target.root_work_command_id!,
            target.root_work_seq!,
          )
        : null;
    if (needsBusiness && proposal.relation === 'same_work' && !originalRun)
      throw new AgentError('work_configuration_unverifiable');
    db.insertCommand({ ...input, commandId: input.decisionId }, request, hash(request), 'applied', {
      controlRevision,
      selectionEffect: proposal.selectionEffect,
      purpose: proposal.purpose,
      targetRootWorkCommandId: target ? String(target.id) : null,
      businessCommandId: businessId,
      requiresReadOnlyProcessing: proposal.relation === 'unresolved',
      configuration: originalRun ? (JSON.parse(String(originalRun.config_json)) as Json) : null,
      continuationRunId: originalRun ? String(originalRun.id) : null,
      ...(observation ? { observation } : {}),
    });
    if (actualWork)
      db.run(
        'UPDATE command SET root_work_command_id=?,root_work_seq=? WHERE id=?',
        actualWork.root_work_command_id!,
        actualWork.root_work_seq!,
        input.decisionId,
      );
    if (businessId && actualWork) {
      const predecessor =
        active ??
        db.row('SELECT * FROM run WHERE session_id=? ORDER BY rowid DESC LIMIT 1', input.sessionId);
      const businessRequest: Json = sameActive
        ? {
            kind: 'input.steer',
            content: String(parse(original.request_json).content),
            targetRunId: String(active.id),
            contextSelectionId: String(session.context_selection_id),
          }
        : {
            kind: 'input.follow_up',
            content: String(parse(original.request_json).content),
            afterRunId: predecessor ? String(predecessor.id) : null,
            contextSelectionId: String(session.context_selection_id),
          };
      // Attachments belong to this exact human input, independently of whether
      // its business work inherits A's configuration or selects a new work.
      const originalRequest = parse(original.request_json).originalRequest;
      if (originalRequest && typeof originalRequest === 'object' && !Array.isArray(originalRequest))
        for (const key of ['images', 'files'])
          if (Object.hasOwn(originalRequest, key)) businessRequest[key] = originalRequest[key]!;
      if (!sameActive && proposal.relation === 'independent_work') {
        const originalRequest = parse(original.request_json).originalRequest;
        if (
          originalRequest &&
          typeof originalRequest === 'object' &&
          !Array.isArray(originalRequest)
        ) {
          for (const key of ['modelId', 'reasoningEffort', 'selectedSkills', 'extensionInputs']) {
            if (Object.hasOwn(originalRequest, key)) businessRequest[key] = originalRequest[key]!;
          }
        }
      }
      db.insertCommand(
        { ...input, commandId: businessId },
        businessRequest,
        hash(businessRequest),
        'accepted',
        {
          outcome: 'human_business_queued',
          inputCommandId: input.inputCommandId,
          decisionCommandId: input.decisionId,
          controlRevision,
          runId: null,
        },
      );
      db.run(
        'UPDATE command SET target_command_id=?,root_work_command_id=?,root_work_seq=?,input_target_run_id=?,input_context_selection_id=?,after_run_id=? WHERE id=?',
        input.decisionId,
        actualWork.root_work_command_id!,
        actualWork.root_work_seq!,
        sameActive ? active.id! : null,
        session.context_selection_id!,
        !sameActive && predecessor ? predecessor.id! : null,
        businessId,
      );
    }
    db.run(
      'UPDATE command SET receipt_json=? WHERE id=?',
      canonicalJson({
        ...oldReceipt,
        state: proposal.relation === 'unresolved' ? 'unresolved' : 'decided',
        decisionCommandId: input.decisionId,
        businessCommandId: businessId,
        applicationState: businessId
          ? 'queued'
          : proposal.relation === 'unresolved'
            ? 'unresolved'
            : 'observed',
        controlRevision,
        ...(observation ? { observation } : {}),
      }),
      input.inputCommandId,
    );
    const raw = parse(original.request_json);
    if (publicCommand) {
      db.run(
        'UPDATE command SET status=?,receipt_json=? WHERE id=?',
        businessId || proposal.relation === 'unresolved' ? 'accepted' : 'applied',
        canonicalJson({
          outcome: businessId
            ? 'human_input_queued'
            : proposal.relation === 'unresolved'
              ? 'human_input_unresolved'
              : 'human_input_observed',
          humanInputCommandId: String(original.id),
          decisionCommandId: input.decisionId,
          businessCommandId: businessId,
          controlRevision,
          runId: null,
          ...(observation ? { observation } : {}),
        }),
        publicCommand.id!,
      );
      db.event(input.sessionId, String(publicCommand.id), 'human.command_associated');
    }
    const clarificationId = input.clarifiesInputId ?? raw.clarifiesInputId;
    if (typeof clarificationId === 'string' && proposal.relation !== 'unresolved') {
      if (typeof raw.clarifiesInputId === 'string' && raw.clarifiesInputId !== clarificationId)
        throw new AgentError('input_clarification_unverifiable');
      const clarified = db.row(
        "SELECT * FROM command WHERE id=? AND kind='human.input'",
        clarificationId,
      );
      if (
        !clarified ||
        clarified.id === original.id ||
        clarified.session_id !== original.session_id ||
        clarified.subject_id !== original.subject_id ||
        clarified.origin_store_id !== original.origin_store_id ||
        clarified.cancelled
      )
        throw new AgentError('input_clarification_unverifiable');
      const receipt = parse(clarified.receipt_json);
      const candidates = receipt.candidateWorkCommandIds;
      const sameWork =
        proposal.relation === 'same_work' &&
        Array.isArray(candidates) &&
        candidates.includes(proposal.targetRootWorkCommandId!);
      // A first unresolved input has no business work to name yet. Its real
      // clarification may admit the first independent work, but never guess an
      // existing work or turn this link into a destructive-control grant.
      const firstWork =
        proposal.relation === 'independent_work' &&
        proposal.purpose === 'work' &&
        proposal.targetRootWorkCommandId === null &&
        receipt.originalSelection === null &&
        Array.isArray(candidates) &&
        candidates.length === 0;
      if (!sameWork && !firstWork) throw new AgentError('input_clarification_unverifiable');
      if (!['pending', 'unresolved'].includes(String(receipt.state)))
        throw new AgentError('input_already_decided');
      db.run(
        'UPDATE command SET receipt_json=? WHERE id=?',
        canonicalJson({
          ...receipt,
          state: 'clarified',
          clarifyingInputId: input.inputCommandId,
          decisionCommandId: input.decisionId,
        }),
        clarificationId,
      );
      const publicId = parse(clarified.request_json).publicCommandId;
      if (typeof publicId === 'string') {
        const previous = db.row('SELECT * FROM command WHERE id=?', publicId);
        if (
          !previous ||
          previous.target_command_id !== clarified.id ||
          previous.subject_id !== input.subjectId ||
          previous.cancelled
        )
          throw new AgentError('input_clarification_unverifiable');
        db.run(
          "UPDATE command SET status='applied',receipt_json=? WHERE id=?",
          canonicalJson({
            ...parse(previous.receipt_json),
            outcome: 'human_input_observed',
            reason: 'clarified_by_input',
            clarifyingInputId: input.inputCommandId,
            decisionCommandId: input.decisionId,
            runId: null,
          }),
          publicId,
        );
        db.event(input.sessionId, publicId, 'human.command_clarified');
      }
    }
    db.event(input.sessionId, input.decisionId, 'human.input_decided');
    if (proposal.purpose === 'continue')
      continueHumanWork(db, {
        decisionCommandId: input.decisionId,
        subjectId: input.subjectId,
        controlRevision,
      });
    if (proposal.purpose === 'stop' && target) {
      const controls: string[] = [];
      const runs = db.rows(
        'SELECT id FROM run WHERE session_id=? AND root_work_command_id=? AND root_work_seq=? AND is_active=1',
        input.sessionId,
        target.root_work_command_id!,
        target.root_work_seq!,
      );
      for (const run of runs) {
        const commandId = `human-stop-${hash([input.decisionId, 'run', String(run.id)])}`;
        cancelWorkBody(db, {
          expectedStoreId: input.expectedStoreId,
          sessionId: input.sessionId,
          subjectId: input.subjectId,
          commandId,
          kind: 'run.cancel',
          runId: String(run.id),
        });
        controls.push(commandId);
      }
      // Exact work cancellation includes its independently activated children.
      // A later reuse of the same child Session under another work is excluded.
      const executions = db.rows(
        `SELECT e.id,e.session_id FROM execution e JOIN session s ON s.id=e.session_id WHERE s.root_id=?
        AND e.root_work_command_id=? AND e.root_work_seq=? AND e.cancel_requested=0 AND e.state IN('planned','dispatching','running','outcome_unknown') ORDER BY e.rowid`,
        input.sessionId,
        target.root_work_command_id!,
        target.root_work_seq!,
      );
      for (const execution of executions) {
        const commandId = `human-stop-${hash([input.decisionId, 'execution', String(execution.id)])}`;
        cancelWorkBody(db, {
          expectedStoreId: input.expectedStoreId,
          sessionId: String(execution.session_id),
          subjectId: input.subjectId,
          commandId,
          kind: 'execution.cancel',
          executionId: String(execution.id),
        });
        controls.push(commandId);
      }
      const saved = db.row('SELECT receipt_json FROM command WHERE id=?', input.decisionId)!;
      db.run(
        'UPDATE command SET receipt_json=? WHERE id=?',
        canonicalJson({ ...parse(saved.receipt_json), controlCommandIds: controls }),
        input.decisionId,
      );
    }
    return decisionResult(
      db,
      db.row('SELECT * FROM command WHERE id=?', input.inputCommandId)!,
      db.row('SELECT * FROM command WHERE id=?', input.decisionId)!,
    );
  });
}

/** Pure SQL read: caller owns its short read/write transaction. No policy or Provider call. */
export function readWorkEligibility(
  db: SqliteOperations,
  input: {
    sessionId: string;
    rootWorkCommandId: string;
    rootWorkSeq: string;
    contextSelectionId?: string;
    ignoreInputCommandId?: string;
  },
): HumanWorkEligibility {
  const local = db.row('SELECT * FROM session WHERE id=?', input.sessionId);
  if (!local) throw new AgentError('session_not_found');
  const session = db.row('SELECT * FROM session WHERE id=?', local.root_id!)!;
  const result = state(db, String(session.id));
  const answer = (
    status: HumanWorkEligibility['state'],
    reason: string | null,
    decisionCommandId: string | null = null,
  ): HumanWorkEligibility => ({ ...result, state: status, reason, decisionCommandId });
  if (session.delete_requested || local.delete_requested)
    return answer('revoked', 'session_deleted');
  if (
    BigInt(input.rootWorkSeq) <= BigInt(session.stop_boundary!) ||
    BigInt(input.rootWorkSeq) <= BigInt(local.stop_boundary!)
  )
    return answer('revoked', 'cancelled');
  if (
    input.contextSelectionId !== undefined &&
    input.contextSelectionId !== local.context_selection_id
  )
    return answer('revoked', 'context_rewound');
  const origin = db.row('SELECT * FROM command WHERE id=?', input.rootWorkCommandId);
  const originSession = origin
    ? db.row('SELECT root_id FROM session WHERE id=?', origin.session_id!)
    : null;
  if (
    !origin ||
    originSession?.root_id !== session.id ||
    origin.root_work_command_id !== input.rootWorkCommandId ||
    String(origin.root_work_seq) !== input.rootWorkSeq ||
    origin.origin_store_id !== db.metadata().storeId
  )
    return answer('revoked', 'work_unverifiable');
  if (
    local.parent_id === null &&
    (origin.cancelled ||
      db.row(
        'SELECT id FROM run WHERE session_id=? AND root_work_command_id=? AND root_work_seq=? AND cancel_requested=1 LIMIT 1',
        session.id!,
        input.rootWorkCommandId,
        input.rootWorkSeq,
      ))
  )
    return answer(
      'revoked',
      db.row(
        `SELECT id FROM command WHERE session_id=? AND kind='human.input.decision' AND status='applied'
      AND json_extract(receipt_json,'$.targetRootWorkCommandId')=? AND json_extract(receipt_json,'$.purpose')='stop' ORDER BY seq DESC LIMIT 1`,
        session.id!,
        input.rootWorkCommandId,
      )
        ? 'work_stopped'
        : 'cancelled',
    );
  // Unknown effects and attached/local cancellation are checked by the existing
  // execution-domain gates. Work selection must not turn one unknown descendant
  // into a new root-wide fence or cancel an already detached execution domain.
  const control = db.row(
    `SELECT id,receipt_json FROM command WHERE session_id=? AND kind='human.input.decision' AND status='applied'
     AND json_extract(receipt_json,'$.targetRootWorkCommandId')=?
     AND json_extract(receipt_json,'$.purpose') IN ('pause','continue','stop','replace') ORDER BY seq DESC LIMIT 1`,
    session.id!,
    input.rootWorkCommandId,
  );
  if (control) {
    const purpose = parse(control.receipt_json).purpose;
    if (purpose !== 'continue')
      return answer(
        'revoked',
        purpose === 'pause'
          ? 'work_paused'
          : purpose === 'replace'
            ? 'work_replaced'
            : 'work_stopped',
        String(control.id),
      );
  }
  for (const item of pending(db, String(session.id))) {
    if (item.id === input.ignoreInputCommandId) continue;
    const candidates = parse(item.receipt_json).candidateWorkCommandIds;
    if (Array.isArray(candidates) && candidates.includes(input.rootWorkCommandId))
      return answer('deferred', 'input_unresolved');
  }
  if (
    ['run.start', 'input.follow_up', 'input.steer', 'human.input'].includes(String(origin.kind)) &&
    result.selectedWork &&
    (result.selectedWork.rootWorkCommandId !== input.rootWorkCommandId ||
      result.selectedWork.rootWorkSeq !== input.rootWorkSeq)
  )
    return answer('deferred', 'work_not_selected');
  return answer('eligible', null, control ? String(control.id) : null);
}
export function assertHumanWorkDispatch(db: SqliteOperations, execution: Row): void {
  if (humanInputInterpretation(db, execution)) return;
  const processing = execution.run_id ? humanInputProcessing(db, String(execution.run_id)) : null;
  if (processing) {
    const original = db.row('SELECT * FROM command WHERE id=?', processing.inputCommandId)!;
    const publicId = parse(original.request_json).publicCommandId;
    const publicCommand =
      typeof publicId === 'string' ? db.row('SELECT * FROM command WHERE id=?', publicId) : null;
    if (
      original.cancelled ||
      publicCommand?.cancelled ||
      !['pending', 'unresolved'].includes(String(parse(original.receipt_json).state))
    )
      throw new AgentError('input_processing_unavailable');
    if (execution.root_work_command_id !== processing.processingCommandId)
      throw new AgentError('input_proposal_unverifiable');
    if (execution.kind === 'model') return;
    if (
      execution.kind === 'tool' &&
      processing.readOnlyTools.some(
        (tool) => tool.id === execution.adapter_id && tool.version === execution.definition_version,
      )
    )
      return;
    throw new AgentError('input_processing_read_only');
  }
  const result = readWorkEligibility(db, {
    sessionId: String(execution.session_id),
    rootWorkCommandId: String(execution.root_work_command_id),
    rootWorkSeq: String(execution.root_work_seq),
  });
  if (
    result.state !== 'eligible' &&
    execution.kind === 'model' &&
    typeof execution.decision_source_json === 'string' &&
    ['input_unresolved', 'work_not_selected', 'work_paused'].includes(result.reason ?? '') &&
    db.row('SELECT parent_id FROM session WHERE id=?', execution.session_id!)?.parent_id !== null
  ) {
    const source = parse(execution.decision_source_json);
    if (Array.isArray(source.toolBindings) && source.toolBindings.length === 0) return;
  }
  if (result.state !== 'eligible') throw new AgentError(result.reason ?? 'human_work_blocked');
}
/** Derived business intent can only apply through its immutable real input/decision. */
/** Only Core's sealed no-tool Model request can interpret a pending human input. */
export function humanInputInterpretation(db: SqliteOperations, execution: Row): string | null {
  if (
    execution.kind !== 'model' ||
    !execution.run_id ||
    typeof execution.decision_source_json !== 'string'
  )
    return null;
  const source = parse(execution.decision_source_json);
  const binding = source.humanInputInterpretation;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
  const original = db.row(
    "SELECT * FROM command WHERE id=? AND kind='human.input'",
    String(binding.inputCommandId),
  );
  const run = db.row(
    'SELECT * FROM run WHERE id=? AND session_id=?',
    execution.run_id,
    execution.session_id!,
  );
  if (
    !original ||
    !run ||
    original.session_id !== execution.session_id ||
    original.request_digest !== binding.inputDigest ||
    original.origin_store_id !== execution.origin_store_id ||
    original.cancelled ||
    !Array.isArray(source.toolBindings) ||
    source.toolBindings.length !== 0 ||
    original.input_context_selection_id !== run.context_selection_id ||
    !run.is_active
  )
    throw new AgentError('input_proposal_unverifiable');
  const publicId = parse(original.request_json).publicCommandId;
  const publicCommand =
    typeof publicId === 'string' ? db.row('SELECT * FROM command WHERE id=?', publicId) : null;
  if (publicCommand?.cancelled) throw new AgentError('input_cancelled');
  const candidates = parse(original.receipt_json).candidateWorkCommandIds;
  if (
    (!Array.isArray(candidates) || !candidates.includes(String(run.root_work_command_id))) &&
    parse(original.request_json).observedRunId !== run.id &&
    humanInputProcessing(db, String(run.id))?.inputCommandId !== original.id
  )
    throw new AgentError('input_proposal_unverifiable');
  const receipt = parse(original.receipt_json);
  if (!['pending', 'unresolved'].includes(String(receipt.state))) {
    const decision =
      typeof receipt.decisionCommandId === 'string'
        ? db.row(
            "SELECT * FROM command WHERE id=? AND kind='human.input.decision'",
            receipt.decisionCommandId,
          )
        : null;
    const body = decision ? parse(decision.request_json) : {};
    const fact = decision ? parse(decision.receipt_json) : {};
    const proposal =
      body.proposal && typeof body.proposal === 'object' && !Array.isArray(body.proposal)
        ? body.proposal
        : null;
    const publicReceipt = publicCommand ? parse(publicCommand.receipt_json) : {};
    const origin = db.row('SELECT * FROM command WHERE id=?', execution.origin_command_id!);
    const business =
      typeof fact?.businessCommandId === 'string'
        ? db.row('SELECT * FROM command WHERE id=?', fact.businessCommandId)
        : null;
    const sameScope = (row: Row | null) =>
      row &&
      row.session_id === original.session_id &&
      row.origin_store_id === original.origin_store_id &&
      row.subject_id === original.subject_id &&
      !row.cancelled;
    const rejection =
      fact.rejection && typeof fact.rejection === 'object' && !Array.isArray(fact.rejection)
        ? fact.rejection
        : null;
    const rejected =
      decision?.status === 'rejected' &&
      fact.outcome === 'human_input_rejected' &&
      ['work_resume_unavailable', 'work_resume_outcome_unknown', 'execution_group_fenced'].includes(
        String(fact.reason),
      ) &&
      proposal?.relation === 'same_work' &&
      proposal.purpose === 'continue' &&
      fact.selectionEffect === 'keep' &&
      fact.businessCommandId === null &&
      receipt.applicationState === 'rejected' &&
      rejection?.outcome === 'human_input_rejected' &&
      rejection.reason === fact.reason &&
      rejection.humanInputCommandId === original.id &&
      rejection.decisionCommandId === decision.id &&
      rejection.businessCommandId === null &&
      rejection.controlRevision === fact.controlRevision &&
      rejection.runId === null &&
      canonicalJson(receipt.rejection ?? null) === canonicalJson(rejection) &&
      (publicId === undefined ||
        (publicCommand?.status === 'rejected' &&
          canonicalJson(publicReceipt) === canonicalJson(rejection)));
    if (
      receipt.state !== 'decided' ||
      !sameScope(origin) ||
      !sameScope(decision) ||
      (decision!.status !== 'applied' && !rejected) ||
      !proposal ||
      decision!.request_digest !== hash(body) ||
      body.inputCommandId !== original.id ||
      body.inputDigest !== original.request_digest ||
      fact.controlRevision !== receipt.controlRevision ||
      fact.purpose !== proposal.purpose ||
      (!rejected && fact.selectionEffect !== proposal.selectionEffect) ||
      fact.targetRootWorkCommandId !== proposal.targetRootWorkCommandId ||
      (publicId !== undefined &&
        (!sameScope(publicCommand) ||
          publicCommand!.target_command_id !== original.id ||
          publicReceipt.humanInputCommandId !== original.id ||
          publicReceipt.decisionCommandId !== decision!.id ||
          publicReceipt.businessCommandId !== fact.businessCommandId)) ||
      fact.businessCommandId !== receipt.businessCommandId ||
      (fact.businessCommandId !== null &&
        (!sameScope(business) ||
          business!.target_command_id !== decision!.id ||
          business!.root_work_command_id !== decision!.root_work_command_id ||
          String(business!.root_work_seq) !== String(decision!.root_work_seq)))
    )
      throw new AgentError('input_proposal_unverifiable');
    // A genuine decision can win after this exact no-tool request was prepared.
    // A dedicated interpretation has no business request to rebuild after that decision.
    if (humanInputProcessing(db, String(run.id))?.inputCommandId === original.id)
      throw new AgentError('input_processing_decided');
    throw new AgentError('context_refresh_required');
  }
  return String(original.id);
}

export function assertHumanBusinessInput(db: SqliteOperations, command: Row): void {
  if (command.target_command_id === null || command.target_command_id === undefined) return;
  const decision = db.row(
    "SELECT * FROM command WHERE id=? AND kind='human.input.decision'",
    command.target_command_id,
  );
  if (!decision) return; // Other existing target_command_id contracts retain their own checks.
  const body = parse(decision.request_json),
    receipt = parse(decision.receipt_json);
  const original = db.row(
    "SELECT * FROM command WHERE id=? AND kind='human.input'",
    String(body.inputCommandId),
  );
  if (
    !original ||
    original.request_digest !== body.inputDigest ||
    original.subject_id !== command.subject_id ||
    decision.subject_id !== command.subject_id ||
    original.session_id !== command.session_id ||
    decision.session_id !== command.session_id ||
    receipt.businessCommandId !== command.id ||
    command.root_work_command_id !== decision.root_work_command_id ||
    String(command.root_work_seq) !== String(decision.root_work_seq)
  )
    throw new AgentError('input_proposal_unverifiable');
  const publicId = parse(original.request_json).publicCommandId;
  const publicCommand =
    typeof publicId === 'string' ? db.row('SELECT * FROM command WHERE id=?', publicId) : null;
  if (original.cancelled || publicCommand?.cancelled) throw new AgentError('input_cancelled');
  const result = readWorkEligibility(db, {
    sessionId: String(command.session_id),
    rootWorkCommandId: String(command.root_work_command_id),
    rootWorkSeq: String(command.root_work_seq),
    contextSelectionId: String(command.input_context_selection_id),
  });
  if (result.state !== 'eligible') throw new AgentError(result.reason ?? 'human_work_blocked');
}

/** Part of applyInput's existing transaction, never a second post-commit acknowledgement. */
export function recordHumanBusinessApplication(
  db: SqliteOperations,
  command: Row,
  runId: string,
  messageId: string,
): void {
  if (!command.target_command_id) return;
  const decision = db.row(
    "SELECT * FROM command WHERE id=? AND kind='human.input.decision'",
    command.target_command_id,
  );
  if (!decision) return;
  const body = parse(decision.request_json);
  const original = db.row(
    "SELECT * FROM command WHERE id=? AND kind='human.input'",
    String(body.inputCommandId),
  )!;
  const inputReceipt = parse(original.receipt_json);
  const receipt: Json = {
    ...inputReceipt,
    businessCommandId: String(command.id),
    applicationState: 'applied',
    runId,
    messageId,
  };
  db.run('UPDATE command SET receipt_json=? WHERE id=?', canonicalJson(receipt), original.id!);
  db.run(
    'UPDATE command SET receipt_json=? WHERE id=?',
    canonicalJson({
      ...parse(db.row('SELECT receipt_json FROM command WHERE id=?', command.id!)!.receipt_json),
      humanInputCommandId: String(original.id),
      decisionCommandId: String(decision.id),
      continuationRunId: parse(decision.receipt_json).continuationRunId ?? null,
    }),
    command.id!,
  );
  const publicId = parse(original.request_json).publicCommandId;
  if (typeof publicId === 'string') {
    db.run(
      "UPDATE command SET status='applied',receipt_json=? WHERE id=?",
      canonicalJson({
        outcome: 'human_input_applied',
        humanInputCommandId: String(original.id),
        decisionCommandId: String(decision.id),
        businessCommandId: String(command.id),
        sourceCommandId: String(command.id),
        runId,
        messageId,
      }),
      publicId,
    );
    db.event(String(command.session_id), publicId, 'human.command_applied');
  }
}

/** Preparation can fail before there is a Run; the public invocation must still settle. */
export function recordHumanCommandRejection(
  db: SqliteOperations,
  command: Row,
  reason: string,
  needsReview: boolean,
): void {
  if (command.status !== 'accepted' || !command.target_command_id) return;
  const target = db.row('SELECT * FROM command WHERE id=?', command.target_command_id);
  const decision = target?.kind === 'human.input.decision' ? target : null;
  const raw = decision
    ? db.row(
        "SELECT * FROM command WHERE id=? AND kind='human.input'",
        String(parse(decision.request_json).inputCommandId),
      )
    : target?.kind === 'human.input'
      ? target
      : null;
  if (
    !raw ||
    raw.session_id !== command.session_id ||
    raw.subject_id !== command.subject_id ||
    raw.origin_store_id !== command.origin_store_id
  )
    return;
  const receipt = parse(raw.receipt_json);
  if (
    decision ? receipt.businessCommandId !== command.id : receipt.processingCommandId !== command.id
  )
    throw new AgentError('input_proposal_unverifiable');
  const publicId = parse(raw.request_json).publicCommandId;
  if (typeof publicId !== 'string') return;
  const original = db.row('SELECT * FROM command WHERE id=?', publicId);
  if (
    !original ||
    original.target_command_id !== raw.id ||
    original.subject_id !== command.subject_id ||
    original.session_id !== command.session_id
  )
    throw new AgentError('input_proposal_unverifiable');
  const proof = {
    humanInputCommandId: String(raw.id),
    ...(decision
      ? { decisionCommandId: String(decision.id), businessCommandId: String(command.id) }
      : { processingCommandId: String(command.id) }),
    outcome: needsReview ? 'human_input_needs_review' : 'human_input_rejected',
    reason,
    runId: null,
  };
  db.run(
    'UPDATE command SET receipt_json=? WHERE id=?',
    canonicalJson({
      ...receipt,
      applicationState: needsReview ? 'needs_review' : 'rejected',
      rejection: proof,
    }),
    raw.id!,
  );
  db.run(
    "UPDATE command SET status=?,receipt_json=? WHERE id=? AND status='accepted'",
    needsReview ? 'needs_review' : 'rejected',
    canonicalJson(proof),
    publicId,
  );
  db.event(
    String(command.session_id),
    publicId,
    needsReview ? 'human.command_needs_review' : 'human.command_rejected',
  );
}

/** Called by the original cancellation transaction; returned Runs use the existing exact cancel path. */
export function cancelHumanCommandBindings(
  db: SqliteOperations,
  publicCommandId: string,
  now: number,
): { commandIds: string[]; runIds: string[] } {
  const publicCommand = db.row('SELECT * FROM command WHERE id=?', publicCommandId);
  const original = publicCommand?.target_command_id
    ? db.row(
        "SELECT * FROM command WHERE id=? AND kind='human.input'",
        publicCommand.target_command_id,
      )
    : null;
  if (!original || parse(original.request_json).publicCommandId !== publicCommandId)
    return { commandIds: [], runIds: [] };
  const receipt = parse(original.receipt_json);
  const ids = [receipt.businessCommandId, receipt.processingCommandId].filter(
    (value): value is string => typeof value === 'string',
  );
  const runIds: string[] = [];
  for (const commandId of ids) {
    const command = db.row(
      'SELECT * FROM command WHERE id=? AND session_id=?',
      commandId,
      original.session_id!,
    );
    if (!command) throw new AgentError('input_proposal_unverifiable');
    for (const run of db.rows(
      'SELECT id FROM run WHERE origin_command_id=? AND is_active=1',
      commandId,
    ))
      runIds.push(String(run.id));
    db.run(
      "UPDATE command SET cancelled=1,cancel_requested_at=COALESCE(cancel_requested_at,?),status=CASE WHEN status='accepted' THEN 'rejected' ELSE status END,receipt_json=CASE WHEN status='accepted' THEN ? ELSE receipt_json END WHERE id=?",
      now,
      canonicalJson({
        ...parse(command.receipt_json),
        outcome: 'cancelled_before_apply',
        reason: 'original_input_cancelled',
      }),
      commandId,
    );
    db.event(String(original.session_id), commandId, 'human.command_binding_cancelled');
  }
  db.run(
    'UPDATE command SET cancelled=1,cancel_requested_at=COALESCE(cancel_requested_at,?),receipt_json=? WHERE id=?',
    now,
    canonicalJson({ ...receipt, state: 'cancelled' }),
    original.id!,
  );
  return { commandIds: ids, runIds };
}
