import { AGENT_KERNEL_BOUNDARY_ } from '@kite-ai/agent-kernel';
import { RUNTIME_CONTRACT_BOUNDARY_ } from '@kite-ai/runtime-contract';
import {
  type CapabilityRegistrySnapshot,
  type ContextCompilerPort,
  createRuntimeModuleRegistry,
  type RuntimeModule,
  type RuntimeModuleRegistry,
} from '@kite-ai/runtime-spi';
import { DefaultRuntimeHost, type RuntimeHost } from './host/runtime-host';
import type { RuntimeStorage, RuntimeStorageBoundary } from './storage';

export type {
  AgentToolCallState as StateToolCallRecord,
  ExecutionTraits as StateExecutionTraits,
  RuntimeEffect as StateRuntimeEffect,
  RuntimeEvent as StateRuntimeEvent,
  RuntimeState as StateRuntimeState,
  SchedulerFacts as StateRuntimeSchedulerFacts,
} from '@kite-ai/agent-kernel';
// Historical format markers are exposed through the Host compatibility seam.
// App composition must not depend directly on the deterministic Kernel.
export {
  LEGACY_STATE26_FORMAT_EPOCH,
  LEGACY_STATE26_SCHEMA_VERSION,
} from '@kite-ai/agent-kernel';
export { bestEffortRegularFileSize } from './artifact-metadata';
export type { RuntimeHostCapabilityExecutionFailureCode } from './execution/capability-execution';
export {
  createRuntimeHostCapabilityExecutionPortFromSnapshot,
  RuntimeHostCapabilityExecutionError,
} from './execution/capability-execution';
export type {
  RuntimeHostContextCompilationPort,
  RuntimeHostContextCompilationRequest,
} from './execution/context-compilation';
export { createRuntimeHostContextCompilationPort } from './execution/context-compilation';
export type {
  RuntimeHostAcceptedCommand,
  RuntimeHostCommandInspection,
  RuntimeHostCommandInspectionContext,
  RuntimeHostExecutionAdapterContext,
  RuntimeHostExecutionBridge,
  RuntimeHostPreparedExecution,
} from './execution/execution-bridge';
export { RUNTIME_HOST_EXECUTION_ADAPTER_ID_ } from './execution/execution-bridge';
export type {
  RuntimeHostCommittedToolInvocationAuthority,
  RuntimeHostPreparedToolInvocationAuthority,
  RuntimeHostRetryableToolInvocationAuthority,
  RuntimeHostSuspendedToolInvocationAuthority,
  RuntimeHostToolInvocationOutcomeAuthority,
  RuntimeHostToolPipelineAttemptCoordinator,
  RuntimeHostToolPipelineAttemptCoordinatorFailureCode,
  RuntimeHostToolPipelineAttemptCoordinatorOptions,
} from './execution/tool-pipeline-coordinator';
export {
  createRuntimeHostToolPipelineAttemptCoordinator,
  RUNTIME_HOST_TOOL_PIPELINE_ATTEMPT_COORDINATOR_SCHEMA_,
  RuntimeHostToolPipelineAttemptCoordinatorError,
} from './execution/tool-pipeline-coordinator';
export {
  runtimeHostCurrentStateEventTypes,
  runtimeHostStateAdmitCurrentRuntimeEvent,
  runtimeHostStateAssertCurrentRuntimeEvent,
} from './format/event-codec';
export type {
  StateRuntimeRestoreInput,
  StateRuntimeRestoreResult,
  StateRuntimeRestoreSource,
} from './format/restore';
export { restoreRuntimeHostStateSession } from './format/restore';
export type { RuntimeHostStateStorageBinding } from './format/storage-binding';
export { createRuntimeHostStateStorageBinding } from './format/storage-binding';
export {
  createRuntimeCommandCommitEvidence,
  digestRuntimeCommand,
  parseRuntimeStoredCommandReceipt,
  resolveRuntimeCommandReceipt,
} from './host/command-receipt';
export {
  parseRuntimeStoredCommandResource,
  projectRuntimeStoredRun,
} from './host/run-projection';
export type { RuntimeHost, RuntimeHostCoordinatorPort } from './host/runtime-host';

export type {
  RuntimeHostExecutionServices,
  RuntimeHostLeasePort,
  RuntimeHostTransactionPort,
  RuntimeLeaseRequirement,
  RuntimeTransactionAcknowledgement,
} from './lifecycle/effect-supervisor';
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
} from './lifecycle/sandbox-preparation-lifecycle';
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
  createRuntimeHostProcessExecutionPort,
  type RuntimeHostProcessExecutionPort,
  type RuntimeHostProcessHandle,
  type RuntimeHostProcessTermination,
  type RuntimeHostProcessTree,
} from './process/execution-port';
export { runMcpStdioChildRuntime } from './process/mcp-stdio-child-runtime';
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
} from './process/mcp-stdio-process';
export { readRuntimeHostProcessOutput } from './process/output';
export {
  buildPosixSupervisorEnvironment,
  executePosixSupervised,
  type RuntimeHostPreparedProcessInput,
  type RuntimeHostPreparedProcessResult,
  type RuntimeHostSandboxExecutionDispatchRecord,
  type RuntimeHostSandboxPreparationLifecycle,
  reconcilePosixSupervisor,
  terminatePosixSupervisor,
} from './process/posix-supervisor';
export { runPosixSupervisorChild } from './process/posix-supervisor-child-runtime';
export {
  type PosixSupervisorIdentity,
  posixProcessIdentityBindsGroup,
  posixSupervisorIdentityPath,
  readComparablePosixProcessStartIdentity,
  readPosixSupervisorIdentity,
  writePosixSupervisorIdentity,
} from './process/posix-supervisor-identity';
export {
  confirmPosixSupervisorLockReleased,
  createPosixSupervisorLock,
  type PosixSupervisorLockHandle,
  type PosixSupervisorLockIdentity,
  posixSupervisorLockPath,
  verifyInheritedPosixSupervisorLock,
} from './process/posix-supervisor-lock';
export {
  guardProcessTree,
  type ProcessTreeGuard,
  type ProcessTreeTerminationResult,
  processTreeSpawnOptions,
} from './process/process-tree';
export { spawnRuntimeHostProcess } from './process/spawn';
export {
  BoundedOutputBuffer,
  BoundedProgressLineBuffer,
  SHELL_CAPTURE_MAX_CHARS,
  SHELL_PROGRESS_LINE_MAX_CHARS,
} from './process/stream-output';
export { resolveProjectIdentity } from './project-identity';
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
export { projectRuntimeObservabilityFact } from './runtime-policy';
export type { RuntimeHostToolCallSnapshotInput } from './tool-call-snapshot';
export { createRuntimeHostToolCallSnapshot } from './tool-call-snapshot';

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
