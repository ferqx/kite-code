import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { z } from 'zod';
import type {
  ExecutionBoundaryAdmissionV1,
  ExecutionBoundaryV1,
  ExecutionCapabilitySurfaceV1,
  ProductionExecutionEntrypointV1,
} from '@/core/sandbox/types';
import { admitProductionExecutionBoundaryV1 } from './execution-boundary';
import { type FeatureFlags, getFeatureFlags } from './features';
import { mcpServerSchema } from './mcp-server-config';
import { defaultConfigPath, projectConfigPath } from './paths';
import {
  resolveSessionLoggingPolicyV1,
  type SessionLoggingPolicyV1,
} from './session-logging-policy';

export type {
  ExecutionBoundaryAdmissionInputV1,
  ExecutionBoundaryQualificationEvaluationInputV1,
  TightenExecutionBoundaryInputV1,
} from './execution-boundary';
export {
  admitProductionExecutionBoundaryV1,
  computeExecutionBoundaryDigestV1,
  executionBackendCapabilitiesV1Schema,
  executionBoundaryV1Schema,
  parseExecutionBoundaryV1,
  tightenExecutionBoundaryV1,
} from './execution-boundary';
export {
  APPROVED_PRODUCTION_EXECUTION_QUALIFICATION_DIGEST_V1,
  APPROVED_PRODUCTION_EXECUTION_QUALIFICATION_REVISION_V1,
  computeInProcessReadOnlyToolCatalogDigestV1,
  computeProductionExecutionQualificationRegistryDigestV1,
  inProcessReadOnlyToolCatalogV1Schema,
  loadApprovedProductionExecutionQualificationRegistryV1,
  parseProductionExecutionQualificationRegistryV1,
  parseProductionExecutionQualificationV1,
  productionExecutionQualificationRegistryV1Schema,
  qualificationMatchesExecutionEnvironmentV1,
} from './execution-qualification';

export {
  DEFAULT_FEATURE_FLAGS,
  getFeatureFlags,
  isFeatureFlagName,
  parseFeatureOverride,
} from './features';
export type {
  McpConfig,
  McpConfigApprovalStatus,
  McpConfigCatalog,
  McpConfigDiagnostic,
  McpConfigSource,
  McpConfigSourceKind,
  McpProjectServerApprovalView,
  McpServerConfigEntry,
  McpWritableScope,
} from './mcp-config';
export { loadMcpConfig, loadMcpConfigCatalog } from './mcp-config';
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
  ProviderDataAdmissionDecisionV1,
  ProviderDataAdmissionGateV1,
  ProviderDataAdmissionInputV1,
  ProviderDataAdmissionReasonV1,
  ProviderDataPolicyRegistryV1,
  ProviderDispatchPurposeV1,
  ProviderPayloadKindV1,
  ProviderPayloadPartV1,
} from './provider-data-admission';
export {
  APPROVED_PROVIDER_DATA_POLICY_DIGEST_V1,
  APPROVED_PROVIDER_DATA_POLICY_REVISION_V1,
  createApprovedProviderDataAdmissionV1,
  createProviderDataPolicyRegistryV1,
  evaluateProviderDataAdmissionV1,
  loadApprovedProviderDataPolicyRegistryV1,
  loadProviderDataPolicyRegistryV1,
  ProviderDataAdmissionError,
  providerPayloadFromModelPromptV1,
  providerRouteIdentityFromAgentConfigV1,
} from './provider-data-admission';
export type {
  ProviderDataPolicyBundleV1,
  ProviderDataPolicyV1,
  ProviderRouteIdentityV1,
  WorkspaceDataLabelV1,
} from './provider-data-policy';
export {
  computeProviderDataPolicyBundleDigest,
  computeProviderEndpointIdentityDigest,
  normalizeProviderRouteIdentityV1,
  parseProviderDataPolicyBundleV1,
  parseProviderDataPolicyV1,
  providerDataPolicyBundleV1Schema,
  providerDataPolicyV1Schema,
  providerRouteIdentityV1Schema,
  raiseWorkspaceDataLabelV1,
  workspaceDataLabelV1Schema,
} from './provider-data-policy';
export type {
  ProviderRouteCandidateBundleV1,
  ProviderRouteCandidateV1,
} from './provider-route-candidate';
export {
  loadProviderRouteCandidateBundleV1,
  providerRouteCandidateBundleV1Schema,
  providerRouteCandidateV1Schema,
} from './provider-route-candidate';
export type {
  CapabilityMaturity,
  CapabilityProfileAdmissionDecisionV1,
  CapabilityProfileAdmissionReasonV1,
  CapabilityProfileDependencyStateV1,
  CapabilityProfileV1,
  CapabilityReleaseState,
  ReleaseCapability,
  RolloutStage,
} from './release-capabilities';
export {
  CAPABILITY_MATURITIES,
  CAPABILITY_MATURITY_RANK,
  CAPABILITY_PROFILE_GATES_V1,
  CAPABILITY_PROFILE_VERSION_V1,
  capabilityMaturitySchema,
  capabilityProfileV1Schema,
  capabilityReleaseStateSchema,
  evaluateCapabilityProfileAdmissionV1,
  isCapabilityReleaseStateValid,
  parseCapabilityProfileV1,
  parseCapabilityReleaseState,
  RELEASE_CAPABILITIES,
  ROLLOUT_STAGE_RANK,
  ROLLOUT_STAGES,
  releaseCapabilitySchema,
  rolloutStageSchema,
} from './release-capabilities';
export type {
  EmbeddedReleaseProfileIdV1,
  ProductionDistributionTargetIdentityV1,
  ProductionDistributionTargetV1,
  ReleaseChannelV1,
  ReleaseProfileApprovalRequirementV1,
  ReleaseProfileV1,
  ReleaseProfileVerificationRequirementV1,
} from './release-profile';
export {
  admitEmbeddedReleaseProfileV1,
  admitProductionDistributionTargetIdentityV1,
  EMBEDDED_RELEASE_PROFILES_V1,
  PRODUCTION_DISTRIBUTION_TARGET_IDENTITIES_V1,
  PRODUCTION_DISTRIBUTION_TARGETS_V1,
  ProductionReleaseProfileAdmissionError,
  parseProductionDistributionTargetIdentityV1,
  parseReleaseProfileV1,
  RELEASE_PROFILE_VERSION,
  releaseCapabilityStatesSchema,
  releaseProfileV1Schema,
  SUPPORTED_PRODUCTION_EXECUTION_TARGETS_V1,
} from './release-profile';
export type {
  ReleaseProfileRestrictionLayerV1,
  ReleaseProfileRestrictionSourceV1,
  ReleaseProfileRestrictionV1,
} from './release-profile-composer';
export {
  composeReleaseProfileV1,
  ReleaseProfileEscalationError,
  releaseProfileRestrictionLayerV1Schema,
  releaseProfileRestrictionV1Schema,
} from './release-profile-composer';
export type {
  SessionLoggingMode,
  SessionLoggingPolicyTightening,
  SessionLoggingPolicyV1,
} from './session-logging-policy';
export {
  DEFAULT_SESSION_LOGGING_POLICY_V1,
  parseSessionLoggingPolicyV1,
  resolveSessionLoggingPolicyV1,
  sessionLoggingPolicyV1Schema,
  tightenSessionLoggingPolicyV1,
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

// Deprecated: kept for backward compatibility with old top-level models array
const legacyModelEntrySchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
  default: z.boolean().optional(),
});

const interactionModeSchema = z.enum(['accept_edits', 'auto', 'full']);
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
    planLifecycleV2: z.boolean().optional(),
    interactionControllerV2: z.boolean().optional(),
    autoReviewV2: z.boolean().optional(),
    nativeLoopEngine: z.boolean().optional(),
    loopMode: z.boolean().optional(),
    capabilityCatalogV1: z.boolean().optional(),
    mcpRuntimeBindingV1: z.boolean().optional(),
    mcpExecutionRecordV1: z.boolean().optional(),
    mcpProviderActionV1: z.boolean().optional(),
    skillActivationV2: z.boolean().optional(),
    skillWorkflowV1: z.boolean().optional(),
    verificationV1: z.boolean().optional(),
    toolSearchV1: z.boolean().optional(),
    contextCompactionV2: z.boolean().optional(),
    contextCompactionAutoV1: z.boolean().optional(),
    contextCompactionManualV1: z.boolean().optional(),
    sessionLoggingPolicyV1: z.boolean().optional(),
    providerDataPolicyV1: z.boolean().optional(),
    remoteMcpEgressPolicyV1: z.boolean().optional(),
    resourceBudgetV1: z.boolean().optional(),
    terminalOutcomeV1: z.boolean().optional(),
    boundedCancellationV1: z.boolean().optional(),
    executionBoundaryV1: z.boolean().optional(),
    networkBoundaryV1: z.boolean().optional(),
    releaseProfileV1: z.boolean().optional(),
    observabilityMetricsV1: z.boolean().optional(),
  })
  .strict()
  .optional();

export const configSchema = z.object({
  provider: z.record(z.string(), providerSchema).optional().default({}),
  /** Last model route explicitly selected by the user. */
  model: modelSelectionSchema,
  /** @deprecated Use provider[name].models instead */
  models: z.array(legacyModelEntrySchema).optional(),
  theme: z.enum(['dark', 'light']).optional(),
  colorPreset: z.string().optional(),
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
  executionBoundary?: ExecutionBoundaryV1;
  /** Exact capability surface admitted by the sealed production gate. */
  executionCapabilitySurface?: ExecutionCapabilitySurfaceV1;
  /** Resolved artifact + user + project session logging policy. */
  sessionLoggingPolicy?: SessionLoggingPolicyV1;
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

declare const productionAgentConfigBrandV1: unique symbol;

/** Config returned only after release-approved execution admission. */
export interface ProductionAgentConfigV1 extends AgentConfig {
  readonly [productionAgentConfigBrandV1]: true;
  executionBoundary: ExecutionBoundaryV1;
  executionCapabilitySurface: ExecutionCapabilitySurfaceV1;
  sandbox: { readonly enabled: true };
  productionExecution: NonNullable<ExecutionBoundaryAdmissionV1['qualificationProof']>;
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
  artifactSessionLoggingPolicy?: SessionLoggingPolicyV1;
}

export interface LoadProductionAgentConfigOptions extends LoadAgentConfigOptions {
  /** Release-profile ceiling. Config rollout can only disable it. */
  artifactExecutionBoundaryV1Enabled: boolean;
  /** Release-controlled boundary. Project/user config cannot define it. */
  artifactExecutionBoundary: unknown;
  /** Canonical workspace selected by the composition root. */
  workspaceRoot: string;
  /** Production composition root being admitted. */
  entrypoint: ProductionExecutionEntrypointV1;
  /** CLI/App rollout overrides; still bounded by the release ceiling. */
  featureOverrides?: Partial<FeatureFlags>;
  /** CLI/App sandbox restriction; false cannot be overridden by config. */
  sandboxEnabled?: boolean;
}

export function composeExecutionBoundaryRolloutV1(
  layers: readonly (boolean | undefined)[],
): boolean {
  const explicit = layers.filter((value): value is boolean => value !== undefined);
  return explicit.length > 0 && explicit.every((value) => value);
}

function composeSandboxEnabledV1(layers: readonly (boolean | undefined)[]): boolean {
  return layers.every((value) => value !== false);
}

export {
  defaultCheckpointPath,
  defaultConfigPath,
  editorInputPath,
  localMcpConfigPath,
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
    models: project.models ?? user.models,
    theme: project.theme ?? user.theme,
    colorPreset: project.colorPreset ?? user.colorPreset,
    interactionMode: project.interactionMode ?? user.interactionMode,
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
    interactionMode: 'accept_edits',
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
  const sessionLoggingPolicy = resolveSessionLoggingPolicyV1({
    enabled: getFeatureFlags(cfg).sessionLoggingPolicyV1,
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
    interactionMode: cfg.interactionMode,
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
  readonly decision: ExecutionBoundaryAdmissionV1;

  constructor(decision: ExecutionBoundaryAdmissionV1) {
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
): ProductionAgentConfigV1 {
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
  const executionBoundaryRolloutEnabled = composeExecutionBoundaryRolloutV1([
    ...configLayers.map((layer) => layer?.features?.executionBoundaryV1),
    featureOverrides?.executionBoundaryV1,
  ]);
  const networkBoundaryRolloutEnabled = composeExecutionBoundaryRolloutV1([
    ...configLayers.map((layer) => layer?.features?.networkBoundaryV1),
    featureOverrides?.networkBoundaryV1,
  ]);
  const effectiveSandboxEnabled = composeSandboxEnabledV1([
    ...configLayers.map((layer) => layer?.sandbox?.enabled),
    sandboxEnabled,
  ]);
  const config = loadAgentConfig({ ...agentOptions, workspace: canonicalWorkspaceRoot });
  const resolvedFeatures = { ...config.features, ...featureOverrides };
  const featureEnabled = artifactExecutionBoundaryV1Enabled && executionBoundaryRolloutEnabled;
  const decision = admitProductionExecutionBoundaryV1({
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
      executionBoundaryV1: true,
      networkBoundaryV1: networkBoundaryRolloutEnabled,
    },
    executionBoundary: decision.boundary,
    executionCapabilitySurface: networkBoundaryRolloutEnabled
      ? decision.surface
      : { ...decision.surface, network: false },
    sandbox: { enabled: true },
    productionExecution: decision.qualificationProof,
  } as ProductionAgentConfigV1;
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
  if (cfg.models?.some((model) => model.provider === route.provider && model.name === route.name)) {
    return true;
  }

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

let _cachedModels: AvailableModel[] | null = null;

export function listAvailableModels(configPath?: string): AvailableModel[] {
  // Cache: config rarely changes at runtime; avoid re-reading file on every render
  if (!configPath && _cachedModels) return _cachedModels;

  const cfg = configPath ? readConfigFile(configPath) : loadConfig();
  if (!cfg) {
    const fallback = DEFAULT_DEEPSEEK_MODELS;
    if (!configPath) _cachedModels = fallback;
    return fallback;
  }

  // Backward compat: old top-level models array
  if (cfg.models && cfg.models.length > 0) {
    const result = cfg.models.map((m) => ({
      provider: m.provider,
      name: m.name,
      isDefault: m.default ?? false,
    }));
    if (!configPath) _cachedModels = result;
    return result;
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
    if (!configPath) _cachedModels = models;
    return models;
  }

  if (!configPath) _cachedModels = DEFAULT_DEEPSEEK_MODELS;
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

/** Persist colorPreset to the user-level config file (creates file if missing). */
export function saveColorPreset(preset: string): void {
  const path = defaultConfigPath();
  try {
    const dir = resolve(path, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    let text = existsSync(path) ? readFileSync(path, 'utf-8') : '{}';
    const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };
    text = applyEdits(text, modify(text, ['colorPreset'], preset, fmt));
    writeFileSync(path, text, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // Non-critical — silently ignore write failures
  }
}

/** Persist the model route selected in the TUI to the user-level config. */
export function saveModelSelection(
  provider: string,
  name: string,
  configPath: string = defaultConfigPath(),
): boolean {
  if (!provider.trim() || !name.trim()) return false;
  try {
    const dir = resolve(configPath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    let text = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : '{}';
    const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };
    const route = `${provider.trim()}:${name.trim()}`;
    text = applyEdits(text, modify(text, ['model'], route, fmt));
    writeFileSync(configPath, text, { encoding: 'utf-8', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
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

export function saveProviderConfig(input: SaveProviderInput): boolean {
  const path = defaultConfigPath();
  try {
    const dir = resolve(path, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let text = existsSync(path) ? readFileSync(path, 'utf-8') : '{}';
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

    writeFileSync(path, text, { encoding: 'utf-8', mode: 0o600 });
    _cachedModels = null;
    return true;
  } catch {
    return false;
  }
}
