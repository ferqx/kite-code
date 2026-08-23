import { isAbsolute, resolve } from 'node:path';
import type {
  BuiltinModelToolCatalogEntryV1,
  BuiltinOperationExecutionValueV1,
  CapabilityArtifactWriterV1,
  SkillCatalogSnapshot,
  SkillManifest,
  SkillScanOptions,
} from '@kite/builtin-runtime';
import {
  createCapabilitySnapshotV1,
  digestCapabilityValueV1,
  type PendingToolRequest,
  pendingToolRequestFromValidatedInvocationV1,
  rejectShellOutsideSubAgentRoleCeilingV1,
  toolRequestFromCall,
} from '@kite/builtin-runtime';
import {
  capabilityChangedProviderError,
  exposedMcpToolName,
  isMcpProviderError,
  type McpProviderRecoveryAction,
  type McpRuntimeProvider,
  providerErrorFromDirectoryEntry,
} from '@kite/builtin-runtime/mcp';
import type { SupportedChatModel } from '@kite/builtin-runtime/model';
import {
  checkProjectInstructionSnapshotFreshnessV1,
  projectProjectInstructionGuardTargetV1,
  resolveProjectInstructionSnapshot,
} from '@kite/builtin-runtime/model';
import type { PlanArtifactStore } from '@kite/builtin-runtime/planning';
import type { NetworkDecisionRecorderV1, ShellExecutor } from '@kite/builtin-runtime/sandbox';
import {
  createProtectedPathEvaluatorV1,
  expandHomeRelativePath,
  isDescriptorAdmittedByExecutionCapabilitySurfaceV1,
  isPathInsideWorkspace,
  msys2ToWindowsPath,
  networkBoundaryPolicyFromExecutionBoundaryV1,
} from '@kite/builtin-runtime/sandbox';
import type { SubAgentEventSink } from '@kite/runtime-contract';
import { type CapabilityDescriptor, getAgentPhase } from '@kite/runtime-contract';
import {
  runtimeHostStateActiveSkillFramesV1 as activeSkillFramesForCurrentWork,
  bestEffortRegularFileSizeV1,
  createRuntimeHostToolCallSnapshotV1,
  DescendantResourceAdmissionError,
  createRuntimeHostInteractionIdV1 as genInteractionId,
  runtimeHostStateActivePlanningV1 as getActivePlanning,
  runtimeHostStateEffectiveInteractionModeV1 as getEffectiveInteractionMode,
  runtimeHostStateToolRecoveryJournalInvalidV1 as isToolRecoveryJournalInvalidV1,
  runtimeHostStateNormalizeToolRecoveryJournalV1 as normalizeToolRecoveryJournalV1,
  runtimeHostStateClassifyToolOutcomeV1,
  runtimeHostStateCreateApprovalBindingDigestV1,
  type StateToolGovernancePolicyFactV1,
  runtimeHostStateToolFailureInstanceIdV1 as toolFailureInstanceIdV1,
  runtimeHostStateToolInvocationFingerprintV1 as toolInvocationFingerprintV1,
} from '@kite/runtime-host';
import type { RuntimeHostFilePreimageRecorderV1 as FilePreimageRecorder } from '@kite/runtime-host/storage';
import {
  deserializeSubagentContinuation,
  serializeSubagentContinuation,
  subagentContinuationCursorIdV1,
} from '#app/bootstrap/runtime/subagent/continuation-codec';
import type {
  SubagentInvocationIdentityV1,
  SubagentInvocationRuntimeV1,
  TaskToolDeps,
} from '#app/bootstrap/runtime/subagent/task-tool';
import type {
  RestoredSubAgentContinuation,
  SubAgentResult,
  SubAgentToolDispatcherV1,
} from '#app/bootstrap/runtime/subagent/types';
import { getFeatureFlags } from '#app/config/features';
import {
  type AgentConfig,
  computeExecutionBoundaryDigestV1,
  ProviderDataAdmissionError,
} from '#app/config/index';
import { appPreparedShellExecutionPortV1 } from '#app/sandbox/prepared-tool-pipeline';
import {
  type BuiltinMcpRuntimePortV1,
  createCapabilityBindingV1,
  createToolSearchProviderFactsV1,
  isBuiltinSubagentTaskToolNameV1,
  normalizeAskUserRequestV1,
} from '#builtin-runtime';
import type {
  CapabilityExecutionPortV1,
  CapabilityToolTerminalResultV1,
  PreparedToolInvocationV1,
  RuntimeJsonValueV1,
  ToolPipelineTaskSubagentSuspensionV1,
} from '#runtime-spi';
import {
  type AppApprovalBindingV1,
  appApprovalBindingForPresentationV1,
  bindAppApprovalBindingV1,
  isAuthenticAppApprovalBindingV1,
} from './approval-binding';
import {
  classifyFailure,
  classifyMcpProviderError,
  failureKindForToolParseFailure,
} from './failures';
import { createAppMcpReadinessRuntimeV1 } from './mcp-readiness-runtime';
import { createPlanRuntimeV1 } from './plan-runtime';
import {
  type ProviderReadinessCoordinatorV1,
  ProviderReadinessPersistenceError,
  ProviderReadinessUnknownError,
} from './provider-readiness';
import type { RuntimeEvent, RuntimeState } from './state-runtime';
import type { AppToolPipelineCompositionV1 } from './tool-pipeline-composition';
import {
  type AppOrdinaryToolPipelineAttemptRuntimeV1,
  isAppOrdinaryToolPipelineOperationIdV1,
} from './tool-pipeline-ordinary-attempt';
import type { AppTaskToolPipelineAttemptRuntimeV1 } from './tool-pipeline-task-attempt';
import { buildToolApproval } from './tool-policy';
import {
  createRmv111SkillMechanismPortV1,
  createRmv111WebMechanismPortV1,
} from './tool-provider-services';
import type { ToolExecutionResult } from './tool-result';
import { type AppToolTurnContextV1, createAppToolTurnContextV1 } from './tool-turn-context';

type SubagentEvent = Parameters<SubAgentEventSink>[0];

type PrivateSubagentTaskV1 = {
  readonly source: 'private_artifact_v1';
  readonly requestArtifact: import('@kite/runtime-spi').SubagentTaskRequestArtifactV1;
  readonly payload: {
    readonly subagent_type: 'explore' | 'plan' | 'code' | 'review';
    readonly task: string;
  };
};

type AppTaskAttemptInputV1 = Parameters<AppTaskToolPipelineAttemptRuntimeV1['execute']>[0];

function modelBuiltinEntryV1(
  catalog: import('@kite/builtin-runtime').BuiltinToolCatalogProjectionV1,
  name: string,
): BuiltinModelToolCatalogEntryV1 | undefined {
  return catalog.entries.find(
    (entry): entry is BuiltinModelToolCatalogEntryV1 =>
      entry.visibility === 'model' && entry.name === name,
  );
}

function recoveryActionForFailure(
  failure: import('./failures').ClassifiedFailure,
): McpProviderRecoveryAction | undefined {
  if (failure.kind === 'provider_auth_required') return 'login';
  if (failure.kind === 'provider_approval_required') return 'approve';
  if (failure.kind === 'provider_unavailable' && failure.retryable) return 'retry';
  return undefined;
}

function providerActionRequiredEvent(input: {
  enabled: boolean;
  providerId: string;
  toolCallId: string;
  action?: McpProviderRecoveryAction;
}): RuntimeEvent | undefined {
  if (!input.enabled || !input.action) return undefined;
  return {
    type: 'provider.action_required',
    interactionId: genInteractionId(),
    providerId: input.providerId,
    action: input.action,
    originatingToolCallId: input.toolCallId,
  };
}

/**
 * Prepare the exact Dynamic MCP mechanism before the Host attempt is
 * acknowledged.  This keeps provider readiness and remote-egress receipts on
 * the pre-dispatch side of the one Host coordinator; the Builtin executor
 * receives only the resulting immutable mechanism facts.
 */
async function prepareDynamicMcpMechanismV1(input: {
  readonly descriptor: Readonly<CapabilityDescriptor>;
  readonly manager: McpRuntimeProvider;
  readonly flags: ReturnType<typeof getFeatureFlags>;
  readonly providerReadinessCoordinator?: ProviderReadinessCoordinatorV1;
  readonly getRuntimeState?: () => Readonly<RuntimeState>;
  readonly persistRuntimeEvent?: (event: RuntimeEvent) => Promise<boolean>;
  readonly taskConfig?: AgentConfig;
  readonly threadId: string;
  readonly toolCallId: string;
  readonly signal: AbortSignal;
  readonly workspace: string;
  readonly canonicalArguments: RuntimeJsonValueV1;
  readonly retryAuthorized?: boolean;
}) {
  if (!isPlainRecordV1(input.canonicalArguments)) {
    throw new Error('Dynamic MCP canonical arguments are not an object.');
  }
  const route = input.manager.getCapabilityRoute?.(input.descriptor.capabilityId);
  const readinessCoordinator = input.providerReadinessCoordinator;
  const getState = input.getRuntimeState;
  const persistEvent = input.persistRuntimeEvent;
  if (!readinessCoordinator || !getState || !persistEvent) {
    throw new ProviderReadinessPersistenceError(
      'Provider readiness coordinator and StateSessionStorageV1 acknowledgement are required.',
    );
  }
  const providerDirectoryRevision = input.manager.getProviderDirectorySnapshot().revision;
  const routeRevision =
    route?.endpointRevision ?? providerDirectoryRevision ?? 'provider-directory-unavailable';
  const executionBoundaryDigest = input.taskConfig?.executionBoundary
    ? computeExecutionBoundaryDigestV1(input.taskConfig.executionBoundary)
    : digestCapabilityValueV1({ schema: 'kite.unsealed-execution-boundary.v1' });
  await readinessCoordinator.ensureReady(
    {
      providerId: input.descriptor.provider.id,
      routeRevision,
      executionBoundaryDigest,
      toolCallId: input.toolCallId,
      retryAuthorized: input.retryAuthorized === true,
      signal: input.signal,
    },
    { getState, persistEvent },
  );
  const currentDescriptor = input.manager.findCapability(input.descriptor.capabilityId);
  if (!currentDescriptor || currentDescriptor.revision !== input.descriptor.revision) {
    throw capabilityChangedProviderError(input.descriptor.provider.id);
  }
  return Object.freeze({
    workspace: input.workspace,
    preassembledMechanism: Object.freeze({
      mcp: Object.freeze({
        runtime: input.manager as unknown as BuiltinMcpRuntimePortV1,
        invocation: Object.freeze({
          capabilityId: input.descriptor.capabilityId,
          expectedRevision: input.descriptor.revision,
        }),
      }),
    }),
  });
}

function isPlainRecordV1(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function forkToolCeiling(input: {
  capabilityCeiling: readonly string[];
  builtinToolCatalog: import('@kite/builtin-runtime').BuiltinToolCatalogProjectionV1;
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
      (entry): entry is BuiltinModelToolCatalogEntryV1 =>
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
    const binding = createCapabilityBindingV1({
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

function forkRole(agent: string): 'explore' | 'plan' | 'code' | 'review' {
  return agent === 'explore' || agent === 'plan' || agent === 'review' ? agent : 'code';
}

function childRuntimeToolCallIdV1(input: {
  parentToolCallId: string;
  subagentId: string;
  modelInvocationId: string;
  modelToolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}): string {
  return `subagent-tool:${digestCapabilityValueV1({
    schema: 'kite.subagent-runtime-tool-identity.v1',
    parentToolCallId: input.parentToolCallId,
    subagentId: input.subagentId,
    modelInvocationId: input.modelInvocationId,
    modelToolCallId: input.modelToolCallId,
    toolName: input.toolName,
    arguments: input.args,
  })}`;
}

function isCurrentExactChildToolReservationV1(
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
function taskResultForBuiltinProjectionV1(
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
function isExactTaskBlockedTerminalProjectionV1(
  terminal: Readonly<CapabilityToolTerminalResultV1<BuiltinOperationExecutionValueV1>>,
  captured: Readonly<SubAgentResult>,
): boolean {
  const structured = terminal.structuredContent;
  const projectedResult =
    structured && typeof structured === 'object' && !Array.isArray(structured)
      ? (structured as Record<string, unknown>).subagentResult
      : undefined;
  const projectedResultRecord = isRecordObjectV1(projectedResult) ? projectedResult : undefined;
  const projectedBlocked = projectedResultRecord?.blocked;
  const expectedBlocked = captured.blocked;
  if (!projectedResultRecord || !isRecordObjectV1(projectedBlocked) || !expectedBlocked) {
    return false;
  }
  if (
    projectedBlocked.reasonCode !== expectedBlocked.reasonCode ||
    projectedBlocked.toolCallId !== expectedBlocked.toolCallId ||
    (projectedBlocked.runtimeToolCallId ?? null) !== (expectedBlocked.runtimeToolCallId ?? null) ||
    projectedBlocked.toolName !== expectedBlocked.toolName ||
    !isRecordObjectV1(projectedBlocked.args) ||
    digestCapabilityValueV1(projectedBlocked.args) !==
      digestCapabilityValueV1(expectedBlocked.args) ||
    typeof projectedBlocked.command !== 'string' ||
    digestCapabilityValueV1(projectedBlocked.command.trim()) !==
      digestCapabilityValueV1(expectedBlocked.command.trim())
  ) {
    return false;
  }

  const projectedRecovery = projectedResultRecord.toolRecovery;
  if (
    !isRecordObjectV1(projectedRecovery) ||
    digestCapabilityValueV1(projectedRecovery) !==
      digestCapabilityValueV1(captured.toolRecovery ?? {})
  ) {
    return false;
  }

  const projectedContinuation = projectedBlocked.continuation;
  const expectedContinuation = expectedBlocked.continuation;
  if (!isRecordObjectV1(projectedContinuation) || !isRecordObjectV1(expectedContinuation)) {
    return false;
  }
  const projectedRole =
    typeof projectedContinuation.role === 'string'
      ? projectedContinuation.role
      : isRecordObjectV1(projectedContinuation.role) &&
          typeof projectedContinuation.role.role === 'string'
        ? projectedContinuation.role.role
        : undefined;
  if (
    projectedContinuation.id !== expectedContinuation.id ||
    projectedRole !== expectedContinuation.role.role ||
    (projectedContinuation.modelInvocationOrdinal ?? 0) !==
      (expectedContinuation.modelInvocationOrdinal ?? 0)
  ) {
    return false;
  }
  const projectedContinuationBlocked = projectedContinuation.blockedTool;
  return (
    isRecordObjectV1(projectedContinuationBlocked) &&
    projectedContinuationBlocked.toolCallId === expectedBlocked.toolCallId &&
    (projectedContinuationBlocked.runtimeToolCallId ?? null) ===
      (expectedBlocked.runtimeToolCallId ?? null) &&
    projectedContinuationBlocked.toolName === expectedBlocked.toolName
  );
}

function isRecordObjectV1(value: unknown): value is Readonly<Record<string, unknown>> {
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
  availCtx: AppToolTurnContextV1,
  builtinToolCatalog: import('@kite/builtin-runtime').BuiltinToolCatalogProjectionV1,
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

export function blockedSubagentReviewEvent(input: {
  state: RuntimeState;
  parentToolCallId: string;
  blocked: NonNullable<import('#app/bootstrap/runtime/subagent/types').SubAgentResult['blocked']>;
  availCtx: AppToolTurnContextV1;
  toolPipelineComposition: AppToolPipelineCompositionV1;
  descriptors?: readonly Readonly<CapabilityDescriptor>[];
}): RuntimeEvent {
  const { blocked, state } = input;
  const exact = exactBlockedSubagentPolicyV1(input);
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

  const effectiveMode = getEffectiveInteractionMode(state);
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
      requestFingerprint: toolInvocationFingerprintV1({
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

function exactBlockedSubagentPolicyV1(input: {
  state: RuntimeState;
  parentToolCallId: string;
  blocked: NonNullable<import('#app/bootstrap/runtime/subagent/types').SubAgentResult['blocked']>;
  availCtx: AppToolTurnContextV1;
  toolPipelineComposition: AppToolPipelineCompositionV1;
  descriptors?: readonly Readonly<CapabilityDescriptor>[];
  allowMissingBinding?: boolean;
}):
  | {
      readonly request: PendingToolRequest;
      readonly decision: Readonly<StateToolGovernancePolicyFactV1>;
      readonly approvalBindingDigest: string;
      readonly approvalBinding: AppApprovalBindingV1;
      readonly route: 'user' | 'auto_review';
    }
  | undefined {
  const { state, blocked } = input;
  const approvalBinding = blocked.approvalBinding;
  if (
    (!approvalBinding && input.allowMissingBinding !== true) ||
    (approvalBinding && !isAuthenticAppApprovalBindingV1({ binding: approvalBinding, blocked }))
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
        digestCapabilityValueV1(call.args) !== digestCapabilityValueV1(blocked.args)))
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
  const snapshot = createRuntimeHostToolCallSnapshotV1({
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
  const dynamicCatalogRevision = createCapabilitySnapshotV1([...descriptors]).revision;
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
      interactionMode: getEffectiveInteractionMode(state),
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
  const approvalBindingDigest = runtimeHostStateCreateApprovalBindingDigestV1(
    facts.value.invocation,
    facts.value.policy,
  );
  const derivedApprovalBinding: AppApprovalBindingV1 = Object.freeze({
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
      digestCapabilityValueV1(approvalBinding.invocationFact) !==
        digestCapabilityValueV1(derivedApprovalBinding.invocationFact) ||
      digestCapabilityValueV1(approvalBinding.policyFact) !==
        digestCapabilityValueV1(derivedApprovalBinding.policyFact))
  ) {
    return undefined;
  }
  const autoReviewFallback =
    blocked.reasonCode === 'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW' &&
    getEffectiveInteractionMode(state) === 'auto' &&
    !state.autoReview.circuitBreakerTripped;
  return {
    request: pendingToolRequestFromValidatedInvocationV1(validated.value, turnPipeline.projection),
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
export function createKernelApprovalBindingForBlockedSubagentV1(input: {
  state: RuntimeState;
  parentToolCallId: string;
  blocked: NonNullable<import('#app/bootstrap/runtime/subagent/types').SubAgentResult['blocked']>;
  availCtx: AppToolTurnContextV1;
  toolPipelineComposition: AppToolPipelineCompositionV1;
  descriptors?: readonly Readonly<CapabilityDescriptor>[];
}): AppApprovalBindingV1 | undefined {
  return exactBlockedSubagentPolicyV1({ ...input, allowMissingBinding: true })?.approvalBinding;
}

/** Convert the subagent runner's private callback payload into a durable public fact. */
export function toRuntimeSubagentEvent(
  event: SubagentEvent,
  concurrencyGroupId?: string,
): RuntimeEvent {
  switch (event.type) {
    case 'start':
      return {
        type: 'subagent.started',
        subagent: concurrencyGroupId == null ? event.data : { ...event.data, concurrencyGroupId },
      };
    case 'step':
      return { type: 'subagent.step', subagent: event.data };
    case 'tool_result':
      return { type: 'subagent.tool_result', subagent: event.data };
    case 'done':
      return { type: 'subagent.completed', subagent: event.data };
    case 'error':
      return { type: 'subagent.failed', subagent: event.data };
    case 'cache_metrics':
      return { type: 'subagent.cache_metrics', subagent: event.data };
  }
}

class AppToolPipelinePersistenceErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppToolPipelinePersistenceErrorV1';
  }
}

class SubagentContinuationPersistenceErrorV1 extends AppToolPipelinePersistenceErrorV1 {
  constructor(message: string) {
    super(message);
    this.name = 'SubagentContinuationPersistenceErrorV1';
  }
}

function privateSuspendedSubagentRecordV1(input: {
  artifacts?: import('#builtin-runtime').SubagentContinuationArtifactAccessV1;
  parentInvocationId: string;
  parentAttempt: number;
  parentToolCallId: string;
  blocked: NonNullable<import('#app/bootstrap/runtime/subagent/types').SubAgentResult['blocked']>;
}): import('@kite/runtime-spi').PrivateSuspendedSubagentRecordV1 {
  if (!input.artifacts) {
    throw new SubagentContinuationPersistenceErrorV1(
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
  const continuationId = subagentContinuationCursorIdV1(snapshot);
  let continuationArtifact: import('@kite/runtime-spi').SubagentContinuationArtifactRefV1;
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
    throw new SubagentContinuationPersistenceErrorV1(
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

export function readPrivateSuspendedSubagentV1(
  suspended: import('@kite/runtime-spi').DurableSuspendedSubagentV1,
  parentToolCallId: string,
  state: Readonly<RuntimeState>,
  artifacts?: import('#builtin-runtime').SubagentContinuationArtifactAccessV1,
): import('@kite/runtime-spi').SuspendedSubagentSnapshot {
  if (!artifacts) {
    throw new SubagentContinuationPersistenceErrorV1(
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
    throw new SubagentContinuationPersistenceErrorV1(
      'Private Subagent continuation has no exact live parent authority.',
    );
  }
  let snapshot: import('@kite/runtime-spi').SuspendedSubagentSnapshot;
  try {
    snapshot = artifacts.read(suspended.continuationArtifact, {
      parentInvocationId: parent.invocationId,
      parentAttempt: parent.attemptsStarted,
      parentToolCallId,
      childInvocationId: lifecycle.childInvocationId,
      continuationId: suspended.continuationId,
    });
  } catch {
    throw new SubagentContinuationPersistenceErrorV1(
      'Private Subagent continuation Artifact failed exact readback.',
    );
  }
  if (
    snapshot.subagentId !== suspended.subagentId ||
    snapshot.role !== suspended.role ||
    (snapshot.modelInvocationOrdinal ?? 0) !== suspended.modelInvocationOrdinal ||
    subagentContinuationCursorIdV1(snapshot) !== suspended.continuationId ||
    snapshot.blockedTool.reasonCode !== suspended.blockedTool.reasonCode ||
    snapshot.blockedTool.toolCallId !== suspended.blockedTool.toolCallId ||
    (snapshot.blockedTool.runtimeToolCallId ?? undefined) !==
      suspended.blockedTool.runtimeToolCallId ||
    snapshot.blockedTool.toolName !== suspended.blockedTool.toolName
  ) {
    throw new SubagentContinuationPersistenceErrorV1(
      'Private Subagent continuation Artifact is cross-bound.',
    );
  }
  return snapshot;
}

/** Preserve every suspended sibling without overwriting the Runtime's single interaction slot. */
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

type AppRuntimeToolExecutionInputV1 = Parameters<typeof executeAppRuntimeToolsV1>[0];

/**
 * Single App-owned child Tool dispatcher shared by Skill forks and legacy
 * `builtin:task`. It recursively re-enters the App runtime and never
 * selects a second Host, registry, or fallback dispatcher.
 */
function createAppSharedChildToolDispatcherV1(input: {
  readonly params: AppRuntimeToolExecutionInputV1;
  readonly parentToolCallId: string;
  readonly parentTaskId?: string;
}): SubAgentToolDispatcherV1 {
  const { params, parentToolCallId, parentTaskId } = input;
  return {
    dispatch: async (childInput) => {
      const runtimeToolCallId = childRuntimeToolCallIdV1({
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
        classifierAdviceV1: {
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
          digestCapabilityValueV1(durableBinding) !== digestCapabilityValueV1(childInput.binding)
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
          digestCapabilityValueV1(existing.args) ===
            digestCapabilityValueV1(childInput.request.args);
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
      const childEvents = await executeAppRuntimeToolsV1({
        ...params,
        state: executionState as RuntimeState,
        toolCallIds: [runtimeToolCallId],
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
        const approvalBinding = appApprovalBindingForPresentationV1(approval.approval);
        if (!approvalBinding) {
          return {
            runtimeToolCallId,
            result: failClosed('Child approval is missing its Kernel governance facts.'),
          };
        }
        const childApprovalBinding: AppApprovalBindingV1 = Object.freeze({
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
        throw new AppToolPipelinePersistenceErrorV1(
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
        throw new AppToolPipelinePersistenceErrorV1(
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
            classifierAdviceV1: finished.classifierAdviceV1,
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

interface AppSkillForkRequestV1 {
  readonly agent: string;
  readonly capabilityCeiling: readonly string[];
  readonly instructions: string;
  readonly workflowInput: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
}

/**
 * The single App owner for a forked Skill's child model invocation. The
 * caller must already hold the exact acknowledged parent identity and the
 * one App-issued runtime; this helper never creates a coordinator or falls
 * back to Core dispatch.
 */
async function runAppSkillForkV1(input: {
  readonly params: AppRuntimeToolExecutionInputV1;
  readonly call: Readonly<import('@kite/runtime-host').StateToolCallRecordV1>;
  readonly toolCallId: string;
  readonly builtinProjection: import('@kite/builtin-runtime').BuiltinToolCatalogProjectionV1;
  readonly childToolDispatcher: SubAgentToolDispatcherV1;
  readonly eventSink: SubAgentEventSink;
  readonly subagentRuntime: SubagentInvocationRuntimeV1;
  readonly subagentInvocationIdentity: SubagentInvocationIdentityV1;
  readonly fork: AppSkillForkRequestV1;
}): Promise<SubAgentResult | null> {
  const { params, call, toolCallId, fork, subagentInvocationIdentity } = input;
  if (
    !params.taskConfig ||
    !params.taskModel ||
    !params.getRuntimeState ||
    !params.persistRuntimeEvents
  ) {
    return null;
  }
  const currentState = params.getRuntimeState();
  const forkParentInvocation = Object.values(currentState.capabilities.invocations).find(
    (invocation) =>
      invocation.invocationId === subagentInvocationIdentity.invocationId &&
      invocation.toolCallId === toolCallId &&
      invocation.status === 'running' &&
      invocation.attemptsStarted === subagentInvocationIdentity.attempt,
  );
  if (!forkParentInvocation?.admissionDigest) return null;

  const ceiling = forkToolCeiling({
    capabilityCeiling: fork.capabilityCeiling,
    builtinToolCatalog: input.builtinProjection,
    mcpManager: params.mcpManager,
    turnId: currentState.turn.turnId,
  });
  if (!ceiling) return null;
  if (ceiling.mcpBindings.length > 0) {
    const mergedBindings = new Map(
      Object.values(currentState.capabilities.bindings).map((binding) => [
        binding.bindingId,
        binding,
      ]),
    );
    for (const { binding } of ceiling.mcpBindings) {
      const existing = mergedBindings.get(binding.bindingId);
      if (existing && digestCapabilityValueV1(existing) !== digestCapabilityValueV1(binding)) {
        return null;
      }
      mergedBindings.set(binding.bindingId, binding);
    }
    const acknowledged = await params.persistRuntimeEvents([
      {
        type: 'capability.bindings_issued',
        catalogRevision:
          params.mcpManager?.getCapabilitySnapshot().revision ??
          currentState.capabilities.catalogRevision,
        bindings: [...mergedBindings.values()],
        disclosures: Object.values(currentState.capabilities.disclosures),
        loadedCapabilities: Object.values(currentState.capabilities.loadedCapabilities),
      },
    ]);
    const durableState = params.getRuntimeState();
    if (
      !acknowledged ||
      ceiling.mcpBindings.some(({ binding }) => {
        const durableBinding = durableState.capabilities.bindings[binding.bindingId];
        return (
          !durableBinding ||
          digestCapabilityValueV1(durableBinding) !== digestCapabilityValueV1(binding)
        );
      })
    ) {
      return null;
    }
  }

  return input.subagentRuntime.start(
    {
      builtinToolCatalog: params.builtinToolCatalog,
      config: params.taskConfig,
      workspace: currentState.session.workspace,
      shellExecutor: params.shellExecutor,
      mcpManager: params.mcpManager,
      skills: params.skillManifests,
      skillOptions: params.skillOptions,
      allowedTools: ceiling.allowedTools,
      mcpBindings: ceiling.mcpBindings,
      authorization: currentState.authorization,
      workspaceAccess: currentState.workspaceAccess,
      phase: getAgentPhase(getActivePlanning(currentState)),
      interactionMode: getEffectiveInteractionMode(currentState),
      projectInstructions: visibleProjectInstructions(
        currentState,
        call.modelMessageId,
        params.taskConfig,
      ),
      threadId: currentState.session.threadId,
      recoveryIdentityKey: currentState.toolRecovery.identityKey,
      eventSink: input.eventSink,
      signal: params.signal,
      model: params.taskModel,
      providerDataAdmission: params.providerDataAdmission,
      descendantResourceAdmission: params.descendantResourceAdmission,
      modelEffectCoordinator: params.modelEffectCoordinator,
      modelInvocationPersistence: params.modelInvocationPersistence,
      subagentLifecyclePersistence: {
        getState: params.getRuntimeState,
        persistEvents: params.persistRuntimeEvents,
      },
      modelInvocationParentId: call.modelInvocationId,
      modelInvocationParentToolCallId: toolCallId,
      modelInvocationParentReservationId: params.modelInvocationParentReservationId,
      subagentInvocationIdentity,
      subagentRuntime: input.subagentRuntime,
      toolDispatcher: input.childToolDispatcher,
      maxDepth: 0,
      recordFilePreimage: params.recordFilePreimage,
    },
    {
      subagent_type: forkRole(fork.agent),
      task: [
        fork.instructions,
        '## Validated Workflow Input',
        JSON.stringify(fork.workflowInput),
        '## Required completion format',
        'When the work is complete, respond with only one JSON object. Do not add Markdown or commentary.',
        `The object must validate against this output schema: ${JSON.stringify(fork.outputSchema)}`,
      ].join('\n\n'),
    },
  );
}

interface AppTaskResumeChildPreparationV1 {
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
async function prepareAppTaskResumeChildV1(input: {
  readonly params: AppRuntimeToolExecutionInputV1;
  readonly state: RuntimeState;
  readonly toolCallId: string;
  readonly continuation: RestoredSubAgentContinuation;
  readonly availCtx: AppToolTurnContextV1;
  readonly toolPipelineComposition: AppToolPipelineCompositionV1;
  readonly builtinToolCatalog: import('@kite/builtin-runtime').BuiltinToolCatalogProjectionV1;
  readonly childToolDispatcher: SubAgentToolDispatcherV1;
  readonly signal: AbortSignal;
}): Promise<
  | { readonly ok: true; readonly value: AppTaskResumeChildPreparationV1 }
  | { readonly ok: false; readonly events: RuntimeEvent[] }
> {
  const { params, continuation, toolCallId } = input;
  const state = params.getRuntimeState?.() ?? input.state;
  const recovery = normalizeToolRecoveryJournalV1(
    continuation.toolRecovery,
    state.toolRecovery.identityKey,
  );
  if (
    isToolRecoveryJournalInvalidV1(state.toolRecovery) ||
    isToolRecoveryJournalInvalidV1(recovery) ||
    recovery.identityKey !== state.toolRecovery.identityKey
  ) {
    return taskResumeRejectedEventsV1(
      toolCallId,
      'Sub-agent continuation recovery journal no longer matches the live runtime.',
    );
  }

  const call = state.tools.calls[toolCallId];
  if (call?.status !== 'approved' || !call.approvalGrant) {
    return taskResumeRejectedEventsV1(
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
    ? childRuntimeToolCallIdV1({
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
    digestCapabilityValueV1(childCall.args) !== digestCapabilityValueV1(blocked.args) ||
    !bindingMatches ||
    mcpBindings.length !== (continuation.mcpBindingIds?.length ?? 0)
  ) {
    return taskResumeRejectedEventsV1(
      toolCallId,
      'Sub-agent child Runtime identity or its operation-bound approval is unavailable.',
    );
  }

  const resumeProjection = input.builtinToolCatalog.forTurn(
    createAppToolTurnContextV1({
      workspace: state.session.workspace,
      threadId: state.session.threadId,
      config: params.taskConfig,
      hasGitBroker: Boolean(params.gitBroker),
      hasTaskAdapter: true,
      toolSearchEnabled: params.taskConfig
        ? getFeatureFlags(params.taskConfig).toolSearchV1
        : false,
      skillCatalog: params.skillCatalog,
      activeSkillFrames: activeSkillFramesForCurrentWork(state).filter(
        (frame) => frame.contextMode === 'inline',
      ),
      phase: getAgentPhase(getActivePlanning(state)),
      interactionMode: getEffectiveInteractionMode(state),
      turnId: state.turn.turnId,
      activeTaskId: state.activeTaskId ?? undefined,
      toolCallId,
    }),
  );
  const blockedRequest = buildBlockedToolRequest(blocked, input.availCtx, resumeProjection);
  const blockedEntry =
    blockedRequest.source === 'builtin'
      ? modelBuiltinEntryV1(resumeProjection, blockedRequest.name)
      : undefined;
  const approvalDescriptors = [
    ...mcpBindings.map(({ descriptor }) => descriptor),
    ...(params.skillCatalog?.capabilities.descriptors ?? []),
  ];
  const exactApproval = exactBlockedSubagentPolicyV1({
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
    return taskResumeRejectedEventsV1(
      toolCallId,
      'Sub-agent child approval binding no longer matches the exact blocked operation.',
    );
  }
  const roleDenial =
    blockedEntry?.executionMechanism === 'shell'
      ? rejectShellOutsideSubAgentRoleCeilingV1(
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
      isToolRecoveryJournalInvalidV1(dispatchState.toolRecovery) ||
      dispatchState.toolRecovery.identityKey !== recovery.identityKey ||
      dispatchCall?.status !== 'approved'
    ) {
      return taskResumeRejectedEventsV1(
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
      return taskResumeRejectedEventsV1(
        toolCallId,
        'Child approval policy did not produce an operation-bound review fact.',
      );
    }
    if (!params.persistRuntimeEvents || !params.getRuntimeState) {
      return taskResumeRejectedEventsV1(
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
      return taskResumeRejectedEventsV1(
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
                if (
                  dispatchState === 'not_started' ||
                  error instanceof ProviderDataAdmissionError
                ) {
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
                      ? bestEffortRegularFileSizeV1(attemptResult.path)
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
      return taskResumeRejectedEventsV1(
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

function taskResumeRejectedEventsV1(
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
async function executeAppTaskToolPipelineV1(input: {
  readonly params: AppRuntimeToolExecutionInputV1;
  readonly taskRuntime: AppTaskToolPipelineAttemptRuntimeV1;
  readonly toolCallId: string;
  readonly call: NonNullable<RuntimeState['tools']['calls'][string]>;
  readonly privateTask: PrivateSubagentTaskV1;
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
  let taskChildToolDispatcher = createAppSharedChildToolDispatcherV1({
    params,
    parentToolCallId: toolCallId,
    ...(call.taskId ? { parentTaskId: call.taskId } : {}),
  });
  let productionFlags = getFeatureFlags(params.taskConfig);
  let turnContext = createAppToolTurnContextV1({
    workspace: state.session.workspace,
    threadId: state.session.threadId,
    config: params.taskConfig,
    hasGitBroker: Boolean(params.gitBroker),
    hasTaskAdapter: true,
    toolSearchEnabled: productionFlags.toolSearchV1 === true,
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
  let snapshotResult = createRuntimeHostToolCallSnapshotV1({
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
  let resumePreparation: AppTaskResumeChildPreparationV1 | undefined;
  if (suspended && call.status === 'approved') {
    let continuation: RestoredSubAgentContinuation;
    try {
      continuation = deserializeSubagentContinuation(
        readPrivateSuspendedSubagentV1(
          suspended,
          toolCallId,
          state,
          params.subagentContinuationArtifacts,
        ),
        state.toolRecovery.identityKey,
      );
    } catch (error) {
      return taskResumeRejectedEventsV1(
        toolCallId,
        error instanceof Error ? error.message : 'Private continuation readback failed.',
      ).events;
    }
    const prepared = await prepareAppTaskResumeChildV1({
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
        readPrivateSuspendedSubagentV1(
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
      return taskResumeRejectedEventsV1(
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
      return taskResumeRejectedEventsV1(
        toolCallId,
        'The approved parent Task continuation changed before its live resume attempt.',
      ).events;
    }
    taskChildToolDispatcher = createAppSharedChildToolDispatcherV1({
      params,
      parentToolCallId: toolCallId,
      ...(call.taskId ? { parentTaskId: call.taskId } : {}),
    });
    productionFlags = getFeatureFlags(params.taskConfig);
    turnContext = createAppToolTurnContextV1({
      workspace: state.session.workspace,
      threadId: state.session.threadId,
      config: params.taskConfig,
      hasGitBroker: Boolean(params.gitBroker),
      hasTaskAdapter: true,
      toolSearchEnabled: productionFlags.toolSearchV1 === true,
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
    snapshotResult = createRuntimeHostToolCallSnapshotV1({
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
    return taskResumeRejectedEventsV1(
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
  const taskInput = (prepared: Readonly<PreparedToolInvocationV1>): TaskToolDeps => {
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
      interactionMode: getEffectiveInteractionMode(makeState()),
      projectInstructions: visibleProjectInstructions(
        makeState(),
        call.modelMessageId,
        params.taskConfig,
      ),
      threadId: makeState().session.threadId,
      recoveryIdentityKey: makeState().toolRecovery.identityKey,
      eventSink: emitSubagentEventForTask(params),
      signal: params.signal,
      model: params.taskModel,
      providerDataAdmission: params.providerDataAdmission,
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
    readonly prepared: Readonly<PreparedToolInvocationV1>;
    readonly arguments: Readonly<RuntimeJsonValueV1>;
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
      return taskResultForBuiltinProjectionV1(result);
    }
    const result = await runtime.start(deps, privateTask.payload);
    capturedSubagentResult = result;
    return taskResultForBuiltinProjectionV1(result);
  };
  const projectSuspension = ({
    executionMode: mode,
    prepared,
    terminal,
  }: Parameters<
    AppTaskAttemptInputV1['projectSuspension']
  >[0]): Readonly<ToolPipelineTaskSubagentSuspensionV1> | null => {
    const captured = capturedSubagentResult;
    if (!captured?.blocked || !isExactTaskBlockedTerminalProjectionV1(terminal, captured)) {
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
    const subagent = privateSuspendedSubagentRecordV1({
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
        argumentsDigest: digestCapabilityValueV1(blockedValue.args),
        commandDigest:
          blockedValue.command.trim().length > 0
            ? digestCapabilityValueV1(blockedValue.command.trim())
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
      const request = pendingToolRequestFromValidatedInvocationV1(
        result.classified.validated,
        turn.projection,
      );
      const approvalBindingDigest = runtimeHostStateCreateApprovalBindingDigestV1(
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
      bindAppApprovalBindingV1(approval, {
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

function emitSubagentEventForTask(params: AppRuntimeToolExecutionInputV1): SubAgentEventSink {
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
export async function executeAppRuntimeToolsV1(params: {
  state: RuntimeState;
  toolCallIds: string[];
  shellExecutor?: ShellExecutor;
  gitBroker?: import('@kite/builtin-runtime/git').GitBrokerV1;
  mcpManager?: McpRuntimeProvider;
  /** Host-owned registry execution port for Runtime SPI capability owners. */
  capabilityExecution?: CapabilityExecutionPortV1;
  builtinToolCatalog?: import('@kite/builtin-runtime').BuiltinToolCatalogProjectionV1;
  /** Stable App composition derived from the same frozen Builtin projection. */
  toolPipelineComposition: AppToolPipelineCompositionV1;
  /** The one effect-scoped Host/Builtin attempt runtime for ordinary cutover operations. */
  ordinaryToolPipelineAttemptRuntime?: AppOrdinaryToolPipelineAttemptRuntimeV1;
  /** The dedicated private Task runtime sharing the same effect-scoped Host coordinator. */
  taskToolPipelineAttemptRuntime?: AppTaskToolPipelineAttemptRuntimeV1;
  providerReadinessCoordinator?: ProviderReadinessCoordinatorV1;
  skillManifests?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  skillCatalog?: SkillCatalogSnapshot;
  signal?: AbortSignal;
  taskConfig?: AgentConfig;
  taskModel?: SupportedChatModel;
  providerDataAdmission?: import('#app/config/provider-data-admission').ProviderDataAdmissionGateV1;
  descendantResourceAdmission?: import('@kite/runtime-host').DescendantResourceAdmissionV1;
  modelEffectCoordinator?: import('@kite/builtin-runtime/model').BuiltinModelEffectCoordinatorV1;
  modelInvocationPersistence?: import('@kite/builtin-runtime/model').ModelInvocationPersistenceV1<
    RuntimeState,
    RuntimeEvent
  >;
  /** Parent reservation for a task/skill child model step. */
  modelInvocationParentReservationId?: string;
  subagentEventSink?: SubAgentEventSink;
  /** Identity supplied by the scheduler/executor only for one admitted parallel task batch. */
  subagentConcurrencyGroupId?: string;
  planArtifactStore?: PlanArtifactStore;
  capabilityArtifactStore?: CapabilityArtifactWriterV1;
  workspaceFilesystemRuntime?: import('@kite/builtin-runtime/filesystem').BuiltinWorkspaceFilesystemRuntimeV1;
  sandboxPreparationArtifacts?: import('@kite/builtin-runtime/sandbox').SandboxPreparationArtifactStoreV1;
  /** Exact sandbox qualification fact captured by the App/Core coordinator. */
  sandboxAvailable?: boolean;
  /** Deterministic observation used only for persisted same-command expiry. */
  authorizationObservedAt?: number;
  /** Elevation guards supplied by the effect coordinator, never inferred by Kernel. */
  authorizationFromAutoReview?: boolean;
  authorizationFromLoopMode?: boolean;
  /** Explicit qualification seam; production omits it and uses the sole Local Provider composition. */
  subagentRuntimeFactory?: import('./subagent/pipeline-runtime').AppSubagentRuntimeFactoryV1;
  subagentContinuationArtifacts?: import('#builtin-runtime').SubagentContinuationArtifactAccessV1;
  subagentTaskRequests?: import('#builtin-runtime').SubagentTaskRequestArtifactAccessV1;
  /** Runtime sink used to publish tool lifecycle/progress events while execution is running. */
  emitRuntimeEvent?: (event: RuntimeEvent) => void;
  /** StateSessionStorageV1-backed acknowledgement required before an automatic provider replay. */
  persistRuntimeEvent?: (event: RuntimeEvent) => Promise<boolean>;
  /** Atomic StateSessionStorageV1 acknowledgement for invocation intent + attempt. */
  persistRuntimeEvents?: (events: RuntimeEvent[]) => Promise<boolean>;
  /** Defers a complete terminal batch to the Kernel's atomic effect commit. */
  emitTerminalEventBatch?: (events: RuntimeEvent[]) => void;
  /** Current Kernel state used to reject a prepared/leased effect that became unsafe. */
  getRuntimeState?: () => Readonly<RuntimeState>;
  /** 写入前文件原像记录器，透传给工具执行链（ADR-0025 §4）。 */
  recordFilePreimage?: FilePreimageRecorder;
  recordNetworkDecision?: NetworkDecisionRecorderV1;
  /** Actor identities for nested child calls; absent top-level calls use parent. */
  toolActorIds?: Readonly<Record<string, string>>;
  /** Child-only exact reservation prepared after authorization and before admission. */
  beforeAdmissionByToolCallId?: Readonly<
    Record<string, () => Promise<import('@kite/runtime-host').DescendantBudgetReservationV1>>
  >;
  /** Child resource admission hook entered only after invocation acknowledgement. */
  beforeDispatchByToolCallId?: Readonly<
    Record<string, (attempt: number, reservationId?: string) => Promise<void>>
  >;
  /** Per-attempt child resource settlement after adapter completion or uncertainty. */
  afterDispatchByToolCallId?: Readonly<
    Record<
      string,
      (input: {
        attempt?: number;
        reservationId?: string;
        dispatchState: 'not_started' | 'started';
        result?: ToolExecutionResult;
        error?: unknown;
      }) => Promise<void>
    >
  >;
}): Promise<RuntimeEvent[]> {
  const approvedParallelShellBatch =
    params.toolCallIds.length > 1 &&
    params.toolCallIds.every((toolCallId) => {
      const call = params.state.tools.calls[toolCallId];
      const entry =
        call && params.builtinToolCatalog
          ? modelBuiltinEntryV1(params.builtinToolCatalog, call.name)
          : undefined;
      return entry?.executionMechanism === 'shell' && call?.status === 'approved';
    });
  const parallelSubagentBatch =
    params.toolCallIds.length > 1 &&
    params.toolCallIds.every((toolCallId) => {
      const call = params.state.tools.calls[toolCallId];
      const entry =
        call && params.builtinToolCatalog
          ? modelBuiltinEntryV1(params.builtinToolCatalog, call.name)
          : undefined;
      return entry?.executionMechanism === 'subagent' && call?.status === 'queued';
    });
  if (approvedParallelShellBatch) {
    const batches = await Promise.all(
      params.toolCallIds.map((toolCallId) =>
        executeAppRuntimeToolsV1({
          ...params,
          toolCallIds: [toolCallId],
        }),
      ),
    );
    return batches.flat();
  }
  if (parallelSubagentBatch) {
    const concurrencyGroupId =
      params.subagentConcurrencyGroupId ?? `subagent-batch:${params.toolCallIds[0]!}`;
    const deferredInteractions = params.toolCallIds.map(() => [] as RuntimeEvent[]);
    const batches = await Promise.all(
      params.toolCallIds.map((toolCallId, index) =>
        executeAppRuntimeToolsV1({
          ...params,
          toolCallIds: [toolCallId],
          subagentConcurrencyGroupId: concurrencyGroupId,
          ...(params.emitRuntimeEvent
            ? {
                emitRuntimeEvent: (event: RuntimeEvent) => {
                  if (
                    event.type === 'subagent.suspended' ||
                    event.type === 'approval.requested' ||
                    event.type === 'auto_review.requested'
                  ) {
                    deferredInteractions[index]!.push(event);
                  } else {
                    params.emitRuntimeEvent?.(event);
                  }
                },
              }
            : {}),
        }),
      ),
    );
    const serialized = serializeConcurrentSubagentApprovalEvents(
      batches.map((batch, index) => {
        const deferred = deferredInteractions[index]!;
        if (deferred.length === 0) return batch;
        return [
          ...deferred,
          ...batch.filter(
            (event) =>
              event.type !== 'subagent.suspended' &&
              event.type !== 'approval.requested' &&
              event.type !== 'auto_review.requested',
          ),
        ];
      }),
    );
    if (!params.emitRuntimeEvent) return serialized;
    for (const event of serialized) params.emitRuntimeEvent(event);
    return [];
  }
  const events: RuntimeEvent[] = [];
  // Direct invocations collect the returned facts. The Runtime runner replaces
  // push with a streaming sink, so events are applied
  // and rendered as soon as they are produced instead of after the tool exits.
  if (params.emitRuntimeEvent) {
    const append = events.push.bind(events);
    events.push = (...items: RuntimeEvent[]) => {
      for (const item of items) params.emitRuntimeEvent?.(item);
      return append();
    };
  }
  const currentState = params.getRuntimeState?.() ?? params.state;
  if (isToolRecoveryJournalInvalidV1(currentState.toolRecovery)) {
    const reason = 'Runtime tool recovery journal is invalid; tool dispatch is blocked.';
    for (const toolCallId of params.toolCallIds) {
      const call = currentState.tools.calls[toolCallId] ?? params.state.tools.calls[toolCallId];
      if (!call || (call.status !== 'queued' && call.status !== 'approved')) continue;
      events.push({
        type: 'tool.rejected',
        toolCallId,
        reason,
        failure: classifyFailure('persistence_unavailable', reason),
      });
    }
    return events;
  }
  const planArtifacts = params.planArtifactStore;
  const emitSubagentEvent: SubAgentEventSink = (event) => {
    events.push(toRuntimeSubagentEvent(event, params.subagentConcurrencyGroupId));
    params.subagentEventSink?.(event);
  };
  for (const toolCallId of params.toolCallIds) {
    const call = params.state.tools.calls[toolCallId];
    if (!call || (call.status !== 'queued' && call.status !== 'approved')) continue;
    let privateSubagentTask: PrivateSubagentTaskV1 | undefined;
    if (isBuiltinSubagentTaskToolNameV1(call.name)) {
      const args = call.args;
      const taskArtifact =
        args && typeof args === 'object' && !Array.isArray(args) && 'taskArtifact' in args
          ? args.taskArtifact
          : undefined;
      const role =
        args && typeof args === 'object' && !Array.isArray(args) && 'subagent_type' in args
          ? args.subagent_type
          : undefined;
      if (
        !params.subagentTaskRequests ||
        !call.modelInvocationId ||
        !taskArtifact ||
        typeof taskArtifact !== 'object' ||
        Array.isArray(taskArtifact) ||
        !['explore', 'plan', 'code', 'review'].includes(String(role))
      ) {
        events.push({
          type: 'tool.failed',
          toolCallId,
          failure: classifyFailure(
            'persistence_unavailable',
            'Private Subagent task request Artifact is unavailable.',
          ),
        });
        continue;
      }
      try {
        const privateTask = params.subagentTaskRequests.read(
          taskArtifact as import('@kite/runtime-spi').SubagentTaskRequestArtifactV1,
          {
            parentModelInvocationId: call.modelInvocationId,
            parentToolCallId: toolCallId,
          },
        );
        if (privateTask.role !== role) throw new Error('Subagent role is cross-bound.');
        privateSubagentTask = {
          source: 'private_artifact_v1',
          requestArtifact:
            taskArtifact as import('@kite/runtime-spi').SubagentTaskRequestArtifactV1,
          payload: { subagent_type: privateTask.role, task: privateTask.task },
        };
      } catch {
        events.push({
          type: 'tool.failed',
          toolCallId,
          failure: classifyFailure(
            'persistence_unavailable',
            'Private Subagent task request Artifact failed exact readback.',
          ),
        });
        continue;
      }
    }
    const childToolDispatcher = createAppSharedChildToolDispatcherV1({
      params,
      parentToolCallId: toolCallId,
      ...(call.taskId ? { parentTaskId: call.taskId } : {}),
    });
    const productionFlags = params.taskConfig ? getFeatureFlags(params.taskConfig) : undefined;
    const syntheticInvalidArgs =
      call.args !== null &&
      typeof call.args === 'object' &&
      !Array.isArray(call.args) &&
      typeof (call.args as Record<string, unknown>)._raw_invalid_args === 'string'
        ? (call.args as Record<string, unknown>)
        : undefined;
    if (syntheticInvalidArgs) {
      events.push({
        type: 'tool.failed',
        toolCallId,
        failure: classifyFailure(
          failureKindForToolParseFailure('invalid_json'),
          typeof syntheticInvalidArgs._parse_error === 'string'
            ? syntheticInvalidArgs._parse_error
            : 'invalid JSON arguments',
          'invalid_json',
        ),
      });
      continue;
    }
    if (
      call.name.startsWith('mcp__') &&
      (!productionFlags?.capabilityCatalogV1 || !productionFlags.mcpRuntimeBindingV1)
    ) {
      events.push({
        type: 'tool.failed',
        toolCallId,
        failure: classifyFailure(
          'tool_invalid_args',
          'MCP Runtime binding is disabled by feature flag.',
        ),
      });
      continue;
    }
    const ordinaryCutoverEntry = params.builtinToolCatalog
      ? modelBuiltinEntryV1(params.builtinToolCatalog, call.name)
      : undefined;
    const taskCutover =
      ordinaryCutoverEntry?.operationId === 'builtin:task' &&
      ordinaryCutoverEntry.executionMechanism === 'subagent';
    const productionBoundaryIncomplete =
      Boolean(params.taskConfig && 'productionExecution' in params.taskConfig) &&
      (!params.taskConfig?.executionBoundary || !params.taskConfig.executionCapabilitySurface);
    if (productionBoundaryIncomplete) {
      const reason = productionExecutionSurfaceFailureV1({
        config: params.taskConfig,
        workspace: currentState.session.workspace,
        descriptor: ordinaryCutoverEntry?.descriptor,
        executionMechanism: ordinaryCutoverEntry?.executionMechanism ?? 'unknown',
        rawArguments: call.args,
      });
      events.push({
        type: 'tool.rejected',
        toolCallId,
        reason:
          reason ??
          'Rejected by production execution boundary: protected-path gate is unavailable.',
        failure: classifyFailure(
          'mandatory_policy_unavailable',
          reason ??
            'Rejected by production execution boundary: protected-path gate is unavailable.',
        ),
      });
      continue;
    }
    if (ordinaryCutoverEntry) {
      const surfaceFailure = productionExecutionSurfaceFailureV1({
        config: params.taskConfig,
        workspace: currentState.session.workspace,
        descriptor: ordinaryCutoverEntry.descriptor,
        executionMechanism: ordinaryCutoverEntry.executionMechanism,
        rawArguments: call.args,
      });
      if (surfaceFailure) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: surfaceFailure,
          failure: classifyFailure('policy_denied', surfaceFailure),
        });
        continue;
      }
    }
    if (isBuiltinSubagentTaskToolNameV1(call.name) && !taskCutover) {
      events.push({
        type: 'tool.failed',
        toolCallId,
        failure: classifyFailure(
          'mandatory_policy_unavailable',
          'Builtin Task catalog identity is unavailable; legacy dispatch is disabled.',
        ),
      });
      continue;
    }
    if (taskCutover) {
      const instructionFailure = projectInstructionGuardFailureV1({
        state: (params.getRuntimeState?.() ?? currentState) as RuntimeState,
        modelMessageId: call.modelMessageId,
        config: params.taskConfig,
        entry: ordinaryCutoverEntry,
        argumentOrigin: 'runtime_private',
        rawArguments: call.args,
      });
      if (instructionFailure) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: instructionFailure,
          failure: classifyFailure('policy_denied', instructionFailure),
        });
        continue;
      }
      if (!params.taskToolPipelineAttemptRuntime || !privateSubagentTask) {
        events.push({
          type: 'tool.failed',
          toolCallId,
          failure: classifyFailure(
            'persistence_unavailable',
            'Private Task Tool Pipeline attempt authority is unavailable.',
          ),
        });
        continue;
      }
      try {
        const taskEvents = await executeAppTaskToolPipelineV1({
          params,
          taskRuntime: params.taskToolPipelineAttemptRuntime,
          toolCallId,
          call,
          privateTask: privateSubagentTask,
        });
        events.push(...taskEvents);
      } catch (error) {
        if (error instanceof DescendantResourceAdmissionError) throw error;
        const after = params.getRuntimeState?.()?.tools.calls[toolCallId];
        if (after && !['queued', 'approved', 'running'].includes(after.status)) continue;
        events.push({
          type: 'tool.failed',
          toolCallId,
          failure: classifyFailure(
            'persistence_unavailable',
            error instanceof Error
              ? error.message
              : 'Private Task Tool Pipeline attempt failed closed.',
          ),
        });
      }
      continue;
    }
    const dynamicMcpCutover =
      call.name.startsWith('mcp__') &&
      productionFlags?.capabilityCatalogV1 === true &&
      productionFlags.mcpRuntimeBindingV1 === true;
    const sealedMcpTerminal =
      (dynamicMcpCutover || ordinaryCutoverEntry?.executionMechanism === 'mcp') &&
      params.taskConfig?.executionBoundary
        ? sealedMcpNetworkTerminalV1({
            config: params.taskConfig,
            toolCallId,
            toolName: call.name,
          })
        : null;
    if (sealedMcpTerminal) {
      events.push(sealedMcpTerminal);
      continue;
    }
    const dynamicMcpCapabilitySnapshot = dynamicMcpCutover
      ? params.mcpManager?.getCapabilitySnapshot()
      : undefined;
    const dynamicMcpCutoverDescriptor =
      call.capabilityId === undefined
        ? undefined
        : (dynamicMcpCapabilitySnapshot?.descriptors.find(
            (descriptor) => descriptor.capabilityId === call.capabilityId,
          ) ?? params.mcpManager?.findCapability(call.capabilityId));
    if (dynamicMcpCutover && dynamicMcpCutoverDescriptor) {
      const surfaceFailure = productionExecutionSurfaceFailureV1({
        config: params.taskConfig,
        workspace: currentState.session.workspace,
        descriptor: dynamicMcpCutoverDescriptor,
        executionMechanism: 'mcp',
        rawArguments: call.args,
      });
      if (surfaceFailure) {
        events.push({
          type: 'tool.rejected',
          toolCallId,
          reason: surfaceFailure,
          failure: classifyFailure('policy_denied', surfaceFailure),
        });
        continue;
      }
    }
    if (
      (ordinaryCutoverEntry &&
        isAppOrdinaryToolPipelineOperationIdV1(ordinaryCutoverEntry.operationId)) ||
      dynamicMcpCutover
    ) {
      if (dynamicMcpCutover && !dynamicMcpCutoverDescriptor) {
        const providerId =
          call.capabilityId?.match(/^mcp:([^/]+)\//u)?.[1] ??
          call.name.match(/^mcp__([^_]+)__/u)?.[1];
        const directoryEntry = providerId
          ? params.mcpManager
              ?.getProviderDirectorySnapshot()
              .entries.find((entry) => entry.providerId === providerId)
          : undefined;
        const failure = providerId
          ? classifyMcpProviderError(
              directoryEntry && directoryEntry.status !== 'ready'
                ? providerErrorFromDirectoryEntry(directoryEntry, providerId)
                : capabilityChangedProviderError(providerId),
            )
          : classifyFailure('tool_not_found', `Unsupported tool '${call.name}'.`);
        events.push({ type: 'tool.failed', toolCallId, failure });
        const providerAction = providerActionRequiredEvent({
          enabled: productionFlags?.mcpProviderActionV1 === true,
          providerId: providerId ?? 'unknown',
          toolCallId,
          action: recoveryActionForFailure(failure),
        });
        if (providerAction) events.push(providerAction);
        continue;
      }
      const cutoverExecutionMechanism = dynamicMcpCutover
        ? ('mcp' as const)
        : ordinaryCutoverEntry!.executionMechanism;
      const cutoverOperationId = dynamicMcpCutover
        ? ('mcp:dynamic_tool' as const)
        : ordinaryCutoverEntry!.operationId;
      const cutoverCapabilityId = dynamicMcpCutover
        ? (dynamicMcpCutoverDescriptor?.capabilityId ?? call.capabilityId ?? 'mcp:dynamic_tool')
        : ordinaryCutoverEntry!.capabilityId;
      const ordinaryRuntime = params.ordinaryToolPipelineAttemptRuntime;
      const capabilityExecution = params.capabilityExecution;
      if (!ordinaryRuntime || !capabilityExecution || !params.builtinToolCatalog) {
        events.push({
          type: 'tool.failed',
          toolCallId,
          failure: classifyFailure(
            'persistence_unavailable',
            'Ordinary Tool Pipeline attempt authority is unavailable.',
          ),
        });
        continue;
      }
      const liveState = (params.getRuntimeState?.() ?? currentState) as RuntimeState;
      const turnContext = createAppToolTurnContextV1({
        workspace: liveState.session.workspace,
        threadId: liveState.session.threadId,
        config: params.taskConfig,
        hasGitBroker: Boolean(params.gitBroker),
        hasTaskAdapter: true,
        toolSearchEnabled: productionFlags?.toolSearchV1 === true,
        skillCatalog: params.skillCatalog,
        activeSkillFrames: activeSkillFramesForCurrentWork(liveState).filter(
          (frame) => frame.contextMode === 'inline',
        ),
        phase: getAgentPhase(getActivePlanning(liveState)),
        interactionMode: getEffectiveInteractionMode(liveState),
        turnId: liveState.turn.turnId,
        activeTaskId: liveState.activeTaskId ?? undefined,
        modelMessageId: call.modelMessageId,
        toolCallId,
      });
      if (ordinaryCutoverEntry) {
        const instructionFailure = projectInstructionGuardFailureV1({
          state: liveState,
          modelMessageId: call.modelMessageId,
          config: params.taskConfig,
          entry: ordinaryCutoverEntry,
          argumentOrigin: 'model_public',
          rawArguments: call.args,
        });
        if (instructionFailure) {
          events.push({
            type: 'tool.rejected',
            toolCallId,
            reason: instructionFailure,
            failure: classifyFailure('policy_denied', instructionFailure),
          });
          continue;
        }
      }
      const turn = params.toolPipelineComposition.forTurn(turnContext);
      const snapshot = createRuntimeHostToolCallSnapshotV1({
        toolCallId,
        name: call.name,
        rawArguments: call.args,
        argumentOrigin: 'model_public',
        createdAtTurnId: call.createdAtTurnId,
        modelMessageId: call.modelMessageId,
        bindingId: call.bindingId ?? null,
        capabilityId: call.capabilityId ?? null,
        capabilityRevision: call.capabilityRevision ?? null,
      });
      if (!snapshot.ok) {
        events.push({
          type: 'tool.failed',
          toolCallId,
          failure: classifyFailure('tool_invalid_args', snapshot.failure.code),
        });
        continue;
      }
      const mcpSnapshot =
        dynamicMcpCapabilitySnapshot ?? params.mcpManager?.getCapabilitySnapshot();
      const skillSnapshot = params.skillCatalog?.capabilities;
      const descriptors = [
        ...(mcpSnapshot?.descriptors ?? []),
        ...(dynamicMcpCutoverDescriptor &&
        !(mcpSnapshot?.descriptors ?? []).some(
          (descriptor) => descriptor.capabilityId === dynamicMcpCutoverDescriptor.capabilityId,
        )
          ? [dynamicMcpCutoverDescriptor]
          : []),
        ...(skillSnapshot?.descriptors ?? []),
      ];
      const activeFrames = Object.values(liveState.skills.frames).filter(
        (frame) => frame.status === 'active' && frame.taskId === liveState.activeTaskId,
      );
      const isSkillLifecycleOperation =
        cutoverOperationId === 'builtin:read_skill_reference' ||
        cutoverOperationId === 'builtin:complete_skill';
      const skillCeilingBlocked =
        !isSkillLifecycleOperation &&
        activeFrames.some((frame) => !frame.capabilityCeiling.includes(cutoverCapabilityId));
      const planning = getActivePlanning(liveState);
      const planId = 'document' in planning ? (planning.document?.planId ?? null) : null;
      const existingInvocation = Object.values(liveState.capabilities.invocations).find(
        (invocation) => invocation.toolCallId === toolCallId,
      );
      const budget = liveState.resourceBudget;
      const reservationIds =
        budget.status === 'active'
          ? Object.values(budget.reservations)
              .filter((reservation) => reservation.invocationId.startsWith(`tool:${toolCallId}`))
              .map((reservation) => reservation.reservationId)
          : [];
      const prepareChildReservation = params.beforeAdmissionByToolCallId?.[toolCallId];
      const beforeChildDispatch = params.beforeDispatchByToolCallId?.[toolCallId];
      const settleChildReservation = params.afterDispatchByToolCallId?.[toolCallId];
      if (prepareChildReservation && !settleChildReservation) {
        events.push({
          type: 'tool.failed',
          toolCallId,
          failure: classifyFailure(
            'persistence_unavailable',
            'Child Tool Pipeline reservation settlement is unavailable.',
          ),
        });
        continue;
      }
      let ordinaryChildReservationId: string | undefined;
      let ordinaryAttemptAcknowledged = false;
      let ordinaryChildReservationSettled = false;
      const settleOrdinaryChildBeforeDispatch = async (error?: unknown) => {
        if (
          !ordinaryChildReservationId ||
          !settleChildReservation ||
          ordinaryAttemptAcknowledged ||
          ordinaryChildReservationSettled
        ) {
          return;
        }
        await settleChildReservation({
          reservationId: ordinaryChildReservationId,
          dispatchState: 'not_started',
          ...(error === undefined ? {} : { error }),
        });
        ordinaryChildReservationSettled = true;
      };
      const signal = params.signal ?? new AbortController().signal;
      const preparedShellExecution =
        cutoverExecutionMechanism === 'shell'
          ? appPreparedShellExecutionPortV1(params.shellExecutor)
          : undefined;
      try {
        let ordinaryAttempt = (existingInvocation?.attemptsStarted ?? 0) + 1;
        let allowSafeReadRetry =
          dynamicMcpCutover && dynamicMcpCutoverDescriptor?.execution?.retry === 'safe_read';
        let preDispatchSafeReadRetryConsumed = false;
        const preDispatchStartedAt = Date.now();
        let acknowledgedSkillAttempt:
          | Readonly<{
              readonly prepared: Readonly<PreparedToolInvocationV1>;
              readonly attempt: number;
            }>
          | undefined;
        let skillForkRuntimeIssued = false;
        let outcome: Awaited<ReturnType<typeof ordinaryRuntime.execute>>;
        while (true) {
          ordinaryChildReservationId = undefined;
          ordinaryAttemptAcknowledged = false;
          ordinaryChildReservationSettled = false;
          acknowledgedSkillAttempt = undefined;
          skillForkRuntimeIssued = false;
          const skillFork =
            cutoverOperationId === 'builtin:activate_skill' &&
            cutoverExecutionMechanism === 'skill' &&
            params.taskConfig &&
            params.taskModel
              ? async (fork: AppSkillForkRequestV1): Promise<SubAgentResult | null> => {
                  const acknowledged = acknowledgedSkillAttempt;
                  if (!acknowledged || !ordinaryAttemptAcknowledged || skillForkRuntimeIssued) {
                    return null;
                  }
                  skillForkRuntimeIssued = true;
                  const subagentRuntime = params.subagentRuntimeFactory?.();
                  if (!subagentRuntime) return null;
                  const identity = acknowledged.prepared.identity;
                  if (
                    identity.isDynamicMcp ||
                    identity.operationId !== 'builtin:activate_skill' ||
                    identity.executionMechanism !== 'skill' ||
                    identity.capabilityId !== cutoverCapabilityId ||
                    identity.capabilityRevision !== ordinaryCutoverEntry?.revision ||
                    identity.authorizationDigest === null ||
                    identity.admissionDigest === null ||
                    identity.attemptId !==
                      `${identity.invocationId}:attempt:${acknowledged.attempt}`
                  ) {
                    return null;
                  }
                  return runAppSkillForkV1({
                    params,
                    call,
                    toolCallId,
                    builtinProjection: turn.projection,
                    childToolDispatcher,
                    eventSink: emitSubagentEvent,
                    subagentRuntime,
                    subagentInvocationIdentity: {
                      invocationId: identity.invocationId,
                      attempt: acknowledged.attempt,
                      capabilityRevision: identity.capabilityRevision,
                      authorizationDigest: identity.authorizationDigest,
                      admissionDigest: identity.admissionDigest,
                      effectiveEffectsDigest: identity.effectiveEffectsDigest,
                    },
                    fork,
                  });
                }
              : undefined;
          outcome = await ordinaryRuntime.execute({
            turn,
            snapshot: snapshot.value,
            resolution: Object.freeze({
              currentTurnId: liveState.turn.turnId,
              builtinProjectionRevision: turn.projection.revision,
              dynamicCatalogRevision: createCapabilitySnapshotV1(descriptors).revision,
              availabilityContext: turnContext,
              bindings: Object.freeze([...Object.values(liveState.capabilities.bindings)]),
              descriptors: Object.freeze([...descriptors]),
              disclosures: Object.freeze([...Object.values(liveState.capabilities.disclosures)]),
            }),
            governance: Object.freeze({
              workspace: liveState.session.workspace,
              threadId: liveState.session.threadId,
              context: Object.freeze({
                phase: getAgentPhase(planning),
                interactionMode: getEffectiveInteractionMode(liveState),
                authorizationMode: liveState.authorization.mode,
                ...(liveState.authorization.modeSource
                  ? { authorizationSource: liveState.authorization.modeSource }
                  : {}),
                sandboxAvailable: params.sandboxAvailable === true,
                circuitBreakerTripped: liveState.autoReview.circuitBreakerTripped,
                observedAt: params.authorizationObservedAt ?? 0,
                autoReview: params.authorizationFromAutoReview === true,
                loopMode: params.authorizationFromLoopMode === true,
                gates: Object.freeze({
                  recoveryAdmission:
                    !call.recoveryAdmission || call.recoveryAdmission === 'admitted'
                      ? ('admitted' as const)
                      : ('blocked' as const),
                  boundedCancellation: 'admitted' as const,
                  executionBoundary:
                    params.taskConfig?.executionBoundary &&
                    (cutoverExecutionMechanism === 'catalog' || cutoverExecutionMechanism === 'mcp')
                      ? ('blocked' as const)
                      : ('admitted' as const),
                  skillCapabilityCeiling: skillCeilingBlocked
                    ? ('blocked' as const)
                    : ('admitted' as const),
                }),
              }),
              approval: Object.freeze({
                status: call.status,
                grant: call.approvalGrant ?? 'none',
                approvedToolCallId: call.status === 'approved' ? toolCallId : null,
                approvalBindingDigest:
                  call.status === 'approved' ? (call.approvalHash ?? null) : null,
              }),
            }),
            admission: Object.freeze({
              freshness: 'current' as const,
              reservationRequired: budget.status === 'active',
              reservationIds: Object.freeze(reservationIds),
            }),
            threadId: liveState.session.threadId,
            attempt: ordinaryAttempt,
            allowSafeReadRetry,
            taskId: call.taskId ?? liveState.activeTaskId ?? null,
            planId,
            planStepId: null,
            capabilityRequestFacts:
              cutoverOperationId === 'builtin:tool_search'
                ? createToolSearchProviderFactsV1({
                    threadId: liveState.session.threadId,
                    turnId: liveState.turn.turnId,
                    toolCallId,
                    mcpDescriptors: mcpSnapshot?.descriptors,
                    skillDescriptors: skillSnapshot?.descriptors,
                    providerEntries: params.mcpManager?.getProviderDirectorySnapshot().entries,
                  })
                : Object.freeze({ toolCallId }),
            capabilityExecution,
            signal,
            mechanismResources: Object.freeze({
              workspace: liveState.session.workspace,
              ...(cutoverExecutionMechanism === 'shell'
                ? {
                    onProgress: (chunk: string, stream: 'stdout' | 'stderr') =>
                      params.emitRuntimeEvent?.({
                        type: 'tool.progress',
                        toolCallId,
                        chunk,
                        stream,
                      }),
                  }
                : {}),
              ...(cutoverExecutionMechanism === 'git' && params.gitBroker
                ? { gitBroker: params.gitBroker }
                : {}),
              ...(cutoverExecutionMechanism === 'mcp' && params.mcpManager
                ? {
                    preassembledMechanism: Object.freeze({
                      mcp: Object.freeze({
                        runtime:
                          cutoverOperationId === 'builtin:read_mcp_resource'
                            ? createAppMcpReadinessRuntimeV1({
                                runtime: params.mcpManager as unknown as BuiltinMcpRuntimePortV1,
                                readinessCoordinator: params.providerReadinessCoordinator,
                                getState: params.getRuntimeState,
                                persistEvent: params.persistRuntimeEvent,
                                toolCallId,
                                executionBoundaryDigest: params.taskConfig?.executionBoundary
                                  ? computeExecutionBoundaryDigestV1(
                                      params.taskConfig.executionBoundary,
                                    )
                                  : digestCapabilityValueV1({
                                      schema: 'kite.unsealed-execution-boundary.v1',
                                    }),
                                signal,
                              })
                            : (params.mcpManager as unknown as BuiltinMcpRuntimePortV1),
                      }),
                    }),
                  }
                : {}),
              ...(cutoverExecutionMechanism === 'skill'
                ? {
                    preassembledMechanism: Object.freeze({
                      skill: createRmv111SkillMechanismPortV1({
                        state: liveState,
                        catalog: params.skillCatalog,
                        flags: productionFlags,
                        verificationEnabled:
                          cutoverOperationId !== 'builtin:read_skill_reference' &&
                          Boolean(params.taskConfig) &&
                          productionFlags?.verificationV1 === true,
                        ...(skillFork ? { runFork: skillFork } : {}),
                      }),
                    }),
                  }
                : {}),
              ...(cutoverExecutionMechanism === 'web'
                ? {
                    preassembledMechanism: Object.freeze({
                      web: createRmv111WebMechanismPortV1({
                        toolCallId,
                        ...(params.taskConfig?.executionBoundary
                          ? {
                              networkBoundaryPolicy: networkBoundaryPolicyFromExecutionBoundaryV1(
                                params.taskConfig.executionBoundary,
                                productionFlags?.networkBoundaryV1 === true,
                              ),
                            }
                          : {}),
                        ...(params.recordNetworkDecision
                          ? { recordNetworkDecision: params.recordNetworkDecision }
                          : {}),
                      }),
                    }),
                  }
                : {}),
              ...(cutoverExecutionMechanism === 'planning' && planArtifacts
                ? {
                    preassembledMechanism: Object.freeze({
                      planning: createPlanRuntimeV1({
                        state: liveState,
                        artifacts: planArtifacts,
                        modelMessageId: call.modelMessageId,
                        ordinal: call.ordinal,
                        deferPlanReviewSiblingCancellation: true,
                      }),
                    }),
                  }
                : {}),
            }),
            ...(dynamicMcpCutover && dynamicMcpCutoverDescriptor && params.mcpManager
              ? {
                  prepareMechanism: async ({
                    canonicalArguments,
                  }: {
                    readonly canonicalArguments: RuntimeJsonValueV1;
                  }) => {
                    let mechanismResources: Awaited<
                      ReturnType<typeof prepareDynamicMcpMechanismV1>
                    >;
                    while (true) {
                      try {
                        mechanismResources = await prepareDynamicMcpMechanismV1({
                          descriptor: dynamicMcpCutoverDescriptor,
                          manager: params.mcpManager!,
                          flags: productionFlags ?? getFeatureFlags(),
                          providerReadinessCoordinator: params.providerReadinessCoordinator,
                          getRuntimeState: params.getRuntimeState,
                          persistRuntimeEvent: params.persistRuntimeEvent,
                          taskConfig: params.taskConfig,
                          threadId: liveState.session.threadId,
                          toolCallId,
                          signal,
                          workspace: liveState.session.workspace,
                          canonicalArguments,
                          retryAuthorized: preDispatchSafeReadRetryConsumed,
                        });
                        break;
                      } catch (error) {
                        if (
                          preDispatchSafeReadRetryConsumed ||
                          !allowSafeReadRetry ||
                          !isMcpProviderError(error) ||
                          error.retryable !== true
                        ) {
                          throw error;
                        }
                        if (!params.persistRuntimeEvent) {
                          throw new ProviderReadinessPersistenceError(
                            'Dynamic MCP safe-read retry requires State persistence.',
                          );
                        }
                        const failure = classifyMcpProviderError(error);
                        const invocationFingerprint =
                          call.invocationFingerprint ??
                          toolInvocationFingerprintV1({
                            toolName: call.name,
                            parsedArgs: call.args,
                          });
                        const baseOutcome = runtimeHostStateClassifyToolOutcomeV1({
                          status: 'failed',
                          failure,
                          authority: {
                            dispatchState: 'not_started',
                            externalEffects: 'none',
                            replaySafety: 'pre_dispatch',
                          },
                          toolAdvice: {
                            disposition: 'retry_once',
                            maximumAdditionalCalls: 1,
                            safeAutomaticRetry: true,
                          },
                          timing: {
                            executionMs: Math.max(0, Date.now() - preDispatchStartedAt),
                            totalActiveMs: Math.max(0, Date.now() - preDispatchStartedAt),
                          },
                        });
                        if (!baseOutcome.recovery.safeAutomaticRetry) throw error;
                        const recoveryOf = toolFailureInstanceIdV1({
                          toolCallId,
                          invocationFingerprint,
                          outcome: baseOutcome,
                        });
                        const persisted = await params.persistRuntimeEvent({
                          type: 'tool.retry_recorded',
                          toolCallId,
                          failure,
                          outcomeV1: {
                            ...baseOutcome,
                            lineage: { failureInstanceId: recoveryOf },
                          },
                          recoveryOf,
                          retryAttempt: 1,
                        });
                        if (!persisted) {
                          throw new ProviderReadinessPersistenceError(
                            'Dynamic MCP safe-read retry evidence became stale.',
                          );
                        }
                        preDispatchSafeReadRetryConsumed = true;
                        allowSafeReadRetry = false;
                      }
                    }
                    if (params.persistRuntimeEvent) {
                      const readinessCall = (params.getRuntimeState?.() ?? liveState).tools.calls[
                        toolCallId
                      ];
                      if (
                        readinessCall?.status === 'queued' ||
                        readinessCall?.status === 'approved'
                      ) {
                        const persisted = await params.persistRuntimeEvent({
                          type: 'tool.started',
                          toolCallId,
                          createdAt: new Date().toISOString(),
                        });
                        if (!persisted) {
                          throw new AppToolPipelinePersistenceErrorV1(
                            'Dynamic MCP tool start acknowledgement became stale before dispatch.',
                          );
                        }
                      } else if (readinessCall?.status !== 'running') {
                        throw new AppToolPipelinePersistenceErrorV1(
                          'Dynamic MCP tool lifecycle changed before dispatch.',
                        );
                      }
                    }
                    return mechanismResources;
                  },
                }
              : {}),
            ...(cutoverExecutionMechanism === 'filesystem' && params.workspaceFilesystemRuntime
              ? {
                  workspaceFilesystem: Object.freeze({
                    runtime: params.workspaceFilesystemRuntime,
                    protectedPathEvaluator: createProtectedPathEvaluatorV1({
                      workspaceRoot:
                        params.taskConfig?.executionBoundary?.workspaceRoot ??
                        params.workspaceFilesystemRuntime.canonicalWorkspace,
                      mode: params.taskConfig?.executionBoundary?.protectedPathPolicy ?? 'deny',
                    }),
                    protectedPathRevision: params.taskConfig?.executionBoundary
                      ? computeExecutionBoundaryDigestV1(params.taskConfig.executionBoundary)
                      : 'protected-path-unconfigured-v1',
                    actorIdentity: Object.freeze({
                      threadId: liveState.session.threadId,
                      actorId: params.toolActorIds?.[toolCallId] ?? 'parent',
                    }),
                    ...(params.recordFilePreimage
                      ? {
                          checkpointProjection: Object.freeze({
                            recordPreimage: params.recordFilePreimage,
                            ...(params.recordFilePreimage.recordPostimage
                              ? { recordPostimage: params.recordFilePreimage.recordPostimage }
                              : {}),
                          }),
                        }
                      : {}),
                    now: () => new Date(),
                  }),
                }
              : {}),
            ...(cutoverExecutionMechanism === 'shell' &&
            preparedShellExecution &&
            params.sandboxPreparationArtifacts
              ? {
                  shell: Object.freeze({
                    execution: preparedShellExecution,
                    artifacts: params.sandboxPreparationArtifacts,
                  }),
                }
              : {}),
            ...(prepareChildReservation ||
            beforeChildDispatch ||
            settleChildReservation ||
            cutoverExecutionMechanism === 'shell' ||
            cutoverOperationId === 'builtin:activate_skill'
              ? {
                  lifecycle: Object.freeze({
                    ...(prepareChildReservation
                      ? {
                          prepareAdmission: async () => {
                            const prepared = await prepareChildReservation();
                            const admissionState = (params.getRuntimeState?.() ??
                              liveState) as RuntimeState;
                            const admissionBudget = admissionState.resourceBudget;
                            if (
                              admissionBudget.status === 'active' &&
                              !isCurrentExactChildToolReservationV1(
                                admissionState,
                                prepared.reservationId,
                                call.name,
                              )
                            ) {
                              throw new DescendantResourceAdmissionError(
                                'reconciliation_required',
                                'Child Tool Pipeline reservation is not the current exact durable child reservation.',
                              );
                            }
                            ordinaryChildReservationId = prepared.reservationId;
                            return Object.freeze({
                              freshness: 'current' as const,
                              reservationRequired: admissionBudget.status === 'active',
                              reservationIds: Object.freeze(
                                admissionBudget.status === 'active' ? [prepared.reservationId] : [],
                              ),
                            });
                          },
                        }
                      : {}),
                    beforeDispatch: async (attempt: number) => {
                      ordinaryAttemptAcknowledged = true;
                      await beforeChildDispatch?.(attempt, ordinaryChildReservationId);
                    },
                    ...(cutoverOperationId === 'builtin:activate_skill'
                      ? {
                          afterAcknowledgement: async ({
                            attempt,
                            prepared,
                          }: {
                            readonly attempt: number;
                            readonly prepared: Readonly<PreparedToolInvocationV1>;
                          }) => {
                            acknowledgedSkillAttempt = Object.freeze({ prepared, attempt });
                          },
                        }
                      : {}),
                    ...(settleChildReservation
                      ? {
                          afterDispatch: async (settlement: {
                            readonly attempt: number;
                            readonly result?: Readonly<
                              import('@kite/builtin-runtime').BuiltinOperationExecutionValueV1
                            >;
                            readonly error?: unknown;
                          }) => {
                            ordinaryAttemptAcknowledged = true;
                            const value = settlement.result;
                            const result: ToolExecutionResult | undefined = value
                              ? {
                                  ok: value.ok,
                                  command: call.name,
                                  exitCode: value.ok ? 0 : -1,
                                  stdout: value.stdout,
                                  stderr: value.stderr,
                                  status: value.ok ? 'success' : 'error',
                                  ...(typeof value.path === 'string' ? { path: value.path } : {}),
                                }
                              : undefined;
                            await settleChildReservation({
                              attempt: settlement.attempt,
                              reservationId: ordinaryChildReservationId,
                              dispatchState: 'started',
                              ...(result ? { result } : {}),
                              ...(settlement.error === undefined
                                ? {}
                                : { error: settlement.error }),
                            });
                            ordinaryChildReservationSettled = true;
                          },
                        }
                      : {}),
                  }),
                }
              : {}),
          });
          if (outcome.kind !== 'retryable') break;
          if (ordinaryChildReservationId && !ordinaryChildReservationSettled) {
            throw new DescendantResourceAdmissionError(
              'reconciliation_required',
              'Child Tool Pipeline retry evidence committed without exact reservation settlement.',
            );
          }
          ordinaryAttempt += 1;
          allowSafeReadRetry = false;
        }
        if (outcome.kind === 'committed' || outcome.kind === 'suspended') {
          if (ordinaryChildReservationId && !ordinaryChildReservationSettled) {
            throw new DescendantResourceAdmissionError(
              'reconciliation_required',
              'Child Tool Pipeline dispatch completed without exact reservation settlement.',
            );
          }
          continue;
        }
        await settleOrdinaryChildBeforeDispatch();
        if (outcome.kind === 'governance_terminal') {
          if (outcome.decision.kind === 'reject') {
            const recovery = outcome.classified.policyCompilation.recovery;
            events.push(
              recovery
                ? policyRecoveryTerminalV1({
                    toolCallId,
                    toolName: call.name,
                    rawArguments: call.args,
                    reason: outcome.decision.reason,
                    recovery,
                  })
                : {
                    type: 'tool.rejected',
                    toolCallId,
                    reason: outcome.decision.reason,
                    failure: classifyFailure(outcome.decision.failureKind, outcome.decision.reason),
                  },
            );
            continue;
          }
          if (outcome.decision.kind === 'request_user_input') {
            if (cutoverExecutionMechanism !== 'user_input') {
              events.push({
                type: 'tool.failed',
                toolCallId,
                failure: classifyFailure(
                  'mandatory_policy_unavailable',
                  'Tool governance emitted user input for a non-interrupt operation.',
                ),
              });
              continue;
            }
            events.push({
              type: 'user_input.requested',
              interactionId: genInteractionId(),
              toolCallId,
              request: normalizeAskUserRequestV1(outcome.classified.validated.request.arguments),
            });
            continue;
          }
          if (
            outcome.decision.kind === 'request_approval' ||
            outcome.decision.kind === 'request_auto_review'
          ) {
            const request = pendingToolRequestFromValidatedInvocationV1(
              outcome.classified.validated,
              turn.projection,
            );
            const approvalBindingDigest = runtimeHostStateCreateApprovalBindingDigestV1(
              outcome.facts.invocation,
              outcome.facts.policy,
            );
            const governingDescriptor =
              outcome.classified.validated.nestedCapability?.descriptor ??
              (outcome.classified.validated.resolved.target.executionFamily === 'mcp'
                ? outcome.classified.validated.resolved.target.descriptor
                : undefined);
            const approval = buildToolApproval({
              workspace: liveState.session.workspace,
              threadId: liveState.session.threadId,
              request,
              decision: outcome.decision.decision,
              approvalBindingDigest,
              ...(governingDescriptor
                ? {
                    capability: {
                      capabilityId: governingDescriptor.capabilityId,
                      capabilityRevision: governingDescriptor.revision,
                      effectiveEffects: governingDescriptor.effectiveEffects,
                    },
                  }
                : {}),
            });
            bindAppApprovalBindingV1(approval, {
              digest: approvalBindingDigest,
              invocationFact: outcome.facts.invocation,
              policyFact: outcome.facts.policy,
            });
            if (outcome.decision.kind === 'request_auto_review') {
              events.push({
                type: 'auto_review.requested',
                reviewId: genInteractionId(),
                toolCallId,
                toolName: request.name,
                reason: outcome.decision.decision.reason,
                approval,
              });
            } else {
              events.push({
                type: 'approval.requested',
                interactionId: genInteractionId(),
                toolCallId,
                approval,
              });
            }
            continue;
          }
        }
        const diagnostic =
          outcome.kind === 'stage_failure'
            ? `Tool Pipeline ${outcome.failure.stage} failed: ${outcome.failure.code}.${
                outcome.failure.diagnostic ? ` ${outcome.failure.diagnostic}` : ''
              }`
            : outcome.kind === 'governance_failure'
              ? outcome.diagnostic
              : 'Ordinary Tool Pipeline emitted an unsupported governance terminal.';
        const failure =
          outcome.kind === 'stage_failure' &&
          outcome.failure.stage === 'resolve' &&
          (outcome.failure.code === 'unknown_tool' || outcome.failure.code === 'tool_unavailable')
            ? classifyFailure('tool_not_found', diagnostic, outcome.failure.code)
            : classifyFailure(
                outcome.kind === 'stage_failure' && outcome.failure.stage === 'validate'
                  ? 'tool_invalid_args'
                  : 'mandatory_policy_unavailable',
                diagnostic,
                outcome.kind === 'stage_failure' &&
                  outcome.failure.stage === 'validate' &&
                  outcome.failure.code === 'invalid_arguments'
                  ? 'invalid_arguments'
                  : undefined,
              );
        events.push({
          type: 'tool.failed',
          toolCallId,
          failure,
        });
      } catch (error) {
        await settleOrdinaryChildBeforeDispatch(error);
        if (error instanceof DescendantResourceAdmissionError) throw error;
        const after = params.getRuntimeState?.().tools.calls[toolCallId];
        if (after && !['queued', 'approved', 'running'].includes(after.status)) continue;
        const failure =
          dynamicMcpCutover && isMcpProviderError(error)
            ? classifyMcpProviderError(error)
            : classifyFailure(
                'persistence_unavailable',
                dynamicMcpCutover
                  ? error instanceof ProviderReadinessPersistenceError ||
                    error instanceof ProviderReadinessUnknownError
                    ? error.message
                    : error instanceof Error
                      ? error.message
                      : String(error)
                  : 'Ordinary Tool Pipeline attempt failed closed without fallback.',
              );
        events.push({
          type: 'tool.failed',
          toolCallId,
          failure,
        });
      }
      continue;
    }
    if (ordinaryCutoverEntry?.executionMechanism === 'filesystem') {
      events.push({
        type: 'tool.failed',
        toolCallId,
        failure: classifyFailure(
          'mandatory_policy_unavailable',
          'Workspace filesystem operations require the acknowledged Host/Builtin Tool Pipeline.',
        ),
      });
      continue;
    }
    if (!params.builtinToolCatalog) {
      events.push({
        type: 'tool.failed',
        toolCallId,
        failure: classifyFailure(
          'mandatory_policy_unavailable',
          'Builtin Runtime catalog projection is unavailable.',
        ),
      });
      continue;
    }
    events.push({
      type: 'tool.failed',
      toolCallId,
      failure: classifyFailure(
        'tool_not_found',
        `Tool '${call.name}' is not available in the Builtin Runtime catalog.`,
      ),
    });
  }
  return events;
}

function projectInstructionGuardFailureV1(input: {
  readonly state: RuntimeState;
  readonly modelMessageId: string | undefined;
  readonly config: AgentConfig | undefined;
  readonly entry: BuiltinModelToolCatalogEntryV1;
  readonly argumentOrigin: 'model_public' | 'runtime_private';
  readonly rawArguments: unknown;
}): string | null {
  if (!input.config || !getFeatureFlags(input.config).promptContractV2) return null;
  const parsed =
    input.argumentOrigin === 'runtime_private'
      ? input.entry.parse(input.rawArguments)
      : input.entry.parseModelInput(input.rawArguments);
  if (!parsed.success) return null;
  const parser =
    input.argumentOrigin === 'runtime_private'
      ? input.entry.parser
      : (input.entry.modelParser ?? input.entry.parser);
  const canonicalArguments = parser.canonicalize(parsed.data);
  if (!isRuntimeJsonRecordV1(canonicalArguments)) return null;
  const classifiedEffects = input.entry.classifyEffects(canonicalArguments);
  const target = projectProjectInstructionGuardTargetV1({
    executionMechanism: input.entry.executionMechanism,
    declaredFilesystemEffect: input.entry.descriptor.declaredEffects.filesystem,
    effectiveFilesystemEffect: classifiedEffects.effectiveEffects.filesystem,
    canonicalArguments,
  });
  if (!target) return null;
  const visibleSnapshot = visibleProjectInstructions(
    input.state,
    input.modelMessageId,
    input.config,
  );
  if (!visibleSnapshot) return null;
  const guard = checkProjectInstructionSnapshotFreshnessV1({
    workspace: input.state.session.workspace,
    visibleSnapshot,
    target,
  });
  return guard.status === 'changed' ? guard.message : null;
}

/**
 * App-side composition check for the release-pinned execution surface.  The
 * descriptor/effect decision remains owned by Builtin; this bridge only binds
 * that decision to the exact production config before a Host attempt or
 * Provider lookup can occur.
 */
function productionExecutionSurfaceFailureV1(input: {
  readonly config: AgentConfig | undefined;
  readonly workspace: string;
  readonly descriptor: Readonly<CapabilityDescriptor> | undefined;
  readonly executionMechanism: string;
  readonly rawArguments: unknown;
}): string | null {
  const config = input.config;
  if (!config) return null;
  const surface = config.executionCapabilitySurface;
  if ('productionExecution' in config && (!config.executionBoundary || !surface)) {
    return 'Rejected by production execution boundary: protected-path gate is unavailable.';
  }
  if (!surface) return null;
  if (!input.descriptor) {
    return 'Rejected by production execution boundary: capability descriptor is unavailable.';
  }

  const argumentsRecord = isPlainRecordV1(input.rawArguments) ? input.rawArguments : undefined;
  const pathArgument = typeof argumentsRecord?.path === 'string' ? argumentsRecord.path : '';
  const outsideWorkspace = pathArgument
    ? isOutsideProductionWorkspaceV1(input.workspace, pathArgument)
    : false;
  if (
    (outsideWorkspace && input.executionMechanism !== 'filesystem') ||
    !isDescriptorAdmittedByExecutionCapabilitySurfaceV1({
      surface,
      descriptor: input.descriptor,
    })
  ) {
    const reason =
      surface.process === false && surface.write === false
        ? 'tool is not in the sealed read-only catalog'
        : 'capability is outside the admitted execution surface';
    return `Rejected by production execution boundary: ${reason}.`;
  }
  return null;
}

function isOutsideProductionWorkspaceV1(workspace: string, pathArgument: string): boolean {
  const normalized = expandHomeRelativePath(msys2ToWindowsPath(pathArgument));
  const target = isAbsolute(normalized) ? resolve(normalized) : resolve(workspace, normalized);
  return !isPathInsideWorkspace(workspace, target);
}

/** Preserve the existing State MCP network terminal without consulting the
 * Provider or inventing a new serialized event shape. */
function sealedMcpNetworkTerminalV1(input: {
  readonly config: AgentConfig | undefined;
  readonly toolCallId: string;
  readonly toolName: string;
}): RuntimeEvent | null {
  const boundary = input.config?.executionBoundary;
  if (!boundary) return null;
  const policy = networkBoundaryPolicyFromExecutionBoundaryV1(
    boundary,
    getFeatureFlags(input.config).networkBoundaryV1 === true,
  );
  const message =
    'MCP execution is unavailable under the sealed network boundary until its transport uses per-invocation endpoint admission.';
  return {
    type: 'tool.finished',
    toolCallId: input.toolCallId,
    name: input.toolName,
    result: {
      ok: false,
      command: input.toolName,
      exitCode: -1,
      stdout: '',
      stderr: message,
      status: 'error',
      resultMeta: {
        networkPolicyRevision: policy.revision,
        networkAdmissionDigests: [],
        networkFailureCode: 'controller_unavailable',
      },
    },
    classifierAdviceV1: {
      detailCode: 'controller_unavailable',
      disposition: 'never',
      maximumAdditionalCalls: 0,
      safeAutomaticRetry: false,
    },
  };
}

/** Mechanically retain recovery facts emitted by the Builtin policy owner.
 * This is a failed terminal, not a dispatch or a fallback. */
function policyRecoveryTerminalV1(input: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly rawArguments: unknown;
  readonly reason: string;
  readonly recovery: Readonly<import('@kite/runtime-spi').CapabilityPolicyRecoveryV1>;
}): RuntimeEvent {
  const argumentsRecord = isPlainRecordV1(input.rawArguments) ? input.rawArguments : undefined;
  const command =
    typeof argumentsRecord?.command === 'string' ? argumentsRecord.command : input.toolName;
  const nextCapability =
    input.recovery.capabilityIntent === 'git_inspect' ? ('git_inspect' as const) : undefined;
  const disposition =
    input.recovery.disposition === 'never'
      ? ('never' as const)
      : input.recovery.disposition === 'retry'
        ? ('retry_once' as const)
        : input.recovery.disposition === 'redirect'
          ? ('alternative' as const)
          : ('user_action' as const);
  const maximumAdditionalCalls = input.recovery.maximumAdditionalCalls === 1 ? 1 : 0;
  return {
    type: 'tool.finished',
    toolCallId: input.toolCallId,
    name: input.toolName,
    result: {
      ok: false,
      command,
      exitCode: -1,
      stdout: '',
      stderr: input.reason,
      status: 'error',
      ...(nextCapability ? { resultMeta: { nextCapability } } : {}),
    },
    classifierAdviceV1: {
      disposition,
      maximumAdditionalCalls,
      safeAutomaticRetry: input.recovery.safeAutomaticRetry,
      ...(input.recovery.capabilityIntent
        ? { capabilityIntent: input.recovery.capabilityIntent }
        : {}),
    },
  };
}

function isRuntimeJsonRecordV1(
  value: RuntimeJsonValueV1,
): value is Readonly<Record<string, RuntimeJsonValueV1>> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function visibleProjectInstructions(
  state: RuntimeState,
  modelMessageId: string | undefined,
  config: AgentConfig | undefined,
) {
  if (!config || !getFeatureFlags(config).promptContractV2) return undefined;
  return resolveProjectInstructionSnapshot({
    workspace: state.session.workspace,
    state,
    excludeModelMessageId: modelMessageId,
  });
}
