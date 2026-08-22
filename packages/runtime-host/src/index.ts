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
  AgentToolCallState as State25ToolCallRecordV1,
  AuthorizationSourceV1 as State25AuthorizationSourceV1,
  ExecutionTraitsV1 as State25ExecutionTraitsV1,
  RuntimeEffect as State25RuntimeEffectV1,
  RuntimeEvent as State25RuntimeEventV1,
  RuntimeState as State25RuntimeStateV1,
  SchedulerFactsV1 as State25RuntimeSchedulerFactsV1,
} from '@kite/agent-kernel';
export { bestEffortRegularFileSizeV1 } from './artifact-metadata';
export {
  type AuthorityKeyV1,
  AuthorityNonceRegistryV1,
  type AuthorityRevocationV1,
  sealAuthorityEnvelopeV1,
  sealAuthorityFrameV1,
  verifyAuthorityEnvelopeV1,
  verifyAuthorityFrameV1,
} from './authority-boundary';
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
export { createProjectIdentityStoreV1, type ProjectIdentityStoreV1 } from './project-identity';
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
export type { RuntimeActionEmission } from './state25-action-emission';
export { acceptRuntimeAction, rejectRuntimeAction } from './state25-action-emission';
export type {
  RuntimeHostState25VerifiedApprovalBindingInputV1,
  State25ToolGovernanceInvocationFactV1,
  State25ToolGovernancePolicyFactV1,
} from './state25-approval-binding';
export {
  runtimeHostState25CreateApprovalBindingDigestV1,
  runtimeHostState25VerifyApprovalBindingDigestV1,
} from './state25-approval-binding';
export type {
  State25ApprovalGrantV1,
  State25AuthorizationStateV1,
} from './state25-authorization';
export {
  runtimeHostState25ApplyApprovalGrantV1,
  runtimeHostState25AuthorizationCommandGrantKeyV1,
  runtimeHostState25DefaultAuthorizationV1,
  runtimeHostState25DefaultPhaseForWorkspaceAccessV1,
  runtimeHostState25GrantSameCommandV1,
  runtimeHostState25HasSameCommandGrantV1,
  runtimeHostState25NormalizeAuthorizationV1,
} from './state25-authorization';
export type {
  State25DoomLoopCheckV1,
  State25DoomLoopRequestV1,
  State25DoomLoopTrackerEntryV1,
} from './state25-doom-loop';
export {
  runtimeHostState25CheckDoomLoopFingerprintV1,
  runtimeHostState25ToolDoomLoopFingerprintV1,
  runtimeHostState25UpdateDoomLoopTrackerV1,
} from './state25-doom-loop';
export type {
  State25RuntimeEffectDeferredV1,
  State25RuntimeEffectEventSinkV1,
  State25RuntimeEffectExecutionContextV1,
  State25RuntimeEffectExecutorV1,
  State25RuntimeEffectLeaseV1,
  State25RuntimeEffectPersistenceAcknowledgementV1,
} from './state25-effect-runtime';
export {
  deferredState25RuntimeEffectV1,
  isState25RuntimeEffectDeferredV1,
} from './state25-effect-runtime';
export {
  runtimeHostState25AdmitCurrentRuntimeEventV1,
  runtimeHostState25AssertCurrentRuntimeEventV1,
} from './state25-event-codec';
export type {
  State25ClassifiedFailureV1,
  State25FailureKindV1,
  State25TerminalReasonCodeV1,
  State25ToolParseFailureCodeV1,
} from './state25-failure';
export {
  runtimeHostState25ClassifyFailureV1,
  runtimeHostState25FailureKindForToolParseFailureV1,
  runtimeHostState25IsFailureKindV1,
  runtimeHostState25TerminalReasonForFailureV1,
} from './state25-failure';
export type {
  RuntimeHostState25InitialStateInputV1,
  RuntimeState,
  TaskState,
  ToolCallRecord,
  ToolCallStatus,
  ToolResultMeta,
} from './state25-initial';
export {
  createRuntimeHostState25InitialStateV1,
  getActivePlanning,
  getActiveTask,
  getEffectiveInteractionMode,
  RUNTIME_STATE_FORMAT_EPOCH,
  RUNTIME_STATE_SCHEMA_VERSION,
  setActivePlanning,
} from './state25-initial';
export {
  runtimeHostState25DecideReadPlanCommandV1,
  runtimeHostState25DecideUpdatePlanCommandV1,
  runtimeHostState25DecideWritePlanCommandV1,
  runtimeHostState25EmptyPlanCompletionEvidenceV1,
  runtimeHostState25PlanCommandFactsV1,
  runtimeHostState25PlanCompletionBlockerV1,
  runtimeHostState25PlanReviewSiblingCancellationsV1,
  runtimeHostState25ProjectPlanCompletionEvidenceV1,
} from './state25-plan-command';
export type {
  RuntimeHostState25RestartRecoveryFactsV1,
  State25ToolRecoveryJournalV1,
} from './state25-recovery';
export {
  isRuntimeHostState25ToolRecoveryInvalidV1,
  projectRuntimeHostState25RestartRecoveryEventsV1,
  runtimeHostState25AdmitRecoveryAttemptV1,
  runtimeHostState25AdvanceToolRecoveryResponseV1,
  runtimeHostState25CreateToolRecoveryJournalV1,
  runtimeHostState25DecideAutoReviewV1,
  runtimeHostState25NormalizeToolRecoveryJournalV1,
  runtimeHostState25RecordRecoveryFailureV1,
  runtimeHostState25RecordRecoveryInvocationV1,
  runtimeHostState25RecordToolOwnedProgressV1,
  runtimeHostState25RestartRecoveryCapabilityInvocationIdsV1,
  runtimeHostState25ToolFailureInstanceIdV1,
  runtimeHostState25ToolInvocationFingerprintV1,
  runtimeHostState25ToolRecoveryJournalInvalidV1,
} from './state25-recovery';
export type {
  DescendantBudgetReservationV1,
  DescendantResourceAdmissionV1,
  ModelResourcePreparationPlanV1,
  RuntimeBudgetAdmissionPlanV1,
  RuntimeBudgetAdmissionReasonV1,
} from './state25-resource-admission';
export {
  actualUsageForReservationV1,
  createDescendantResourceAdmissionV1,
  DescendantResourceAdmissionError,
  planModelInvocationResourceV1,
  planRuntimeBudgetAdmissionV1,
  reconciliationEventsForReservationsV1,
} from './state25-resource-admission';
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
} from './state25-resource-budget';
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
} from './state25-resource-budget';
export type {
  State25RuntimeRestoreInputV1,
  State25RuntimeRestoreResultV1,
  State25RuntimeRestoreSourceV1,
} from './state25-restore';
export { restoreRuntimeHostState25SessionV1 } from './state25-restore';
export type {
  State25RuntimeConcurrentEffectEventCurrentV1,
  State25RuntimeConcurrentEffectStateProjectorV1,
  State25RuntimeEventBatchAdmissionValidatorV1,
  State25RuntimeEventBatchPreprocessorV1,
  State25RuntimeNamedTurnSnapshotInputV1,
  State25RuntimeProcessEventBatchOptionsV1,
  State25RuntimeProcessEventResultV1,
  State25RuntimeSessionClockV1,
  State25RuntimeSessionEffectLeaseV1,
  State25RuntimeSessionEventContextV1,
  State25RuntimeSessionIdSourceV1,
  State25RuntimeSessionInputV1,
  State25RuntimeSessionV1,
  State25RuntimeToolTerminalBatchValidatorV1,
  State25RuntimeVerificationAdmissionV1,
} from './state25-session';
export {
  createRuntimeHostState25SessionV1,
  STATE25_RUNTIME_SESSION_FORMAT_V1,
  State25RuntimeSession,
} from './state25-session';
export type { RuntimeHostState25StorageBindingV1 } from './state25-storage';
export { createRuntimeHostState25StorageBindingV1 } from './state25-storage';
export type {
  State25FailureModeContextV1,
  State25FailureModeDispositionV1,
  State25FailureModeDurableStateV1,
  State25FailureModeFallbackV1,
  State25FailureModeResolutionV1,
  State25RunTerminalOutcomeV1,
  State25RuntimeFailureModeV1,
  State25RuntimeTerminalStatusV1,
} from './state25-terminal';
export {
  runtimeHostState25CompletedTerminalOutcomeV1,
  runtimeHostState25FailedTerminalOutcomeV1,
  runtimeHostState25NormalizeTerminalRuntimeEventV1,
  runtimeHostState25ResolveFailureModeV1,
  STATE25_RUNTIME_FAILURE_MODES_V1,
} from './state25-terminal';
export type {
  RuntimeHostState25SameCommandGrantInputV1,
  RuntimeHostState25ToolGovernanceAuthorizationInputV1,
  RuntimeHostState25ToolGovernanceDecisionV1,
  RuntimeHostState25ToolGovernanceFactsV1,
  RuntimeHostState25ToolGovernanceFailureCodeV1,
  RuntimeHostState25ToolGovernanceFailureV1,
  RuntimeHostState25ToolGovernanceInputV1,
  RuntimeHostState25ToolGovernancePortV1,
  RuntimeHostState25ToolGovernanceResultV1,
} from './state25-tool-governance';
export { createRuntimeHostState25ToolGovernanceV1 } from './state25-tool-governance';
export type {
  State25ToolDispatchStateV1,
  State25ToolExternalEffectsV1,
  State25ToolOutcomeDetailCodeV1,
  State25ToolOutcomeEventV1,
  State25ToolOutcomeStatusV1,
  State25ToolOutcomeV1,
  State25ToolRecoveryDispositionV1,
  State25UnknownToolFieldsObservationV1,
} from './state25-tool-outcome';
export {
  runtimeHostState25CanonicalToolOutcomeV1,
  runtimeHostState25ClassifyToolOutcomeV1,
  runtimeHostState25NormalizeToolOutcomeEventV1,
} from './state25-tool-outcome';
export type {
  RuntimeHostShellResultV1,
  RuntimeHostToolExecutionResultV1,
  RuntimeHostToolExecutionSideEffectsV1,
  RuntimeHostToolFailureV1,
} from './state25-tool-result';
export type { RuntimeHostState25VerificationSchemaAdmissionsV1 } from './state25-verification';
export { runtimeHostState25VerificationSchemaAdmissionDigestV1 } from './state25-verification';
export {
  runtimeHostState25ActivePlanningV1,
  runtimeHostState25ActiveSkillFramesV1,
  runtimeHostState25ActiveTaskV1,
  runtimeHostState25DecideCompletionV1,
  runtimeHostState25EffectiveInteractionModeV1,
  runtimeHostState25InteractionBelongsToCurrentWorkV1,
  runtimeHostState25InteractionToolCallV1,
  runtimeHostState25ToolCallBelongsToCurrentWorkV1,
} from './state25-view';
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
