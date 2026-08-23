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
  AgentToolCallState as StateToolCallRecordV1,
  AuthorizationSourceV1 as StateAuthorizationSourceV1,
  ExecutionTraitsV1 as StateExecutionTraitsV1,
  RuntimeEffect as StateRuntimeEffectV1,
  RuntimeEvent as StateRuntimeEventV1,
  RuntimeState as StateRuntimeStateV1,
  SchedulerFactsV1 as StateRuntimeSchedulerFactsV1,
} from '@kite/agent-kernel';
export { bestEffortRegularFileSizeV1 } from './artifact-metadata';
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
export { createRuntimeControlFrameV1, verifyRuntimeControlFrameV1 } from './control-frame';
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
  decodeUtf8StrictV1,
  isMcpStdioWrapperInvocationV1,
  MCP_STDIO_CONTROL_DOMAIN_V1,
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
export { resolveProjectIdentityV1 } from './project-identity';
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
export type { RuntimeActionEmission } from './state-action-emission';
export { acceptRuntimeAction, rejectRuntimeAction } from './state-action-emission';
export type {
  RuntimeHostStateVerifiedApprovalBindingInputV1,
  StateToolGovernanceInvocationFactV1,
  StateToolGovernancePolicyFactV1,
} from './state-approval-binding';
export {
  runtimeHostStateCreateApprovalBindingDigestV1,
  runtimeHostStateVerifyApprovalBindingDigestV1,
} from './state-approval-binding';
export type {
  StateApprovalGrantV1,
  StateAuthorizationStateV1,
} from './state-authorization';
export {
  runtimeHostStateApplyApprovalGrantV1,
  runtimeHostStateAuthorizationCommandGrantKeyV1,
  runtimeHostStateDefaultAuthorizationV1,
  runtimeHostStateDefaultPhaseForWorkspaceAccessV1,
  runtimeHostStateGrantSameCommandV1,
  runtimeHostStateHasSameCommandGrantV1,
  runtimeHostStateNormalizeAuthorizationV1,
} from './state-authorization';
export type {
  StateDoomLoopCheckV1,
  StateDoomLoopRequestV1,
  StateDoomLoopTrackerEntryV1,
} from './state-doom-loop';
export {
  runtimeHostStateCheckDoomLoopFingerprintV1,
  runtimeHostStateToolDoomLoopFingerprintV1,
  runtimeHostStateUpdateDoomLoopTrackerV1,
} from './state-doom-loop';
export type {
  StateRuntimeEffectDeferredV1,
  StateRuntimeEffectEventSinkV1,
  StateRuntimeEffectExecutionContextV1,
  StateRuntimeEffectExecutorV1,
  StateRuntimeEffectLeaseV1,
  StateRuntimeEffectPersistenceAcknowledgementV1,
} from './state-effect-runtime';
export {
  deferredStateRuntimeEffectV1,
  isStateRuntimeEffectDeferredV1,
} from './state-effect-runtime';
export {
  runtimeHostStateAdmitCurrentRuntimeEventV1,
  runtimeHostStateAssertCurrentRuntimeEventV1,
} from './state-event-codec';
export type {
  StateClassifiedFailureV1,
  StateFailureKindV1,
  StateTerminalReasonCodeV1,
  StateToolParseFailureCodeV1,
} from './state-failure';
export {
  runtimeHostStateClassifyFailureV1,
  runtimeHostStateFailureKindForToolParseFailureV1,
  runtimeHostStateIsFailureKindV1,
  runtimeHostStateTerminalReasonForFailureV1,
} from './state-failure';
export type {
  RuntimeHostStateInitialStateInputV1,
  RuntimeState,
  TaskState,
  ToolCallRecord,
  ToolCallStatus,
  ToolResultMeta,
} from './state-initial';
export {
  createRuntimeHostStateInitialStateV1,
  getActivePlanning,
  getActiveTask,
  getEffectiveInteractionMode,
  RUNTIME_STATE_FORMAT_EPOCH,
  RUNTIME_STATE_SCHEMA_VERSION,
  setActivePlanning,
} from './state-initial';
export {
  runtimeHostStateDecideReadPlanCommandV1,
  runtimeHostStateDecideUpdatePlanCommandV1,
  runtimeHostStateDecideWritePlanCommandV1,
  runtimeHostStateEmptyPlanCompletionEvidenceV1,
  runtimeHostStatePlanCommandFactsV1,
  runtimeHostStatePlanCompletionBlockerV1,
  runtimeHostStatePlanReviewSiblingCancellationsV1,
  runtimeHostStateProjectPlanCompletionEvidenceV1,
} from './state-plan-command';
export type {
  RuntimeHostStateRestartRecoveryFactsV1,
  StateToolRecoveryJournalV1,
} from './state-recovery';
export {
  isRuntimeHostStateToolRecoveryInvalidV1,
  projectRuntimeHostStateRestartRecoveryEventsV1,
  runtimeHostStateAdmitRecoveryAttemptV1,
  runtimeHostStateAdvanceToolRecoveryResponseV1,
  runtimeHostStateCreateToolRecoveryJournalV1,
  runtimeHostStateDecideAutoReviewV1,
  runtimeHostStateNormalizeToolRecoveryJournalV1,
  runtimeHostStateRecordRecoveryFailureV1,
  runtimeHostStateRecordRecoveryInvocationV1,
  runtimeHostStateRecordToolOwnedProgressV1,
  runtimeHostStateRestartRecoveryCapabilityInvocationIdsV1,
  runtimeHostStateToolFailureInstanceIdV1,
  runtimeHostStateToolInvocationFingerprintV1,
  runtimeHostStateToolRecoveryJournalInvalidV1,
} from './state-recovery';
export type {
  DescendantBudgetReservationV1,
  DescendantResourceAdmissionV1,
  ModelResourcePreparationPlanV1,
  RuntimeBudgetAdmissionPlanV1,
  RuntimeBudgetAdmissionReasonV1,
} from './state-resource-admission';
export {
  actualUsageForReservationV1,
  createDescendantResourceAdmissionV1,
  DescendantResourceAdmissionError,
  planModelInvocationResourceV1,
  planRuntimeBudgetAdmissionV1,
  reconciliationEventsForReservationsV1,
} from './state-resource-admission';
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
} from './state-resource-budget';
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
} from './state-resource-budget';
export type {
  StateRuntimeRestoreInputV1,
  StateRuntimeRestoreResultV1,
  StateRuntimeRestoreSourceV1,
} from './state-restore';
export { restoreRuntimeHostStateSessionV1 } from './state-restore';
export type {
  StateRuntimeConcurrentEffectEventCurrentV1,
  StateRuntimeConcurrentEffectStateProjectorV1,
  StateRuntimeEventBatchAdmissionValidatorV1,
  StateRuntimeEventBatchPreprocessorV1,
  StateRuntimeNamedTurnSnapshotInputV1,
  StateRuntimeProcessEventBatchOptionsV1,
  StateRuntimeProcessEventResultV1,
  StateRuntimeSessionClockV1,
  StateRuntimeSessionEffectLeaseV1,
  StateRuntimeSessionEventContextV1,
  StateRuntimeSessionIdSourceV1,
  StateRuntimeSessionInputV1,
  StateRuntimeSessionV1,
  StateRuntimeToolTerminalBatchValidatorV1,
  StateRuntimeVerificationAdmissionV1,
} from './state-session';
export {
  createRuntimeHostStateSessionV1,
  STATE26_RUNTIME_SESSION_FORMAT_V1,
  StateRuntimeSession,
} from './state-session';
export type { RuntimeHostStateStorageBindingV1 } from './state-storage';
export { createRuntimeHostStateStorageBindingV1 } from './state-storage';
export type {
  StateFailureModeContextV1,
  StateFailureModeDispositionV1,
  StateFailureModeDurableStateV1,
  StateFailureModeFallbackV1,
  StateFailureModeResolutionV1,
  StateRunTerminalOutcomeV1,
  StateRuntimeFailureModeV1,
  StateRuntimeTerminalStatusV1,
} from './state-terminal';
export {
  runtimeHostStateCompletedTerminalOutcomeV1,
  runtimeHostStateFailedTerminalOutcomeV1,
  runtimeHostStateNormalizeTerminalRuntimeEventV1,
  runtimeHostStateResolveFailureModeV1,
  STATE26_RUNTIME_FAILURE_MODES_V1,
} from './state-terminal';
export type {
  RuntimeHostStateSameCommandGrantInputV1,
  RuntimeHostStateToolGovernanceAuthorizationInputV1,
  RuntimeHostStateToolGovernanceDecisionV1,
  RuntimeHostStateToolGovernanceFactsV1,
  RuntimeHostStateToolGovernanceFailureCodeV1,
  RuntimeHostStateToolGovernanceFailureV1,
  RuntimeHostStateToolGovernanceInputV1,
  RuntimeHostStateToolGovernancePortV1,
  RuntimeHostStateToolGovernanceResultV1,
} from './state-tool-governance';
export { createRuntimeHostStateToolGovernanceV1 } from './state-tool-governance';
export type {
  StateToolDispatchStateV1,
  StateToolExternalEffectsV1,
  StateToolOutcomeDetailCodeV1,
  StateToolOutcomeEventV1,
  StateToolOutcomeStatusV1,
  StateToolOutcomeV1,
  StateToolRecoveryDispositionV1,
  StateUnknownToolFieldsObservationV1,
} from './state-tool-outcome';
export {
  runtimeHostStateCanonicalToolOutcomeV1,
  runtimeHostStateClassifyToolOutcomeV1,
  runtimeHostStateNormalizeToolOutcomeEventV1,
} from './state-tool-outcome';
export type {
  RuntimeHostShellResultV1,
  RuntimeHostToolExecutionResultV1,
  RuntimeHostToolExecutionSideEffectsV1,
  RuntimeHostToolFailureV1,
} from './state-tool-result';
export type { RuntimeHostStateVerificationSchemaAdmissionsV1 } from './state-verification';
export { runtimeHostStateVerificationSchemaAdmissionDigestV1 } from './state-verification';
export {
  runtimeHostStateActivePlanningV1,
  runtimeHostStateActiveSkillFramesV1,
  runtimeHostStateActiveTaskV1,
  runtimeHostStateDecideCompletionV1,
  runtimeHostStateEffectiveInteractionModeV1,
  runtimeHostStateInteractionBelongsToCurrentWorkV1,
  runtimeHostStateInteractionToolCallV1,
  runtimeHostStateToolCallBelongsToCurrentWorkV1,
} from './state-view';
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
