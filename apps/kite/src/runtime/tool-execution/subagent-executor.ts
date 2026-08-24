import type {
  BuiltinModelToolCatalogEntry,
  BuiltinOperationExecutionValue,
} from '@kite/builtin-runtime';
import {
  type PendingToolRequest,
  pendingToolRequestFromValidatedInvocation,
  toolRequestFromCall,
} from '@kite/builtin-runtime';
import { digestCapabilityValue } from '@kite/builtin-runtime/capability';
import { exposedMcpToolName, type McpRuntimeProvider } from '@kite/builtin-runtime/mcp';
import { createCapabilitySnapshot } from '@kite/builtin-runtime/skills';
import type { SubagentContinuationArtifactAccess } from '@kite/builtin-runtime/subagent';
import { rejectShellOutsideSubAgentRoleCeiling } from '@kite/builtin-runtime/subagent';
import type { SubAgentEventSink } from '@kite/runtime-contract';
import { type CapabilityDescriptor, getAgentPhase } from '@kite/runtime-contract';
import {
  bestEffortRegularFileSize,
  createRuntimeHostToolCallSnapshot,
  createRuntimeHostInteractionId as genInteractionId,
} from '@kite/runtime-host';
import {
  runtimeHostStateActiveSkillFrames as activeSkillFramesForCurrentWork,
  DescendantResourceAdmissionError,
  runtimeHostStateActivePlanning as getActivePlanning,
  runtimeHostStateEffectiveInteractionMode as getEffectiveInteractionMode,
  runtimeHostStateToolRecoveryJournalInvalid as isToolRecoveryJournalInvalid,
  runtimeHostStateNormalizeToolRecoveryJournal as normalizeToolRecoveryJournal,
  runtimeHostStateCreateApprovalBindingDigest,
  type StateToolGovernancePolicyFact,
  runtimeHostStateToolInvocationFingerprint as toolInvocationFingerprint,
} from '@kite/runtime-host/kernel-adapter';
import {
  type AppApprovalBinding,
  appApprovalBindingForPresentation,
  bindAppApprovalBinding,
  isAuthenticAppApprovalBinding,
} from '#app/bootstrap/runtime/approval-binding';
import { classifyFailure } from '#app/bootstrap/runtime/failures';
import type { RuntimeEvent, RuntimeState } from '#app/bootstrap/runtime/state-runtime';
import {
  deserializeSubagentContinuation,
  serializeSubagentContinuation,
  subagentContinuationCursorId,
} from '#app/bootstrap/runtime/subagent/continuation-codec';
import type { TaskToolDeps } from '#app/bootstrap/runtime/subagent/task-tool';
import type {
  RestoredSubAgentContinuation,
  SubAgentResult,
  SubAgentToolDispatcher,
} from '#app/bootstrap/runtime/subagent/types';
import type { AppToolPipelineComposition } from '#app/bootstrap/runtime/tool-pipeline-composition';
import type { AppTaskToolPipelineAttemptRuntime } from '#app/bootstrap/runtime/tool-pipeline-task-attempt';
import { buildToolApproval } from '#app/bootstrap/runtime/tool-policy';
import type { ToolExecutionResult } from '#app/bootstrap/runtime/tool-result';
import {
  type AppToolTurnContext,
  createAppToolTurnContext,
} from '#app/bootstrap/runtime/tool-turn-context';
import { getFeatureFlags } from '#app/config/features';
import { visibleProjectInstructions } from '#app/runtime/tool-execution/project-instruction-guard';
import { createCapabilityBinding } from '#builtin-runtime';
import type {
  CapabilityToolTerminalResult,
  DurableSuspendedSubagent,
  PreparedToolInvocation,
  PrivateSuspendedSubagentRecord,
  RuntimeJsonValue,
  SubagentContinuationArtifactRef,
  SuspendedSubagentSnapshot,
  ToolPipelineTaskSubagentSuspension,
} from '#runtime-spi';
import { modelBuiltinEntry } from './builtin-executor';
import { executeAppRuntimeTools } from './router';
import { toRuntimeSubagentEvent } from './terminal-projection';

class SubagentContinuationPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubagentContinuationPersistenceError';
  }
}

export function privateSuspendedSubagentRecord(input: {
  artifacts?: SubagentContinuationArtifactAccess;
  parentInvocationId: string;
  parentAttempt: number;
  parentToolCallId: string;
  blocked: NonNullable<SubAgentResult['blocked']>;
}): PrivateSuspendedSubagentRecord {
  if (!input.artifacts) {
    throw new SubagentContinuationPersistenceError(
      'Private Subagent continuation Artifact storage is unavailable.',
    );
  }
  const snapshot = serializeSubagentContinuation(input.blocked.continuation, {
    reasonCode: input.blocked.reasonCode,
    toolCallId: input.blocked.toolCallId,
    ...(input.blocked.runtimeToolCallId
      ? { runtimeToolCallId: input.blocked.runtimeToolCallId }
      : {}),
    toolName: input.blocked.toolName,
    args: input.blocked.args,
    command: input.blocked.command,
    ...(input.blocked.approvalBinding ? { approvalBinding: input.blocked.approvalBinding } : {}),
  });
  const continuationId = subagentContinuationCursorId(snapshot);
  let continuationArtifact: SubagentContinuationArtifactRef;
  try {
    continuationArtifact = input.artifacts.write({
      owner: {
        parentInvocationId: input.parentInvocationId,
        parentAttempt: input.parentAttempt,
        parentToolCallId: input.parentToolCallId,
        childInvocationId: snapshot.subagentId,
        continuationId,
      },
      snapshot,
    });
  } catch {
    throw new SubagentContinuationPersistenceError(
      'Private Subagent continuation Artifact publication failed.',
    );
  }
  return {
    storage: 'private_artifact_v1',
    subagentId: snapshot.subagentId,
    role: snapshot.role,
    continuationId,
    modelInvocationOrdinal: snapshot.modelInvocationOrdinal ?? 0,
    continuationArtifact,
    parentInvocationId: input.parentInvocationId,
    parentAttempt: input.parentAttempt,
    blockedTool: {
      reasonCode: snapshot.blockedTool.reasonCode,
      toolCallId: snapshot.blockedTool.toolCallId,
      ...(snapshot.blockedTool.runtimeToolCallId
        ? { runtimeToolCallId: snapshot.blockedTool.runtimeToolCallId }
        : {}),
      toolName: snapshot.blockedTool.toolName,
    },
  };
}

export function readPrivateSuspendedSubagent(
  suspended: DurableSuspendedSubagent,
  parentToolCallId: string,
  state: Readonly<RuntimeState>,
  artifacts?: SubagentContinuationArtifactAccess,
): SuspendedSubagentSnapshot {
  if (!artifacts) {
    throw new SubagentContinuationPersistenceError(
      'Private Subagent continuation Artifact reader is unavailable.',
    );
  }
  const call = state.tools.calls[parentToolCallId];
  const parent = state.capabilities.invocations[suspended.parentInvocationId];
  const lifecycle = parent?.subagentProviderLifecycle;
  if (
    !call ||
    !parent ||
    parent.toolCallId !== parentToolCallId ||
    parent.capabilityId !== 'builtin:task' ||
    parent.status !== 'running' ||
    parent.attemptsStarted !== suspended.parentAttempt ||
    lifecycle?.attempt !== suspended.parentAttempt ||
    lifecycle.childInvocationId !== suspended.subagentId ||
    lifecycle.status !== 'cleanup_completed' ||
    lifecycle.observationStatus !== 'blocked' ||
    lifecycle.cleanupConfirmed !== true
  ) {
    throw new SubagentContinuationPersistenceError(
      'Private Subagent continuation has no exact live parent authority.',
    );
  }
  let snapshot: SuspendedSubagentSnapshot;
  try {
    snapshot = artifacts.read(suspended.continuationArtifact, {
      parentInvocationId: parent.invocationId,
      parentAttempt: parent.attemptsStarted,
      parentToolCallId,
      childInvocationId: lifecycle.childInvocationId,
      continuationId: suspended.continuationId,
    });
  } catch {
    throw new SubagentContinuationPersistenceError(
      'Private Subagent continuation Artifact failed exact readback.',
    );
  }
  if (
    snapshot.subagentId !== suspended.subagentId ||
    snapshot.role !== suspended.role ||
    (snapshot.modelInvocationOrdinal ?? 0) !== suspended.modelInvocationOrdinal ||
    subagentContinuationCursorId(snapshot) !== suspended.continuationId ||
    snapshot.blockedTool.reasonCode !== suspended.blockedTool.reasonCode ||
    snapshot.blockedTool.toolCallId !== suspended.blockedTool.toolCallId ||
    (snapshot.blockedTool.runtimeToolCallId ?? undefined) !==
      suspended.blockedTool.runtimeToolCallId ||
    snapshot.blockedTool.toolName !== suspended.blockedTool.toolName
  ) {
    throw new SubagentContinuationPersistenceError(
      'Private Subagent continuation Artifact is cross-bound.',
    );
  }
  return snapshot;
}

/** Preserve every suspended sibling without overwriting the Runtime interaction slot. */
export function serializeConcurrentSubagentApprovalEvents(
  batches: RuntimeEvent[][],
): RuntimeEvent[] {
  let interactionClaimed = false;
  return batches.flatMap((batch) => {
    const request = batch.find(
      (event) => event.type === 'approval.requested' || event.type === 'auto_review.requested',
    );
    if (!request) return batch;
    if (!interactionClaimed) {
      interactionClaimed = true;
      return batch;
    }
    return [
      ...batch.filter(
        (event) => event.type !== 'approval.requested' && event.type !== 'auto_review.requested',
      ),
      { type: 'subagent.approval_deferred', toolCallId: request.toolCallId } as const,
    ];
  });
}

export type PrivateSubagentTask = {
  readonly source: 'private_artifact_v1';
  readonly requestArtifact: import('@kite/runtime-spi').SubagentTaskRequestArtifact;
  readonly payload: {
    readonly name: string;
    readonly subagent_type: 'explore' | 'plan' | 'code' | 'review';
    readonly task: string;
  };
};

type AppTaskAttemptInput = Parameters<AppTaskToolPipelineAttemptRuntime['execute']>[0];

export function forkToolCeiling(input: {
  capabilityCeiling: readonly string[];
  builtinToolCatalog: import('@kite/builtin-runtime').BuiltinToolCatalogProjection;
  mcpManager?: McpRuntimeProvider;
  turnId: string;
}): {
  allowedTools: Set<string>;
  mcpBindings: Array<{
    binding: import('@kite/runtime-contract').CapabilityBinding;
    descriptor: import('@kite/runtime-contract').CapabilityDescriptor;
  }>;
} | null {
  const tools = new Set<string>();
  const mcpBindings: Array<{
    binding: import('@kite/runtime-contract').CapabilityBinding;
    descriptor: import('@kite/runtime-contract').CapabilityDescriptor;
  }> = [];
  for (const capabilityId of input.capabilityCeiling) {
    const builtinEntry = input.builtinToolCatalog.entries.find(
      (entry): entry is BuiltinModelToolCatalogEntry =>
        entry.visibility === 'model' &&
        entry.availability === 'available' &&
        entry.capabilityId === capabilityId,
    );
    if (builtinEntry) {
      tools.add(builtinEntry.name);
      continue;
    }
    const descriptor = input.mcpManager?.findCapability(capabilityId);
    if (
      descriptor?.kind !== 'mcp_tool' ||
      descriptor.availability !== 'available' ||
      !descriptor.inputSchema
    )
      return null;
    const binding = createCapabilityBinding({
      capabilityId: descriptor.capabilityId,
      capabilityRevision: descriptor.revision,
      exposedToolName: exposedMcpToolName(descriptor.provider.id, descriptor.displayName),
      inputSchema: descriptor.inputSchema ?? {},
      turnId: input.turnId,
    });
    tools.add(binding.exposedToolName);
    mcpBindings.push({ binding, descriptor });
  }
  return { allowedTools: tools, mcpBindings };
}

export function forkRole(agent: string): 'explore' | 'plan' | 'code' | 'review' {
  return agent === 'explore' || agent === 'plan' || agent === 'review' ? agent : 'code';
}

function childRuntimeToolCallId(input: {
  parentToolCallId: string;
  subagentId: string;
  modelInvocationId: string;
  modelToolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}): string {
  return `subagent-tool:${digestCapabilityValue({
    schema: 'kite.subagent-runtime-tool-identity.v1',
    parentToolCallId: input.parentToolCallId,
    subagentId: input.subagentId,
    modelInvocationId: input.modelInvocationId,
    modelToolCallId: input.modelToolCallId,
    toolName: input.toolName,
    arguments: input.args,
  })}`;
}

export function isCurrentExactChildToolReservation(
  state: Readonly<RuntimeState>,
  reservationId: string,
  toolName: string,
): boolean {
  const budget = state.resourceBudget;
  if (budget.status !== 'active') return false;
  const reservation = budget.reservations[reservationId];
  if (
    reservation?.state !== 'dispatch_started' ||
    !reservation.parentReservationId ||
    reservation.resourceKind !== (toolName.startsWith('mcp__') ? 'mcp' : 'tool')
  ) {
    return false;
  }
  const parent = budget.reservations[reservation.parentReservationId];
  return Boolean(
    parent?.resourceKind === 'subagent' &&
      parent.state === 'dispatch_started' &&
      reservation.invocationId.startsWith(`descendant:${parent.invocationId}:`),
  );
}

/**
 * The Builtin operation receives a JSON-safe transport view. The exact
 * Provider result remains captured separately for the private Artifact and
 * review path; this view only removes the restored-only blockedTool backlink
 * and converts the role's local Set before Builtin projection.
 */
function taskResultForBuiltinProjection(
  result: Readonly<SubAgentResult>,
): Readonly<Record<string, unknown>> {
  if (!result.blocked) return Object.freeze({ ...result });
  const continuation = result.blocked.continuation as RestoredSubAgentContinuation;
  const { blockedTool: _blockedTool, ...continuationWithoutBacklink } = continuation;
  const role = continuation.role;
  const transportRole = Object.freeze({
    ...role,
    ...(role.allowedTools ? { allowedTools: [...role.allowedTools] } : {}),
  });
  return Object.freeze({
    ...result,
    blocked: Object.freeze({
      ...result.blocked,
      continuation: Object.freeze({
        ...continuationWithoutBacklink,
        role: transportRole,
      }),
    }),
  });
}

/**
 * Verify the neutral Builtin terminal against the exact typed Provider result
 * captured by the one Task execution callback. The terminal may intentionally
 * omit private continuation payloads, but its identity, argument/command and
 * recovery facts must remain mechanically bound to that result.
 */
function isExactTaskBlockedTerminalProjection(
  terminal: Readonly<CapabilityToolTerminalResult<BuiltinOperationExecutionValue>>,
  captured: Readonly<SubAgentResult>,
): boolean {
  const structured = terminal.structuredContent;
  const projectedResult =
    structured && typeof structured === 'object' && !Array.isArray(structured)
      ? (structured as Record<string, unknown>).subagentResult
      : undefined;
  const projectedResultRecord = isRecordObject(projectedResult) ? projectedResult : undefined;
  const projectedBlocked = projectedResultRecord?.blocked;
  const expectedBlocked = captured.blocked;
  if (!projectedResultRecord || !isRecordObject(projectedBlocked) || !expectedBlocked) {
    return false;
  }
  if (
    projectedBlocked.reasonCode !== expectedBlocked.reasonCode ||
    projectedBlocked.toolCallId !== expectedBlocked.toolCallId ||
    (projectedBlocked.runtimeToolCallId ?? null) !== (expectedBlocked.runtimeToolCallId ?? null) ||
    projectedBlocked.toolName !== expectedBlocked.toolName ||
    !isRecordObject(projectedBlocked.args) ||
    digestCapabilityValue(projectedBlocked.args) !== digestCapabilityValue(expectedBlocked.args) ||
    typeof projectedBlocked.command !== 'string' ||
    digestCapabilityValue(projectedBlocked.command.trim()) !==
      digestCapabilityValue(expectedBlocked.command.trim())
  ) {
    return false;
  }

  const projectedRecovery = projectedResultRecord.toolRecovery;
  if (
    !isRecordObject(projectedRecovery) ||
    digestCapabilityValue(projectedRecovery) !== digestCapabilityValue(captured.toolRecovery ?? {})
  ) {
    return false;
  }

  const projectedContinuation = projectedBlocked.continuation;
  const expectedContinuation = expectedBlocked.continuation;
  if (!isRecordObject(projectedContinuation) || !isRecordObject(expectedContinuation)) {
    return false;
  }
  const projectedRole =
    typeof projectedContinuation.role === 'string'
      ? projectedContinuation.role
      : isRecordObject(projectedContinuation.role) &&
          typeof projectedContinuation.role.role === 'string'
        ? projectedContinuation.role.role
        : undefined;
  if (
    projectedContinuation.id !== expectedContinuation.id ||
    projectedContinuation.name !== (expectedContinuation.name ?? 'Delegated task') ||
    projectedRole !== expectedContinuation.role.role ||
    (projectedContinuation.modelInvocationOrdinal ?? 0) !==
      (expectedContinuation.modelInvocationOrdinal ?? 0)
  ) {
    return false;
  }
  const projectedContinuationBlocked = projectedContinuation.blockedTool;
  return (
    isRecordObject(projectedContinuationBlocked) &&
    projectedContinuationBlocked.toolCallId === expectedBlocked.toolCallId &&
    (projectedContinuationBlocked.runtimeToolCallId ?? null) ===
      (expectedBlocked.runtimeToolCallId ?? null) &&
    projectedContinuationBlocked.toolName === expectedBlocked.toolName
  );
}

function isRecordObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

/**
 * Build a proper PendingToolRequest from a blocked sub-agent tool via the
 * request-adapter layer (Registry → toolRequestFromCall). Falls back to a
 * minimal typed object when the tool is not registered in the builtin Registry
 * (e.g. an MCP tool blocked before binding resolution).
 */
export function buildBlockedToolRequest(
  blocked: { toolCallId: string; toolName: string; args: Record<string, unknown>; command: string },
  availCtx: AppToolTurnContext,
  builtinToolCatalog: import('@kite/builtin-runtime').BuiltinToolCatalogProjection,
): PendingToolRequest {
  const parsed = toolRequestFromCall(
    { id: blocked.toolCallId, name: blocked.toolName, args: blocked.args },
    availCtx,
    builtinToolCatalog,
  );
  if (parsed?.ok) return parsed.request;
  // Fallback: unknown/unavailable tool — construct minimal typed request.
  // MCP tool names use the 'mcp__' prefix; route to the correct variant.
  if (blocked.toolName.startsWith('mcp__')) {
    return {
      source: 'mcp',
      id: blocked.toolCallId,
      name: blocked.toolName as `mcp__${string}`,
      args: blocked.args,
      reason: `Sub-agent MCP tool "${blocked.toolName}" blocked for approval`,
      protectedCommand: blocked.command,
    };
  }
  return {
    source: 'builtin',
    id: blocked.toolCallId,
    name: blocked.toolName,
    args: blocked.args,
    reason: `Sub-agent tool "${blocked.toolName}" blocked for approval`,
    protectedCommand: blocked.command,
  } as PendingToolRequest;
}

/** Multi-agent exploration gets model-reviewed autonomy in accept-edits mode.
 * The identity comes from sibling task calls in one model response, never from
 * task prose. Full remains full and every other delegated shape inherits the
 * live parent mode. */
export function isConcurrentExploreSubagentBatch(
  state: Readonly<RuntimeState>,
  toolCallIds: readonly string[],
): boolean {
  if (toolCallIds.length < 2) return false;
  const first = state.tools.calls[toolCallIds[0]!];
  if (!first?.modelMessageId) return false;
  return toolCallIds.every((toolCallId) => {
    const call = state.tools.calls[toolCallId];
    return (
      call?.name === 'task' &&
      call.modelMessageId === first.modelMessageId &&
      call.createdAtTurnId === first.createdAtTurnId &&
      isRecordObject(call.args) &&
      call.args.subagent_type === 'explore'
    );
  });
}

export function effectiveSubagentInteractionMode(
  state: RuntimeState,
  parentToolCallId: string,
  concurrentExploreBatch = false,
  knownRole?: string,
): ReturnType<typeof getEffectiveInteractionMode> {
  const parentMode = getEffectiveInteractionMode(state);
  if (parentMode !== 'accept_edits') return parentMode;
  const parent = state.tools.calls[parentToolCallId];
  const role =
    (parent && isRecordObject(parent.args) ? parent.args.subagent_type : undefined) ??
    state.suspendedSubagents[parentToolCallId]?.role ??
    knownRole;
  if (parent?.name !== 'task' || role !== 'explore' || !parent.modelMessageId) {
    return parentMode;
  }
  if (concurrentExploreBatch) return 'auto';
  const exploreSiblingCount = Object.values(state.tools.calls).filter((call) => {
    const siblingRole = isRecordObject(call.args)
      ? call.args.subagent_type
      : state.suspendedSubagents[call.toolCallId]?.role;
    return (
      call.name === 'task' &&
      call.modelMessageId === parent.modelMessageId &&
      call.createdAtTurnId === parent.createdAtTurnId &&
      siblingRole === 'explore'
    );
  }).length;
  return exploreSiblingCount > 1 ? 'auto' : parentMode;
}

export function blockedSubagentReviewEvent(input: {
  state: RuntimeState;
  parentToolCallId: string;
  blocked: NonNullable<import('#app/bootstrap/runtime/subagent/types').SubAgentResult['blocked']>;
  availCtx: AppToolTurnContext;
  toolPipelineComposition: AppToolPipelineComposition;
  descriptors?: readonly Readonly<CapabilityDescriptor>[];
}): RuntimeEvent {
  const { blocked, state } = input;
  const exact = exactBlockedSubagentPolicy(input);
  if (!exact) {
    throw new Error('Sub-agent approval requires the exact Kernel approval binding digest.');
  }
  const request = exact.request;
  const approval = buildToolApproval({
    workspace: state.session.workspace,
    threadId: state.session.threadId,
    request,
    decision: exact.decision,
    approvalBindingDigest: exact.approvalBindingDigest,
  });
  approval.subagentId = blocked.continuation.id;

  const effectiveMode = effectiveSubagentInteractionMode(state, input.parentToolCallId);
  if (
    exact.route === 'auto_review' ||
    (blocked.reasonCode === 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW' &&
      effectiveMode === 'auto' &&
      !state.autoReview.circuitBreakerTripped)
  ) {
    return {
      type: 'auto_review.requested',
      reviewId: genInteractionId(),
      toolCallId: input.parentToolCallId,
      toolName: blocked.toolName,
      reason: exact.decision.reason,
      approval,
      requestFingerprint: toolInvocationFingerprint({
        toolName: blocked.toolName,
        parsedArgs: blocked.args,
        identityRevision: 'subagent-blocked-v1',
      }),
    };
  }
  return {
    type: 'approval.requested',
    interactionId: genInteractionId(),
    toolCallId: input.parentToolCallId,
    approval,
  };
}

function exactBlockedSubagentPolicy(input: {
  state: RuntimeState;
  parentToolCallId: string;
  blocked: NonNullable<import('#app/bootstrap/runtime/subagent/types').SubAgentResult['blocked']>;
  availCtx: AppToolTurnContext;
  toolPipelineComposition: AppToolPipelineComposition;
  descriptors?: readonly Readonly<CapabilityDescriptor>[];
  allowMissingBinding?: boolean;
}):
  | {
      readonly request: PendingToolRequest;
      readonly decision: Readonly<StateToolGovernancePolicyFact>;
      readonly approvalBindingDigest: string;
      readonly approvalBinding: AppApprovalBinding;
      readonly route: 'user' | 'auto_review';
    }
  | undefined {
  const { state, blocked } = input;
  const approvalBinding = blocked.approvalBinding;
  if (
    (!approvalBinding && input.allowMissingBinding !== true) ||
    (approvalBinding && !isAuthenticAppApprovalBinding({ binding: approvalBinding, blocked }))
  ) {
    return undefined;
  }
  const runtimeChildCallId = blocked.runtimeToolCallId;
  const call = state.tools.calls[runtimeChildCallId ?? blocked.toolCallId];
  if (
    (runtimeChildCallId !== undefined &&
      !call &&
      approvalBinding?.runtimeToolCallId !== runtimeChildCallId) ||
    (call !== undefined &&
      (call.toolCallId !== runtimeChildCallId ||
        call.name !== blocked.toolName ||
        digestCapabilityValue(call.args) !== digestCapabilityValue(blocked.args)))
  ) {
    return undefined;
  }
  const toolCallId =
    approvalBinding?.invocationFact.toolCallId ?? call?.toolCallId ?? blocked.toolCallId;
  const createdAtTurnId =
    approvalBinding?.invocationFact.turnId ?? call?.createdAtTurnId ?? state.turn.turnId;
  const modelMessageId =
    approvalBinding?.invocationFact.modelMessageId ??
    call?.modelMessageId ??
    `subagent:${blocked.continuation.id}`;
  const turnPipeline = input.toolPipelineComposition.forTurn(
    Object.freeze({
      ...input.availCtx,
      turnId: state.turn.turnId,
      modelMessageId,
      toolCallId,
    }),
  );
  const snapshot = createRuntimeHostToolCallSnapshot({
    toolCallId,
    name: call?.name ?? blocked.toolName,
    rawArguments: call?.args ?? blocked.args,
    argumentOrigin: 'model_public',
    createdAtTurnId,
    modelMessageId,
    bindingId: approvalBinding
      ? approvalBinding.invocationFact.bindingId
      : (call?.bindingId ?? null),
    capabilityId: approvalBinding
      ? approvalBinding.invocationFact.bindingId
        ? approvalBinding.invocationFact.capabilityId
        : null
      : (call?.capabilityId ?? null),
    capabilityRevision: approvalBinding
      ? approvalBinding.invocationFact.bindingId
        ? approvalBinding.invocationFact.capabilityRevision
        : null
      : (call?.capabilityRevision ?? null),
  });
  if (!snapshot.ok) return undefined;
  const descriptors = input.descriptors ?? [];
  const dynamicCatalogRevision = createCapabilitySnapshot([...descriptors]).revision;
  const resolved = turnPipeline.callbacks.resolve(snapshot.value, {
    currentTurnId: state.turn.turnId,
    builtinProjectionRevision: turnPipeline.projection.revision,
    dynamicCatalogRevision,
    availabilityContext: input.availCtx,
    bindings: Object.values(state.capabilities.bindings),
    descriptors,
    disclosures: Object.values(state.capabilities.disclosures),
  });
  if (!resolved.ok) return undefined;
  const validated = turnPipeline.callbacks.validate(resolved.value);
  if (!validated.ok) return undefined;
  const classified = turnPipeline.callbacks.classify(validated.value);
  if (!classified.ok) return undefined;
  const command =
    blocked.args && typeof blocked.args.command === 'string' ? blocked.args.command : undefined;
  const governanceInput = Object.freeze({
    classified: classified.value,
    workspace: state.session.workspace,
    threadId: state.session.threadId,
    context: Object.freeze({
      phase: getAgentPhase(getActivePlanning(state)),
      interactionMode: effectiveSubagentInteractionMode(state, input.parentToolCallId),
      authorizationMode: state.authorization.mode,
      ...(state.authorization.modeSource
        ? { authorizationSource: state.authorization.modeSource }
        : {}),
      sandboxAvailable: false,
      circuitBreakerTripped: state.autoReview.circuitBreakerTripped,
      observedAt: 0,
      autoReview: false,
      loopMode: false,
      gates: Object.freeze({
        recoveryAdmission: 'admitted' as const,
        boundedCancellation: 'admitted' as const,
        executionBoundary: 'admitted' as const,
        skillCapabilityCeiling: 'admitted' as const,
      }),
    }),
    approval: Object.freeze({
      status: 'queued' as const,
      grant: 'none' as const,
      approvedToolCallId: null,
      approvalBindingDigest: null,
    }),
    ...(command
      ? { sameCommandGrant: Object.freeze({ authorization: state.authorization, command }) }
      : {}),
  });
  const facts = turnPipeline.governance.project(
    governanceInput,
    Object.freeze({
      freshness: 'current' as const,
      reservationRequired: false,
      reservationIds: Object.freeze([]),
    }),
  );
  if (!facts.ok) return undefined;
  const authorization = turnPipeline.governance.authorize(governanceInput);
  if (!authorization.ok) return undefined;
  const reviewTerminal =
    authorization.value.kind === 'request_approval' ||
    authorization.value.kind === 'request_auto_review'
      ? authorization.value
      : undefined;
  if (authorization.value.kind !== 'authorized' && !reviewTerminal) {
    return undefined;
  }
  const approvalBindingDigest = runtimeHostStateCreateApprovalBindingDigest(
    facts.value.invocation,
    facts.value.policy,
  );
  const derivedApprovalBinding: AppApprovalBinding = Object.freeze({
    schema: 'kite.app-approval-binding.v1',
    digest: approvalBindingDigest,
    invocationFact: facts.value.invocation,
    policyFact: facts.value.policy,
    childToolCallId: blocked.toolCallId,
    ...(blocked.runtimeToolCallId ? { runtimeToolCallId: blocked.runtimeToolCallId } : {}),
  });
  if (
    approvalBinding &&
    (approvalBinding.digest !== derivedApprovalBinding.digest ||
      digestCapabilityValue(approvalBinding.invocationFact) !==
        digestCapabilityValue(derivedApprovalBinding.invocationFact) ||
      digestCapabilityValue(approvalBinding.policyFact) !==
        digestCapabilityValue(derivedApprovalBinding.policyFact))
  ) {
    return undefined;
  }
  const autoReviewFallback =
    blocked.reasonCode === 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW' &&
    effectiveSubagentInteractionMode(state, input.parentToolCallId) === 'auto' &&
    !state.autoReview.circuitBreakerTripped;
  return {
    request: pendingToolRequestFromValidatedInvocation(validated.value, turnPipeline.projection),
    decision: reviewTerminal?.decision ?? facts.value.policy,
    approvalBindingDigest: derivedApprovalBinding.digest,
    approvalBinding: approvalBinding ?? derivedApprovalBinding,
    route: reviewTerminal
      ? reviewTerminal.kind === 'request_auto_review'
        ? 'auto_review'
        : 'user'
      : autoReviewFallback
        ? 'auto_review'
        : 'user',
  };
}

/** Test fixture builder; facts and digest come directly from Kernel stages. */
export function createKernelApprovalBindingForBlockedSubagent(input: {
  state: RuntimeState;
  parentToolCallId: string;
  blocked: NonNullable<import('#app/bootstrap/runtime/subagent/types').SubAgentResult['blocked']>;
  availCtx: AppToolTurnContext;
  toolPipelineComposition: AppToolPipelineComposition;
  descriptors?: readonly Readonly<CapabilityDescriptor>[];
}): AppApprovalBinding | undefined {
  return exactBlockedSubagentPolicy({ ...input, allowMissingBinding: true })?.approvalBinding;
}

export class AppToolPipelinePersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppToolPipelinePersistenceError';
  }
}

type AppRuntimeToolExecutionInput = Parameters<typeof executeAppRuntimeTools>[0];

/**
 * Single App-owned child Tool dispatcher shared by Skill forks and legacy
 * `builtin:task`. It recursively re-enters the App runtime and never
 * selects a second Host, registry, or fallback dispatcher.
 */
export function createAppSharedChildToolDispatcher(input: {
  readonly params: AppRuntimeToolExecutionInput;
  readonly parentToolCallId: string;
  readonly parentTaskId?: string;
}): SubAgentToolDispatcher {
  const { params, parentToolCallId, parentTaskId } = input;
  return {
    dispatch: async (childInput) => {
      const runtimeToolCallId = childRuntimeToolCallId({
        parentToolCallId,
        subagentId: childInput.subagentId,
        modelInvocationId: childInput.modelInvocationId,
        modelToolCallId: childInput.modelToolCallId,
        toolName: childInput.request.name,
        args: childInput.request.args,
      });
      const failClosed = (message: string): ToolExecutionResult => ({
        ok: false,
        command: childInput.request.protectedCommand,
        exitCode: -1,
        stdout: '',
        stderr: message,
        status: 'error',
        classifierAdvice: {
          detailCode: 'persistence_unavailable',
          disposition: 'never',
          maximumAdditionalCalls: 0,
          requiresNewModelResponse: false,
          safeAutomaticRetry: false,
        },
      });
      const beforeQueue = params.getRuntimeState?.();
      if (!beforeQueue || !params.persistRuntimeEvents) {
        return {
          runtimeToolCallId,
          result: failClosed('Runtime persistence is unavailable for child tool dispatch.'),
        };
      }
      const getChildRuntimeState = params.getRuntimeState;
      const persistChildRuntimeEvents = params.persistRuntimeEvents;
      if (!getChildRuntimeState || !persistChildRuntimeEvents) {
        return {
          runtimeToolCallId,
          result: failClosed('Runtime persistence is unavailable for child tool dispatch.'),
        };
      }
      if (childInput.binding) {
        const durableBinding = beforeQueue.capabilities.bindings[childInput.binding.bindingId];
        if (
          !durableBinding ||
          digestCapabilityValue(durableBinding) !== digestCapabilityValue(childInput.binding)
        ) {
          return {
            runtimeToolCallId,
            result: failClosed(
              'Child MCP binding was not durably acknowledged before model tool dispatch.',
            ),
          };
        }
      }
      const existing = beforeQueue.tools.calls[runtimeToolCallId];
      let executionState: Readonly<RuntimeState>;
      if (existing) {
        const sameCall =
          existing.name === childInput.request.name &&
          digestCapabilityValue(existing.args) === digestCapabilityValue(childInput.request.args);
        if (!sameCall || existing.status !== 'approved') {
          return {
            runtimeToolCallId,
            result: failClosed(
              sameCall
                ? 'A child Runtime tool identity was already consumed.'
                : 'A child Runtime tool identity collided with different arguments.',
            ),
          };
        }
        executionState = beforeQueue;
      } else {
        const queued = await persistChildRuntimeEvents([
          {
            type: 'tool.queued',
            toolCallId: runtimeToolCallId,
            modelInvocationId: childInput.modelInvocationId,
            ...(parentTaskId ? { taskId: parentTaskId } : {}),
            name: childInput.request.name,
            args: childInput.request.args,
            modelMessageId: childInput.modelInvocationId,
            ordinal: 0,
            ...(childInput.binding
              ? {
                  bindingId: childInput.binding.bindingId,
                  capabilityId: childInput.binding.capabilityId,
                  capabilityRevision: childInput.binding.capabilityRevision,
                }
              : {}),
          },
        ]);
        const queuedState = getChildRuntimeState();
        if (!queued || queuedState.tools.calls[runtimeToolCallId]?.status !== 'queued') {
          return {
            runtimeToolCallId,
            result: failClosed('Child tool queue acknowledgement became stale.'),
          };
        }
        executionState = queuedState;
      }

      let committedOrdinaryResult: ToolExecutionResult | undefined;
      const childEvents = await executeAppRuntimeTools({
        ...params,
        state: executionState as RuntimeState,
        toolCallIds: [runtimeToolCallId],
        interactionModeOverride: effectiveSubagentInteractionMode(
          beforeQueue,
          parentToolCallId,
          params.subagentAutoReviewBatch === true,
        ),
        signal: childInput.signal,
        emitRuntimeEvent: undefined,
        emitTerminalEventBatch: undefined,
        toolActorIds: {
          ...(params.toolActorIds ?? {}),
          [runtimeToolCallId]: childInput.subagentId,
        },
        beforeAdmissionByToolCallId: {
          ...(params.beforeAdmissionByToolCallId ?? {}),
          ...(childInput.beforeAdmission
            ? { [runtimeToolCallId]: childInput.beforeAdmission }
            : {}),
        },
        beforeDispatchByToolCallId: {
          ...(params.beforeDispatchByToolCallId ?? {}),
          ...(childInput.beforeDispatch ? { [runtimeToolCallId]: childInput.beforeDispatch } : {}),
        },
        afterDispatchByToolCallId: {
          ...(params.afterDispatchByToolCallId ?? {}),
          [runtimeToolCallId]: async (settlement) => {
            await childInput.afterDispatch?.(settlement);
            if (
              settlement.dispatchState === 'started' &&
              settlement.error === undefined &&
              settlement.result
            ) {
              committedOrdinaryResult = settlement.result;
            }
          },
        },
      });
      const approval = childEvents.find(
        (event) => event.type === 'approval.requested' || event.type === 'auto_review.requested',
      );
      if (approval) {
        const approvalBinding = appApprovalBindingForPresentation(approval.approval);
        if (!approvalBinding) {
          return {
            runtimeToolCallId,
            result: failClosed('Child approval is missing its Kernel governance facts.'),
          };
        }
        const childApprovalBinding: AppApprovalBinding = Object.freeze({
          ...approvalBinding,
          childToolCallId: childInput.modelToolCallId,
          runtimeToolCallId,
        });
        return {
          runtimeToolCallId,
          result: {
            ok: false,
            command: childInput.request.protectedCommand,
            exitCode: -1,
            stdout: '',
            stderr: `${childInput.request.name} requires approval but was not approved.`,
            status: 'rejected',
            approvalRoute: approval.type === 'auto_review.requested' ? 'auto_review' : 'user',
            approvalBinding: childApprovalBinding,
          },
        };
      }
      if (committedOrdinaryResult && childEvents.length === 0) {
        const committedState = getChildRuntimeState();
        const committedCall = committedState.tools.calls[runtimeToolCallId];
        const committedInvocation = Object.values(committedState.capabilities.invocations).find(
          (invocation) => invocation.toolCallId === runtimeToolCallId,
        );
        const invocationStatusMatches = committedOrdinaryResult.ok
          ? committedInvocation?.status === 'succeeded'
          : committedInvocation?.status === 'failed';
        if (
          invocationStatusMatches &&
          committedCall &&
          ['succeeded', 'failed', 'exhausted'].includes(committedCall.status)
        ) {
          return { runtimeToolCallId, result: committedOrdinaryResult };
        }
        throw new AppToolPipelinePersistenceError(
          'Child ordinary Tool Pipeline result lacks its exact durable terminal acknowledgement.',
        );
      }
      if (childEvents.length === 0 || !(await persistChildRuntimeEvents(childEvents))) {
        return {
          runtimeToolCallId,
          result: failClosed('Child tool terminal receipt could not be durably persisted.'),
        };
      }
      if (childEvents.some((event) => event.type === 'capability.execution_unknown')) {
        throw new AppToolPipelinePersistenceError(
          'Child tool effect is unknown after its acknowledged dispatch attempt.',
        );
      }
      const acknowledged = getChildRuntimeState().tools.calls[runtimeToolCallId];
      const finished = childEvents.find(
        (event): event is Extract<RuntimeEvent, { type: 'tool.finished' }> =>
          event.type === 'tool.finished' && event.toolCallId === runtimeToolCallId,
      );
      if (
        finished &&
        acknowledged &&
        ['succeeded', 'failed', 'exhausted'].includes(acknowledged.status)
      ) {
        return {
          runtimeToolCallId,
          result: {
            ...finished.result,
            ...(typeof finished.result.resultMeta?.path === 'string'
              ? { path: finished.result.resultMeta.path }
              : {}),
            classifierAdvice: finished.classifierAdvice,
            classifierDiagnostic: finished.classifierDiagnostic,
          },
        };
      }
      const rejected = childEvents.find(
        (event): event is Extract<RuntimeEvent, { type: 'tool.rejected' }> =>
          event.type === 'tool.rejected' && event.toolCallId === runtimeToolCallId,
      );
      const failed = childEvents.find(
        (event): event is Extract<RuntimeEvent, { type: 'tool.failed' }> =>
          event.type === 'tool.failed' && event.toolCallId === runtimeToolCallId,
      );
      const reason = rejected?.reason ?? failed?.failure.message;
      if (
        reason &&
        acknowledged &&
        ['rejected', 'failed', 'exhausted'].includes(acknowledged.status)
      ) {
        return {
          runtimeToolCallId,
          result: {
            ok: false,
            command: childInput.request.protectedCommand,
            exitCode: -1,
            stdout: '',
            stderr: reason,
            status: rejected ? 'rejected' : 'error',
          },
        };
      }
      return {
        runtimeToolCallId,
        result: failClosed('Child tool terminal acknowledgement is incomplete.'),
      };
    },
  };
}

interface AppTaskResumeChildPreparation {
  readonly continuation: RestoredSubAgentContinuation;
  readonly toolResult: ToolExecutionResult;
  readonly mcpBindings: readonly {
    readonly binding: import('@kite/runtime-contract').CapabilityBinding;
    readonly descriptor: CapabilityDescriptor;
  }[];
}

/**
 * Validate and dispatch the one previously blocked child operation before a
 * resumed parent Task attempt is even prepared. This is deliberately a
 * child-only helper: it never claims the parent Host attempt or invokes the
 * subagent Provider.
 */
async function prepareAppTaskResumeChild(input: {
  readonly params: AppRuntimeToolExecutionInput;
  readonly state: RuntimeState;
  readonly toolCallId: string;
  readonly continuation: RestoredSubAgentContinuation;
  readonly availCtx: AppToolTurnContext;
  readonly toolPipelineComposition: AppToolPipelineComposition;
  readonly builtinToolCatalog: import('@kite/builtin-runtime').BuiltinToolCatalogProjection;
  readonly childToolDispatcher: SubAgentToolDispatcher;
  readonly signal: AbortSignal;
}): Promise<
  | { readonly ok: true; readonly value: AppTaskResumeChildPreparation }
  | { readonly ok: false; readonly events: RuntimeEvent[] }
> {
  const { params, continuation, toolCallId } = input;
  const state = params.getRuntimeState?.() ?? input.state;
  const recovery = normalizeToolRecoveryJournal(
    continuation.toolRecovery,
    state.toolRecovery.identityKey,
  );
  if (
    isToolRecoveryJournalInvalid(state.toolRecovery) ||
    isToolRecoveryJournalInvalid(recovery) ||
    recovery.identityKey !== state.toolRecovery.identityKey
  ) {
    return taskResumeRejectedEvents(
      toolCallId,
      'Sub-agent continuation recovery journal no longer matches the live runtime.',
    );
  }

  const call = state.tools.calls[toolCallId];
  if (call?.status !== 'approved' || !call.approvalGrant) {
    return taskResumeRejectedEvents(
      toolCallId,
      'The approved parent Task call is no longer live before child resume.',
    );
  }

  const blocked = continuation.blockedTool;
  const runtimeToolCallId = blocked.runtimeToolCallId;
  const childCall = runtimeToolCallId ? state.tools.calls[runtimeToolCallId] : undefined;
  const childBinding = childCall?.bindingId
    ? state.capabilities.bindings[childCall.bindingId]
    : undefined;
  const expectedRuntimeToolCallId = childCall?.modelInvocationId
    ? childRuntimeToolCallId({
        parentToolCallId: toolCallId,
        subagentId: continuation.id,
        modelInvocationId: childCall.modelInvocationId,
        modelToolCallId: blocked.toolCallId,
        toolName: blocked.toolName,
        args: blocked.args,
      })
    : undefined;
  const bindingMatches = childCall?.bindingId
    ? Boolean(
        childBinding &&
          continuation.mcpBindingIds?.includes(childCall.bindingId) &&
          childCall.capabilityId === childBinding.capabilityId &&
          childCall.capabilityRevision === childBinding.capabilityRevision,
      )
    : !childCall?.capabilityId && !childCall?.capabilityRevision;
  const mcpBindings = (continuation.mcpBindingIds ?? []).flatMap((bindingId) => {
    const binding = state.capabilities.bindings[bindingId];
    const descriptor = binding
      ? params.mcpManager?.findCapability(binding.capabilityId)
      : undefined;
    return binding && descriptor?.revision === binding.capabilityRevision
      ? [{ binding, descriptor }]
      : [];
  });
  if (
    !runtimeToolCallId ||
    !childCall ||
    childCall.status !== 'queued' ||
    !childCall.modelInvocationId ||
    runtimeToolCallId !== expectedRuntimeToolCallId ||
    childCall.name !== blocked.toolName ||
    digestCapabilityValue(childCall.args) !== digestCapabilityValue(blocked.args) ||
    !bindingMatches ||
    mcpBindings.length !== (continuation.mcpBindingIds?.length ?? 0)
  ) {
    return taskResumeRejectedEvents(
      toolCallId,
      'Sub-agent child Runtime identity or its operation-bound approval is unavailable.',
    );
  }

  const resumeProjection = input.builtinToolCatalog.forTurn(
    createAppToolTurnContext({
      workspace: state.session.workspace,
      threadId: state.session.threadId,
      config: params.taskConfig,
      hasGitBroker: Boolean(params.gitBroker),
      hasTaskAdapter: true,
      toolSearchEnabled: params.taskConfig ? getFeatureFlags(params.taskConfig).toolSearch : false,
      skillCatalog: params.skillCatalog,
      activeSkillFrames: activeSkillFramesForCurrentWork(state).filter(
        (frame) => frame.contextMode === 'inline',
      ),
      phase: getAgentPhase(getActivePlanning(state)),
      interactionMode: effectiveSubagentInteractionMode(state, toolCallId),
      turnId: state.turn.turnId,
      activeTaskId: state.activeTaskId ?? undefined,
      toolCallId,
    }),
  );
  const blockedRequest = buildBlockedToolRequest(blocked, input.availCtx, resumeProjection);
  const blockedEntry =
    blockedRequest.source === 'builtin'
      ? modelBuiltinEntry(resumeProjection, blockedRequest.name)
      : undefined;
  const approvalDescriptors = [
    ...mcpBindings.map(({ descriptor }) => descriptor),
    ...(params.skillCatalog?.capabilities.descriptors ?? []),
  ];
  const exactApproval = exactBlockedSubagentPolicy({
    state,
    parentToolCallId: toolCallId,
    blocked: {
      ...blocked,
      message: `Sub-agent tool '${blocked.toolName}' requires approval.`,
      continuation,
    },
    availCtx: input.availCtx,
    toolPipelineComposition: input.toolPipelineComposition,
    descriptors: approvalDescriptors,
  });
  if (!exactApproval || call.approvalHash !== exactApproval.approvalBindingDigest) {
    return taskResumeRejectedEvents(
      toolCallId,
      'Sub-agent child approval binding no longer matches the exact blocked operation.',
    );
  }
  const roleDenial =
    blockedEntry?.executionMechanism === 'shell'
      ? rejectShellOutsideSubAgentRoleCeiling(
          continuation.role,
          String((blockedRequest.args as Record<string, unknown>).command ?? ''),
        )
      : undefined;
  let toolResult: ToolExecutionResult;
  if (roleDenial) {
    toolResult = roleDenial;
  } else {
    const dispatchState = params.getRuntimeState?.() ?? state;
    const dispatchCall = dispatchState.tools.calls[toolCallId];
    if (
      isToolRecoveryJournalInvalid(dispatchState.toolRecovery) ||
      dispatchState.toolRecovery.identityKey !== recovery.identityKey ||
      dispatchCall?.status !== 'approved'
    ) {
      return taskResumeRejectedEvents(
        toolCallId,
        'Sub-agent approval became stale before its blocked child could be dispatched.',
      );
    }
    const review = blockedSubagentReviewEvent({
      state: dispatchState,
      parentToolCallId: toolCallId,
      blocked: {
        ...blocked,
        message: `Sub-agent tool '${blocked.toolName}' requires approval.`,
        continuation,
      },
      availCtx: input.availCtx,
      toolPipelineComposition: input.toolPipelineComposition,
      descriptors: approvalDescriptors,
    });
    if (review.type !== 'approval.requested' && review.type !== 'auto_review.requested') {
      return taskResumeRejectedEvents(
        toolCallId,
        'Child approval policy did not produce an operation-bound review fact.',
      );
    }
    if (!params.persistRuntimeEvents || !params.getRuntimeState) {
      return taskResumeRejectedEvents(
        toolCallId,
        'Child approval persistence is unavailable before resume dispatch.',
      );
    }
    const interactionId = genInteractionId();
    const approvalAcknowledged = await params.persistRuntimeEvents([
      {
        type: 'approval.requested',
        interactionId,
        toolCallId: runtimeToolCallId,
        approval: review.approval,
      },
      {
        type: 'approval.granted',
        interactionId,
        toolCallId: runtimeToolCallId,
        grant: call.approvalGrant,
      },
    ]);
    if (
      !approvalAcknowledged ||
      params.getRuntimeState().tools.calls[runtimeToolCallId]?.status !== 'approved'
    ) {
      return taskResumeRejectedEvents(
        toolCallId,
        'Child operation-bound approval could not be durably acknowledged.',
      );
    }
    let childToolAdmissionAttempt = 0;
    const dispatched = await input.childToolDispatcher.dispatch({
      subagentId: continuation.id,
      modelInvocationId: childCall.modelInvocationId,
      modelToolCallId: blocked.toolCallId,
      request: blockedRequest,
      signal: input.signal,
      ...(params.descendantResourceAdmission
        ? {
            beforeAdmission: async () => {
              childToolAdmissionAttempt += 1;
              return params.descendantResourceAdmission!.reserveTool({
                invocationKey: `resume-tool:${continuation.toolCallCount}:${runtimeToolCallId}:attempt:${childToolAdmissionAttempt}`,
                toolKind: blocked.toolName,
                shell: blocked.toolName === 'shell_execute',
              });
            },
            afterDispatch: async ({
              reservationId,
              dispatchState,
              result: attemptResult,
              error,
            }) => {
              if (!reservationId) return;
              if (error) {
                if (dispatchState === 'not_started') {
                  await params.descendantResourceAdmission!.markLocalProviderAdmissionDenied(
                    reservationId,
                  );
                } else {
                  await params.descendantResourceAdmission!.markUnknown(reservationId);
                }
                return;
              }
              try {
                await params.descendantResourceAdmission!.reconcileTool({
                  reservationId,
                  artifactBytes:
                    (blocked.toolName === 'write_file' || blocked.toolName === 'edit_file') &&
                    attemptResult?.path
                      ? bestEffortRegularFileSize(attemptResult.path)
                      : 0,
                });
              } catch (settlementError) {
                await params.descendantResourceAdmission!.markUnknown(reservationId);
                throw settlementError;
              }
            },
          }
        : {}),
      ...(childBinding ? { binding: childBinding } : {}),
    });
    if (dispatched.runtimeToolCallId !== runtimeToolCallId) {
      return taskResumeRejectedEvents(
        toolCallId,
        'Resumed child tool identity no longer matches its approved Runtime fact.',
      );
    }
    toolResult = dispatched.result;
  }
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({ continuation, toolResult, mcpBindings: Object.freeze(mcpBindings) }),
  });
}

function taskResumeRejectedEvents(
  toolCallId: string,
  reason: string,
): { readonly ok: false; readonly events: RuntimeEvent[] } {
  return Object.freeze({
    ok: false as const,
    events: [
      {
        type: 'tool.rejected' as const,
        toolCallId,
        reason,
        failure: classifyFailure('persistence_unavailable', reason),
      },
    ],
  });
}

/**
 * App composition for the dedicated private Task route.  The route shares
 * the effect-scoped Host coordinator through taskRuntime; no Core dispatcher,
 * direct executor, or fallback is reachable from this function.
 */
export async function executeAppTaskToolPipeline(input: {
  readonly params: AppRuntimeToolExecutionInput;
  readonly taskRuntime: AppTaskToolPipelineAttemptRuntime;
  readonly toolCallId: string;
  readonly call: NonNullable<RuntimeState['tools']['calls'][string]>;
  readonly privateTask: PrivateSubagentTask;
}): Promise<RuntimeEvent[]> {
  const { params, taskRuntime, toolCallId, privateTask } = input;
  const capabilityExecution = params.capabilityExecution;
  const builtinToolCatalog = params.builtinToolCatalog;
  const currentState = (params.getRuntimeState?.() ?? params.state) as RuntimeState;
  if (
    !capabilityExecution ||
    !builtinToolCatalog ||
    !params.taskConfig ||
    !params.taskModel ||
    !params.modelEffectCoordinator ||
    !params.modelInvocationPersistence ||
    !params.subagentRuntimeFactory ||
    !params.getRuntimeState ||
    !params.persistRuntimeEvents ||
    !params.capabilityArtifactStore
  ) {
    return [
      {
        type: 'tool.failed',
        toolCallId,
        failure: classifyFailure(
          'persistence_unavailable',
          'Private Task Tool Pipeline composition is unavailable.',
        ),
      },
    ];
  }

  const makeState = () => (params.getRuntimeState?.() ?? currentState) as RuntimeState;
  let state = makeState();
  let call = state.tools.calls[toolCallId] ?? input.call;
  let taskChildToolDispatcher = createAppSharedChildToolDispatcher({
    params,
    parentToolCallId: toolCallId,
    ...(call.taskId ? { parentTaskId: call.taskId } : {}),
  });
  let productionFlags = getFeatureFlags(params.taskConfig);
  let turnContext = createAppToolTurnContext({
    workspace: state.session.workspace,
    threadId: state.session.threadId,
    config: params.taskConfig,
    hasGitBroker: Boolean(params.gitBroker),
    hasTaskAdapter: true,
    toolSearchEnabled: productionFlags.toolSearch === true,
    skillCatalog: params.skillCatalog,
    activeSkillFrames: activeSkillFramesForCurrentWork(state).filter(
      (frame) => frame.contextMode === 'inline',
    ),
    phase: getAgentPhase(getActivePlanning(state)),
    interactionMode: getEffectiveInteractionMode(state),
    turnId: state.turn.turnId,
    activeTaskId: state.activeTaskId ?? undefined,
    modelMessageId: call.modelMessageId,
    toolCallId,
  });
  let turn = params.toolPipelineComposition.forTurn(turnContext);
  let snapshotResult = createRuntimeHostToolCallSnapshot({
    toolCallId,
    name: 'task',
    rawArguments: call.args,
    argumentOrigin: 'runtime_private',
    createdAtTurnId: call.createdAtTurnId,
    modelMessageId: call.modelMessageId,
    bindingId: null,
    capabilityId: null,
    capabilityRevision: null,
  });
  if (!snapshotResult.ok) {
    return [
      {
        type: 'tool.failed',
        toolCallId,
        failure: classifyFailure('tool_invalid_args', snapshotResult.failure.code),
      },
    ];
  }
  let mcpSnapshot = params.mcpManager?.getCapabilitySnapshot();
  let skillSnapshot = params.skillCatalog?.capabilities;
  let descriptors = Object.freeze([
    ...(mcpSnapshot?.descriptors ?? []),
    ...(skillSnapshot?.descriptors ?? []),
  ]);
  let planning = getActivePlanning(state);
  let planId = 'document' in planning ? (planning.document?.planId ?? null) : null;
  let budget = state.resourceBudget;
  let reservationIds = Object.freeze(
    budget.status === 'active'
      ? Object.values(budget.reservations)
          .filter((reservation) => reservation.invocationId.startsWith(`tool:${toolCallId}`))
          .map((reservation) => reservation.reservationId)
      : [],
  );
  let suspended = state.suspendedSubagents[toolCallId];
  const executionMode: 'start' | 'resume' =
    suspended && call.status === 'approved' ? 'resume' : 'start';
  let resumePreparation: AppTaskResumeChildPreparation | undefined;
  if (suspended && call.status === 'approved') {
    let continuation: RestoredSubAgentContinuation;
    try {
      continuation = deserializeSubagentContinuation(
        readPrivateSuspendedSubagent(
          suspended,
          toolCallId,
          state,
          params.subagentContinuationArtifacts,
        ),
        state.toolRecovery.identityKey,
      );
    } catch (error) {
      return taskResumeRejectedEvents(
        toolCallId,
        error instanceof Error ? error.message : 'Private continuation readback failed.',
      ).events;
    }
    const prepared = await prepareAppTaskResumeChild({
      params,
      state,
      toolCallId,
      continuation,
      availCtx: turnContext,
      toolPipelineComposition: params.toolPipelineComposition,
      builtinToolCatalog,
      childToolDispatcher: taskChildToolDispatcher,
      signal: params.signal ?? new AbortController().signal,
    });
    if (!prepared.ok) return prepared.events;
    resumePreparation = prepared.value;
  } else if (suspended && call.status === 'queued') {
    try {
      const continuation = deserializeSubagentContinuation(
        readPrivateSuspendedSubagent(
          suspended,
          toolCallId,
          state,
          params.subagentContinuationArtifacts,
        ),
        state.toolRecovery.identityKey,
      );
      const review = blockedSubagentReviewEvent({
        state,
        parentToolCallId: toolCallId,
        blocked: {
          ...continuation.blockedTool,
          message: `Sub-agent tool '${continuation.blockedTool.toolName}' requires approval.`,
          continuation,
        },
        availCtx: turnContext,
        toolPipelineComposition: params.toolPipelineComposition,
        descriptors,
      });
      return [review];
    } catch (error) {
      return taskResumeRejectedEvents(
        toolCallId,
        error instanceof Error ? error.message : 'Private continuation readback failed.',
      ).events;
    }
  } else if (suspended) {
    return [];
  }

  // Child dispatch and its State receipt may yield to the event loop. A
  // resumed parent attempt must therefore be rebuilt from the live state;
  // carrying the pre-child turn, invocation count, or governance facts would
  // either replay a stale attempt or admit the wrong parent identity.
  if (executionMode === 'resume') {
    state = makeState();
    call = state.tools.calls[toolCallId] ?? call;
    suspended = state.suspendedSubagents[toolCallId];
    if (call.status !== 'approved' || !suspended) {
      return taskResumeRejectedEvents(
        toolCallId,
        'The approved parent Task continuation changed before its live resume attempt.',
      ).events;
    }
    taskChildToolDispatcher = createAppSharedChildToolDispatcher({
      params,
      parentToolCallId: toolCallId,
      ...(call.taskId ? { parentTaskId: call.taskId } : {}),
    });
    productionFlags = getFeatureFlags(params.taskConfig);
    turnContext = createAppToolTurnContext({
      workspace: state.session.workspace,
      threadId: state.session.threadId,
      config: params.taskConfig,
      hasGitBroker: Boolean(params.gitBroker),
      hasTaskAdapter: true,
      toolSearchEnabled: productionFlags.toolSearch === true,
      skillCatalog: params.skillCatalog,
      activeSkillFrames: activeSkillFramesForCurrentWork(state).filter(
        (frame) => frame.contextMode === 'inline',
      ),
      phase: getAgentPhase(getActivePlanning(state)),
      interactionMode: getEffectiveInteractionMode(state),
      turnId: state.turn.turnId,
      activeTaskId: state.activeTaskId ?? undefined,
      modelMessageId: call.modelMessageId,
      toolCallId,
    });
    turn = params.toolPipelineComposition.forTurn(turnContext);
    snapshotResult = createRuntimeHostToolCallSnapshot({
      toolCallId,
      name: 'task',
      rawArguments: call.args,
      argumentOrigin: 'runtime_private',
      createdAtTurnId: call.createdAtTurnId,
      modelMessageId: call.modelMessageId,
      bindingId: null,
      capabilityId: null,
      capabilityRevision: null,
    });
    if (!snapshotResult.ok) {
      return [
        {
          type: 'tool.failed',
          toolCallId,
          failure: classifyFailure('tool_invalid_args', snapshotResult.failure.code),
        },
      ];
    }
    mcpSnapshot = params.mcpManager?.getCapabilitySnapshot();
    skillSnapshot = params.skillCatalog?.capabilities;
    descriptors = Object.freeze([
      ...(mcpSnapshot?.descriptors ?? []),
      ...(skillSnapshot?.descriptors ?? []),
    ]);
    planning = getActivePlanning(state);
    planId = 'document' in planning ? (planning.document?.planId ?? null) : null;
    budget = state.resourceBudget;
    reservationIds = Object.freeze(
      budget.status === 'active'
        ? Object.values(budget.reservations)
            .filter((reservation) => reservation.invocationId.startsWith(`tool:${toolCallId}`))
            .map((reservation) => reservation.reservationId)
        : [],
    );
  }

  const resumedParent = executionMode === 'resume' ? suspended : undefined;
  if (
    executionMode === 'resume' &&
    (!resumedParent ||
      !state.capabilities.invocations[resumedParent.parentInvocationId] ||
      state.capabilities.invocations[resumedParent.parentInvocationId]?.toolCallId !== toolCallId ||
      state.capabilities.invocations[resumedParent.parentInvocationId]?.attemptsStarted !==
        resumedParent.parentAttempt)
  ) {
    return taskResumeRejectedEvents(
      toolCallId,
      'The suspended parent invocation is no longer the exact live State attempt.',
    ).events;
  }
  const existingInvocation =
    executionMode === 'resume' && resumedParent
      ? state.capabilities.invocations[resumedParent.parentInvocationId]
      : Object.values(state.capabilities.invocations).find(
          (invocation) => invocation.toolCallId === toolCallId,
        );
  const expectedAttempt =
    executionMode === 'resume' && resumedParent
      ? resumedParent.parentAttempt + 1
      : (existingInvocation?.attemptsStarted ?? 0) + 1;
  const governance = Object.freeze({
    workspace: state.session.workspace,
    threadId: state.session.threadId,
    context: Object.freeze({
      phase: getAgentPhase(planning),
      interactionMode: getEffectiveInteractionMode(state),
      authorizationMode: state.authorization.mode,
      ...(state.authorization.modeSource
        ? { authorizationSource: state.authorization.modeSource }
        : {}),
      sandboxAvailable: params.sandboxAvailable === true,
      circuitBreakerTripped: state.autoReview.circuitBreakerTripped,
      observedAt: params.authorizationObservedAt ?? 0,
      autoReview: params.authorizationFromAutoReview === true,
      loopMode: params.authorizationFromLoopMode === true,
      gates: Object.freeze({
        recoveryAdmission:
          !call.recoveryAdmission || call.recoveryAdmission === 'admitted'
            ? ('admitted' as const)
            : ('blocked' as const),
        boundedCancellation: 'admitted' as const,
        executionBoundary: 'admitted' as const,
        skillCapabilityCeiling: 'admitted' as const,
      }),
    }),
    approval:
      executionMode === 'resume'
        ? Object.freeze({
            status: 'queued' as const,
            grant: 'none' as const,
            approvedToolCallId: null,
            approvalBindingDigest: null,
          })
        : Object.freeze({
            status: call.status === 'approved' ? ('approved' as const) : ('queued' as const),
            grant: call.approvalGrant ?? 'none',
            approvedToolCallId: call.status === 'approved' ? toolCallId : null,
            approvalBindingDigest: call.status === 'approved' ? (call.approvalHash ?? null) : null,
          }),
  });
  const taskInput = (prepared: Readonly<PreparedToolInvocation>): TaskToolDeps => {
    const identity = prepared.identity;
    if (
      identity.operationId !== 'builtin:task' ||
      identity.executionMechanism !== 'subagent' ||
      identity.executionFamily !== 'subagent' ||
      identity.argumentOrigin !== 'runtime_private' ||
      identity.attemptId !== `${identity.invocationId}:attempt:${expectedAttempt}` ||
      (executionMode === 'resume' &&
        (!resumedParent || identity.invocationId !== resumedParent.parentInvocationId)) ||
      identity.authorizationDigest === null ||
      identity.admissionDigest === null
    ) {
      throw new Error('Prepared Task identity is not exact.');
    }
    const mcpBindings =
      resumePreparation?.mcpBindings ??
      Object.values(makeState().capabilities.bindings).flatMap((binding) => {
        const descriptor = params.mcpManager?.findCapability(binding.capabilityId);
        return descriptor && descriptor.revision === binding.capabilityRevision
          ? [{ binding, descriptor }]
          : [];
      });
    return {
      builtinToolCatalog,
      config: params.taskConfig!,
      workspace: makeState().session.workspace,
      shellExecutor: params.shellExecutor,
      gitBroker: params.gitBroker,
      mcpManager: params.mcpManager,
      skills: params.skillManifests,
      skillOptions: params.skillOptions,
      mcpBindings: [...mcpBindings],
      authorization: makeState().authorization,
      workspaceAccess: makeState().workspaceAccess,
      phase: getAgentPhase(getActivePlanning(makeState())),
      interactionMode: effectiveSubagentInteractionMode(
        makeState(),
        toolCallId,
        params.subagentAutoReviewBatch === true,
        privateTask.payload.subagent_type,
      ),
      projectInstructions: visibleProjectInstructions(makeState(), call.modelMessageId),
      threadId: makeState().session.threadId,
      recoveryIdentityKey: makeState().toolRecovery.identityKey,
      eventSink: emitSubagentEventForTask(params),
      signal: params.signal,
      model: params.taskModel,
      descendantResourceAdmission: params.descendantResourceAdmission,
      modelEffectCoordinator: params.modelEffectCoordinator,
      modelInvocationPersistence: params.modelInvocationPersistence,
      subagentLifecyclePersistence: {
        getState: params.getRuntimeState!,
        persistEvents: params.persistRuntimeEvents!,
      },
      modelInvocationParentId: call.modelInvocationId,
      modelInvocationParentToolCallId: toolCallId,
      modelInvocationParentReservationId: params.modelInvocationParentReservationId,
      subagentInvocationIdentity: {
        invocationId: identity.invocationId,
        attempt: expectedAttempt,
        capabilityRevision: identity.capabilityRevision,
        authorizationDigest: identity.authorizationDigest,
        admissionDigest: identity.admissionDigest,
        effectiveEffectsDigest: identity.effectiveEffectsDigest,
      },
      toolDispatcher: taskChildToolDispatcher,
      maxDepth: 0,
      recordFilePreimage: params.recordFilePreimage,
    };
  };
  let capturedSubagentResult: Readonly<SubAgentResult> | undefined;
  let taskExecutionCaptured = false;
  const executeTask = async ({
    executionMode: mode,
    prepared,
  }: {
    readonly executionMode: 'start' | 'resume';
    readonly prepared: Readonly<PreparedToolInvocation>;
    readonly arguments: Readonly<RuntimeJsonValue>;
    readonly signal: AbortSignal;
  }): Promise<Readonly<Record<string, unknown>>> => {
    if (taskExecutionCaptured) {
      throw new Error('Builtin Task execution was requested more than once for one attempt.');
    }
    taskExecutionCaptured = true;
    const runtime = params.subagentRuntimeFactory!();
    if (!runtime) throw new Error('Subagent Runtime factory returned no runtime.');
    const deps = taskInput(prepared);
    if (mode === 'resume') {
      const resume = resumePreparation;
      if (!resume) throw new Error('Task resume child preparation is unavailable.');
      const result = await runtime.resume(deps, resume.continuation, {
        toolCallId: resume.continuation.blockedTool.toolCallId,
        toolName: resume.continuation.blockedTool.toolName,
        result: resume.toolResult,
      });
      capturedSubagentResult = result;
      return taskResultForBuiltinProjection(result);
    }
    const result = await runtime.start(deps, privateTask.payload);
    capturedSubagentResult = result;
    return taskResultForBuiltinProjection(result);
  };
  const projectSuspension = ({
    executionMode: mode,
    prepared,
    terminal,
  }: Parameters<
    AppTaskAttemptInput['projectSuspension']
  >[0]): Readonly<ToolPipelineTaskSubagentSuspension> | null => {
    const captured = capturedSubagentResult;
    if (!captured?.blocked || !isExactTaskBlockedTerminalProjection(terminal, captured)) {
      return null;
    }
    // The terminal is a neutral JSON-safe projection. Use the exact typed
    // result captured at the Builtin execution seam for continuation bytes and
    // review facts; never cast projected continuation data back into a live
    // SubAgentResult.
    const blockedValue = captured.blocked;
    const live = makeState();
    const review = blockedSubagentReviewEvent({
      state: live,
      parentToolCallId: toolCallId,
      blocked: blockedValue,
      availCtx: turnContext,
      toolPipelineComposition: params.toolPipelineComposition,
      descriptors,
    });
    if (review.type !== 'approval.requested' && review.type !== 'auto_review.requested') {
      return null;
    }
    const subagent = privateSuspendedSubagentRecord({
      artifacts: params.subagentContinuationArtifacts,
      parentInvocationId: prepared.identity.invocationId,
      parentAttempt: expectedAttempt,
      parentToolCallId: toolCallId,
      blocked: blockedValue,
    });
    const suspension = Object.freeze({
      schema: 'kite.tool-pipeline-stage.v1' as const,
      kind: 'task_subagent' as const,
      operationId: 'builtin:task' as const,
      executionMode: mode,
      toolCallId,
      parent: Object.freeze({
        toolCallId,
        invocationId: prepared.identity.invocationId,
        attemptId: prepared.identity.attemptId,
        attempt: expectedAttempt,
      }),
      subagent,
      blockedTool: Object.freeze({
        toolCallId: blockedValue.toolCallId,
        runtimeToolCallId: blockedValue.runtimeToolCallId ?? null,
        toolName: blockedValue.toolName,
        argumentsDigest: digestCapabilityValue(blockedValue.args),
        commandDigest:
          blockedValue.command.trim().length > 0
            ? digestCapabilityValue(blockedValue.command.trim())
            : null,
      }),
      event: review,
    });
    return suspension;
  };
  const phase = getAgentPhase(planning) === 'planning' ? 'planning' : 'building';
  let result: Awaited<ReturnType<typeof taskRuntime.execute>>;
  result = await taskRuntime.execute({
    turn,
    snapshot: snapshotResult.value,
    resolution: Object.freeze({
      currentTurnId: state.turn.turnId,
      builtinProjectionRevision: turn.projection.revision,
      dynamicCatalogRevision: null,
      availabilityContext: turnContext,
      bindings: Object.freeze([...Object.values(state.capabilities.bindings)]),
      descriptors,
      disclosures: Object.freeze([...Object.values(state.capabilities.disclosures)]),
    }),
    governance,
    admission: Object.freeze({
      freshness: 'current' as const,
      reservationRequired: budget.status === 'active',
      reservationIds,
    }),
    threadId: state.session.threadId,
    attempt: expectedAttempt,
    taskId: call.taskId ?? state.activeTaskId ?? null,
    planId,
    planStepId: null,
    capabilityRequestFacts: Object.freeze({ toolCallId }),
    capabilityExecution,
    signal: params.signal ?? new AbortController().signal,
    workspace: state.session.workspace,
    phase,
    executionMode,
    executeTask,
    projectSuspension,
  });
  if (result.kind === 'committed') {
    const resourceFailure = capturedSubagentResult?.resourceAdmissionFailure;
    if (resourceFailure) {
      // The exact child result has already crossed the Builtin projection and
      // the Host has durably committed the parent capability/tool receipt.
      // Only now may the App lift the known descendant admission denial into
      // the existing run-level terminal policy; throwing inside dispatch would
      // incorrectly turn this known outcome into post-ack unknown recovery.
      throw new DescendantResourceAdmissionError(resourceFailure.reason, resourceFailure.message);
    }
    return [];
  }
  if (result.kind === 'suspended') return [];
  if (result.kind === 'governance_terminal') {
    if (result.decision.kind === 'reject') {
      return [
        {
          type: 'tool.rejected',
          toolCallId,
          reason: result.decision.reason,
          failure: classifyFailure(result.decision.failureKind, result.decision.reason),
        },
      ];
    }
    if (result.decision.kind === 'request_user_input') {
      return [
        {
          type: 'tool.failed',
          toolCallId,
          failure: classifyFailure(
            'mandatory_policy_unavailable',
            'Task governance cannot become a user-input interrupt.',
          ),
        },
      ];
    }
    if (
      result.decision.kind === 'request_approval' ||
      result.decision.kind === 'request_auto_review'
    ) {
      const request = pendingToolRequestFromValidatedInvocation(
        result.classified.validated,
        turn.projection,
      );
      const approvalBindingDigest = runtimeHostStateCreateApprovalBindingDigest(
        result.facts.invocation,
        result.facts.policy,
      );
      const approval = buildToolApproval({
        workspace: state.session.workspace,
        threadId: state.session.threadId,
        request,
        decision: result.decision.decision,
        approvalBindingDigest,
      });
      bindAppApprovalBinding(approval, {
        digest: approvalBindingDigest,
        invocationFact: result.facts.invocation,
        policyFact: result.facts.policy,
      });
      return result.decision.kind === 'request_auto_review'
        ? [
            {
              type: 'auto_review.requested',
              reviewId: genInteractionId(),
              toolCallId,
              toolName: request.name,
              reason: result.decision.decision.reason,
              approval,
            },
          ]
        : [
            {
              type: 'approval.requested',
              interactionId: genInteractionId(),
              toolCallId,
              approval,
            },
          ];
    }
  }
  const diagnostic =
    result.kind === 'stage_failure'
      ? `Task Tool Pipeline ${result.failure.stage} failed: ${result.failure.code}.`
      : result.kind === 'governance_failure'
        ? result.diagnostic
        : 'Task Tool Pipeline failed closed.';
  return [
    {
      type: 'tool.failed',
      toolCallId,
      failure: classifyFailure(
        result.kind === 'stage_failure' && result.failure.stage === 'validate'
          ? 'tool_invalid_args'
          : 'mandatory_policy_unavailable',
        diagnostic,
      ),
    },
  ];
}

function emitSubagentEventForTask(params: AppRuntimeToolExecutionInput): SubAgentEventSink {
  return (event) => {
    params.subagentEventSink?.(event);
    params.emitRuntimeEvent?.(toRuntimeSubagentEvent(event, params.subagentConcurrencyGroupId));
  };
}

/**
 * Kernel-native tool effect.  It derives the execution request from the
 * persisted call record and returns facts only; it never creates a ToolMessage
 * or mutates a graph channel.
 */
