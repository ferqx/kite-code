import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  ExecutionBoundary,
  ExecutionBoundaryAdmission,
  ExecutionCapabilitySurface,
  ProductionExecutionEntrypoint,
} from '@kite-ai/builtin-runtime/sandbox';
import {
  acquireConfigFileMutationLock,
  acquireConfigFileMutationLocks,
  replaceConfigFileAtomically,
} from '@kite-ai/kite-local-runtime/config';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { z } from 'zod';
import { admitProductionExecutionBoundary } from './execution-boundary';
import { type FeatureFlags, getFeatureFlags } from './features';
import { mcpServerSchema } from './mcp-server-config';
import { defaultConfigPath, projectConfigPath } from './paths';
import { resolveSessionLoggingPolicy, type SessionLoggingPolicy } from './session-logging-policy';

export type {
  ExecutionBoundaryAdmissionInput,
  ExecutionBoundaryQualificationEvaluationInput,
  TightenExecutionBoundaryInput,
} from './execution-boundary';
export {
  admitProductionExecutionBoundary,
  computeExecutionBoundaryDigest,
  executionBackendCapabilitiesSchema,
  executionBoundarySchema,
  parseExecutionBoundary,
  tightenExecutionBoundary,
} from './execution-boundary';
export {
  APPROVED_PRODUCTION_EXECUTION_QUALIFICATION_DIGEST_,
  APPROVED_PRODUCTION_EXECUTION_QUALIFICATION_REVISION_,
  computeInProcessReadOnlyToolCatalogDigest,
  computeProductionExecutionQualificationRegistryDigest,
  inProcessReadOnlyToolCatalogSchema,
  loadApprovedProductionExecutionQualificationRegistry,
  parseProductionExecutionQualification,
  parseProductionExecutionQualificationRegistry,
  productionExecutionQualificationRegistrySchema,
  qualificationMatchesExecutionEnvironment,
} from './execution-qualification';

export {
  DEFAULT_FEATURE_FLAGS,
  getFeatureFlags,
  isFeatureFlagName,
  parseFeatureOverride,
} from './features';
export type {
  McpConfigApprovalStatus,
  McpConfigCatalog,
  McpConfigDiagnostic,
  McpConfigSource,
  McpConfigSourceKind,
  McpProjectServerApprovalView,
  McpServerConfigEntry,
  McpWritableScope,
} from './mcp-config';
export { loadMcpConfigCatalog } from './mcp-config';
export type {
  McpConfigCommand,
  McpConfigPatch,
  McpConfigRepository,
  McpServerConfigInput,
} from './mcp-config-repository';
export {
  DefaultMcpConfigRepository,
  McpConfigMutationError,
  validateMcpServerName,
} from './mcp-config-repository';
export { expandEnvVars } from './mcp-server-config';
export type {
  CapabilityMaturity,
  CapabilityProfile,
  CapabilityProfileAdmissionDecision,
  CapabilityProfileAdmissionReason,
  CapabilityProfileDependencyState,
  CapabilityReleaseState,
  ReleaseCapability,
  RolloutStage,
} from './release-capabilities';
export {
  CAPABILITY_MATURITIES,
  CAPABILITY_MATURITY_RANK,
  CAPABILITY_PROFILE_GATES_,
  CAPABILITY_PROFILE_VERSION_,
  capabilityMaturitySchema,
  capabilityProfileSchema,
  capabilityReleaseStateSchema,
  evaluateCapabilityProfileAdmission,
  isCapabilityReleaseStateValid,
  parseCapabilityProfile,
  parseCapabilityReleaseState,
  RELEASE_CAPABILITIES,
  ROLLOUT_STAGE_RANK,
  ROLLOUT_STAGES,
  releaseCapabilitySchema,
  rolloutStageSchema,
} from './release-capabilities';
export type {
  EmbeddedReleaseProfileId,
  ProductionDistributionTarget,
  ProductionDistributionTargetIdentity,
  ReleaseChannel,
  ReleaseProfile,
  ReleaseProfileApprovalRequirement,
  ReleaseProfileVerificationRequirement,
} from './release-profile';
export {
  admitEmbeddedReleaseProfile,
  admitProductionDistributionTargetIdentity,
  EMBEDDED_RELEASE_PROFILES_,
  PRODUCTION_DISTRIBUTION_TARGET_IDENTITIES_,
  PRODUCTION_DISTRIBUTION_TARGETS_,
  ProductionReleaseProfileAdmissionError,
  parseProductionDistributionTargetIdentity,
  parseReleaseProfile,
  RELEASE_PROFILE_VERSION,
  releaseCapabilityStatesSchema,
  releaseProfileSchema,
  SUPPORTED_PRODUCTION_EXECUTION_TARGETS_,
} from './release-profile';
export type {
  ReleaseProfileRestriction,
  ReleaseProfileRestrictionLayer,
  ReleaseProfileRestrictionSource,
} from './release-profile-composer';
export {
  composeReleaseProfile,
  ReleaseProfileEscalationError,
  releaseProfileRestrictionLayerSchema,
  releaseProfileRestrictionSchema,
} from './release-profile-composer';
export type {
  SessionLoggingMode,
  SessionLoggingPolicy,
  SessionLoggingPolicyTightening,
} from './session-logging-policy';
export {
  DEFAULT_SESSION_LOGGING_POLICY_,
  parseSessionLoggingPolicy,
  resolveSessionLoggingPolicy,
  sessionLoggingPolicySchema,
  tightenSessionLoggingPolicy,
} from './session-logging-policy';

// ── Zod schemas ──

const modelEntrySchema = z.union([
  z.string().min(1),
  z
    .object({
      name: z.string().min(1),
      default: z.boolean().optional(),
      contextWindow: z.number().int().positive().optional(),
      /** @deprecated Use contextWindow. */
      tokens: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
      tokenizerFamily: z.string().min(1).optional(),
      supportsUsageMetadata: z.boolean().optional(),
      supportsPromptCache: z.boolean().optional(),
      streaming: z.boolean().optional(),
    })
    .strict(),
]);

const providerSchema = z.object({
  type: z.enum(['deepseek', 'openai', 'openai-compatible', 'ollama']).optional(),
  apiKey: z.string().optional(),
  baseURL: z.string().url().optional(),
  /** Default model name */
  model: z.string().optional(),
  /** Reasoning effort (low | medium | high | xhigh | max) */
  effort: z.string().optional(),
  /** Whether to pass reasoning_effort to the API. Default: deepseek=true, others=false. */
  reasoning: z.boolean().optional(),
  /** Extra kwargs passed through to the LangChain model constructor */
  modelKwargs: z.record(z.string(), z.any()).optional(),
  /** Available model names (string[]) */
  models: z.array(modelEntrySchema).optional(),
});

const interactionModeSchema = z.enum(['accept_edits', 'auto', 'full']);
const languagePreferenceSchema = z.enum(['system', 'zh-CN', 'en-US']);
const modelRouteObjectSchema = z
  .object({
    provider: z.string().trim().min(1),
    name: z.string().trim().min(1),
  })
  .strict();
const compactModelRouteSchema = z
  .string()
  .trim()
  .refine((value) => {
    const separator = value.indexOf(':');
    return separator > 0 && value.slice(separator + 1).trim().length > 0;
  }, 'Expected model route in provider:model format')
  .transform((value) => {
    const separator = value.indexOf(':');
    return {
      provider: value.slice(0, separator).trim(),
      name: value.slice(separator + 1).trim(),
    };
  });
const modelRouteSchema = z.union([compactModelRouteSchema, modelRouteObjectSchema]);
const modelSelectionSchema = z
  .union([
    compactModelRouteSchema.transform((route) => ({ default: route })),
    z.object({ default: modelRouteSchema }).strict(),
  ])
  .optional();
const sandboxSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .optional();
const sessionLoggingTighteningSchema = z
  .object({
    mode: z.enum(['off', 'metadata', 'content']).optional(),
    retentionDays: z.number().int().positive().optional(),
    maxTotalBytes: z.number().int().positive().optional(),
    maxSessionBytes: z.number().int().positive().optional(),
  })
  .strict()
  .optional();
const telemetryConsentGrantSchema = z
  .object({
    state: z.enum(['granted', 'withdrawn']),
    metricCategories: z.array(
      z.enum(['run_turn', 'model_usage', 'tool_mcp_skill', 'runtime_resource', 'release_rollout']),
    ),
    receiver: z.string().trim().min(1).max(128),
    retentionDays: z.number().int().nonnegative(),
    withdrawalMethod: z.string().trim().min(1).max(256),
    canaryOptIn: z.boolean(),
  })
  .strict();
const telemetryConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    endpointPolicy: z.enum(['disabled', 'vendor_managed', 'admin_managed']).optional(),
    endpointSecret: z.string().min(1).optional(),
    consent: telemetryConsentGrantSchema.optional(),
    contentLoggingConsent: z.boolean().optional(),
    modelProviderConsent: z.boolean().optional(),
  })
  .strict()
  .optional();

const featuresSchema = z
  .object({
    planLifecycle: z.boolean().optional(),
    interactionController: z.boolean().optional(),
    autoReview: z.boolean().optional(),
    nativeLoopEngine: z.boolean().optional(),
    loopMode: z.boolean().optional(),
    capabilityCatalog: z.boolean().optional(),
    mcpRuntimeBinding: z.boolean().optional(),
    mcpExecutionRecord: z.boolean().optional(),
    mcpProviderAction: z.boolean().optional(),
    skillActivation: z.boolean().optional(),
    skillWorkflow: z.boolean().optional(),
    verification: z.boolean().optional(),
    toolSearch: z.boolean().optional(),
    contextCompaction: z.boolean().optional(),
    contextCompactionAuto: z.boolean().optional(),
    contextCompactionManual: z.boolean().optional(),
    sessionLoggingPolicy: z.boolean().optional(),
    resourceBudget: z.boolean().optional(),
    terminalOutcome: z.boolean().optional(),
    boundedCancellation: z.boolean().optional(),
    executionBoundary: z.boolean().optional(),
    networkBoundary: z.boolean().optional(),
    releaseProfile: z.boolean().optional(),
    observabilityMetrics: z.boolean().optional(),
  })
  .strict()
  .optional();

export const configSchema = z.object({
  provider: z.record(z.string(), providerSchema).optional().default({}),
  /** Last model route explicitly selected by the user. */
  model: modelSelectionSchema,
  theme: z.enum(['dark', 'light']).optional(),
  colorPreset: z.string().optional(),
  /** Personal terminal language preference. Project config must never override it. */
  language: languagePreferenceSchema.optional(),
  interactionMode: interactionModeSchema.optional(),
  features: featuresSchema,
  sessionLogging: sessionLoggingTighteningSchema,
  telemetry: telemetryConfigSchema,
  sandbox: sandboxSchema,
  autoReview: z
    .object({
      provider: z.string().optional(),
      model: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
      failOpen: z.boolean().optional(),
      doomLoopRepeatThreshold: z.number().int().positive().optional(),
      circuitBreakerMaxRejections: z.number().int().positive().optional(),
      circuitBreakerWindowMs: z.number().int().positive().optional(),
    })
    .optional(),
  compaction: z
    .object({
      autoMode: z.enum(['off', 'shadow', 'live']).optional(),
      cohortSalt: z.string().min(1).optional(),
      livePercentage: z.number().min(0).max(100).optional(),
      localDebug: z
        .object({ enabled: z.boolean(), directory: z.string().min(1) })
        .strict()
        .optional(),
      triggerRatio: z.number().positive().max(1).optional(),
      compactAfterEstimatedTokens: z.number().int().positive().optional(),
      maxSummaryTokens: z.number().int().positive().optional(),
      maxSummaryInputTokens: z.number().int().positive().optional(),
      maxNarrativeTokens: z.number().int().positive().optional(),
      compactRatio: z.number().positive().max(1).optional(),
      hardRatio: z.number().positive().max(1).optional(),
      warningRatio: z.number().positive().max(1).optional(),
      minimumReductionRatio: z.number().nonnegative().max(1).optional(),
      cooldownTurns: z.number().int().nonnegative().optional(),
      providerSafetyRatio: z.number().positive().max(0.2).optional(),
    })
    .strict()
    .superRefine((val, ctx) => {
      if (
        val.maxSummaryTokens != null &&
        val.maxNarrativeTokens != null &&
        val.maxSummaryTokens > val.maxNarrativeTokens
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'maxSummaryTokens must not exceed maxNarrativeTokens',
          path: ['maxSummaryTokens'],
        });
      }
      const warning = val.warningRatio ?? 0.8;
      const compact = val.compactRatio ?? 0.9;
      const hard = val.hardRatio ?? 0.94;
      if (warning >= compact) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `warningRatio (${warning}) must be less than compactRatio (${compact})`,
          path: ['warningRatio'],
        });
      }
      if (compact >= hard) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `compactRatio (${compact}) must be less than hardRatio (${hard})`,
          path: ['compactRatio'],
        });
      }
    })
    .optional(),
  mcpServers: z.record(z.string(), mcpServerSchema).optional().default({}),
});

export type KiteCodeConfig = z.infer<typeof configSchema>;
export type LanguagePreference = z.infer<typeof languagePreferenceSchema>;
export type InteractionModePreference = z.infer<typeof interactionModeSchema>;

// ── Types ──

export type ModelProviderType = 'deepseek' | 'openai' | 'openai-compatible' | 'ollama';

/** Agent 配置 / Agent configuration */
export interface AgentConfig {
  /** API 密钥 / API key */
  apiKey: string;
  /** API 基础 URL / API base URL */
  baseURL: string;
  /** 模型名称 / Model name */
  modelName: string;
  /** 提供商名称 / Provider name */
  providerName: string;
  /** LangChain adapter 类型 / LangChain adapter type */
  providerType: ModelProviderType;
  /** 思考程度，映射到 reasoning_effort API 参数。仅 reasoning=true 时生效。 */
  reasoningEffort?: string | null;
  /** 是否启用思考字段回传。缺省时按 providerType 推断：deepseek=true，其他=false。 */
  reasoning?: boolean;
  /** True only when the provider configuration explicitly sets `reasoning: false`. */
  reasoningExplicitlyDisabled?: boolean;
  /** 透传给 LangChain 模型构造器的额外参数 */
  modelKwargs?: Record<string, unknown>;
  /** Explicit capabilities from the selected model entry, before catalog fallback resolution. */
  modelCapabilities?: {
    contextWindowTokens?: number;
    maxOutputTokens?: number;
    tokenizerFamily?: string;
    supportsUsageMetadata?: boolean;
    supportsPromptCache?: boolean;
    streaming?: boolean;
  };
  interactionMode?: z.infer<typeof interactionModeSchema>;
  features?: Partial<FeatureFlags>;
  /** Release-pinned execution boundary; never sourced from project/user config. */
  executionBoundary?: ExecutionBoundary;
  /** Exact capability surface admitted by the sealed production gate. */
  executionCapabilitySurface?: ExecutionCapabilitySurface;
  /** Release-owned native evidence; never accepted from project/user config. */
  brokeredGitShellDenyEvidence?: import('@kite-ai/runtime-spi').GitShellDenyEvidence;
  /** Resolved artifact + user + project session logging policy. */
  sessionLoggingPolicy?: SessionLoggingPolicy;
  /** Source-aware telemetry preferences; App consent composition remains authoritative. */
  telemetry?: {
    user?: NonNullable<KiteCodeConfig['telemetry']>;
    project?: { enabled?: boolean };
  };
  sandbox: {
    enabled: boolean;
  };
  autoReview?: {
    provider?: string;
    model?: string;
    timeoutMs?: number;
    failOpen?: boolean;
    doomLoopRepeatThreshold?: number;
    circuitBreakerMaxRejections?: number;
    circuitBreakerWindowMs?: number;
  };
  compaction?: NonNullable<KiteCodeConfig['compaction']>;
}

declare const productionAgentConfigBrand: unique symbol;

/** Config returned only after release-approved execution admission. */
export interface ProductionAgentConfig extends AgentConfig {
  readonly [productionAgentConfigBrand]: true;
  executionBoundary: ExecutionBoundary;
  executionCapabilitySurface: ExecutionCapabilitySurface;
  sandbox: { readonly enabled: true };
  productionExecution: NonNullable<ExecutionBoundaryAdmission['qualificationProof']>;
}

/** 加载配置选项 / Configuration loading options */
export interface LoadAgentConfigOptions {
  /** 配置文件路径 / Configuration file path */
  configPath?: string;
  /** 覆盖默认 provider 名称 / Override default provider name */
  providerName?: string;
  /** 覆盖默认模型名称 / Override default model name */
  modelName?: string;
  /** Workspace whose project config is loaded. Defaults to process.cwd(). */
  workspace?: string;
  /** Release-controlled policy; callers cannot source this from project config. */
  artifactSessionLoggingPolicy?: SessionLoggingPolicy;
}

export interface LoadProductionAgentConfigOptions extends LoadAgentConfigOptions {
  /** Release-profile ceiling. Config rollout can only disable it. */
  artifactExecutionBoundaryV1Enabled: boolean;
  /** Release-controlled boundary. Project/user config cannot define it. */
  artifactExecutionBoundary: unknown;
  /** Canonical workspace selected by the composition root. */
  workspaceRoot: string;
  /** Production composition root being admitted. */
  entrypoint: ProductionExecutionEntrypoint;
  /** CLI/App rollout overrides; still bounded by the release ceiling. */
  featureOverrides?: Partial<FeatureFlags>;
  /** CLI/App sandbox restriction; false cannot be overridden by config. */
  sandboxEnabled?: boolean;
}

export function composeExecutionBoundaryRollout(layers: readonly (boolean | undefined)[]): boolean {
  const explicit = layers.filter((value): value is boolean => value !== undefined);
  return explicit.length > 0 && explicit.every((value) => value);
}

function composeSandboxEnabled(layers: readonly (boolean | undefined)[]): boolean {
  return layers.every((value) => value !== false);
}

export {
  defaultCheckpointPath,
  defaultConfigPath,
  editorInputPath,
  mcpProjectApprovalPath,
  projectConfigPath,
  projectMcpConfigPath,
  sessionExportPath,
  userMcpConfigPath,
} from './paths';

// ── Defaults (DeepSeek) ──

const DEFAULT_DEEPSEEK_MODELS: AvailableModel[] = [
  { provider: 'deepseek', name: 'deepseek-v4-flash', isDefault: true },
  { provider: 'deepseek', name: 'deepseek-v4-pro', isDefault: false },
];

// ── Config file loading ──

/** Read and parse a single config file. Returns null if not found. */
function readConfigFile(path: string): KiteCodeConfig | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  return configSchema.parse(parse(raw));
}

/** Merge project config over user config. */
function mergeConfigs(user: KiteCodeConfig, project: KiteCodeConfig): KiteCodeConfig {
  return {
    provider: { ...user.provider, ...project.provider },
    // The last route selected by this user is a personal UI preference and
    // intentionally takes precedence over a project-provided initial default.
    model: user.model ?? project.model,
    theme: project.theme ?? user.theme,
    colorPreset: project.colorPreset ?? user.colorPreset,
    // Interface language is a personal preference. A repository must not be
    // able to change the language of the workspace trust or approval screens.
    language: user.language,
    // Permission mode is an explicit personal choice. A trusted repository may
    // provide the initial default, but it must not overwrite a mode the user
    // selected and persisted through the TUI.
    interactionMode: user.interactionMode ?? project.interactionMode,
    features: { ...user.features, ...project.features },
    sessionLogging: project.sessionLogging ?? user.sessionLogging,
    telemetry: user.telemetry,
    sandbox: project.sandbox ?? user.sandbox,
    autoReview: project.autoReview ?? user.autoReview,
    compaction: project.compaction ?? user.compaction,
    mcpServers: { ...user.mcpServers, ...project.mcpServers },
  };
}

/**
 * Load and merge user-level (~/.kite-code/kite-code.jsonc) + project-level (.kite-code/kite-code.jsonc).
 * Project overrides user.
 * When explicitPath is given, loads only that file (no merge).
 * Falls back to DeepSeek defaults when no config file exists.
 */
function loadConfig(workspace?: string, explicitPath?: string): KiteCodeConfig {
  if (explicitPath) {
    const cfg = readConfigFile(explicitPath);
    if (!cfg) {
      throw new Error(`Kite Code config file not found: ${explicitPath}`);
    }
    return cfg;
  }
  const user = readConfigFile(defaultConfigPath());
  const project = readConfigFile(projectConfigPath(workspace));
  if (user && project) return mergeConfigs(user, project);
  if (user) return user;
  if (project) return project;
  // No config file → DeepSeek defaults
  return defaultKiteCodeConfig();
}

function defaultKiteCodeConfig(): KiteCodeConfig {
  return {
    provider: {
      deepseek: {
        baseURL: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-flash',
        models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      },
    },
    model: {
      default: { provider: 'deepseek', name: 'deepseek-v4-flash' },
    },
    theme: 'dark',
    interactionMode: 'auto',
    features: {},
    telemetry: undefined,
    sandbox: { enabled: true },
    mcpServers: {},
  };
}

// ── Agent config ──

/** 加载并解析 Agent 配置 / Load and parse agent configuration */
export function loadAgentConfig(options: LoadAgentConfigOptions = {}): AgentConfig {
  const { configPath } = options;
  const workspace = options.workspace ?? process.cwd();
  const cfg = loadConfig(workspace, configPath);
  const userSessionLogging = configPath
    ? cfg.sessionLogging
    : readConfigFile(defaultConfigPath())?.sessionLogging;
  const projectSessionLogging = configPath
    ? undefined
    : readConfigFile(projectConfigPath(workspace))?.sessionLogging;
  const userTelemetry = configPath ? cfg.telemetry : readConfigFile(defaultConfigPath())?.telemetry;
  const projectTelemetry = configPath
    ? undefined
    : readConfigFile(projectConfigPath(workspace))?.telemetry;
  const sessionLoggingPolicy = resolveSessionLoggingPolicy({
    enabled: getFeatureFlags(cfg).sessionLoggingPolicy,
    artifactPolicy: options.artifactSessionLoggingPolicy,
    user: userSessionLogging,
    project: projectSessionLogging,
  });
  const defaultModel = findDefaultModel(cfg);

  const providerName = options.providerName ?? defaultModel?.provider ?? 'deepseek';
  const provider = cfg.provider?.[providerName] ?? builtInProvider(providerName);

  if (!provider) {
    throw new Error(`Model provider '${providerName}' is not configured`);
  }

  const providerType = provider.type ?? inferProviderType(providerName);

  const reasoningEffort = provider.effort ?? null;
  const reasoning = provider.reasoning ?? inferReasoningDefault(providerType);
  const selectedDefaultName =
    defaultModel?.provider === providerName ? defaultModel.name : undefined;
  const modelName =
    options.modelName ?? selectedDefaultName ?? provider.model ?? 'deepseek-v4-flash';
  const selectedModel = provider.models?.find((entry) => modelEntryName(entry) === modelName);
  const selected = selectedModel && typeof selectedModel === 'object' ? selectedModel : undefined;

  return {
    apiKey: resolveProviderApiKey(providerName, providerType, provider.apiKey),
    baseURL: resolveProviderBaseURL(providerName, providerType, provider.baseURL),
    modelName,
    providerName,
    providerType,
    reasoningEffort,
    reasoning,
    reasoningExplicitlyDisabled: provider.reasoning === false,
    modelKwargs: provider.modelKwargs as Record<string, unknown> | undefined,
    ...(selected
      ? {
          modelCapabilities: {
            ...((selected.contextWindow ?? selected.tokens)
              ? { contextWindowTokens: selected.contextWindow ?? selected.tokens }
              : {}),
            ...(selected.maxOutputTokens ? { maxOutputTokens: selected.maxOutputTokens } : {}),
            ...(selected.tokenizerFamily ? { tokenizerFamily: selected.tokenizerFamily } : {}),
            ...(selected.supportsUsageMetadata != null
              ? { supportsUsageMetadata: selected.supportsUsageMetadata }
              : {}),
            ...(selected.supportsPromptCache != null
              ? { supportsPromptCache: selected.supportsPromptCache }
              : {}),
            ...(selected.streaming != null ? { streaming: selected.streaming } : {}),
          },
        }
      : {}),
    interactionMode: cfg.interactionMode ?? 'auto',
    features: cfg.features,
    sessionLoggingPolicy,
    telemetry: {
      ...(userTelemetry ? { user: userTelemetry } : {}),
      ...(projectTelemetry ? { project: { enabled: projectTelemetry.enabled } } : {}),
    },
    sandbox: { enabled: cfg.sandbox?.enabled ?? true },
    autoReview: cfg.autoReview,
    compaction: cfg.compaction,
  };
}

export class ProductionExecutionAdmissionError extends Error {
  readonly decision: ExecutionBoundaryAdmission;

  constructor(decision: ExecutionBoundaryAdmission) {
    super(`Production execution admission denied: ${decision.reason}`);
    this.name = 'ProductionExecutionAdmissionError';
    this.decision = decision;
  }
}

/**
 * Production-only composition gate. It resolves ordinary configuration but
 * returns no runnable config unless both release and rollout flags are enabled
 * and the sealed native qualification registry admits this exact environment.
 */
export function loadProductionAgentConfig(
  options: LoadProductionAgentConfigOptions,
): ProductionAgentConfig {
  const {
    artifactExecutionBoundary,
    artifactExecutionBoundaryV1Enabled,
    workspaceRoot,
    entrypoint,
    featureOverrides,
    sandboxEnabled,
    ...agentOptions
  } = options;
  const canonicalWorkspaceRoot = realpathSync.native(resolve(workspaceRoot));
  const configLayers = agentOptions.configPath
    ? [readConfigFile(agentOptions.configPath)]
    : [
        readConfigFile(defaultConfigPath()),
        readConfigFile(projectConfigPath(canonicalWorkspaceRoot)),
      ];
  const executionBoundaryRolloutEnabled = composeExecutionBoundaryRollout([
    ...configLayers.map((layer) => layer?.features?.executionBoundary),
    featureOverrides?.executionBoundary,
  ]);
  const networkBoundaryRolloutEnabled = composeExecutionBoundaryRollout([
    ...configLayers.map((layer) => layer?.features?.networkBoundary),
    featureOverrides?.networkBoundary,
  ]);
  const effectiveSandboxEnabled = composeSandboxEnabled([
    ...configLayers.map((layer) => layer?.sandbox?.enabled),
    sandboxEnabled,
  ]);
  const config = loadAgentConfig({ ...agentOptions, workspace: canonicalWorkspaceRoot });
  const resolvedFeatures = { ...config.features, ...featureOverrides };
  const featureEnabled = artifactExecutionBoundaryV1Enabled && executionBoundaryRolloutEnabled;
  const decision = admitProductionExecutionBoundary({
    featureEnabled,
    boundary: artifactExecutionBoundary,
    workspaceRoot: canonicalWorkspaceRoot,
    entrypoint,
    sandboxEnabled: effectiveSandboxEnabled,
  });
  if (
    !decision.allowed ||
    decision.admissionKind !== 'release_approved' ||
    !decision.boundary ||
    !decision.qualificationProof
  ) {
    throw new ProductionExecutionAdmissionError(decision);
  }
  return {
    ...config,
    features: {
      ...resolvedFeatures,
      executionBoundary: true,
      networkBoundary: networkBoundaryRolloutEnabled,
    },
    executionBoundary: decision.boundary,
    executionCapabilitySurface: networkBoundaryRolloutEnabled
      ? decision.surface
      : { ...decision.surface, network: false },
    brokeredGitShellDenyEvidence: decision.qualificationProof.brokeredGitShellDenyEvidence,
    sandbox: { enabled: true },
    productionExecution: decision.qualificationProof,
  } as ProductionAgentConfig;
}

/** Like loadAgentConfig but returns null instead of throwing when no API key is configured. */
export function tryLoadAgentConfig(options: LoadAgentConfigOptions = {}): AgentConfig | null {
  try {
    return loadAgentConfig(options);
  } catch {
    // No config file or missing API key → first-run setup needed
    return null;
  }
}

export type ConfigProbeResult =
  | {
      status: 'ready';
      config: AgentConfig;
    }
  | {
      status: 'not-configured';
    }
  | {
      status: 'invalid';
      path: string;
      message: string;
    };

/**
 * Probe the agent configuration, distinguishing between:
 * - ready: valid config with an API key
 * - not-configured: no config file or no API key
 * - invalid: config file exists but is malformed / fails schema validation
 *
 * Does NOT auto-enter setup; callers decide how to handle each case.
 */
export function probeAgentConfig(options: LoadAgentConfigOptions = {}): ConfigProbeResult {
  const configPath = options.configPath ?? defaultConfigPath();
  try {
    const config = loadAgentConfig(options);
    return { status: 'ready', config };
  } catch (err) {
    if (err instanceof z.ZodError) {
      // If the only issue is an empty/missing apiKey, treat as not-configured
      // rather than "configuration corrupt". The Zod schema uses .min(1) which
      // rejects empty strings before resolveProviderApiKey can throw "requires apiKey".
      const isApiKeyOnly = err.issues.every(
        (issue) => issue.path.includes('apiKey') && issue.code === 'too_small',
      );
      if (isApiKeyOnly) {
        return { status: 'not-configured' };
      }
      const firstIssue = err.issues[0];
      const message = firstIssue
        ? `${firstIssue.path.join('.')}: ${firstIssue.message}`
        : 'Configuration schema validation failed.';
      return { status: 'invalid', path: configPath, message };
    }
    if (err instanceof Error && err.message.includes('requires apiKey')) {
      // Config file exists but has no API key — treat as not yet configured
      return { status: 'not-configured' };
    }
    if (err instanceof Error && err.message.includes('config file not found')) {
      return { status: 'not-configured' };
    }
    // Parsing errors from jsonc-parser, or other unexpected failures during load
    if (err instanceof Error) {
      return { status: 'invalid', path: configPath, message: err.message };
    }
    return { status: 'not-configured' };
  }
}

function inferProviderType(providerName: string): ModelProviderType {
  if (providerName === 'deepseek') return 'deepseek';
  if (providerName === 'ollama') return 'ollama';
  return 'openai-compatible';
}

/** Default reasoning support: only DeepSeek enables it by default. */
function inferReasoningDefault(type: ModelProviderType): boolean {
  return type === 'deepseek';
}

function builtInProvider(providerName: string): z.infer<typeof providerSchema> | null {
  if (providerName === 'ollama') return { type: 'ollama' };
  if (providerName === 'deepseek')
    return { type: 'deepseek', baseURL: 'https://api.deepseek.com/v1' };
  return null;
}

/** Normalize a model entry (string or object) to its name string. */
function modelEntryName(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && 'name' in entry)
    return (entry as { name: string }).name;
  return null;
}

function modelEntryObject(entry: unknown): {
  default?: boolean;
  contextWindow?: number;
  tokens?: number;
  maxOutputTokens?: number;
} | null {
  return entry && typeof entry === 'object'
    ? (entry as {
        default?: boolean;
        contextWindow?: number;
        tokens?: number;
        maxOutputTokens?: number;
      })
    : null;
}

/**
 * Find the default model from config.
 * Priority:
 * 1. Persisted top-level model route, when still configured
 * 2. Provider with apiKey + model set (first found)
 * 3. Provider with apiKey + default:true model
 * 4. Provider with apiKey + first model
 * 5. Provider with model + apiKey from env var
 * 6. Fall through all providers regardless of apiKey
 */
function findDefaultModel(cfg: KiteCodeConfig): { provider: string; name: string } | null {
  const persisted = cfg.model?.default;
  if (persisted && isConfiguredModelRoute(cfg, persisted)) return persisted;

  // Pass 1: providers with an explicit apiKey
  for (const [provName, prov] of Object.entries(cfg.provider)) {
    if (!prov.apiKey) continue;
    if (prov.model && prov.models?.length) return { provider: provName, name: prov.model };
    if (prov.models) {
      for (const m of prov.models) {
        if (modelEntryObject(m)?.default) {
          const name = modelEntryName(m);
          if (name) return { provider: provName, name };
        }
      }
    }
  }
  // Pass 2: providers with models (apiKey may come from env var)
  for (const [provName, prov] of Object.entries(cfg.provider)) {
    if (prov.model && prov.models?.length) return { provider: provName, name: prov.model };
    if (prov.models) {
      for (const m of prov.models) {
        if (modelEntryObject(m)?.default) {
          const name = modelEntryName(m);
          if (name) return { provider: provName, name };
        }
      }
    }
  }
  // Fallback: first model of any provider with models
  // Fallback: first model of first provider with models
  for (const [provName, prov] of Object.entries(cfg.provider)) {
    if (prov.models?.length) {
      const name = modelEntryName(prov.models[0]);
      if (name) return { provider: provName, name };
    }
  }
  return null;
}

function isConfiguredModelRoute(
  cfg: KiteCodeConfig,
  route: { provider: string; name: string },
): boolean {
  const provider = cfg.provider[route.provider];
  if (!provider) return false;
  if (provider.model === route.name) return true;
  if (provider.models?.some((model) => modelEntryName(model) === route.name)) return true;

  const hasConfiguredModels = Object.values(cfg.provider).some((candidate) =>
    Boolean(candidate.models?.length),
  );
  return (
    !hasConfiguredModels &&
    DEFAULT_DEEPSEEK_MODELS.some(
      (model) => model.provider === route.provider && model.name === route.name,
    )
  );
}

function resolveProviderApiKey(
  providerName: string,
  providerType: ModelProviderType,
  apiKey: string | undefined,
): string {
  if (apiKey) return apiKey;
  if (providerType === 'ollama') return '';
  // Try env var: PROVIDERNAME_API_KEY
  const envKey = process.env[`${providerName.toUpperCase()}_API_KEY`];
  if (envKey) return envKey;
  throw new Error(
    `Model provider '${providerName}' requires apiKey (set ${providerName.toUpperCase()}_API_KEY)`,
  );
}

function resolveProviderBaseURL(
  providerName: string,
  providerType: ModelProviderType,
  baseURL: string | undefined,
): string {
  if (baseURL) return baseURL;
  if (providerType === 'ollama') return 'http://localhost:11434';
  if (providerType === 'deepseek') return 'https://api.deepseek.com/v1';
  // Try env var: PROVIDERNAME_BASE_URL
  const envURL = process.env[`${providerName.toUpperCase()}_BASE_URL`];
  if (envURL) return envURL;
  throw new Error(`Model provider '${providerName}' requires baseURL`);
}

// ── Available models ──

/** 可用模型 / Available model */
export interface AvailableModel {
  provider: string;
  name: string;
  isDefault: boolean;
  /** 上下文窗口大小（token 数）/ Context window size in tokens */
  contextWindow?: number;
  maxOutputTokens?: number;
}

let _cachedModels: { readonly key: string; readonly models: AvailableModel[] } | null = null;

export function listAvailableModels(
  configPath?: string,
  workspace = process.cwd(),
): AvailableModel[] {
  // Cache: config rarely changes at runtime; avoid re-reading file on every render
  const cacheKey = configPath ?? `workspace:${resolve(workspace)}`;
  if (_cachedModels?.key === cacheKey) return _cachedModels.models;

  const cfg = configPath ? readConfigFile(configPath) : loadConfig(workspace);
  if (!cfg) {
    const fallback = DEFAULT_DEEPSEEK_MODELS;
    _cachedModels = { key: cacheKey, models: fallback };
    return fallback;
  }

  // Collect models from providers
  const models: AvailableModel[] = [];
  for (const [provName, prov] of Object.entries(cfg.provider)) {
    if (prov.models) {
      const defaultName = prov.model ?? null;
      for (const m of prov.models) {
        const name = modelEntryName(m);
        if (!name) continue;
        const entry = modelEntryObject(m);
        const isDefault = name === defaultName || Boolean(entry?.default);
        const contextWindow = entry?.contextWindow ?? entry?.tokens;
        const maxOutputTokens = entry?.maxOutputTokens;
        models.push({ provider: provName, name, isDefault, contextWindow, maxOutputTokens });
      }
    }
  }
  if (models.length > 0) {
    _cachedModels = { key: cacheKey, models };
    return models;
  }

  _cachedModels = { key: cacheKey, models: DEFAULT_DEEPSEEK_MODELS };
  return DEFAULT_DEEPSEEK_MODELS;
}

// ── Theme ──

export type ThemeName = 'dark' | 'light';

/** Read theme from config. Falls back to "dark". */
export function loadTheme(workspace?: string): ThemeName {
  const cfg = loadConfig(workspace);
  return cfg?.theme ?? 'dark';
}

/** Read color preset from config. Falls back to "blue". */
export function loadColorPreset(workspace?: string): string {
  const cfg = loadConfig(workspace);
  return cfg?.colorPreset ?? 'blue';
}

/** Read the personal language setting without loading project configuration. */
export function loadUserLanguage(configPath = defaultConfigPath()): LanguagePreference {
  return readConfigFile(configPath)?.language ?? 'system';
}

/** Read the terminal interaction preference without loading project/provider configuration. */
export function loadUserInteractionMode(
  configPath = defaultConfigPath(),
): InteractionModePreference {
  return readConfigFile(configPath)?.interactionMode ?? 'auto';
}

type UserConfigMutationResult = 'saved' | 'conflict' | 'unavailable';

function mutateUserConfigResult(
  path: string,
  mutate: (source: string) => string,
  options: {
    readonly guardPaths?: readonly string[];
    readonly isCurrent?: () => boolean;
  } = {},
): UserConfigMutationResult {
  let lock:
    | ReturnType<typeof acquireConfigFileMutationLock>
    | ReturnType<typeof acquireConfigFileMutationLocks>
    | undefined;
  try {
    lock = options.guardPaths
      ? acquireConfigFileMutationLocks([path, ...options.guardPaths])
      : acquireConfigFileMutationLock(path);
    if (options.isCurrent && !options.isCurrent()) return 'conflict';
    const source = existsSync(path) ? readFileSync(path, 'utf-8') : '{}';
    replaceConfigFileAtomically(path, mutate(source), 0o600);
    return 'saved';
  } catch {
    return 'unavailable';
  } finally {
    lock?.release();
  }
}

function mutateUserConfig(path: string, mutate: (source: string) => string): boolean {
  return mutateUserConfigResult(path, mutate) === 'saved';
}

/** Persist the personal terminal language setting to the user config. */
export function saveUserLanguage(
  language: LanguagePreference,
  configPath = defaultConfigPath(),
): boolean {
  return mutateUserConfig(configPath, (source) => {
    let text = source;
    const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };
    text = applyEdits(text, modify(text, ['language'], language, fmt));
    return text;
  });
}

/** Persist the personal TUI permission mode for subsequent launches. */
export function saveInteractionMode(
  interactionMode: InteractionModePreference,
  configPath = defaultConfigPath(),
): boolean {
  return mutateUserConfig(configPath, (source) => {
    let text = source;
    const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };
    text = applyEdits(text, modify(text, ['interactionMode'], interactionMode, fmt));
    return text;
  });
}

/** Persist colorPreset to the user-level config file (creates file if missing). */
export function saveColorPreset(preset: string): void {
  const path = defaultConfigPath();
  mutateUserConfig(path, (source) => {
    let text = source;
    const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };
    text = applyEdits(text, modify(text, ['colorPreset'], preset, fmt));
    return text;
  });
}

/** Persist the model route selected in the TUI to the user-level config. */
export function saveModelSelection(
  provider: string,
  name: string,
  configPath: string = defaultConfigPath(),
): boolean {
  if (!provider.trim() || !name.trim()) return false;
  return mutateUserConfig(configPath, (source) => {
    let text = source;
    const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };
    const route = `${provider.trim()}:${name.trim()}`;
    text = applyEdits(text, modify(text, ['model'], route, fmt));
    return text;
  });
}

export function saveModelSelectionWithRevisionGuard(input: {
  readonly provider: string;
  readonly name: string;
  readonly configPath?: string;
  readonly guardPaths: readonly string[];
  readonly isCurrent: () => boolean;
}): UserConfigMutationResult {
  if (!input.provider.trim() || !input.name.trim()) return 'unavailable';
  const path = input.configPath ?? defaultConfigPath();
  return mutateUserConfigResult(
    path,
    (source) => {
      const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };
      return applyEdits(
        source,
        modify(source, ['model'], `${input.provider.trim()}:${input.name.trim()}`, fmt),
      );
    },
    { guardPaths: input.guardPaths, isCurrent: input.isCurrent },
  );
}

// ── Provider config saving ──

/** Input for saving a provider configuration. */
export interface SaveProviderInput {
  /** Provider key name (e.g., 'deepseek', 'my-openai') */
  name: string;
  /** Provider type */
  type: ModelProviderType;
  /** API key (empty string for ollama) */
  apiKey?: string;
  /** Base URL (omit to use built-in default) */
  baseURL?: string;
  /** Models with their default flag */
  models?: { name: string; default: boolean }[];
  /** Reasoning effort (low | medium | high | xhigh | max) */
  effort?: string;
  /** Whether to pass reasoning_effort to the API */
  reasoning?: boolean;
  /** Extra kwargs passed through to the LangChain model constructor */
  modelKwargs?: Record<string, unknown>;
}

/**
 * Save a provider configuration to the user-level config file.
 * Creates the file and directory if they don't exist.
 * Preserves existing config sections (other providers, theme, mcpServers, etc.).
 */
/** Sensible default models per provider type (used when no models are provided). */
function defaultModelsForProvider(type: ModelProviderType): { name: string; default: boolean }[] {
  switch (type) {
    case 'deepseek':
      return [
        { name: 'deepseek-v4-flash', default: true },
        { name: 'deepseek-v4-pro', default: false },
      ];
    case 'openai':
      return [
        { name: 'gpt-4o', default: true },
        { name: 'gpt-4.1', default: false },
      ];
    case 'ollama':
      return [{ name: 'llama3.2', default: true }];
    default:
      // openai-compatible — no well-known defaults, let user type their own
      return [];
  }
}

export function saveProviderConfig(
  input: SaveProviderInput,
  configPath: string = defaultConfigPath(),
): boolean {
  const path = configPath;
  const saved = mutateUserConfig(path, (source) => {
    let text = source;
    const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };

    const provPath = ['provider', input.name];
    text = applyEdits(text, modify(text, provPath, {}, fmt));

    const setField = (jsonPath: string[], value: unknown) => {
      text = applyEdits(text, modify(text, jsonPath, value, fmt));
    };

    // type is omitted — inferProviderType handles it from the provider name
    if (input.apiKey !== undefined) setField([...provPath, 'apiKey'], input.apiKey);
    if (input.baseURL) setField([...provPath, 'baseURL'], input.baseURL);

    const models =
      input.models && input.models.length > 0
        ? input.models.map((m) => m.name)
        : defaultModelsForProvider(input.type).map((m) => m.name);
    const defaultModel = input.models?.find((m) => m.default)?.name ?? models[0];
    if (models.length > 0) setField([...provPath, 'models'], models);
    if (defaultModel) setField([...provPath, 'model'], defaultModel);
    if (input.effort && input.reasoning !== false) setField([...provPath, 'effort'], input.effort);
    if (input.reasoning !== undefined) setField([...provPath, 'reasoning'], input.reasoning);
    if (input.modelKwargs && Object.keys(input.modelKwargs).length > 0) {
      setField([...provPath, 'modelKwargs'], input.modelKwargs);
    }

    return text;
  });
  if (saved) _cachedModels = null;
  return saved;
}
