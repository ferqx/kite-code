import type { CapabilityArtifactWriter } from '@kite-ai/builtin-runtime';
import { pendingToolRequestFromValidatedInvocation } from '@kite-ai/builtin-runtime';
import { digestCapabilityValue } from '@kite-ai/builtin-runtime/capability';
import {
  capabilityChangedProviderError,
  isMcpProviderError,
  type McpRuntimeProvider,
  providerErrorFromDirectoryEntry,
} from '@kite-ai/builtin-runtime/mcp';
import type { SupportedChatModel } from '@kite-ai/builtin-runtime/model';
import type { PlanArtifactStore } from '@kite-ai/builtin-runtime/planning';
import type { NetworkDecisionRecorder, ShellExecutor } from '@kite-ai/builtin-runtime/sandbox';
import {
  createProtectedPathEvaluator,
  networkBoundaryPolicyFromExecutionBoundary,
} from '@kite-ai/builtin-runtime/sandbox';
import type {
  SkillCatalogSnapshot,
  SkillManifest,
  SkillScanOptions,
} from '@kite-ai/builtin-runtime/skills';
import { createCapabilitySnapshot } from '@kite-ai/builtin-runtime/skills';
import {
  isBuiltinSubagentTaskToolName,
  normalizeAskUserRequest,
} from '@kite-ai/builtin-runtime/subagent';
import type { SubAgentEventSink } from '@kite-ai/runtime-contract';
import { getAgentPhase } from '@kite-ai/runtime-contract';
import {
  createRuntimeHostToolCallSnapshot,
  createRuntimeHostInteractionId as genInteractionId,
} from '@kite-ai/runtime-host';
import {
  runtimeHostStateActiveSkillFrames as activeSkillFramesForCurrentWork,
  DescendantResourceAdmissionError,
  runtimeHostStateActivePlanning as getActivePlanning,
  runtimeHostStateEffectiveInteractionMode as getEffectiveInteractionMode,
  runtimeHostStateToolRecoveryJournalInvalid as isToolRecoveryJournalInvalid,
  runtimeHostStateCanAuthorizeToolInFullMode,
  runtimeHostStateClassifyToolOutcome,
  runtimeHostStateCreateApprovalBindingDigest,
  runtimeHostStateToolFailureInstanceId as toolFailureInstanceId,
  runtimeHostStateToolInvocationFingerprint as toolInvocationFingerprint,
} from '@kite-ai/runtime-host/kernel-adapter';
import type { RuntimeHostFilePreimageRecorder as FilePreimageRecorder } from '@kite-ai/runtime-host/storage';
import { type BuiltinMcpRuntimePort, createToolSearchProviderFacts } from '#builtin-runtime';
import { bindAppApprovalBinding } from '#kite-service/bootstrap/runtime/approval-binding';
import {
  classifyFailure,
  classifyMcpProviderError,
  failureKindForToolParseFailure,
} from '#kite-service/bootstrap/runtime/failures';
import { createAppMcpReadinessRuntime } from '#kite-service/bootstrap/runtime/mcp-readiness-runtime';
import { createPlanRuntime } from '#kite-service/bootstrap/runtime/plan-runtime';
import {
  type ProviderReadinessCoordinator,
  ProviderReadinessPersistenceError,
  ProviderReadinessUnknownError,
} from '#kite-service/bootstrap/runtime/provider-readiness';
import type { RuntimeEvent, RuntimeState } from '#kite-service/bootstrap/runtime/state-runtime';
import type { SubAgentResult } from '#kite-service/bootstrap/runtime/subagent/types';
import type { AppToolPipelineComposition } from '#kite-service/bootstrap/runtime/tool-pipeline-composition';
import {
  type AppOrdinaryToolPipelineAttemptRuntime,
  isAppOrdinaryToolPipelineOperationId,
} from '#kite-service/bootstrap/runtime/tool-pipeline-ordinary-attempt';
import type { AppTaskToolPipelineAttemptRuntime } from '#kite-service/bootstrap/runtime/tool-pipeline-task-attempt';
import {
  buildToolApproval,
  commandIdentityForToolApproval,
} from '#kite-service/bootstrap/runtime/tool-policy';
import {
  createSkillMechanismPort,
  createWebMechanismPort,
} from '#kite-service/bootstrap/runtime/tool-provider-services';
import type { ToolExecutionResult } from '#kite-service/bootstrap/runtime/tool-result';
import { createAppToolTurnContext } from '#kite-service/bootstrap/runtime/tool-turn-context';
import { getFeatureFlags } from '#kite-service/config/features';
import { type AgentConfig, computeExecutionBoundaryDigest } from '#kite-service/config/index';
import {
  policyRecoveryTerminal,
  productionExecutionSurfaceFailure,
  sealedMcpNetworkTerminal,
} from '#kite-service/runtime/tool-execution/execution-surface-guard';
import { projectInstructionGuardFailure } from '#kite-service/runtime/tool-execution/project-instruction-guard';
import { appPreparedShellExecutionPort } from '#kite-service/sandbox/prepared-tool-pipeline';
import type {
  CapabilityExecutionPort,
  PreparedToolInvocation,
  RuntimeJsonValue,
} from '#runtime-spi';
import { modelBuiltinEntry } from './builtin-executor';
import { prepareDynamicMcpMechanism } from './mcp-executor';
import { type AppSkillForkRequest, runAppSkillFork } from './skill-executor';
import {
  AppToolPipelinePersistenceError,
  createAppSharedChildToolDispatcher,
  executeAppTaskToolPipeline,
  isConcurrentExploreSubagentBatch,
  isCurrentExactChildToolReservation,
  type PrivateSubagentTask,
} from './subagent-executor';
import {
  providerActionRequiredEvent,
  recoveryActionForFailure,
  toRuntimeSubagentEvent,
} from './terminal-projection';

export async function executeAppRuntimeTools(params: {
  state: RuntimeState;
  toolCallIds: string[];
  shellExecutor?: ShellExecutor;
  gitBroker?: import('@kite-ai/builtin-runtime/git').GitBroker;
  mcpManager?: McpRuntimeProvider;
  /** Host-owned registry execution port for Runtime SPI capability owners. */
  capabilityExecution?: CapabilityExecutionPort;
  builtinToolCatalog?: import('@kite-ai/builtin-runtime').BuiltinToolCatalogProjection;
  /** Stable App composition derived from the same frozen Builtin projection. */
  toolPipelineComposition: AppToolPipelineComposition;
  /** The one effect-scoped Host/Builtin attempt runtime for ordinary cutover operations. */
  ordinaryToolPipelineAttemptRuntime?: AppOrdinaryToolPipelineAttemptRuntime;
  /** The dedicated private Task runtime sharing the same effect-scoped Host coordinator. */
  taskToolPipelineAttemptRuntime?: AppTaskToolPipelineAttemptRuntime;
  providerReadinessCoordinator?: ProviderReadinessCoordinator;
  skillManifests?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  skillCatalog?: SkillCatalogSnapshot;
  signal?: AbortSignal;
  taskConfig?: AgentConfig;
  taskModel?: SupportedChatModel;
  descendantResourceAdmission?: import('@kite-ai/runtime-host/kernel-adapter').DescendantResourceAdmission;
  modelEffectCoordinator?: import('@kite-ai/builtin-runtime/model').BuiltinModelEffectCoordinator;
  modelInvocationPersistence?: import('@kite-ai/builtin-runtime/model').ModelInvocationPersistence<
    RuntimeState,
    RuntimeEvent
  >;
  /** Parent reservation for a task/skill child model step. */
  modelInvocationParentReservationId?: string;
  subagentEventSink?: SubAgentEventSink;
  /** Identity supplied by the scheduler/executor only for one admitted parallel task batch. */
  subagentConcurrencyGroupId?: string;
  /** True only for an admitted concurrent batch whose every Task role is Explore. */
  subagentAutoReviewBatch?: boolean;
  /** Child-only live mode specialization; ordinary parent calls never set it. */
  interactionModeOverride?: import('@kite-ai/runtime-contract').InteractionMode;
  /**
   * A resumed child may use the exact already-acknowledged parent approval.
   * This is an in-memory execution hint bound to the parent receipt; it never
   * emits a synthetic child approval request/grant.
   */
  parentApprovalForToolCallId?: Readonly<
    Record<
      string,
      {
        parentToolCallId: string;
        grant: 'approve_once' | 'same_command';
        approvalBindingDigest?: string;
      }
    >
  >;
  planArtifactStore?: PlanArtifactStore;
  capabilityArtifactStore?: CapabilityArtifactWriter;
  workspaceFilesystemRuntime?: import('@kite-ai/builtin-runtime/filesystem').BuiltinWorkspaceFilesystemRuntime;
  sandboxPreparationArtifacts?: import('@kite-ai/builtin-runtime/sandbox').SandboxPreparationArtifactStore;
  /** Exact sandbox qualification fact captured by the App/Core coordinator. */
  sandboxAvailable?: boolean;
  /** Deterministic observation used only for persisted same-command expiry. */
  authorizationObservedAt?: number;
  /** Elevation guards supplied by the effect coordinator, never inferred by Kernel. */
  authorizationFromAutoReview?: boolean;
  authorizationFromLoopMode?: boolean;
  /** Explicit qualification seam; production omits it and uses the sole Local Provider composition. */
  subagentRuntimeFactory?: import('#kite-service/bootstrap/runtime/subagent/pipeline-runtime').AppSubagentRuntimeFactory;
  subagentContinuationArtifacts?: import('@kite-ai/builtin-runtime/subagent').SubagentContinuationArtifactAccess;
  subagentTaskRequests?: import('@kite-ai/builtin-runtime/subagent').SubagentTaskRequestArtifactAccess;
  /** Runtime sink used to publish tool lifecycle/progress events while execution is running. */
  emitRuntimeEvent?: (event: RuntimeEvent) => void;
  /** StateRuntimeStorage-backed acknowledgement required before an automatic provider replay. */
  persistRuntimeEvent?: (event: RuntimeEvent) => Promise<boolean>;
  /** Atomic StateRuntimeStorage acknowledgement for invocation intent + attempt. */
  persistRuntimeEvents?: (events: RuntimeEvent[]) => Promise<boolean>;
  /** Defers a complete terminal batch to the Kernel's atomic effect commit. */
  emitTerminalEventBatch?: (events: RuntimeEvent[]) => void;
  /** Current Kernel state used to reject a prepared/leased effect that became unsafe. */
  getRuntimeState?: () => Readonly<RuntimeState>;
  /** 写入前文件原像记录器，透传给工具执行链（ADR-0025 §4）。 */
  recordFilePreimage?: FilePreimageRecorder;
  recordNetworkDecision?: NetworkDecisionRecorder;
  /** Actor identities for nested child calls; absent top-level calls use parent. */
  toolActorIds?: Readonly<Record<string, string>>;
  /** Child-only exact reservation prepared after authorization and before admission. */
  beforeAdmissionByToolCallId?: Readonly<
    Record<
      string,
      () => Promise<import('@kite-ai/runtime-host/kernel-adapter').DescendantBudgetReservation>
    >
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
  const isAuthorizedStatus = (status: string | undefined) =>
    status === 'approved' || status === 'authorized_queued';
  const isDispatchableStatus = (status: string | undefined) =>
    status === 'queued' || isAuthorizedStatus(status);
  const approvedParallelShellBatch =
    params.toolCallIds.length > 1 &&
    params.toolCallIds.every((toolCallId) => {
      const call = params.state.tools.calls[toolCallId];
      const entry =
        call && params.builtinToolCatalog
          ? modelBuiltinEntry(params.builtinToolCatalog, call.name)
          : undefined;
      return (
        entry?.executionMechanism === 'shell' &&
        (isAuthorizedStatus(call?.status) ||
          (params.state.mode === 'full' && call?.status === 'queued'))
      );
    });
  const parallelSubagentBatch =
    params.toolCallIds.length > 1 &&
    params.toolCallIds.every((toolCallId) => {
      const call = params.state.tools.calls[toolCallId];
      const entry =
        call && params.builtinToolCatalog
          ? modelBuiltinEntry(params.builtinToolCatalog, call.name)
          : undefined;
      return entry?.executionMechanism === 'subagent' && call?.status === 'queued';
    });
  const parallelExploreBatch =
    parallelSubagentBatch && isConcurrentExploreSubagentBatch(params.state, params.toolCallIds);
  if (approvedParallelShellBatch) {
    const batches = await Promise.all(
      params.toolCallIds.map((toolCallId) =>
        executeAppRuntimeTools({
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
        executeAppRuntimeTools({
          ...params,
          toolCallIds: [toolCallId],
          subagentConcurrencyGroupId: concurrencyGroupId,
          subagentAutoReviewBatch: parallelExploreBatch,
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
    const canonicalEvents = batches.flatMap((batch, index) => {
      const deferred = deferredInteractions[index]!;
      if (deferred.length === 0) return batch;
      // Keep every canonical suspension/review event.  The Kernel queue owns
      // focus and FIFO order; this adapter must not synthesize a deferred
      // placeholder for a sibling.
      return [
        ...deferred,
        ...batch.filter(
          (event) =>
            event.type !== 'subagent.suspended' &&
            event.type !== 'approval.requested' &&
            event.type !== 'auto_review.requested',
        ),
      ];
    });
    if (!params.emitRuntimeEvent) return canonicalEvents;
    for (const event of canonicalEvents) params.emitRuntimeEvent(event);
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
  if (isToolRecoveryJournalInvalid(currentState.toolRecovery)) {
    const reason = 'Runtime tool recovery journal is invalid; tool dispatch is blocked.';
    for (const toolCallId of params.toolCallIds) {
      const call = currentState.tools.calls[toolCallId] ?? params.state.tools.calls[toolCallId];
      if (!call || !isDispatchableStatus(call.status)) continue;
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
    if (!call || !isDispatchableStatus(call.status)) continue;
    let privateSubagentTask: PrivateSubagentTask | undefined;
    if (isBuiltinSubagentTaskToolName(call.name)) {
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
          taskArtifact as import('@kite-ai/runtime-spi').SubagentTaskRequestArtifact,
          {
            parentModelInvocationId: call.modelInvocationId,
            parentToolCallId: toolCallId,
          },
        );
        if (privateTask.role !== role) throw new Error('Subagent role is cross-bound.');
        privateSubagentTask = {
          source: 'private_artifact_v1',
          requestArtifact:
            taskArtifact as import('@kite-ai/runtime-spi').SubagentTaskRequestArtifact,
          payload: {
            name: privateTask.name,
            subagent_type: privateTask.role,
            task: privateTask.task,
          },
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
    const childToolDispatcher = createAppSharedChildToolDispatcher({
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
      (!productionFlags?.capabilityCatalog || !productionFlags.mcpRuntimeBinding)
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
      ? modelBuiltinEntry(params.builtinToolCatalog, call.name)
      : undefined;
    const taskCutover =
      ordinaryCutoverEntry?.operationId === 'builtin:task' &&
      ordinaryCutoverEntry.executionMechanism === 'subagent';
    const productionBoundaryIncomplete =
      Boolean(params.taskConfig && 'productionExecution' in params.taskConfig) &&
      (!params.taskConfig?.executionBoundary || !params.taskConfig.executionCapabilitySurface);
    if (productionBoundaryIncomplete) {
      const reason = productionExecutionSurfaceFailure({
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
      const surfaceFailure = productionExecutionSurfaceFailure({
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
    if (isBuiltinSubagentTaskToolName(call.name) && !taskCutover) {
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
      const instructionFailure = projectInstructionGuardFailure({
        state: (params.getRuntimeState?.() ?? currentState) as RuntimeState,
        modelMessageId: call.modelMessageId,
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
        const taskEvents = await executeAppTaskToolPipeline({
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
        if (after && !['queued', 'approved', 'authorized_queued', 'running'].includes(after.status))
          continue;
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
      productionFlags?.capabilityCatalog === true &&
      productionFlags.mcpRuntimeBinding === true;
    const sealedMcpTerminal =
      (dynamicMcpCutover || ordinaryCutoverEntry?.executionMechanism === 'mcp') &&
      params.taskConfig?.executionBoundary
        ? sealedMcpNetworkTerminal({
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
      const surfaceFailure = productionExecutionSurfaceFailure({
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
        isAppOrdinaryToolPipelineOperationId(ordinaryCutoverEntry.operationId)) ||
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
          enabled: productionFlags?.mcpProviderAction === true,
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
      const turnContext = createAppToolTurnContext({
        workspace: liveState.session.workspace,
        threadId: liveState.session.threadId,
        config: params.taskConfig,
        hasGitBroker: Boolean(params.gitBroker),
        hasTaskAdapter: true,
        toolSearchEnabled: productionFlags?.toolSearch === true,
        skillCatalog: params.skillCatalog,
        activeSkillFrames: activeSkillFramesForCurrentWork(liveState).filter(
          (frame) => frame.contextMode === 'inline',
        ),
        phase: getAgentPhase(getActivePlanning(liveState)),
        interactionMode: params.interactionModeOverride ?? getEffectiveInteractionMode(liveState),
        turnId: liveState.turn.turnId,
        activeTaskId: liveState.activeTaskId ?? undefined,
        modelMessageId: call.modelMessageId,
        toolCallId,
      });
      if (ordinaryCutoverEntry) {
        const instructionFailure = projectInstructionGuardFailure({
          state: liveState,
          modelMessageId: call.modelMessageId,
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
      const snapshot = createRuntimeHostToolCallSnapshot({
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
          ? appPreparedShellExecutionPort(params.shellExecutor)
          : undefined;
      try {
        let ordinaryAttempt = (existingInvocation?.attemptsStarted ?? 0) + 1;
        let allowSafeReadRetry =
          dynamicMcpCutover && dynamicMcpCutoverDescriptor?.execution?.retry === 'safe_read';
        let preDispatchSafeReadRetryConsumed = false;
        const preDispatchStartedAt = Date.now();
        let acknowledgedSkillAttempt:
          | Readonly<{
              readonly prepared: Readonly<PreparedToolInvocation>;
              readonly attempt: number;
            }>
          | undefined;
        let skillForkRuntimeIssued = false;
        let outcome: Awaited<ReturnType<typeof ordinaryRuntime.execute>>;
        const parentApproval = params.parentApprovalForToolCallId?.[toolCallId];
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
              ? async (fork: AppSkillForkRequest): Promise<SubAgentResult | null> => {
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
                  return runAppSkillFork({
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
              dynamicCatalogRevision: createCapabilitySnapshot(descriptors).revision,
              availabilityContext: turnContext,
              bindings: Object.freeze([...Object.values(liveState.capabilities.bindings)]),
              descriptors: Object.freeze([...descriptors]),
              disclosures: Object.freeze([...Object.values(liveState.capabilities.disclosures)]),
            }),
            governance: Object.freeze({
              sessionId: liveState.session.threadId,
              workspace: liveState.session.workspace,
              canonicalWorkspaceIdentity:
                liveState.session.canonicalWorkspaceDigest ?? liveState.session.workspace,
              threadId: liveState.session.threadId,
              context: Object.freeze({
                phase: getAgentPhase(planning),
                interactionMode:
                  params.interactionModeOverride ?? getEffectiveInteractionMode(liveState),
                sandboxAvailable: params.sandboxAvailable === true,
                circuitBreakerTripped: liveState.autoReview.circuitBreakerTripped,
                observedAt: params.authorizationObservedAt ?? 0,
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
                status: parentApproval
                  ? ('approved' as const)
                  : call.status === 'authorized_queued'
                    ? ('approved' as const)
                    : call.status,
                grant: parentApproval?.grant ?? call.approvalGrant ?? 'none',
                approvedToolCallId:
                  parentApproval ||
                  call.status === 'approved' ||
                  call.status === 'authorized_queued'
                    ? toolCallId
                    : null,
                approvalBindingDigest:
                  parentApproval?.approvalBindingDigest ??
                  (call.status === 'approved' || call.status === 'authorized_queued'
                    ? (call.approvalHash ?? null)
                    : null),
              }),
              sameCommandGrant: Object.freeze({
                sessionCommandGrants: liveState.sessionCommandGrants,
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
                ? createToolSearchProviderFacts({
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
                            ? createAppMcpReadinessRuntime({
                                runtime: params.mcpManager as unknown as BuiltinMcpRuntimePort,
                                readinessCoordinator: params.providerReadinessCoordinator,
                                getState: params.getRuntimeState,
                                persistEvent: params.persistRuntimeEvent,
                                toolCallId,
                                executionBoundaryDigest: params.taskConfig?.executionBoundary
                                  ? computeExecutionBoundaryDigest(
                                      params.taskConfig.executionBoundary,
                                    )
                                  : digestCapabilityValue({
                                      schema: 'kite.unsealed-execution-boundary.v1',
                                    }),
                                signal,
                              })
                            : (params.mcpManager as unknown as BuiltinMcpRuntimePort),
                      }),
                    }),
                  }
                : {}),
              ...(cutoverExecutionMechanism === 'skill'
                ? {
                    preassembledMechanism: Object.freeze({
                      skill: createSkillMechanismPort({
                        state: liveState,
                        catalog: params.skillCatalog,
                        flags: productionFlags,
                        verificationEnabled:
                          cutoverOperationId !== 'builtin:read_skill_reference' &&
                          Boolean(params.taskConfig) &&
                          productionFlags?.verification === true,
                        ...(skillFork ? { runFork: skillFork } : {}),
                      }),
                    }),
                  }
                : {}),
              ...(cutoverExecutionMechanism === 'web'
                ? {
                    preassembledMechanism: Object.freeze({
                      web: createWebMechanismPort({
                        toolCallId,
                        ...(params.taskConfig?.executionBoundary
                          ? {
                              networkBoundaryPolicy: networkBoundaryPolicyFromExecutionBoundary(
                                params.taskConfig.executionBoundary,
                                productionFlags?.networkBoundary === true,
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
                      planning: createPlanRuntime({
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
                    readonly canonicalArguments: RuntimeJsonValue;
                  }) => {
                    let mechanismResources: Awaited<ReturnType<typeof prepareDynamicMcpMechanism>>;
                    while (true) {
                      try {
                        mechanismResources = await prepareDynamicMcpMechanism({
                          descriptor: dynamicMcpCutoverDescriptor,
                          manager: params.mcpManager!,
                          providerReadinessCoordinator: params.providerReadinessCoordinator,
                          getRuntimeState: params.getRuntimeState,
                          persistRuntimeEvent: params.persistRuntimeEvent,
                          taskConfig: params.taskConfig,
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
                          toolInvocationFingerprint({
                            toolName: call.name,
                            parsedArgs: call.args,
                          });
                        const baseOutcome = runtimeHostStateClassifyToolOutcome({
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
                        const recoveryOf = toolFailureInstanceId({
                          toolCallId,
                          invocationFingerprint,
                          outcome: baseOutcome,
                        });
                        const persisted = await params.persistRuntimeEvent({
                          type: 'tool.retry_recorded',
                          toolCallId,
                          failure,
                          outcome: {
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
                        isAuthorizedStatus(readinessCall?.status)
                      ) {
                        const persisted = await params.persistRuntimeEvent({
                          type: 'tool.started',
                          toolCallId,
                          createdAt: new Date().toISOString(),
                        });
                        if (!persisted) {
                          throw new AppToolPipelinePersistenceError(
                            'Dynamic MCP tool start acknowledgement became stale before dispatch.',
                          );
                        }
                      } else if (readinessCall?.status !== 'running') {
                        throw new AppToolPipelinePersistenceError(
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
                    protectedPathEvaluator: createProtectedPathEvaluator({
                      workspaceRoot:
                        params.taskConfig?.executionBoundary?.workspaceRoot ??
                        params.workspaceFilesystemRuntime.canonicalWorkspace,
                      mode: params.taskConfig?.executionBoundary?.protectedPathPolicy ?? 'deny',
                    }),
                    protectedPathRevision: params.taskConfig?.executionBoundary
                      ? computeExecutionBoundaryDigest(params.taskConfig.executionBoundary)
                      : 'protected-path-unconfigured-v1',
                    actorIdentity: Object.freeze({
                      threadId: liveState.session.threadId,
                      actorId: params.toolActorIds?.[toolCallId] ?? 'parent',
                    }),
                    ...(params.recordFilePreimage
                      ? {
                          rewindProjection: Object.freeze({
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
                              !isCurrentExactChildToolReservation(
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
                            readonly prepared: Readonly<PreparedToolInvocation>;
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
                              import('@kite-ai/builtin-runtime').BuiltinOperationExecutionValue
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
                ? policyRecoveryTerminal({
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
              request: normalizeAskUserRequest(outcome.classified.validated.request.arguments),
            });
            continue;
          }
          if (
            outcome.decision.kind === 'request_approval' ||
            outcome.decision.kind === 'request_auto_review'
          ) {
            const request = pendingToolRequestFromValidatedInvocation(
              outcome.classified.validated,
              turn.projection,
            );
            const approvalBindingDigest = runtimeHostStateCreateApprovalBindingDigest(
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
            bindAppApprovalBinding(approval, {
              digest: approvalBindingDigest,
              invocationFact: outcome.facts.invocation,
              policyFact: outcome.facts.policy,
            });
            const commandIdentity = commandIdentityForToolApproval({
              sessionId: liveState.session.threadId,
              threadId: liveState.session.threadId,
              workspace: liveState.session.workspace,
              canonicalWorkspaceIdentity:
                liveState.session.canonicalWorkspaceDigest ?? liveState.session.workspace,
              invocation: outcome.facts.invocation,
            });
            const fullModePolicyBypassAllowed = runtimeHostStateCanAuthorizeToolInFullMode(
              outcome.facts,
            );
            const fullModeBypassEligible =
              outcome.facts.context.interactionMode === 'full' && fullModePolicyBypassAllowed;
            if (outcome.decision.kind === 'request_auto_review') {
              events.push({
                type: 'auto_review.requested',
                reviewId: genInteractionId(),
                toolCallId,
                toolName: request.name,
                reason: outcome.decision.decision.reason,
                approval,
                fullModeBypassEligible,
                fullModePolicyBypassAllowed,
                ...(commandIdentity ? { commandIdentity } : {}),
              });
            } else {
              events.push({
                type: 'approval.requested',
                interactionId: genInteractionId(),
                toolCallId,
                approval,
                fullModeBypassEligible,
                fullModePolicyBypassAllowed,
                ...(commandIdentity ? { commandIdentity } : {}),
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
        if (after && !['queued', 'approved', 'authorized_queued', 'running'].includes(after.status))
          continue;
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
