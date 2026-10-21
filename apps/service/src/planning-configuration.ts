import { createHash } from 'node:crypto';
import { AgentError, type AgentRuntime } from '@kite-ai/agent';
import type { AuthorizationRequest, ConditionReadContext, Json } from '@kite-ai/agent/extensions';
import {
  type createPlanningValidation,
  type PlanningState,
  planningExtensionId,
} from '@kite-ai/agent/planning';
import { skillWorkflowExtensionId } from '@kite-ai/agent/skill-workflow';
import type { CommandRecord, ExecutionRecord, RunRecord } from '@kite-ai/agent/storage';

export type PlanningIntent = { readonly mode: 'plan' } | null;
const object = (value: Json | undefined): value is Record<string, Json> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: Json): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
export const planningSnapshotDigest = (value: Json) =>
  createHash('sha256').update(canonical(value)).digest('hex');

/** Dispatch envelopes without changing the original Command or its digest. */
export function readBusinessRunInputs(request: Json): {
  planning: PlanningIntent;
  workflowRequest: Json;
} {
  if (!object(request)) throw new AgentError('business_run_input_invalid');
  const inputs = request.extensionInputs;
  if (inputs === undefined) return { planning: null, workflowRequest: structuredClone(request) };
  if (!Array.isArray(inputs)) throw new AgentError('business_run_input_invalid');
  const ids = new Set<string>();
  let planning: PlanningIntent = null;
  const workflow: Json[] = [];
  for (const input of inputs) {
    if (
      !object(input) ||
      Object.keys(input).sort().join(',') !== 'definitionVersion,extensionId,input' ||
      typeof input.extensionId !== 'string' ||
      input.definitionVersion !== '1' ||
      ids.has(input.extensionId)
    )
      throw new AgentError('business_run_input_unavailable');
    ids.add(input.extensionId);
    if (input.extensionId === planningExtensionId) {
      if (
        !['run.start', 'input.follow_up'].includes(String(request.kind)) ||
        !object(input.input) ||
        Object.keys(input.input).join(',') !== 'mode' ||
        input.input.mode !== 'plan'
      )
        throw new AgentError('planning_run_input_invalid');
      planning = Object.freeze({ mode: 'plan' });
    } else if (input.extensionId === skillWorkflowExtensionId)
      workflow.push(structuredClone(input));
    else throw new AgentError('business_run_input_unavailable');
  }
  return { planning, workflowRequest: { ...structuredClone(request), extensionInputs: workflow } };
}

export function readPlanningIntent(snapshot: Json): PlanningIntent {
  if (!object(snapshot)) throw new AgentError('recovery_configuration_unavailable');
  const intent = snapshot.intent;
  if (intent === null) return null;
  if (!object(intent) || Object.keys(intent).join(',') !== 'mode' || intent.mode !== 'plan')
    throw new AgentError('recovery_configuration_unavailable');
  return Object.freeze({ mode: 'plan' });
}

type Planning = Pick<ReturnType<typeof createPlanningValidation>, 'readPlanningState'>;
type PlanningRunIdentity = { runId: string; sessionId: string };

/** A fresh report admission proves its protected qualification and actual human continue cause. */
export async function readContinuedReportOrigin(
  runtime: AgentRuntime,
  command: Readonly<CommandRecord>,
  carrier: Readonly<ExecutionRecord>,
): Promise<string> {
  const unavailable = () => new AgentError('planning_run_scope_unavailable');
  if (command.kind !== 'job.report.continue' || !object(command.request)) throw unavailable();
  const request = command.request;
  const [original, qualification] = await Promise.all([
    typeof request.originalReportCommandId === 'string'
      ? runtime.getCommand(request.originalReportCommandId)
      : null,
    typeof request.continuationCommandId === 'string'
      ? runtime.getCommand(request.continuationCommandId)
      : null,
  ]);
  if (
    !original ||
    !qualification ||
    !object(qualification.request) ||
    !object(qualification.receipt)
  )
    throw unavailable();
  const proof = qualification.request;
  const [decision, start] = await Promise.all([
    typeof proof.continueDecisionCommandId === 'string'
      ? runtime.getCommand(proof.continueDecisionCommandId)
      : null,
    typeof proof.startCommandId === 'string' ? runtime.getCommand(proof.startCommandId) : null,
  ]);
  if (
    !decision ||
    !start ||
    !object(decision.request) ||
    !object(decision.receipt) ||
    !object(start.request)
  )
    throw unavailable();
  const [raw, root] = await Promise.all([
    typeof decision.request.inputCommandId === 'string'
      ? runtime.getCommand(decision.request.inputCommandId)
      : null,
    runtime.getSession(decision.sessionId),
  ]);
  const binding = carrier.afterTurn;
  const normalized = Object.fromEntries(
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
  ) as Json;
  if (
    !raw ||
    !root ||
    !object(raw.receipt) ||
    !object(binding) ||
    !object(decision.request.proposal) ||
    original.kind !== 'job.report' ||
    original.id !==
      `report-${planningSnapshotDigest([carrier.originStoreId, carrier.id, carrier.resultRevision])}` ||
    command.id !== `report-continue-${planningSnapshotDigest([qualification.id, original.id])}` ||
    qualification.kind !== 'job.report.qualification' ||
    qualification.status !== 'applied' ||
    qualification.cancelRequestedAt !== null ||
    qualification.id !==
      `report-qualification-${planningSnapshotDigest([decision.id, carrier.id])}` ||
    [original, qualification].some(
      (record) =>
        record.originStoreId !== command.originStoreId ||
        record.sessionId !== command.sessionId ||
        record.subjectId !== command.subjectId ||
        record.rootWorkCommandId !== command.rootWorkCommandId ||
        record.rootWorkSeq !== command.rootWorkSeq,
    ) ||
    planningSnapshotDigest(original.request) !== planningSnapshotDigest(normalized) ||
    request.continueDecisionCommandId !== decision.id ||
    proof.carrierExecutionId !== carrier.id ||
    proof.subscriptionDigest !== planningSnapshotDigest(binding) ||
    proof.startRequestDigest !== start.requestDigest ||
    proof.controlRevision !== decision.receipt.controlRevision ||
    qualification.receipt.outcome !== 'future_result_eligible' ||
    binding.kind !== 'agent_completion' ||
    start.id !== `child-start-${carrier.id}` ||
    start.cancelRequestedAt !== null ||
    !['child.start', 'input.follow_up'].includes(start.kind) ||
    start.sessionId !== carrier.childSessionId ||
    start.originStoreId !== command.originStoreId ||
    start.subjectId !== command.subjectId ||
    start.rootWorkCommandId !== command.rootWorkCommandId ||
    start.rootWorkSeq !== command.rootWorkSeq ||
    (start.kind === 'child.start' && start.request.parentExecutionId !== carrier.id) ||
    decision.kind !== 'human.input.decision' ||
    decision.status !== 'applied' ||
    decision.cancelRequestedAt !== null ||
    raw.kind !== 'human.input' ||
    raw.status !== 'applied' ||
    raw.cancelRequestedAt !== null ||
    decision.originStoreId !== command.originStoreId ||
    raw.originStoreId !== command.originStoreId ||
    decision.subjectId !== command.subjectId ||
    raw.subjectId !== command.subjectId ||
    raw.sessionId !== decision.sessionId ||
    root.parentSessionId !== null ||
    decision.rootWorkCommandId !== command.rootWorkCommandId ||
    decision.rootWorkSeq !== command.rootWorkSeq ||
    decision.receipt.purpose !== 'continue' ||
    decision.receipt.selectionEffect !== 'select_work' ||
    decision.receipt.targetRootWorkCommandId !== command.rootWorkCommandId ||
    decision.request.proposal.relation !== 'same_work' ||
    decision.request.inputDigest !== raw.requestDigest ||
    raw.receipt.decisionCommandId !== decision.id ||
    !['decided', 'clarified'].includes(String(raw.receipt.state))
  )
    throw unavailable();
  const local = await runtime.getSession(command.sessionId);
  if (local?.rootSessionId !== root.id) throw unavailable();
  if (start.kind === 'input.follow_up') {
    const reference = carrier.reference;
    const childRun =
      object(reference) && typeof reference.runId === 'string'
        ? await runtime.getRun(reference.runId)
        : null;
    if (
      !childRun ||
      childRun.carrierExecutionId !== carrier.id ||
      childRun.originCommandId !== start.id ||
      childRun.sessionId !== carrier.childSessionId ||
      childRun.rootWorkCommandId !== carrier.rootWorkCommandId ||
      childRun.rootWorkSeq !== carrier.rootWorkSeq
    )
      throw unavailable();
  }
  return original.id;
}

/** A report reuses its original binding only through the persisted, consumed cause. */
export async function readBoundJobReportParent(
  runtime: AgentRuntime,
  originStoreId: string,
  identity: PlanningRunIdentity,
  reportRun: Readonly<RunRecord>,
  suppliedCommand?: Readonly<CommandRecord>,
): Promise<RunRecord> {
  const unavailable = () => new AgentError('planning_run_scope_unavailable');
  const [metadata, parent, command, session] = await Promise.all([
    runtime.getMetadata(),
    runtime.getRun(identity.runId),
    runtime.getCommand(reportRun.originCommandId),
    runtime.getSession(identity.sessionId),
  ]);
  if (
    metadata.storeId !== originStoreId ||
    !parent ||
    !command ||
    !session ||
    session.deletedAt !== null ||
    parent.id === reportRun.id ||
    parent.sessionId !== identity.sessionId ||
    parent.originStoreId !== originStoreId ||
    parent.status !== 'completed' ||
    parent.isActive ||
    reportRun.sessionId !== identity.sessionId ||
    reportRun.originStoreId !== originStoreId ||
    reportRun.rootWorkCommandId !== parent.rootWorkCommandId ||
    reportRun.rootWorkSeq !== parent.rootWorkSeq ||
    planningSnapshotDigest(reportRun.configuration) !==
      planningSnapshotDigest(parent.configuration) ||
    !['job.report', 'job.report.continue'].includes(command.kind) ||
    command.status !== 'applied' ||
    command.cancelRequestedAt !== null ||
    command.sessionId !== identity.sessionId ||
    command.originStoreId !== originStoreId ||
    command.rootWorkCommandId !== parent.rootWorkCommandId ||
    command.rootWorkSeq !== parent.rootWorkSeq ||
    !object(command.request) ||
    command.request.parentRunId !== parent.id ||
    typeof command.request.executionId !== 'string' ||
    !object(command.receipt) ||
    command.receipt.outcome !== 'report_started' ||
    command.receipt.runId !== reportRun.id ||
    command.receipt.executionId !== command.request.executionId ||
    (suppliedCommand &&
      planningSnapshotDigest(suppliedCommand as unknown as Json) !==
        planningSnapshotDigest(command as unknown as Json))
  )
    throw unavailable();
  const carrier = await runtime.getExecution(command.request.executionId);
  const binding = carrier?.afterTurn ?? undefined;
  if (
    carrier?.kind !== 'job' ||
    !['succeeded', 'failed'].includes(carrier.status) ||
    carrier.cancelRequestedAt !== null ||
    carrier.originStoreId !== originStoreId ||
    carrier.sessionId !== parent.sessionId ||
    carrier.rootWorkCommandId !== parent.rootWorkCommandId ||
    carrier.rootWorkSeq !== parent.rootWorkSeq ||
    !carrier.childSessionId ||
    !carrier.childConfiguration ||
    carrier.resultRevision !== command.request.resultRevision ||
    (command.kind === 'job.report.continue'
      ? await readContinuedReportOrigin(runtime, command, carrier)
      : command.id) !==
      `report-${planningSnapshotDigest([originStoreId, carrier.id, carrier.resultRevision])}` ||
    carrier.delivery !== 'consumed' ||
    carrier.resultAcceptance?.runId !== reportRun.id ||
    !object(binding) ||
    !['after_turn', 'agent_completion'].includes(String(binding.kind)) ||
    binding.parentRunId !== parent.id ||
    binding.sourceExecutionId !== carrier.parentExecutionId ||
    typeof binding.sourceExecutionId !== 'string' ||
    binding.contextSelectionId !== command.request.contextSelectionId ||
    planningSnapshotDigest(binding.configuration!) !==
      planningSnapshotDigest(carrier.childConfiguration as unknown as Json) ||
    (binding.kind === 'after_turn' &&
      planningSnapshotDigest(binding.authorization!) !==
        planningSnapshotDigest(command.request.authorization!)) ||
    (binding.kind === 'agent_completion' &&
      (command.receipt.sourceId !== carrier.resultAcceptance?.sourceId ||
        command.receipt.resultRevision !== carrier.resultRevision ||
        carrier.resultAcceptance?.selectionId !== command.request.contextSelectionId))
  )
    throw unavailable();
  const [source, origin, child] = await Promise.all([
    runtime.getExecution(binding.sourceExecutionId),
    runtime.getCommand(parent.originCommandId),
    runtime.getSession(carrier.childSessionId),
  ]);
  if (
    !source ||
    !origin ||
    !child ||
    source.kind !== 'tool' ||
    source.status !== 'succeeded' ||
    source.cancelRequestedAt !== null ||
    source.runId !== parent.id ||
    source.sessionId !== parent.sessionId ||
    source.originStoreId !== originStoreId ||
    source.rootWorkCommandId !== parent.rootWorkCommandId ||
    source.rootWorkSeq !== parent.rootWorkSeq ||
    source.originCommandId !== parent.originCommandId ||
    source.definitionId !== binding.definitionId ||
    source.definitionVersion !== binding.definitionVersion ||
    planningSnapshotDigest(source.input) !== binding.inputDigest ||
    origin.originStoreId !== originStoreId ||
    origin.sessionId !== parent.sessionId ||
    origin.rootWorkCommandId !== parent.rootWorkCommandId ||
    origin.rootWorkSeq !== parent.rootWorkSeq ||
    origin.subjectId !== command.subjectId ||
    origin.cancelRequestedAt !== null ||
    !['run.start', 'input.follow_up', 'child.start', 'job.report', 'job.report.continue'].includes(
      origin.kind,
    ) ||
    child.parentSessionId !== parent.sessionId ||
    child.rootSessionId !== session.rootSessionId ||
    child.workspaceId !== session.workspaceId ||
    parent.requirements.some(
      (ref) =>
        !reportRun.requirements.some(
          (inherited) =>
            planningSnapshotDigest(inherited as unknown as Json) ===
            planningSnapshotDigest(ref as unknown as Json),
        ),
    )
  )
    throw unavailable();
  return parent;
}

export async function readPlanningPermissionState(
  runtime: AgentRuntime,
  planning: Planning,
  request: AuthorizationRequest,
  originStoreId: string,
  identity: PlanningRunIdentity,
): Promise<PlanningState> {
  const execution = await runtime.getExecution(request.executionId);
  const metadata = await runtime.getMetadata();
  const boundRun = await runtime.getRun(identity.runId);
  if (
    metadata.storeId !== originStoreId ||
    !boundRun ||
    boundRun.sessionId !== identity.sessionId ||
    boundRun.originStoreId !== originStoreId ||
    !execution ||
    execution.originStoreId !== originStoreId ||
    execution.sessionId !== request.sessionId ||
    execution.runId !== request.runId ||
    execution.kind !== request.kind ||
    execution.definitionId !== request.definitionId ||
    execution.definitionVersion !== request.definitionVersion
  )
    throw new AgentError('planning_run_scope_unavailable');
  // Core composes this parent's ceiling into actual delegated children. Observe
  // durable causality here; a new same-Session Run cannot borrow the old plan.
  if (
    execution.rootWorkCommandId !== boundRun.rootWorkCommandId ||
    execution.rootWorkSeq !== boundRun.rootWorkSeq
  )
    throw new AgentError('planning_run_scope_unavailable');
  if (request.sessionId === identity.sessionId) {
    let cursor = execution;
    const seen = new Set<string>();
    while (cursor.runId !== identity.runId) {
      if (seen.has(cursor.id)) throw new AgentError('planning_run_scope_unavailable');
      seen.add(cursor.id);
      if (!cursor.parentExecutionId) {
        const reportRun = cursor.runId && (await runtime.getRun(cursor.runId));
        if (!reportRun) throw new AgentError('planning_run_scope_unavailable');
        await readBoundPlanningSuccessor(runtime, originStoreId, identity, reportRun);
        break;
      }
      const parent = await runtime.getExecution(cursor.parentExecutionId);
      if (
        !parent ||
        parent.originStoreId !== originStoreId ||
        parent.sessionId !== identity.sessionId ||
        parent.rootWorkCommandId !== boundRun.rootWorkCommandId ||
        parent.rootWorkSeq !== boundRun.rootWorkSeq
      )
        throw new AgentError('planning_run_scope_unavailable');
      cursor = parent;
    }
  } else {
    let session = await runtime.getSession(request.sessionId);
    const seen = new Set<string>();
    while (session?.id !== identity.sessionId) {
      if (
        !session ||
        session.deletedAt !== null ||
        !session.parentSessionId ||
        seen.has(session.id)
      )
        throw new AgentError('planning_run_scope_unavailable');
      seen.add(session.id);
      session = await runtime.getSession(session.parentSessionId);
    }
  }
  const read: ConditionReadContext = {
    sessionId: identity.sessionId,
    async getRun(id) {
      if (id !== identity.runId) throw new AgentError('planning_run_scope_unavailable');
      const run = await runtime.getRun(id);
      if (run && (run.sessionId !== identity.sessionId || run.originStoreId !== originStoreId))
        throw new AgentError('planning_run_scope_unavailable');
      return run;
    },
    async getExecution(id) {
      const actual = await runtime.getExecution(id);
      if (
        actual &&
        (actual.sessionId !== identity.sessionId || actual.originStoreId !== originStoreId)
      )
        throw new AgentError('planning_run_scope_unavailable');
      return actual;
    },
    getInteraction: (interactionId) =>
      runtime.getInteraction({
        expectedStoreId: originStoreId,
        sessionId: identity.sessionId,
        interactionId,
      }),
    records: {
      get: (key) =>
        runtime.readRunExtensionRecord({
          sessionId: identity.sessionId,
          runId: identity.runId,
          extensionId: planningExtensionId,
          key,
        }),
    },
  };
  return planning.readPlanningState(read, { runId: identity.runId, originStoreId });
}

/** Follow only sealed causal links; same-work identity alone never grants a plan. */
export async function readBoundPlanningSuccessor(
  runtime: AgentRuntime,
  originStoreId: string,
  identity: PlanningRunIdentity,
  successor: Readonly<RunRecord>,
  suppliedCommand?: Readonly<CommandRecord>,
): Promise<RunRecord> {
  const seen = new Set<string>();
  let current = successor;
  for (;;) {
    if (seen.has(current.id)) throw new AgentError('planning_run_scope_unavailable');
    seen.add(current.id);
    const command = await runtime.getCommand(current.originCommandId);
    if (
      !command ||
      (suppliedCommand &&
        current.id === successor.id &&
        planningSnapshotDigest(suppliedCommand as unknown as Json) !==
          planningSnapshotDigest(command as unknown as Json))
    )
      throw new AgentError('planning_run_scope_unavailable');
    let parent: RunRecord;
    if (
      ['job.report', 'job.report.continue'].includes(command.kind) &&
      object(command.request) &&
      typeof command.request.parentRunId === 'string'
    ) {
      parent = await readBoundJobReportParent(
        runtime,
        originStoreId,
        { runId: command.request.parentRunId, sessionId: identity.sessionId },
        current,
        command,
      );
    } else {
      const receipt = command.receipt;
      if (
        !object(receipt) ||
        typeof receipt.humanInputCommandId !== 'string' ||
        typeof receipt.decisionCommandId !== 'string' ||
        typeof receipt.continuationRunId !== 'string'
      )
        throw new AgentError('planning_run_scope_unavailable');
      const [original, decision, prior] = await Promise.all([
        runtime.getCommand(receipt.humanInputCommandId),
        runtime.getCommand(receipt.decisionCommandId),
        runtime.getRun(receipt.continuationRunId),
      ]);
      const request = decision?.request;
      const decisionReceipt = decision?.receipt;
      if (
        !original ||
        !decision ||
        !prior ||
        !object(original.request) ||
        !object(original.receipt) ||
        !object(request) ||
        !object(request.proposal) ||
        !object(decisionReceipt) ||
        original.kind !== 'human.input' ||
        decision.kind !== 'human.input.decision' ||
        decision.status !== 'applied' ||
        !['run.start', 'input.follow_up'].includes(command.kind) ||
        command.status !== 'applied' ||
        command.cancelRequestedAt !== null ||
        original.cancelRequestedAt !== null ||
        decision.cancelRequestedAt !== null ||
        request.inputCommandId !== original.id ||
        request.inputDigest !== original.requestDigest ||
        request.proposal.relation !== 'same_work' ||
        decisionReceipt.continuationRunId !== prior.id ||
        decisionReceipt.targetRootWorkCommandId !== prior.rootWorkCommandId ||
        decisionReceipt.businessCommandId !== command.id ||
        original.receipt.businessCommandId !== command.id ||
        original.receipt.applicationState !== 'applied' ||
        original.receipt.runId !== current.id ||
        receipt.runId !== current.id ||
        prior.id === current.id ||
        prior.isActive ||
        prior.status !== 'completed' ||
        [original, decision].some(
          (record) =>
            record.originStoreId !== originStoreId || record.sessionId !== identity.sessionId,
        ) ||
        [command, prior, current].some(
          (record) =>
            record.originStoreId !== originStoreId ||
            record.sessionId !== identity.sessionId ||
            record.rootWorkCommandId !== prior.rootWorkCommandId ||
            record.rootWorkSeq !== prior.rootWorkSeq,
        ) ||
        original.subjectId !== command.subjectId ||
        decision.subjectId !== command.subjectId ||
        prior.contextSelectionId !== current.contextSelectionId ||
        planningSnapshotDigest(prior.configuration) !==
          planningSnapshotDigest(current.configuration) ||
        prior.requirements.some(
          (ref) =>
            !current.requirements.some(
              (inherited) =>
                planningSnapshotDigest(ref as unknown as Json) ===
                planningSnapshotDigest(inherited as unknown as Json),
            ),
        )
      )
        throw new AgentError('planning_run_scope_unavailable');
      const publicId = original.request.publicCommandId;
      const publicCommand =
        typeof publicId === 'string' ? await runtime.getCommand(publicId) : null;
      if (
        !publicCommand ||
        !object(publicCommand.receipt) ||
        publicCommand.status !== 'applied' ||
        publicCommand.cancelRequestedAt !== null ||
        !['run.start', 'input.steer', 'input.follow_up'].includes(publicCommand.kind) ||
        !object(original.request.originalRequest) ||
        planningSnapshotDigest(publicCommand.request) !==
          planningSnapshotDigest(original.request.originalRequest) ||
        publicCommand.receipt.businessCommandId !== command.id ||
        publicCommand.receipt.humanInputCommandId !== original.id ||
        publicCommand.receipt.decisionCommandId !== decision.id ||
        publicCommand.receipt.runId !== current.id ||
        publicCommand.sessionId !== current.sessionId ||
        publicCommand.originStoreId !== originStoreId ||
        publicCommand.subjectId !== command.subjectId
      )
        throw new AgentError('planning_run_scope_unavailable');
      parent = prior;
    }
    if (parent.id === identity.runId) return parent;
    current = parent;
  }
}
