import type {
  BuiltinToolCatalogProjectionV1,
  CapabilityArtifactAccessV1,
  SkillManifest,
  SkillScanOptions,
} from '@kite/builtin-runtime';
import {
  createSkillCapabilityResolver,
  refreshSkillCatalog,
  type SkillCatalogSnapshot,
} from '@kite/builtin-runtime';
import type { McpRuntimeProvider } from '@kite/builtin-runtime/mcp';
import type {
  CompactionReporter,
  ContextCompactionProgressPhase,
  ModelInvocationGatewayV1,
  SupportedChatModel,
} from '@kite/builtin-runtime/model';
import {
  buildContextProjection,
  preflightModelContext,
  resolveModelCapabilities,
} from '@kite/builtin-runtime/model';
import type { PlanArtifactStore } from '@kite/builtin-runtime/planning';
import type { SandboxBackend, ShellExecutor } from '@kite/builtin-runtime/sandbox';
import type { SubAgentEventSink } from '@kite/runtime-contract';
import { committedResourceUsageV1 } from '@kite/runtime-host';
import { getFeatureFlags } from '#app/config/features';
import type { AgentConfig } from '#app/config/index';
import {
  createApprovedProviderDataAdmissionV1,
  denyMissingProviderDataAdmissionV1,
  type ProviderDataAdmissionGateV1,
} from '#app/config/provider-data-admission';
import type { CapabilityExecutionPortV1 } from '#runtime-spi';
import type { ContextCompactor } from './context-compaction-effect';
import { resolveContextProjectionEnvironment } from './model-effect';
import type { RuntimeEffect, RuntimeState, State26SessionStorageV1 } from './state26-runtime';
import type { AppToolPipelineCompositionV1 } from './tool-pipeline-composition';

/** Dependencies owned by the application boundary, never persisted in RuntimeState. */
export interface RuntimeExecutorDependencies {
  config: AgentConfig;
  model: SupportedChatModel;
  /** App-owned wall clock used for durable State26 effect facts; tests may inject it. */
  now?: () => string;
  shellExecutor?: ShellExecutor;
  gitBroker?: import('@kite/builtin-runtime/git').GitBrokerV1;
  sandboxBackend?: SandboxBackend | 'unknown';
  mcpManager?: McpRuntimeProvider;
  /** Host-owned immutable Runtime SPI registry execution port. */
  capabilityExecution?: CapabilityExecutionPortV1;
  /** App projection of the exact frozen snapshot backing capabilityExecution. */
  builtinToolCatalog?: BuiltinToolCatalogProjectionV1;
  /** App composition derived from the same Builtin projection; no second registry. */
  toolPipelineComposition?: AppToolPipelineCompositionV1;
  /** App-owned single Plan Artifact writer; missing means plan dispatch fails closed. */
  planArtifactStore?: PlanArtifactStore;
  skills?: SkillManifest[];
  skillOptions?: SkillScanOptions;
  skillCatalog?: SkillCatalogSnapshot;
  signal?: AbortSignal;
  subagentEventSink?: SubAgentEventSink;
  /** Explicit unit-test seam; production creates the compactor only through modelEffectCoordinator. */
  testContextCompactor?: ContextCompactor;
  /** Owned and flushed by the application composition root. */
  compactionReporter?: CompactionReporter;
  onCompactionProgress?: (phase: ContextCompactionProgressPhase | undefined) => void;
  /** 用于记录文件写入前原像（ADR-0042 §4），缺省时工具写入不留原像。 */
  runtimeStore?: State26SessionStorageV1;
  /** Immutable production Provider policy gate. Missing gate fails closed when enabled. */
  providerDataAdmission?: ProviderDataAdmissionGateV1;
  /** Required by every model-bearing production effect. */
  modelInvocationGateway?: ModelInvocationGatewayV1;
  /** App-owned coordinator bound to the exact same Model Gateway. */
  modelEffectCoordinator?: import('@kite/builtin-runtime/model').BuiltinModelEffectCoordinatorV1;
  /** Installation-private capability receipt writer; never synthesized at dispatch time. */
  capabilityArtifactStore?: CapabilityArtifactAccessV1;
  /** Explicit Local/Test filesystem Provider composition; no runtime fallback exists. */
  workspaceFilesystemRuntime?: import('@kite/builtin-runtime/filesystem').BuiltinWorkspaceFilesystemRuntimeV1;
  sandboxPreparationArtifacts?: import('@kite/builtin-runtime/sandbox').SandboxPreparationArtifactStoreV1;
  subagentRuntimeFactory?: import('./subagent/pipeline-runtime').AppSubagentRuntimeFactoryV1;
  subagentContinuationArtifacts?: import('#builtin-runtime').SubagentContinuationArtifactAccessV1;
  subagentTaskRequests?: import('#builtin-runtime').SubagentTaskRequestArtifactAccessV1;
  /** Independent user/admin authorization source for one remote MCP invocation. */
}

/** Resolve the reviewer timeout while preserving the pre-flag compatibility path. */
export function resolveAutoReviewTimeout(config: AgentConfig): number {
  return getFeatureFlags(config).autoReviewV2 ? (config.autoReview?.timeoutMs ?? 15_000) : 15_000;
}

export function reviewerProviderDataAdmission(
  dependencies: RuntimeExecutorDependencies,
  reviewerConfig: AgentConfig,
): ProviderDataAdmissionGateV1 {
  const sameRoute =
    reviewerConfig.providerType === dependencies.config.providerType &&
    reviewerConfig.providerName === dependencies.config.providerName &&
    reviewerConfig.modelName === dependencies.config.modelName &&
    reviewerConfig.baseURL === dependencies.config.baseURL;
  return sameRoute
    ? (dependencies.providerDataAdmission ?? denyMissingProviderDataAdmissionV1)
    : createApprovedProviderDataAdmissionV1(reviewerConfig);
}

export function runtimeProviderDataAdmission(
  dependencies: RuntimeExecutorDependencies,
): ProviderDataAdmissionGateV1 {
  return dependencies.providerDataAdmission ?? denyMissingProviderDataAdmissionV1;
}

export function resolveRuntimeContextProjectionEnvironment(
  dependencies: RuntimeExecutorDependencies,
  state: RuntimeState,
) {
  const flags = getFeatureFlags(dependencies.config);
  const skillCatalog =
    dependencies.skillOptions && flags.skillWorkflowV1 && flags.skillActivationV2
      ? refreshSkillCatalog(dependencies.skillOptions, {
          resolveCapability: createSkillCapabilityResolver(dependencies.mcpManager),
        })
      : dependencies.skillCatalog;
  return resolveContextProjectionEnvironment({
    state,
    config: dependencies.config,
    model: dependencies.model,
    shellExecutor: dependencies.shellExecutor,
    gitBroker: dependencies.gitBroker,
    mcpManager: dependencies.mcpManager,
    skills: dependencies.skills,
    skillOptions: dependencies.skillOptions,
    skillCatalog,
    subagentEventSink: dependencies.subagentEventSink,
    signal: dependencies.signal,
    sandboxBackend: dependencies.sandboxBackend,
    builtinToolCatalog: requireBuiltinToolCatalogV1(dependencies),
  });
}

function requireBuiltinToolCatalogV1(
  dependencies: RuntimeExecutorDependencies,
): BuiltinToolCatalogProjectionV1 {
  if (!dependencies.builtinToolCatalog) {
    throw new Error('Runtime Builtin tool catalog projection is unavailable.');
  }
  return dependencies.builtinToolCatalog;
}

/** Prepare the exact model input and bounded output before Runtime reservation. */
export function prepareRuntimeEffectForBudgetV1(
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
    promptContractVersion: environment.promptContractVersion,
    projectInstructions: environment.projectInstructions,
    sandboxBackend: environment.sandboxBackend,
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
  const remainingOutputTokens =
    state.resourceBudget.status === 'active'
      ? state.resourceBudget.budget.maxRunOutputTokens -
        committedResourceUsageV1(state.resourceBudget).counters.outputTokens
      : providerOutputLimit;
  if (remainingOutputTokens == null) {
    throw new Error('Model output admission requires a configured Runtime resource budget.');
  }
  return {
    ...effect,
    resourceEstimate: {
      inputTokens: preflight.estimate.totalInputTokens,
      maxOutputTokens: Math.max(
        1,
        Math.min(providerOutputLimit ?? remainingOutputTokens, remainingOutputTokens),
      ),
    },
  };
}
