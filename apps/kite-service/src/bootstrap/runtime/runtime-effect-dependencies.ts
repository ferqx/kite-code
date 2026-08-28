import type {
  BuiltinToolCatalogProjection,
  CapabilityArtifactAccess,
} from '@kite-ai/builtin-runtime';
import type { McpRuntimeProvider } from '@kite-ai/builtin-runtime/mcp';
import type {
  CompactionReporter,
  ContextCompactionProgressPhase,
  ModelInvocationGateway,
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
import type { SubAgentEventSink } from '@kite-ai/runtime-contract';
import { committedResourceUsage } from '@kite-ai/runtime-host/kernel-adapter';
import { getFeatureFlags } from '#kite-service/config/features';
import type { AgentConfig } from '#kite-service/config/index';
import type { CapabilityExecutionPort } from '#runtime-spi';
import type { ContextCompactor } from './context-compaction-effect';
import { resolveContextProjectionEnvironment } from './model-effect';
import type { RuntimeEffect, RuntimeState, StateRuntimeStorage } from './state-runtime';
import type { AppToolPipelineComposition } from './tool-pipeline-composition';

/** Dependencies owned by the application boundary, never persisted in RuntimeState. */
export interface RuntimeExecutorDependencies {
  config: AgentConfig;
  model: SupportedChatModel;
  /** App-owned wall clock used for durable State effect facts; tests may inject it. */
  now?: () => string;
  shellExecutor?: ShellExecutor;
  gitBroker?: import('@kite-ai/builtin-runtime/git').GitBroker;
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
  subagentEventSink?: SubAgentEventSink;
  /** Explicit unit-test seam; production creates the compactor only through modelEffectCoordinator. */
  testContextCompactor?: ContextCompactor;
  /** Owned and flushed by the application composition root. */
  compactionReporter?: CompactionReporter;
  onCompactionProgress?: (phase: ContextCompactionProgressPhase | undefined) => void;
  /** 用于记录文件写入前原像（ADR-0042 §4），缺省时工具写入不留原像。 */
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
  subagentContinuationArtifacts?: import('@kite-ai/builtin-runtime/subagent').SubagentContinuationArtifactAccess;
  subagentTaskRequests?: import('@kite-ai/builtin-runtime/subagent').SubagentTaskRequestArtifactAccess;
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
    gitBroker: dependencies.gitBroker,
    mcpManager: dependencies.mcpManager,
    skills: dependencies.skills,
    skillOptions: dependencies.skillOptions,
    skillCatalog,
    subagentEventSink: dependencies.subagentEventSink,
    signal: dependencies.signal,
    sandboxBackend: dependencies.sandboxBackend,
    builtinToolCatalog: requireBuiltinToolCatalog(dependencies),
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
        committedResourceUsage(state.resourceBudget).counters.outputTokens
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
