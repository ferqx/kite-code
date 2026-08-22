import { AGENT_KERNEL_BOUNDARY_V1 } from '@kite/agent-kernel';
import { RUNTIME_CONTRACT_BOUNDARY_V1 } from '@kite/runtime-contract';
import {
  type CapabilityRegistrySnapshotV1,
  type ContextCompilerPortV1,
  createRuntimeModuleRegistryV1,
  type RuntimeModuleRegistryV1,
  type RuntimeModuleV1,
} from '@kite/runtime-spi';
import { DefaultRuntimeHost, type RuntimeHost } from './runtime-host';
import type { RuntimeStorage, RuntimeStorageBoundaryV1 } from './storage';

export type {
  AgentToolCallState as State26ToolCallRecordV1,
  AuthorizationSourceV1 as State26AuthorizationSourceV1,
  ExecutionTraitsV1 as State26ExecutionTraitsV1,
  RuntimeEffect as State26RuntimeEffectV1,
  RuntimeEvent as State26RuntimeEventV1,
  RuntimeState as State26RuntimeStateV1,
  SchedulerFactsV1 as State26RuntimeSchedulerFactsV1,
} from '@kite/agent-kernel';
export { bestEffortRegularFileSizeV1 } from './artifact-metadata';
export {
  type AuthorityKeyV1,
  sealAuthorityFrameV1,
  verifyAuthorityFrameV1,
} from './authority-boundary';
export {
  createPosixAuthorityKeyPipeV1,
  POSIX_AUTHORITY_FRAME_KEY_FD_V1,
  readPosixAuthorityFrameKeyV1,
} from './authority-key-bootstrap';
export type { RuntimeHostCapabilityExecutionFailureCodeV1 } from './capability-execution';
export {
  createRuntimeHostCapabilityExecutionPortV1,
  RuntimeHostCapabilityExecutionErrorV1,
} from './capability-execution';
export type {
  RuntimeHostContextCompilationPortV1,
  RuntimeHostContextCompilationRequestV1,
} from './context-compilation';
export { createRuntimeHostContextCompilationPortV1 } from './context-compilation';
export type {
  RuntimeHostExecutionServices,
  RuntimeHostLeasePort,
  RuntimeHostTransactionPort,
  RuntimeLeaseRequirementV1,
  RuntimeTransactionAcknowledgement,
} from './effect-supervisor';
export type {
  RuntimeHostExecutionAdapterContext,
  RuntimeHostExecutionBridge,
  RuntimeHostPreparedExecution,
} from './execution-bridge';
export { RUNTIME_HOST_EXECUTION_ADAPTER_ID_V1 } from './execution-bridge';
export type { RuntimeCommandKernelEvent, RuntimeHostKernelInput } from './kernel-input';
export {
  runtimeCommandFromKernelInput,
  runtimeCommandSessionId,
  translateRuntimeCommandToKernelInput,
} from './kernel-input';
export { runMcpStdioChildRuntimeV1 } from './mcp-stdio-child-runtime';
export {
  createRuntimeHostMcpStdioProcessPortV1,
  decodeMcpStdioAuthorityBootstrapV1,
  decodeUtf8StrictV1,
  encodeMcpStdioAuthorityBootstrapV1,
  isMcpStdioWrapperInvocationV1,
  MCP_STDIO_AUTHORITY_DOMAIN_V1,
  MCP_STDIO_HOST_PEER_ID_V1,
  MCP_STDIO_MAX_LINE_BYTES_V1,
  MCP_STDIO_MAX_TOTAL_OUTPUT_BYTES_V1,
  MCP_STDIO_STARTUP_TIMEOUT_MS_V1,
  MCP_STDIO_WRAPPER_ENTRYPOINT_V1,
  MCP_STDIO_WRAPPER_PEER_ID_V1,
  parseMcpStdioJsonLineV1,
  type RuntimeHostMcpStdioCleanupV1,
  type RuntimeHostMcpStdioProcessHandleV1,
  type RuntimeHostMcpStdioProcessLaunchV1,
  type RuntimeHostMcpStdioProcessPortOptionsV1,
  type RuntimeHostMcpStdioProcessPortV1,
  type RuntimeHostMcpStdioReadyV1,
  type RuntimeHostMcpStdioTerminalV1,
  sanitizeMcpStdioEnvironmentV1,
} from './mcp-stdio-process';
export type {
  MetricAttributeKeyV1,
  MetricAttributesV1,
  MetricControlledAliasRegistryV1,
  MetricDefinitionV1,
  MetricDynamicAliasKeyV1,
  MetricKindV1,
  MetricNameV1,
  MetricPriorityV1,
  MetricPrivacyV1,
  MetricSampleV1,
} from './observability/metrics';
export {
  createMetricSampleV1,
  MAX_METRIC_SAMPLE_BYTES_V1,
  METRIC_ATTRIBUTE_KEYS,
  METRIC_DEFINITIONS_V1,
  metricPriorityV1,
  OBSERVABILITY_METRICS_VERSION,
  parseMetricSampleV1,
} from './observability/metrics';
export type {
  MetricExporterV1,
  MetricReporterStatusV1,
  MetricReporterV1,
} from './observability/reporter';
export {
  BoundedMetricQueueV1,
  BufferedMetricReporterV1,
  NoopMetricReporterV1,
} from './observability/reporter';
export { createRuntimePersistedAuthorityCodecV1 } from './persisted-authority';
export {
  buildPosixSupervisorEnvironmentV1,
  executePosixSupervisedV1,
  type RuntimeHostPreparedProcessInputV1,
  type RuntimeHostPreparedProcessResultV1,
  type RuntimeHostSandboxExecutionDispatchRecordV1,
  type RuntimeHostSandboxPreparationLifecycleV1,
  reconcilePosixSupervisorV1,
  terminatePosixSupervisorV1,
} from './posix-supervisor';
export { runPosixSupervisorChildV1 } from './posix-supervisor-child-runtime';
export {
  type PosixSupervisorIdentityV1,
  posixProcessIdentityBindsGroupV1,
  posixSupervisorIdentityPathV1,
  readComparablePosixProcessStartIdentityV1,
  readPosixSupervisorIdentityV1,
  writePosixSupervisorIdentityV1,
} from './posix-supervisor-identity';
export {
  confirmPosixSupervisorLockReleasedV1,
  createPosixSupervisorLockV1,
  type PosixSupervisorLockHandleV1,
  type PosixSupervisorLockIdentityV1,
  posixSupervisorLockPathV1,
  verifyInheritedPosixSupervisorLockV1,
} from './posix-supervisor-lock';
export {
  createRuntimeHostProcessExecutionPortV1,
  type RuntimeHostProcessExecutionPortV1,
  type RuntimeHostProcessHandleV1,
  type RuntimeHostProcessTerminationV1,
  type RuntimeHostProcessTreeV1,
} from './process-execution-port';
export { readRuntimeHostProcessOutputV1 } from './process-output';
export { spawnRuntimeHostProcessV1 } from './process-spawn';
export {
  guardProcessTree,
  type ProcessTreeGuard,
  type ProcessTreeTerminationResult,
  processTreeSpawnOptions,
} from './process-tree';
export { createProjectIdentityStoreV1, type ProjectIdentityStoreV1 } from './project-identity';
export { bindProjectIdentityToRuntimeBridgeV1 } from './project-identity-bridge';
export type { RuntimeHost, RuntimeHostCoordinatorPortV1 } from './runtime-host';
export type { RuntimeIdScopeV1, RuntimeIdSourceV1 } from './runtime-id-source';
export {
  createDeterministicRuntimeIdSourceV1,
  createLiveRuntimeIdSourceV1,
  RUNTIME_ID_SOURCE_REVISION_V1,
} from './runtime-id-source';
export {
  createRuntimeHostInteractionIdV1,
  createRuntimeHostTurnIdV1,
} from './runtime-identity';
export type { RuntimeAuthorizationElevationFactsV1 } from './runtime-policy';
export {
  assertRuntimeAuthorizationElevationV1,
  projectRuntimeObservabilityFactV1,
} from './runtime-policy';
export {
  createRuntimeHostSandboxPreparationLifecycleV1,
  createRuntimeHostSandboxPreparedProcessExecutionPortV1,
  RuntimeHostSandboxLifecycleErrorV1,
  type RuntimeHostSandboxLifecycleEvidencePortV1,
  type RuntimeHostSandboxLifecycleEvidenceV1,
  type RuntimeHostSandboxLifecycleEvidenceVerificationResultV1,
  type RuntimeHostSandboxLifecycleFailureCodeV1,
  type RuntimeHostSandboxLifecyclePersistenceV1,
  type RuntimeHostSandboxSupervisorPortV1,
} from './sandbox-preparation-lifecycle';
export { acquireSingleHostInvariantV1, type SingleHostLeaseV1 } from './single-host-invariant';
export type { RuntimeActionEmission } from './state26-action-emission';
export { acceptRuntimeAction, rejectRuntimeAction } from './state26-action-emission';
export type {
  RuntimeHostState26VerifiedApprovalBindingInputV1,
  State26ToolGovernanceInvocationFactV1,
  State26ToolGovernancePolicyFactV1,
} from './state26-approval-binding';
export {
  runtimeHostState26CreateApprovalBindingDigestV1,
  runtimeHostState26VerifyApprovalBindingDigestV1,
} from './state26-approval-binding';
export type {
  State26ApprovalGrantV1,
  State26AuthorizationStateV1,
} from './state26-authorization';
export {
  runtimeHostState26ApplyApprovalGrantV1,
  runtimeHostState26AuthorizationCommandGrantKeyV1,
  runtimeHostState26DefaultAuthorizationV1,
  runtimeHostState26DefaultPhaseForWorkspaceAccessV1,
  runtimeHostState26GrantSameCommandV1,
  runtimeHostState26HasSameCommandGrantV1,
  runtimeHostState26NormalizeAuthorizationV1,
} from './state26-authorization';
export type {
  State26DoomLoopCheckV1,
  State26DoomLoopRequestV1,
  State26DoomLoopTrackerEntryV1,
} from './state26-doom-loop';
export {
  runtimeHostState26CheckDoomLoopFingerprintV1,
  runtimeHostState26ToolDoomLoopFingerprintV1,
  runtimeHostState26UpdateDoomLoopTrackerV1,
} from './state26-doom-loop';
export type {
  State26RuntimeEffectDeferredV1,
  State26RuntimeEffectEventSinkV1,
  State26RuntimeEffectExecutionContextV1,
  State26RuntimeEffectExecutorV1,
  State26RuntimeEffectLeaseV1,
  State26RuntimeEffectPersistenceAcknowledgementV1,
} from './state26-effect-runtime';
export {
  deferredState26RuntimeEffectV1,
  isState26RuntimeEffectDeferredV1,
} from './state26-effect-runtime';
export {
  runtimeHostState26AdmitCurrentRuntimeEventV1,
  runtimeHostState26AssertCurrentRuntimeEventV1,
} from './state26-event-codec';
export type {
  State26ClassifiedFailureV1,
  State26FailureKindV1,
  State26TerminalReasonCodeV1,
  State26ToolParseFailureCodeV1,
} from './state26-failure';
export {
  runtimeHostState26ClassifyFailureV1,
  runtimeHostState26FailureKindForToolParseFailureV1,
  runtimeHostState26IsFailureKindV1,
  runtimeHostState26TerminalReasonForFailureV1,
} from './state26-failure';
export type {
  RuntimeHostState26InitialStateInputV1,
  RuntimeState,
  TaskState,
  ToolCallRecord,
  ToolCallStatus,
  ToolResultMeta,
} from './state26-initial';
export {
  createRuntimeHostState26InitialStateV1,
  getActivePlanning,
  getActiveTask,
  getEffectiveInteractionMode,
  RUNTIME_STATE_FORMAT_EPOCH,
  RUNTIME_STATE_SCHEMA_VERSION,
  setActivePlanning,
} from './state26-initial';
export {
  runtimeHostState26DecideReadPlanCommandV1,
  runtimeHostState26DecideUpdatePlanCommandV1,
  runtimeHostState26DecideWritePlanCommandV1,
  runtimeHostState26EmptyPlanCompletionEvidenceV1,
  runtimeHostState26PlanCommandFactsV1,
  runtimeHostState26PlanCompletionBlockerV1,
  runtimeHostState26PlanReviewSiblingCancellationsV1,
  runtimeHostState26ProjectPlanCompletionEvidenceV1,
} from './state26-plan-command';
export type {
  RuntimeHostState26RestartRecoveryFactsV1,
  State26ToolRecoveryJournalV1,
} from './state26-recovery';
export {
  isRuntimeHostState26ToolRecoveryInvalidV1,
  projectRuntimeHostState26RestartRecoveryEventsV1,
  runtimeHostState26AdmitRecoveryAttemptV1,
  runtimeHostState26AdvanceToolRecoveryResponseV1,
  runtimeHostState26CreateToolRecoveryJournalV1,
  runtimeHostState26DecideAutoReviewV1,
  runtimeHostState26NormalizeToolRecoveryJournalV1,
  runtimeHostState26RecordRecoveryFailureV1,
  runtimeHostState26RecordRecoveryInvocationV1,
  runtimeHostState26RecordToolOwnedProgressV1,
  runtimeHostState26RestartRecoveryCapabilityInvocationIdsV1,
  runtimeHostState26ToolFailureInstanceIdV1,
  runtimeHostState26ToolInvocationFingerprintV1,
  runtimeHostState26ToolRecoveryJournalInvalidV1,
} from './state26-recovery';
export type {
  DescendantBudgetReservationV1,
  DescendantResourceAdmissionV1,
  ModelResourcePreparationPlanV1,
  RuntimeBudgetAdmissionPlanV1,
  RuntimeBudgetAdmissionReasonV1,
} from './state26-resource-admission';
export {
  actualUsageForReservationV1,
  createDescendantResourceAdmissionV1,
  DescendantResourceAdmissionError,
  planModelInvocationResourceV1,
  planRuntimeBudgetAdmissionV1,
  reconciliationEventsForReservationsV1,
} from './state26-resource-admission';
export type {
  ActiveResourceBudgetRuntimeStateV1,
  BudgetReservationState,
  BudgetReservationV1,
  ConcurrencyWaiterV1,
  ResourceBudgetConfiguredEvent,
  ResourceBudgetDispatchStartedEvent,
  ResourceBudgetEvent,
  ResourceBudgetReconciledEvent,
  ResourceBudgetReleasedEvent,
  ResourceBudgetReservedEvent,
  ResourceBudgetRuntimeStateV1,
  ResourceBudgetUnknownEvent,
  ResourceBudgetV1,
  ResourceBudgetWaiterCancelledEvent,
  ResourceBudgetWaiterEnqueuedEvent,
  ResourceBudgetWaiterPromotedEvent,
  ResourceBudgetWaiterTimedOutEvent,
  ResourceUsageV1,
} from './state26-resource-budget';
export {
  assertResourceBudgetRuntimeStateV1,
  assertResourceBudgetV1,
  assertResourceUsageV1,
  committedResourceUsageV1,
  createUnconfiguredResourceBudgetStateV1,
  createZeroResourceUsageV1,
  INTERNAL_RESOURCE_BUDGET_V1,
  LIMITED_RESOURCE_BUDGET_V1,
  RESOURCE_BUDGET_VERSION,
  reduceResourceBudgetStateV1,
  tightenResourceBudgetV1,
} from './state26-resource-budget';
export type {
  State26RuntimeRestoreInputV1,
  State26RuntimeRestoreResultV1,
  State26RuntimeRestoreSourceV1,
} from './state26-restore';
export { restoreRuntimeHostState26SessionV1 } from './state26-restore';
export type {
  State26RuntimeConcurrentEffectEventCurrentV1,
  State26RuntimeConcurrentEffectStateProjectorV1,
  State26RuntimeEventBatchAdmissionValidatorV1,
  State26RuntimeEventBatchPreprocessorV1,
  State26RuntimeNamedTurnSnapshotInputV1,
  State26RuntimeProcessEventBatchOptionsV1,
  State26RuntimeProcessEventResultV1,
  State26RuntimeSessionClockV1,
  State26RuntimeSessionEffectLeaseV1,
  State26RuntimeSessionEventContextV1,
  State26RuntimeSessionIdSourceV1,
  State26RuntimeSessionInputV1,
  State26RuntimeSessionV1,
  State26RuntimeToolTerminalBatchValidatorV1,
  State26RuntimeVerificationAdmissionV1,
} from './state26-session';
export {
  createRuntimeHostState26SessionV1,
  STATE26_RUNTIME_SESSION_FORMAT_V1,
  State26RuntimeSession,
} from './state26-session';
export type { RuntimeHostState26StorageBindingV1 } from './state26-storage';
export { createRuntimeHostState26StorageBindingV1 } from './state26-storage';
export type {
  State26FailureModeContextV1,
  State26FailureModeDispositionV1,
  State26FailureModeDurableStateV1,
  State26FailureModeFallbackV1,
  State26FailureModeResolutionV1,
  State26RunTerminalOutcomeV1,
  State26RuntimeFailureModeV1,
  State26RuntimeTerminalStatusV1,
} from './state26-terminal';
export {
  runtimeHostState26CompletedTerminalOutcomeV1,
  runtimeHostState26FailedTerminalOutcomeV1,
  runtimeHostState26NormalizeTerminalRuntimeEventV1,
  runtimeHostState26ResolveFailureModeV1,
  STATE26_RUNTIME_FAILURE_MODES_V1,
} from './state26-terminal';
export type {
  RuntimeHostState26SameCommandGrantInputV1,
  RuntimeHostState26ToolGovernanceAuthorizationInputV1,
  RuntimeHostState26ToolGovernanceDecisionV1,
  RuntimeHostState26ToolGovernanceFactsV1,
  RuntimeHostState26ToolGovernanceFailureCodeV1,
  RuntimeHostState26ToolGovernanceFailureV1,
  RuntimeHostState26ToolGovernanceInputV1,
  RuntimeHostState26ToolGovernancePortV1,
  RuntimeHostState26ToolGovernanceResultV1,
} from './state26-tool-governance';
export { createRuntimeHostState26ToolGovernanceV1 } from './state26-tool-governance';
export type {
  State26ToolDispatchStateV1,
  State26ToolExternalEffectsV1,
  State26ToolOutcomeDetailCodeV1,
  State26ToolOutcomeEventV1,
  State26ToolOutcomeStatusV1,
  State26ToolOutcomeV1,
  State26ToolRecoveryDispositionV1,
  State26UnknownToolFieldsObservationV1,
} from './state26-tool-outcome';
export {
  runtimeHostState26CanonicalToolOutcomeV1,
  runtimeHostState26ClassifyToolOutcomeV1,
  runtimeHostState26NormalizeToolOutcomeEventV1,
} from './state26-tool-outcome';
export type {
  RuntimeHostShellResultV1,
  RuntimeHostToolExecutionResultV1,
  RuntimeHostToolExecutionSideEffectsV1,
  RuntimeHostToolFailureV1,
} from './state26-tool-result';
export type { RuntimeHostState26VerificationSchemaAdmissionsV1 } from './state26-verification';
export { runtimeHostState26VerificationSchemaAdmissionDigestV1 } from './state26-verification';
export {
  runtimeHostState26ActivePlanningV1,
  runtimeHostState26ActiveSkillFramesV1,
  runtimeHostState26ActiveTaskV1,
  runtimeHostState26DecideCompletionV1,
  runtimeHostState26EffectiveInteractionModeV1,
  runtimeHostState26InteractionBelongsToCurrentWorkV1,
  runtimeHostState26InteractionToolCallV1,
  runtimeHostState26ToolCallBelongsToCurrentWorkV1,
} from './state26-view';
export {
  BoundedOutputBuffer,
  BoundedProgressLineBuffer,
  SHELL_CAPTURE_MAX_CHARS,
  SHELL_PROGRESS_LINE_MAX_CHARS,
} from './stream-output';
export type { RuntimeHostToolCallSnapshotInputV1 } from './tool-call-snapshot';
export { createRuntimeHostToolCallSnapshotV1 } from './tool-call-snapshot';
export type {
  RuntimeHostCommittedToolInvocationAuthorityV1,
  RuntimeHostPreparedToolInvocationAuthorityV1,
  RuntimeHostRetryableToolInvocationAuthorityV1,
  RuntimeHostSuspendedToolInvocationAuthorityV1,
  RuntimeHostToolInvocationOutcomeAuthorityV1,
  RuntimeHostToolPipelineAttemptCoordinatorFailureCodeV1,
  RuntimeHostToolPipelineAttemptCoordinatorOptionsV1,
  RuntimeHostToolPipelineAttemptCoordinatorV1,
} from './tool-pipeline-coordinator';
export {
  createRuntimeHostToolPipelineAttemptCoordinatorV1,
  RUNTIME_HOST_TOOL_PIPELINE_ATTEMPT_COORDINATOR_SCHEMA_V1,
  RuntimeHostToolPipelineAttemptCoordinatorErrorV1,
} from './tool-pipeline-coordinator';

export interface RuntimeHostBoundaryV1 {
  readonly contractRevision: typeof RUNTIME_CONTRACT_BOUNDARY_V1.revision;
  readonly deterministicKernel: typeof AGENT_KERNEL_BOUNDARY_V1.deterministic;
  readonly storage: RuntimeStorageBoundaryV1;
  readonly moduleIds: readonly string[];
}

export interface RuntimeHostModuleCompositionInputV1<Event = unknown, State = unknown> {
  readonly storage: RuntimeStorage<Event, State>;
  readonly modules: readonly RuntimeModuleV1[];
  readonly contextCompiler?: ContextCompilerPortV1;
  readonly moduleRegistry?: never;
  readonly capabilityRegistrySnapshot?: never;
}

export interface RuntimeHostPrebuiltRegistryInputV1<Event = unknown, State = unknown> {
  readonly storage: RuntimeStorage<Event, State>;
  readonly moduleRegistry: RuntimeModuleRegistryV1;
  readonly capabilityRegistrySnapshot: CapabilityRegistrySnapshotV1;
  readonly contextCompiler?: ContextCompilerPortV1;
  readonly modules?: never;
}

export type RuntimeHostCompositionInputV1<Event = unknown, State = unknown> =
  | RuntimeHostModuleCompositionInputV1<Event, State>
  | RuntimeHostPrebuiltRegistryInputV1<Event, State>;

export function createRuntimeHostBoundaryV1(input: {
  readonly storage: RuntimeStorageBoundaryV1;
  readonly modules: readonly RuntimeModuleV1[];
}): RuntimeHostBoundaryV1 {
  const registry = createRuntimeModuleRegistryV1(input.modules);
  return Object.freeze({
    contractRevision: RUNTIME_CONTRACT_BOUNDARY_V1.revision,
    deterministicKernel: AGENT_KERNEL_BOUNDARY_V1.deterministic,
    storage: input.storage,
    moduleIds: registry.moduleIds,
  });
}

/** Runtime Host composition seam. Modules are registered exactly once and never hot-swapped. */
export function createRuntimeHost<Event = unknown, State = unknown>(input: {
  readonly storage: RuntimeStorage<Event, State>;
  readonly modules: readonly RuntimeModuleV1[];
  readonly contextCompiler?: ContextCompilerPortV1;
}): RuntimeHost<Event, State>;
export function createRuntimeHost<Event = unknown, State = unknown>(
  input: RuntimeHostPrebuiltRegistryInputV1<Event, State>,
): RuntimeHost<Event, State>;
export function createRuntimeHost<Event = unknown, State = unknown>(
  input: RuntimeHostCompositionInputV1<Event, State>,
): RuntimeHost<Event, State> {
  if ('modules' in input) {
    if ('moduleRegistry' in input || 'capabilityRegistrySnapshot' in input) {
      throw new Error('Runtime Host modules cannot be combined with a prebuilt registry.');
    }
    if (!input.modules) {
      throw new Error('Runtime Host module composition requires modules.');
    }
    const moduleRegistry = createRuntimeModuleRegistryV1(input.modules);
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
export function createRuntimeHostFromRegistryV1<Event = unknown, State = unknown>(
  input: RuntimeHostPrebuiltRegistryInputV1<Event, State>,
): RuntimeHost<Event, State> {
  return createRuntimeHost(input);
}
