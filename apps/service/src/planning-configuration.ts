import { createHash } from 'node:crypto';
import { AgentError, type AgentRuntime } from '@kite-ai/agent';
import type {
  AuthorizationRequest,
  ConditionReadContext,
  Json,
  PermissionDecision,
  Permissions,
} from '@kite-ai/agent/extensions';
import {
  type createPlanningValidation,
  type PlanningState,
  planningExtensionId,
} from '@kite-ai/agent/planning';
import { skillWorkflowExtensionId } from '@kite-ai/agent/skill-workflow';
import type { CommandRecord, RunRecord } from '@kite-ai/agent/storage';
import { type CapabilityDescription, createPermissionPolicy } from './permissions';

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

const management = new Set([
  'planning.read',
  'planning.write',
  'planning.review',
  'planning.update',
  'validation.define',
  'validation.check',
  'validation.rebind',
]);

type Planning = Pick<ReturnType<typeof createPlanningValidation>, 'readPlanningState'>;
type PlanningRunIdentity = { runId: string; sessionId: string };

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
    command.kind !== 'job.report' ||
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
    !carrier ||
    carrier.kind !== 'job' ||
    !['succeeded', 'failed'].includes(carrier.status) ||
    carrier.cancelRequestedAt !== null ||
    carrier.originStoreId !== originStoreId ||
    carrier.sessionId !== parent.sessionId ||
    carrier.rootWorkCommandId !== parent.rootWorkCommandId ||
    carrier.rootWorkSeq !== parent.rootWorkSeq ||
    !carrier.childSessionId ||
    !carrier.childConfiguration ||
    carrier.resultRevision !== command.request.resultRevision ||
    command.id !==
      `report-${planningSnapshotDigest([originStoreId, carrier.id, carrier.resultRevision])}` ||
    carrier.delivery !== 'consumed' ||
    carrier.resultAcceptance?.runId !== reportRun.id ||
    !object(binding) ||
    binding.kind !== 'after_turn' ||
    binding.parentRunId !== parent.id ||
    binding.sourceExecutionId !== carrier.parentExecutionId ||
    typeof binding.sourceExecutionId !== 'string' ||
    binding.contextSelectionId !== command.request.contextSelectionId ||
    planningSnapshotDigest(binding.configuration!) !==
      planningSnapshotDigest(carrier.childConfiguration as unknown as Json) ||
    planningSnapshotDigest(binding.authorization!) !==
      planningSnapshotDigest(command.request.authorization!)
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
    !['run.start', 'input.follow_up', 'child.start'].includes(origin.kind) ||
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

async function readState(
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
        await readBoundJobReportParent(runtime, originStoreId, identity, reportRun);
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

/** One ceiling cannot grant a call denied by current policy or widen its grant scope. */
function intersect(
  current: PermissionDecision,
  ceiling: PermissionDecision,
  state: PlanningState,
  identity: PlanningRunIdentity | undefined,
): PermissionDecision {
  const revision = planningSnapshotDigest({
    current: current as unknown as Json,
    ceiling: ceiling as unknown as Json,
    state: state as unknown as Json,
    identity: identity ?? null,
  });
  const proof = {
    ...(current.controlReads === undefined ? {} : { controlReads: current.controlReads }),
    snapshot: {
      namespace: 'builtin.planning.permissions',
      version: '1',
      data: {
        planning: state as unknown as Json,
        originalRun: identity ?? null,
        current: current.snapshot ?? null,
        ceiling: ceiling.snapshot ?? null,
      },
    },
  };
  if (!current.allowed && !current.approval && !current.review)
    return { allowed: false, revision, reason: current.reason, ...proof };
  if (!ceiling.allowed && !ceiling.approval && !ceiling.review)
    return { allowed: false, revision, reason: ceiling.reason, ...proof };
  if (ceiling.allowed) return { ...current, revision, ...proof };
  if (current.allowed) return { ...ceiling, revision, ...proof };
  const decisions = [current, ceiling];
  const approvals = decisions.filter((decision) => decision.approval);
  const reviews = decisions.filter((decision) => decision.review);
  const scopes = decisions.map((decision, index) => ({
    scope: index === 0 ? 'current' : 'plan',
    revision: decision.revision,
    request: decision.approval?.request ?? null,
  }));
  const commandDigest = approvals[0]?.approval?.commandDigest;
  const sameCommand =
    !!commandDigest &&
    approvals.every(
      (decision) =>
        decision.approval?.commandDigest === commandDigest &&
        decision.approval.grants?.includes('same_command'),
    );
  return {
    allowed: false,
    revision,
    reason: 'planning_mode_ceiling',
    ...proof,
    ...(approvals.length
      ? {
          approval: {
            request: { kind: 'planning_mode_ceiling', policies: scopes },
            ...(sameCommand
              ? { grants: ['approve_once', 'same_command'] as const, commandDigest }
              : {}),
          },
        }
      : {}),
    ...(reviews.length
      ? {
          review: {
            request: {
              kind: 'planning_mode_ceiling',
              policies: decisions.map((decision, index) => ({
                scope: index === 0 ? 'current' : 'plan',
                revision: decision.revision,
                request: decision.review?.request ?? null,
              })),
            },
            requireApproval: decisions.some(
              (decision) =>
                decision.review?.requireApproval || (!!decision.approval && !decision.review),
            ),
          },
        }
      : {}),
  };
}

export function createPlanningPermissionCeiling(options: {
  required: boolean;
  runtime: () => AgentRuntime | undefined;
  planning: Planning;
  originStoreId: string;
  run: () => PlanningRunIdentity | undefined;
  current: Permissions;
  describe: (request: AuthorizationRequest) => CapabilityDescription | null;
}): Permissions {
  return {
    async authorize(request) {
      request.signal.throwIfAborted();
      const current = await options.current.authorize(request);
      if (!options.required) return current;
      const runtime = options.runtime();
      const identity = options.run();
      let state: PlanningState;
      try {
        if (!runtime || !identity) throw new AgentError('planning_run_scope_unavailable');
        state = await readState(
          runtime,
          options.planning,
          request,
          options.originStoreId,
          identity,
        );
        if (state.status === 'disabled')
          throw new AgentError('planning_run_obligation_unavailable');
      } catch {
        return intersect(
          current,
          {
            allowed: false,
            revision: 'planning-scope-1',
            reason: 'planning_run_scope_unavailable',
          },
          { status: 'pending' },
          identity,
        );
      }
      request.signal.throwIfAborted();
      const description = options.describe(request);
      const beforeApproval =
        request.kind === 'model' ||
        (request.kind === 'tool' &&
          ((request.definitionVersion === '1' && management.has(request.definitionId)) ||
            (!!description?.safeRead && description.effects.every((effect) => effect === 'read'))));
      if (state.status !== 'approved' || beforeApproval)
        return intersect(
          current,
          {
            allowed: beforeApproval,
            revision: 'planning-preapproval-1',
            ...(beforeApproval ? {} : { reason: 'plan_approval_required' }),
          },
          state,
          identity,
        );
      const policy = createPermissionPolicy({
        readPolicy: () => ({
          mode: state.mode,
          workspaceTrust: true,
          revision: `plan:${state.planId}:${state.version}:${state.digest}`,
          allowed: [
            {
              kind: request.kind,
              definitionId: request.definitionId,
              definitionVersion: request.definitionVersion,
            },
          ],
        }),
        describeCapability: options.describe,
      });
      return intersect(current, await policy.authorize(request), state, identity);
    },
  };
}
