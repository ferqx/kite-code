import type {
  BuiltinToolCatalogProjection,
  CapabilityArtifactAccess,
} from '@kite-ai/builtin-runtime';
import type { McpRuntimeProvider } from '@kite-ai/builtin-runtime/mcp';
import type {
  CompactionReporter,
  ContextCompactionProgressPhase,
  ModelInvocationGateway,
  ModelInvocationPersistence,
  SupportedChatModel,
} from '@kite-ai/builtin-runtime/model';
import {
  buildContextProjection,
  preflightModelContext,
  resolveModelCapabilities,
} from '@kite-ai/builtin-runtime/model';
import type { PlanArtifactStore } from '@kite-ai/builtin-runtime/planning';
import type { SandboxBackend, ShellExecutor } from '@kite-ai/builtin-runtime/sandbox';
import type { SkillManifest, SkillScanOptions } from '@kite-ai/builtin-runtime/skills';
import {
  createSkillCapabilityResolver,
  refreshSkillCatalog,
  type SkillCatalogSnapshot,
} from '@kite-ai/builtin-runtime/skills';
import type { RuntimeCommandContext, SubAgentEventSink } from '@kite-ai/runtime-contract';
import { committedResourceUsage } from '@kite-ai/runtime-host/kernel-adapter';
import { getFeatureFlags } from '#kite-service/config/features';
import type { AgentConfig } from '#kite-service/config/index';
import type { CapabilityExecutionPort } from '#runtime-spi';
import type {
  WorkspaceEffectAttemptContext,
  WorkspaceEffectDispatchComposition,
} from '../../workspace-worker/effect-adapter';
import type { ContextCompactor } from './context-compaction-effect';
import { resolveContextProjectionEnvironment } from './model-effect';
import type {
  RuntimeEffect,
  RuntimeEvent,
  RuntimeState,
  StateRuntimeStorage,
} from './state-runtime';
import type { AppToolPipelineComposition } from './tool-pipeline-composition';

export type AppWorkspaceEffectDispatchComposition = Readonly<WorkspaceEffectDispatchComposition> & {
  readonly context: Readonly<WorkspaceEffectAttemptContext>;
};

/** Builds one Worker effect composition for one admission-time command context. */
export type AppWorkspaceEffectCompositionFactory = (
  context: Readonly<RuntimeCommandContext>,
) => AppWorkspaceEffectDispatchComposition;

/** Dependencies owned by the application boundary, never persisted in RuntimeState. */
export interface RuntimeExecutorDependencies {
  config: AgentConfig;
  model: SupportedChatModel;
  /** App-owned wall clock used for durable State effect facts; tests may inject it. */
  now?: () => string;
  shellExecutor?: ShellExecutor;
  sandboxBackend?: SandboxBackend | 'unknown';
  mcpManager?: McpRuntimeProvider;
  /** Host-owned immutable Runtime SPI registry execution port. */
  capabilityExecution?: CapabilityExecutionPort;
  /** App projection of the exact frozen snapshot backing capabilityExecution. */
  builtinToolCatalog?: BuiltinToolCatalogProjection;
  /** App composition derived from the same Builtin projection; no second registry. */
  toolPipelineComposition?: AppToolPipelineComposition;
  /** App-owned single Plan Artifact writer; missing means plan dispatch fails closed. */
  planArtifactStore?: PlanArtifactStore;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  skillCatalog?: SkillCatalogSnapshot;
  signal?: AbortSignal;
  /** Admission-time in-process command context pinned by the Runtime Host closure. */
  commandContext?: Readonly<RuntimeCommandContext>;
  /** Worker-owned Store/effect composition; configured callers require commandContext. */
  workspaceEffectCompositionFactory?: AppWorkspaceEffectCompositionFactory;
  subagentEventSink?: SubAgentEventSink;
  /** Explicit unit-test seam; production creates the compactor only through modelEffectCoordinator. */
  testContextCompactor?: ContextCompactor;
  /** Owned and flushed by the application composition root. */
  compactionReporter?: CompactionReporter;
  onCompactionProgress?: (phase: ContextCompactionProgressPhase | undefined) => void;
  /** 用于记录文件写入前原像，缺省时工具写入不留原像。 */
  runtimeStore?: StateRuntimeStorage;
  /** Required by every model-bearing production effect. */
  modelInvocationGateway?: ModelInvocationGateway;
  /** App-owned coordinator bound to the exact same Model Gateway. */
  modelEffectCoordinator?: import('@kite-ai/builtin-runtime/model').BuiltinModelEffectCoordinator;
  /** Installation-private capability receipt writer; never synthesized at dispatch time. */
  capabilityArtifactStore?: CapabilityArtifactAccess;
  /** Explicit Local/Test filesystem Provider composition; no runtime fallback exists. */
  workspaceFilesystemRuntime?: import('@kite-ai/builtin-runtime/filesystem').BuiltinWorkspaceFilesystemRuntime;
  sandboxPreparationArtifacts?: import('@kite-ai/builtin-runtime/sandbox').SandboxPreparationArtifactStore;
  subagentRuntimeFactory?: import('./subagent/pipeline-runtime').AppSubagentRuntimeFactory;
  delegatedTaskArtifacts?: Pick<
    import('@kite-ai/builtin-runtime/subagent').SubagentTaskArtifactAccess,
    'read'
  >;
  backgroundSubagentRuntime?: import('./subagent/background-runtime').BackgroundSubagentControlRuntime;
  /** Private child Session receipt owner; absence retains the current guarded route. */
  childSessionAcceptance?: Readonly<{
    /** Pending Store intents whose delegated budget must survive a fenced restart. */
    pendingDelegationReservations?: () => readonly string[];
    pendingAfterTurnDelegations?: () => NonNullable<
      import('@kite-ai/runtime-host/kernel-adapter').RuntimeHostStateRestartRecoveryFacts['preservePendingAfterTurnDelegations']
    >;
    liveAfterTurnDelegations?: () => NonNullable<
      import('@kite-ai/runtime-host/kernel-adapter').RuntimeHostStateRestartRecoveryFacts['preserveLiveAfterTurnDelegations']
    >;
    sealedAfterTurnReports?: () => NonNullable<
      import('@kite-ai/runtime-host/kernel-adapter').RuntimeHostStateRestartRecoveryFacts['preserveSealedAfterTurnReports']
    >;
    effectLeases: Pick<
      import('@kite-ai/runtime-host/storage').EffectLeasePort,
      'tryAcquireEffectLease' | 'releaseEffectLease'
    >;
    onAccepted: (
      accepted: import('./subagent/child-session-acceptance').AcceptedChildSession,
      parentSignal?: AbortSignal,
    ) => void | Promise<void>;
    /** Propagate a committed parent Run cancellation to locally owned child executions. */
    cancelOriginRun?: (runId: string) => void;
    taskControl?: import('../../runtime/tool-execution/router').AppIndependentChildTaskControl;
    backgroundSnapshot?: () => Readonly<{
      aggregateGeneration: string;
      watermark: number;
      executions: readonly import('@kite-ai/runtime-contract').RuntimeBackgroundExecutionProjection[];
    }>;
    approvalProxy?: import('./subagent/child-approval-owner').ChildApprovalProxyOwner;
  }>;
  /** Exact sealed grant tool ceiling supplied by the private child runner. */
  childToolCeiling?: Parameters<
    typeof import('../../runtime/tool-execution/router').executeAppRuntimeTools
  >[0]['childToolCeiling'];
  /** Session Host creates a caller-bound port for the exact prepared Tool call. */
  agentMailboxPortForCall?: (input: {
    readonly state: Readonly<RuntimeState>;
    readonly toolCallId: string;
  }) => import('@kite-ai/builtin-runtime/subagent').AgentMailboxPort | undefined;
  /** Host Store 11 and exact effect callbacks can admit root mailbox commands. */
  agentMailboxAvailable?: boolean;
  /** D2 exact tool surface; does not advertise list/wait/followup/interrupt. */
  agentMailboxQueueOnlyAvailable?: boolean;
  /** Workspace-owned policy proof for one prepared TriggerTurn Tool attempt. */
  followupPolicyForPreparedTool?: NonNullable<
    import('./agent-mailbox-port').CrossSessionRootMailboxInput['authorizeFollowup']
  >;
  /** Child owner may attach one source-funded TriggerTurn at an old Run's next Model boundary. */
  currentTurnFollowup?: Readonly<{
    prepareAgentMail: NonNullable<
      Parameters<typeof import('./model-effect').projectPrimaryModelEffect>[0]['prepareAgentMail']
    >;
    firstAttemptTimeoutMs(): number | undefined;
    /** Narrow the next old-Run Surface while a read-only TriggerTurn is pending. */
    safeToolNames(stage: 'model' | 'tool'): readonly string[] | undefined;
    afterPrepared(
      invocationId: string,
      commitRoute: NonNullable<
        import('@kite-ai/runtime-host/kernel-adapter').StateRuntimeEffectExecutionContext<
          RuntimeState,
          RuntimeEvent
        >['commitCurrentTurnFollowupRoute']
      >,
    ): Promise<boolean>;
    beforeDispatch(invocationId: string): Promise<boolean>;
  }>;
  /** Store11 owner binds each Tool/Model effect to its own active Host commit callback. */
  crossSessionQueueMail?: Readonly<{
    bindForEffect(
      input: Readonly<{
        acceptSource?: import('./cross-session-agent-mail-composition').CrossSessionMailDecisionCommitters['acceptSource'];
        acceptInterruptSource?: import('./cross-session-agent-mail-composition').CrossSessionMailDecisionCommitters['acceptInterruptSource'];
        prepareModel?: import('./cross-session-agent-mail-composition').CrossSessionMailDecisionCommitters['prepareModel'];
      }>,
    ): Readonly<{
      mailbox: import('./agent-mailbox-port').CrossSessionQueueMailPort;
      modelInput: import('./agent-mail-model-input').CrossSessionQueueMailModelPort;
      scheduleDelivery?: (sourceSessionId: string, messageId: string) => void | Promise<void>;
      scheduleFollowup?: (sourceSessionId: string, submissionId: string) => void | Promise<void>;
      scheduleInterrupt?: (
        targetSessionId: string,
        sourceSessionId: string,
        commandId: string,
      ) => void | Promise<void>;
    }>;
  }>;
  crossSessionChildIdentity?: Readonly<{
    parentSessionId: string;
    taskId: string;
    grantId: string;
    grantDigest: string;
  }>;
  afterTurnContinuationRuntime?: import('./subagent/after-turn-continuation').AfterTurnContinuationRuntime;
  /** Session-mailbox persistence retained after the starting Tool effect settles. */
  backgroundModelInvocationPersistence?: ModelInvocationPersistence<RuntimeState, RuntimeEvent> & {
    readonly ownerKey: string;
    readonly recoveryIdentityKey: string;
    readonly commitBackgroundAgentSettlement?: (
      input: import('./subagent/task-tool').BackgroundAgentSettlementCommitInput,
    ) => Promise<
      ReturnType<
        import('@kite-ai/runtime-host/kernel-adapter').StateRuntimeSession['commitBackgroundAgentSettlement']
      >
    >;
  };
  subagentContinuationArtifacts?: import('@kite-ai/builtin-runtime/subagent').SubagentContinuationArtifactAccess;
  subagentTaskRequests?: import('@kite-ai/builtin-runtime/subagent').SubagentTaskRequestArtifactAccess;
  checkpointArtifacts?: Pick<
    import('@kite-ai/builtin-runtime/subagent').SubagentCheckpointArtifactStore,
    'write'
  >;
  /** Independent user/admin authorization source for one remote MCP invocation. */
}

/** Resolve the configured reviewer timeout with the current bounded default. */
export function resolveAutoReviewTimeout(config: AgentConfig): number {
  return config.autoReview?.timeoutMs ?? 15_000;
}

export function resolveRuntimeContextProjectionEnvironment(
  dependencies: RuntimeExecutorDependencies,
  state: RuntimeState,
) {
  const flags = getFeatureFlags(dependencies.config);
  const skillCatalog =
    dependencies.skillOptions && flags.skillWorkflow && flags.skillActivation
      ? refreshSkillCatalog(dependencies.skillOptions, {
          resolveCapability: createSkillCapabilityResolver(dependencies.mcpManager),
        })
      : dependencies.skillCatalog;
  return resolveContextProjectionEnvironment({
    state,
    config: dependencies.config,
    model: dependencies.model,
    shellExecutor: dependencies.shellExecutor,
    mcpManager: dependencies.mcpManager,
    skills: dependencies.skills,
    skillOptions: dependencies.skillOptions,
    skillCatalog,
    subagentEventSink: dependencies.subagentEventSink,
    agentMailboxAvailable:
      dependencies.agentMailboxAvailable === true ||
      dependencies.agentMailboxPortForCall !== undefined,
    agentMailboxQueueOnlyAvailable:
      dependencies.agentMailboxQueueOnlyAvailable === true &&
      dependencies.crossSessionQueueMail !== undefined,
    signal: dependencies.signal,
    sandboxBackend: dependencies.sandboxBackend,
    builtinToolCatalog: requireBuiltinToolCatalog(dependencies),
    delegatedTaskArtifacts: dependencies.delegatedTaskArtifacts,
    subagentTaskRequests: dependencies.subagentTaskRequests,
    childToolCeiling: dependencies.childToolCeiling,
  });
}

function requireBuiltinToolCatalog(
  dependencies: RuntimeExecutorDependencies,
): BuiltinToolCatalogProjection {
  if (!dependencies.builtinToolCatalog) {
    throw new Error('Runtime Builtin tool catalog projection is unavailable.');
  }
  return dependencies.builtinToolCatalog;
}

/** Prepare the exact model input and bounded output before Runtime reservation. */
export function prepareRuntimeEffectForBudget(
  effect: RuntimeEffect,
  state: RuntimeState,
  dependencies: RuntimeExecutorDependencies,
): RuntimeEffect {
  if (effect.type !== 'call_model') return effect;
  const environment = resolveRuntimeContextProjectionEnvironment(dependencies, state);
  const projection = buildContextProjection({
    role: 'agent',
    state,
    serializedTools: environment.serializedTools,
    activeSkillInstructions: environment.activeSkillInstructions,
    workflowSkills: environment.workflowSkills,
    projectInstructions: environment.projectInstructions,
    sandboxBackend: environment.sandboxBackend,
    delegatedTask: environment.delegatedTask,
    transcriptToolCallArgs: environment.transcriptToolCallArgs,
  });
  const capabilities = resolveModelCapabilities({
    config: dependencies.config,
    adapter: dependencies.model.capabilityMetadata,
  });
  const configuredMaxOutput =
    typeof dependencies.config.modelKwargs?.maxOutputTokens === 'number'
      ? dependencies.config.modelKwargs.maxOutputTokens
      : typeof dependencies.config.modelKwargs?.maxTokens === 'number'
        ? dependencies.config.modelKwargs.maxTokens
        : undefined;
  const preflight = preflightModelContext({
    estimate: projection.estimate,
    capabilities,
    requestMaxOutputTokens: configuredMaxOutput,
    providerSafetyRatio: dependencies.config.compaction?.providerSafetyRatio,
    compactRatio: dependencies.config.compaction?.compactRatio,
    hardRatio: dependencies.config.compaction?.hardRatio,
    warningRatio: dependencies.config.compaction?.warningRatio,
  });
  const providerOutputLimit =
    preflight.reservedOutputTokens ?? configuredMaxOutput ?? capabilities.maxOutputTokens;
  const unboundedCumulativeUsage =
    state.resourceBudget.status === 'active' &&
    (state.resourceBudget.budget.durationOnlyChildRun === true ||
      state.resourceBudget.budget.unboundedCumulativeUsage === true);
  const remainingOutputTokens =
    state.resourceBudget.status === 'active'
      ? unboundedCumulativeUsage
        ? providerOutputLimit
        : state.resourceBudget.budget.maxRunOutputTokens -
          committedResourceUsage(state.resourceBudget).counters.outputTokens
      : providerOutputLimit;
  if (remainingOutputTokens == null && !unboundedCumulativeUsage) {
    throw new Error('Model output admission requires a configured Runtime resource budget.');
  }
  const maxOutputTokens =
    remainingOutputTokens == null
      ? undefined
      : Math.max(1, Math.min(providerOutputLimit ?? remainingOutputTokens, remainingOutputTokens));
  return {
    ...effect,
    resourceEstimate: {
      inputTokens: preflight.estimate.totalInputTokens,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    },
  };
}
