import { AGENT_KERNEL_BOUNDARY_ } from '@kite/agent-kernel';
import { RUNTIME_CONTRACT_BOUNDARY_ } from '@kite/runtime-contract';
import {
  type CapabilityRegistrySnapshot,
  type ContextCompilerPort,
  createRuntimeModuleRegistry,
  type RuntimeModule,
  type RuntimeModuleRegistry,
} from '@kite/runtime-spi';
import { DefaultRuntimeHost, type RuntimeHost } from './runtime-host';
import type { RuntimeStorage, RuntimeStorageBoundary } from './storage';

export type {
  AgentToolCallState as StateToolCallRecord,
  AuthorizationSource as StateAuthorizationSource,
  ExecutionTraits as StateExecutionTraits,
  RuntimeEffect as StateRuntimeEffect,
  RuntimeEvent as StateRuntimeEvent,
  RuntimeState as StateRuntimeState,
  SchedulerFacts as StateRuntimeSchedulerFacts,
} from '@kite/agent-kernel';
export { bestEffortRegularFileSize } from './artifact-metadata';
export type { RuntimeHostCapabilityExecutionFailureCode } from './capability-execution';
export {
  createRuntimeHostCapabilityExecutionPort,
  RuntimeHostCapabilityExecutionError,
} from './capability-execution';
export type {
  RuntimeHostContextCompilationPort,
  RuntimeHostContextCompilationRequest,
} from './context-compilation';
export { createRuntimeHostContextCompilationPort } from './context-compilation';
export { createRuntimeControlFrame, verifyRuntimeControlFrame } from './control-frame';
export type {
  RuntimeHostExecutionServices,
  RuntimeHostLeasePort,
  RuntimeHostTransactionPort,
  RuntimeLeaseRequirement,
  RuntimeTransactionAcknowledgement,
} from './effect-supervisor';
export type {
  RuntimeHostExecutionAdapterContext,
  RuntimeHostExecutionBridge,
  RuntimeHostPreparedExecution,
} from './execution-bridge';
export { RUNTIME_HOST_EXECUTION_ADAPTER_ID_ } from './execution-bridge';
export type { RuntimeCommandKernelEvent, RuntimeHostKernelInput } from './kernel-input';
export {
  runtimeCommandFromKernelInput,
  runtimeCommandSessionId,
  translateRuntimeCommandToKernelInput,
} from './kernel-input';
export { runMcpStdioChildRuntime } from './mcp-stdio-child-runtime';
export {
  createRuntimeHostMcpStdioProcessPort,
  decodeUtf8Strict,
  isMcpStdioWrapperInvocation,
  MCP_STDIO_CONTROL_DOMAIN_,
  MCP_STDIO_HOST_PEER_ID_,
  MCP_STDIO_MAX_LINE_BYTES_,
  MCP_STDIO_MAX_TOTAL_OUTPUT_BYTES_,
  MCP_STDIO_STARTUP_TIMEOUT_MS_,
  MCP_STDIO_WRAPPER_ENTRYPOINT_,
  MCP_STDIO_WRAPPER_PEER_ID_,
  parseMcpStdioJsonLine,
  type RuntimeHostMcpStdioCleanup,
  type RuntimeHostMcpStdioProcessHandle,
  type RuntimeHostMcpStdioProcessLaunch,
  type RuntimeHostMcpStdioProcessPort,
  type RuntimeHostMcpStdioProcessPortOptions,
  type RuntimeHostMcpStdioReady,
  type RuntimeHostMcpStdioTerminal,
  sanitizeMcpStdioEnvironment,
} from './mcp-stdio-process';
export type {
  MetricAttributeKey,
  MetricAttributes,
  MetricControlledAliasRegistry,
  MetricDefinition,
  MetricDynamicAliasKey,
  MetricKind,
  MetricName,
  MetricPriority,
  MetricPrivacy,
  MetricSample,
} from './observability/metrics';
export {
  createMetricSample,
  MAX_METRIC_SAMPLE_BYTES_,
  METRIC_ATTRIBUTE_KEYS,
  METRIC_DEFINITIONS_,
  metricPriority,
  OBSERVABILITY_METRICS_VERSION,
  parseMetricSample,
} from './observability/metrics';
export type {
  MetricExporter,
  MetricReporter,
  MetricReporterStatus,
} from './observability/reporter';
export {
  BoundedMetricQueue,
  BufferedMetricReporter,
  NoopMetricReporter,
} from './observability/reporter';
export {
  buildPosixSupervisorEnvironment,
  executePosixSupervised,
  type RuntimeHostPreparedProcessInput,
  type RuntimeHostPreparedProcessResult,
  type RuntimeHostSandboxExecutionDispatchRecord,
  type RuntimeHostSandboxPreparationLifecycle,
  reconcilePosixSupervisor,
  terminatePosixSupervisor,
} from './posix-supervisor';
export { runPosixSupervisorChild } from './posix-supervisor-child-runtime';
export {
  type PosixSupervisorIdentity,
  posixProcessIdentityBindsGroup,
  posixSupervisorIdentityPath,
  readComparablePosixProcessStartIdentity,
  readPosixSupervisorIdentity,
  writePosixSupervisorIdentity,
} from './posix-supervisor-identity';
export {
  confirmPosixSupervisorLockReleased,
  createPosixSupervisorLock,
  type PosixSupervisorLockHandle,
  type PosixSupervisorLockIdentity,
  posixSupervisorLockPath,
  verifyInheritedPosixSupervisorLock,
} from './posix-supervisor-lock';
export {
  createRuntimeHostProcessExecutionPort,
  type RuntimeHostProcessExecutionPort,
  type RuntimeHostProcessHandle,
  type RuntimeHostProcessTermination,
  type RuntimeHostProcessTree,
} from './process-execution-port';
export { readRuntimeHostProcessOutput } from './process-output';
export { spawnRuntimeHostProcess } from './process-spawn';
export {
  guardProcessTree,
  type ProcessTreeGuard,
  type ProcessTreeTerminationResult,
  processTreeSpawnOptions,
} from './process-tree';
export { resolveProjectIdentity } from './project-identity';
export type { RuntimeHost, RuntimeHostCoordinatorPort } from './runtime-host';
export type { RuntimeIdScope, RuntimeIdSource } from './runtime-id-source';
export {
  createDeterministicRuntimeIdSource,
  createLiveRuntimeIdSource,
  RUNTIME_ID_SOURCE_REVISION_,
} from './runtime-id-source';
export {
  createRuntimeHostInteractionId,
  createRuntimeHostTurnId,
} from './runtime-identity';
export type { RuntimeAuthorizationElevationFacts } from './runtime-policy';
export {
  assertRuntimeAuthorizationElevation,
  projectRuntimeObservabilityFact,
} from './runtime-policy';
export {
  createRuntimeHostSandboxPreparationLifecycle,
  createRuntimeHostSandboxPreparedProcessExecutionPort,
  RuntimeHostSandboxLifecycleError,
  type RuntimeHostSandboxLifecycleEvidence,
  type RuntimeHostSandboxLifecycleEvidencePort,
  type RuntimeHostSandboxLifecycleEvidenceVerificationResult,
  type RuntimeHostSandboxLifecycleFailureCode,
  type RuntimeHostSandboxLifecyclePersistence,
  type RuntimeHostSandboxSupervisorPort,
} from './sandbox-preparation-lifecycle';
export type { RuntimeActionEmission } from './state-action-emission';
export { acceptRuntimeAction, rejectRuntimeAction } from './state-action-emission';
export type {
  RuntimeHostStateVerifiedApprovalBindingInput,
  StateToolGovernanceInvocationFact,
  StateToolGovernancePolicyFact,
} from './state-approval-binding';
export {
  runtimeHostStateCreateApprovalBindingDigest,
  runtimeHostStateVerifyApprovalBindingDigest,
} from './state-approval-binding';
export type {
  StateApprovalGrant,
  StateAuthorizationState,
} from './state-authorization';
export {
  runtimeHostStateApplyApprovalGrant,
  runtimeHostStateAuthorizationCommandGrantKey,
  runtimeHostStateDefaultAuthorization,
  runtimeHostStateDefaultPhaseForWorkspaceAccess,
  runtimeHostStateGrantSameCommand,
  runtimeHostStateHasSameCommandGrant,
  runtimeHostStateNormalizeAuthorization,
} from './state-authorization';
export type {
  StateDoomLoopCheck,
  StateDoomLoopRequest,
  StateDoomLoopTrackerEntry,
} from './state-doom-loop';
export {
  runtimeHostStateCheckDoomLoopFingerprint,
  runtimeHostStateToolDoomLoopFingerprint,
  runtimeHostStateUpdateDoomLoopTracker,
} from './state-doom-loop';
export type {
  StateRuntimeEffectDeferred,
  StateRuntimeEffectEventSink,
  StateRuntimeEffectExecutionContext,
  StateRuntimeEffectExecutor,
  StateRuntimeEffectLease,
  StateRuntimeEffectPersistenceAcknowledgement,
} from './state-effect-runtime';
export {
  deferredStateRuntimeEffect,
  isStateRuntimeEffectDeferred,
} from './state-effect-runtime';
export {
  runtimeHostStateAdmitCurrentRuntimeEvent,
  runtimeHostStateAssertCurrentRuntimeEvent,
} from './state-event-codec';
export type {
  StateClassifiedFailure,
  StateFailureKind,
  StateTerminalReasonCode,
  StateToolParseFailureCode,
} from './state-failure';
export {
  runtimeHostStateClassifyFailure,
  runtimeHostStateFailureKindForToolParseFailure,
  runtimeHostStateIsFailureKind,
  runtimeHostStateTerminalReasonForFailure,
} from './state-failure';
export type {
  RuntimeHostStateInitialStateInput,
  RuntimeState,
  TaskState,
  ToolCallRecord,
  ToolCallStatus,
  ToolResultMeta,
} from './state-initial';
export {
  createRuntimeHostStateInitialState,
  getActivePlanning,
  getActiveTask,
  getEffectiveInteractionMode,
  RUNTIME_STATE_FORMAT_EPOCH,
  RUNTIME_STATE_SCHEMA_VERSION,
  setActivePlanning,
} from './state-initial';
export {
  runtimeHostStateDecideReadPlanCommand,
  runtimeHostStateDecideUpdatePlanCommand,
  runtimeHostStateDecideWritePlanCommand,
  runtimeHostStateEmptyPlanCompletionEvidence,
  runtimeHostStatePlanCommandFacts,
  runtimeHostStatePlanCompletionBlocker,
  runtimeHostStatePlanReviewSiblingCancellations,
  runtimeHostStateProjectPlanCompletionEvidence,
} from './state-plan-command';
export type {
  RuntimeHostStateRestartRecoveryFacts,
  StateToolRecoveryJournal,
} from './state-recovery';
export {
  isRuntimeHostStateToolRecoveryInvalid,
  projectRuntimeHostStateRestartRecoveryEvents,
  runtimeHostStateAdmitRecoveryAttempt,
  runtimeHostStateAdvanceToolRecoveryResponse,
  runtimeHostStateCreateToolRecoveryJournal,
  runtimeHostStateDecideAutoReview,
  runtimeHostStateNormalizeToolRecoveryJournal,
  runtimeHostStateRecordRecoveryFailure,
  runtimeHostStateRecordRecoveryInvocation,
  runtimeHostStateRecordToolOwnedProgress,
  runtimeHostStateRestartRecoveryCapabilityInvocationIds,
  runtimeHostStateToolFailureInstanceId,
  runtimeHostStateToolInvocationFingerprint,
  runtimeHostStateToolRecoveryJournalInvalid,
} from './state-recovery';
export type {
  DescendantBudgetReservation,
  DescendantResourceAdmission,
  ModelResourcePreparationPlan,
  RuntimeBudgetAdmissionPlan,
  RuntimeBudgetAdmissionReason,
} from './state-resource-admission';
export {
  actualUsageForReservation,
  createDescendantResourceAdmission,
  DescendantResourceAdmissionError,
  planModelInvocationResource,
  planRuntimeBudgetAdmission,
  reconciliationEventsForReservations,
} from './state-resource-admission';
export type {
  ActiveResourceBudgetRuntimeState,
  BudgetReservation,
  BudgetReservationState,
  ConcurrencyWaiter,
  ResourceBudget,
  ResourceBudgetConfiguredEvent,
  ResourceBudgetDispatchStartedEvent,
  ResourceBudgetEvent,
  ResourceBudgetReconciledEvent,
  ResourceBudgetReleasedEvent,
  ResourceBudgetReservedEvent,
  ResourceBudgetRuntimeState,
  ResourceBudgetUnknownEvent,
  ResourceBudgetWaiterCancelledEvent,
  ResourceBudgetWaiterEnqueuedEvent,
  ResourceBudgetWaiterPromotedEvent,
  ResourceBudgetWaiterTimedOutEvent,
  ResourceUsage,
} from './state-resource-budget';
export {
  assertResourceBudget,
  assertResourceBudgetRuntimeState,
  assertResourceUsage,
  committedResourceUsage,
  createUnconfiguredResourceBudgetState,
  createZeroResourceUsage,
  INTERNAL_RESOURCE_BUDGET_,
  LIMITED_RESOURCE_BUDGET_,
  RESOURCE_BUDGET_VERSION,
  reduceResourceBudgetState,
  tightenResourceBudget,
} from './state-resource-budget';
export type {
  StateRuntimeRestoreInput,
  StateRuntimeRestoreResult,
  StateRuntimeRestoreSource,
} from './state-restore';
export { restoreRuntimeHostStateSession } from './state-restore';
export type {
  StateRuntimeConcurrentEffectEventCurrent,
  StateRuntimeConcurrentEffectStateProjector,
  StateRuntimeEventBatchAdmissionValidator,
  StateRuntimeEventBatchPreprocessor,
  StateRuntimeNamedTurnSnapshotInput,
  StateRuntimeProcessEventBatchOptions,
  StateRuntimeProcessEventResult,
  StateRuntimeSession,
  StateRuntimeSessionClock,
  StateRuntimeSessionEffectLease,
  StateRuntimeSessionEventContext,
  StateRuntimeSessionIdSource,
  StateRuntimeSessionInput,
  StateRuntimeToolTerminalBatchValidator,
  StateRuntimeVerificationAdmission,
} from './state-session';
export {
  createRuntimeHostStateSession,
  STATE_RUNTIME_SESSION_FORMAT_,
} from './state-session';
export type { RuntimeHostStateStorageBinding } from './state-storage';
export { createRuntimeHostStateStorageBinding } from './state-storage';
export type {
  StateFailureModeContext,
  StateFailureModeDisposition,
  StateFailureModeDurableState,
  StateFailureModeFallback,
  StateFailureModeResolution,
  StateRunTerminalOutcome,
  StateRuntimeFailureMode,
  StateRuntimeTerminalStatus,
} from './state-terminal';
export {
  runtimeHostStateCompletedTerminalOutcome,
  runtimeHostStateFailedTerminalOutcome,
  runtimeHostStateNormalizeTerminalRuntimeEvent,
  runtimeHostStateResolveFailureMode,
  STATE_RUNTIME_FAILURE_MODES_,
} from './state-terminal';
export type {
  RuntimeHostStateSameCommandGrantInput,
  RuntimeHostStateToolGovernanceAuthorizationInput,
  RuntimeHostStateToolGovernanceDecision,
  RuntimeHostStateToolGovernanceFacts,
  RuntimeHostStateToolGovernanceFailure,
  RuntimeHostStateToolGovernanceFailureCode,
  RuntimeHostStateToolGovernanceInput,
  RuntimeHostStateToolGovernancePort,
  RuntimeHostStateToolGovernanceResult,
} from './state-tool-governance';
export { createRuntimeHostStateToolGovernance } from './state-tool-governance';
export type {
  StateToolDispatchState,
  StateToolExternalEffects,
  StateToolOutcome,
  StateToolOutcomeDetailCode,
  StateToolOutcomeEvent,
  StateToolOutcomeStatus,
  StateToolRecoveryDisposition,
  StateUnknownToolFieldsObservation,
} from './state-tool-outcome';
export {
  runtimeHostStateCanonicalToolOutcome,
  runtimeHostStateClassifyToolOutcome,
  runtimeHostStateNormalizeToolOutcomeEvent,
} from './state-tool-outcome';
export type {
  RuntimeHostShellResult,
  RuntimeHostToolExecutionResult,
  RuntimeHostToolExecutionSideEffects,
  RuntimeHostToolFailure,
} from './state-tool-result';
export type { RuntimeHostStateVerificationSchemaAdmissions } from './state-verification';
export { runtimeHostStateVerificationSchemaAdmissionDigest } from './state-verification';
export {
  runtimeHostStateActivePlanning,
  runtimeHostStateActiveSkillFrames,
  runtimeHostStateActiveTask,
  runtimeHostStateDecideCompletion,
  runtimeHostStateEffectiveInteractionMode,
  runtimeHostStateInteractionBelongsToCurrentWork,
  runtimeHostStateInteractionToolCall,
  runtimeHostStateToolCallBelongsToCurrentWork,
} from './state-view';
export {
  BoundedOutputBuffer,
  BoundedProgressLineBuffer,
  SHELL_CAPTURE_MAX_CHARS,
  SHELL_PROGRESS_LINE_MAX_CHARS,
} from './stream-output';
export type { RuntimeHostToolCallSnapshotInput } from './tool-call-snapshot';
export { createRuntimeHostToolCallSnapshot } from './tool-call-snapshot';
export type {
  RuntimeHostCommittedToolInvocationAuthority,
  RuntimeHostPreparedToolInvocationAuthority,
  RuntimeHostRetryableToolInvocationAuthority,
  RuntimeHostSuspendedToolInvocationAuthority,
  RuntimeHostToolInvocationOutcomeAuthority,
  RuntimeHostToolPipelineAttemptCoordinator,
  RuntimeHostToolPipelineAttemptCoordinatorFailureCode,
  RuntimeHostToolPipelineAttemptCoordinatorOptions,
} from './tool-pipeline-coordinator';
export {
  createRuntimeHostToolPipelineAttemptCoordinator,
  RUNTIME_HOST_TOOL_PIPELINE_ATTEMPT_COORDINATOR_SCHEMA_,
  RuntimeHostToolPipelineAttemptCoordinatorError,
} from './tool-pipeline-coordinator';

export interface RuntimeHostBoundary {
  readonly contractRevision: typeof RUNTIME_CONTRACT_BOUNDARY_.revision;
  readonly deterministicKernel: typeof AGENT_KERNEL_BOUNDARY_.deterministic;
  readonly storage: RuntimeStorageBoundary;
  readonly moduleIds: readonly string[];
}

export interface RuntimeHostModuleCompositionInput<Event = unknown, State = unknown> {
  readonly storage: RuntimeStorage<Event, State>;
  readonly modules: readonly RuntimeModule[];
  readonly contextCompiler?: ContextCompilerPort;
  readonly moduleRegistry?: never;
  readonly capabilityRegistrySnapshot?: never;
}

export interface RuntimeHostPrebuiltRegistryInput<Event = unknown, State = unknown> {
  readonly storage: RuntimeStorage<Event, State>;
  readonly moduleRegistry: RuntimeModuleRegistry;
  readonly capabilityRegistrySnapshot: CapabilityRegistrySnapshot;
  readonly contextCompiler?: ContextCompilerPort;
  readonly modules?: never;
}

export type RuntimeHostCompositionInput<Event = unknown, State = unknown> =
  | RuntimeHostModuleCompositionInput<Event, State>
  | RuntimeHostPrebuiltRegistryInput<Event, State>;

export function createRuntimeHostBoundary(input: {
  readonly storage: RuntimeStorageBoundary;
  readonly modules: readonly RuntimeModule[];
}): RuntimeHostBoundary {
  const registry = createRuntimeModuleRegistry(input.modules);
  return Object.freeze({
    contractRevision: RUNTIME_CONTRACT_BOUNDARY_.revision,
    deterministicKernel: AGENT_KERNEL_BOUNDARY_.deterministic,
    storage: input.storage,
    moduleIds: registry.moduleIds,
  });
}

/** Runtime Host composition seam. Modules are registered exactly once and never hot-swapped. */
export function createRuntimeHost<Event = unknown, State = unknown>(input: {
  readonly storage: RuntimeStorage<Event, State>;
  readonly modules: readonly RuntimeModule[];
  readonly contextCompiler?: ContextCompilerPort;
}): RuntimeHost<Event, State>;
export function createRuntimeHost<Event = unknown, State = unknown>(
  input: RuntimeHostPrebuiltRegistryInput<Event, State>,
): RuntimeHost<Event, State>;
export function createRuntimeHost<Event = unknown, State = unknown>(
  input: RuntimeHostCompositionInput<Event, State>,
): RuntimeHost<Event, State> {
  if ('modules' in input) {
    if ('moduleRegistry' in input || 'capabilityRegistrySnapshot' in input) {
      throw new Error('Runtime Host modules cannot be combined with a prebuilt registry.');
    }
    if (!input.modules) {
      throw new Error('Runtime Host module composition requires modules.');
    }
    const moduleRegistry = createRuntimeModuleRegistry(input.modules);
    return new DefaultRuntimeHost({
      storage: input.storage,
      moduleRegistry,
      capabilityRegistrySnapshot: moduleRegistry.snapshot(),
      ...(input.contextCompiler ? { contextCompiler: input.contextCompiler } : {}),
    });
  }

  if ('moduleRegistry' in input || 'capabilityRegistrySnapshot' in input) {
    if (!('moduleRegistry' in input) || !input.moduleRegistry) {
      throw new Error('Runtime Host prebuilt input requires a module registry.');
    }
    if (!('capabilityRegistrySnapshot' in input) || !input.capabilityRegistrySnapshot) {
      throw new Error('Runtime Host prebuilt input requires a capability registry snapshot.');
    }
    return new DefaultRuntimeHost({
      storage: input.storage,
      moduleRegistry: input.moduleRegistry,
      capabilityRegistrySnapshot: input.capabilityRegistrySnapshot,
      ...(input.contextCompiler ? { contextCompiler: input.contextCompiler } : {}),
    });
  }

  throw new Error('Runtime Host requires modules or a prebuilt registry and snapshot.');
}

/** Compose a Host from the one registry and immutable snapshot owned by App. */
export function createRuntimeHostFromRegistry<Event = unknown, State = unknown>(
  input: RuntimeHostPrebuiltRegistryInput<Event, State>,
): RuntimeHost<Event, State> {
  return createRuntimeHost(input);
}
