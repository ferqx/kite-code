import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyEdits, modify, parse } from 'jsonc-parser';
import { z } from 'zod';
import type { FeatureFlags } from './features';
import { mcpServerSchema } from './mcp-server-config';
import { defaultConfigPath, projectConfigPath } from './paths';

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
    })
    .strict(),
]);

const providerSchema = z.object({
  type: z.enum(['deepseek', 'openai', 'openai-compatible', 'ollama']).optional(),
  apiKey: z.string().min(1).optional(),
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
const sandboxSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
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
  })
  .strict()
  .optional();

export const configSchema = z.object({
  provider: z.record(z.string(), providerSchema).optional().default({}),
  /** @deprecated Use provider[name].models instead */
  models: z.array(legacyModelEntrySchema).optional(),
  theme: z.enum(['dark', 'light']).optional(),
  colorPreset: z.string().optional(),
  interactionMode: interactionModeSchema.optional(),
  features: featuresSchema,
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
      maxSummaryTokens: z.number().int().positive().optional(),
      maxSummaryInputTokens: z.number().int().positive().optional(),
      softRatio: z.number().positive().max(1).optional(),
      hardRatio: z.number().positive().max(1).optional(),
      warningRatio: z.number().positive().max(1).optional(),
      targetRatio: z.number().positive().max(1).optional(),
      minimumReductionRatio: z.number().nonnegative().max(1).optional(),
      cooldownTurns: z.number().int().nonnegative().optional(),
      recentTurns: z.number().int().nonnegative().optional(),
      providerSafetyRatio: z.number().positive().max(0.2).optional(),
      maxAutoCompactionsPerWindow: z.number().int().positive().optional(),
      autoCompactionWindowTurns: z.number().int().positive().optional(),
      maxConsecutiveLowGain: z.number().int().positive().optional(),
    })
    .strict()
    .superRefine((val, ctx) => {
      const warning = val.warningRatio ?? 0.8;
      const compact = val.softRatio ?? 0.88;
      const hard = val.hardRatio ?? 0.94;
      const target = val.targetRatio ?? 0.62;
      if (warning >= compact) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `warningRatio (${warning}) must be less than softRatio (${compact})`,
          path: ['warningRatio'],
        });
      }
      if (compact >= hard) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `softRatio (${compact}) must be less than hardRatio (${hard})`,
          path: ['softRatio'],
        });
      }
      if (target >= compact) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `targetRatio (${target}) must be less than softRatio (${compact})`,
          path: ['targetRatio'],
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
  };
  interactionMode?: z.infer<typeof interactionModeSchema>;
  features?: Partial<FeatureFlags>;
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

/** 加载配置选项 / Configuration loading options */
export interface LoadAgentConfigOptions {
  /** 配置文件路径 / Configuration file path */
  configPath?: string;
  /** 覆盖默认 provider 名称 / Override default provider name */
  providerName?: string;
  /** 覆盖默认模型名称 / Override default model name */
  modelName?: string;
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
  { provider: 'deepseek', name: 'deepseek-v4-flash', isDefault: true, contextWindow: 1048576 },
  { provider: 'deepseek', name: 'deepseek-v4-pro', isDefault: false, contextWindow: 1048576 },
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
    models: project.models ?? user.models,
    theme: project.theme ?? user.theme,
    colorPreset: project.colorPreset ?? user.colorPreset,
    interactionMode: project.interactionMode ?? user.interactionMode,
    features: { ...user.features, ...project.features },
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
    theme: 'dark',
    interactionMode: 'accept_edits',
    features: {},
    sandbox: { enabled: true },
    mcpServers: {},
  };
}

// ── Agent config ──

/** 加载并解析 Agent 配置 / Load and parse agent configuration */
export function loadAgentConfig(options: LoadAgentConfigOptions = {}): AgentConfig {
  const { configPath } = options;
  const cfg = loadConfig(process.cwd(), configPath);

  const defaultModel = findDefaultModel(cfg);

  const providerName = options.providerName ?? defaultModel?.provider ?? 'deepseek';
  const provider = cfg.provider?.[providerName] ?? builtInProvider(providerName);

  if (!provider) {
    throw new Error(`Model provider '${providerName}' is not configured`);
  }

  const providerType = provider.type ?? inferProviderType(providerName);

  const reasoningEffort = provider.effort ?? null;
  const reasoning = provider.reasoning ?? inferReasoningDefault(providerType);
  const modelName =
    options.modelName ?? provider.model ?? defaultModel?.name ?? 'deepseek-v4-flash';
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
          },
        }
      : {}),
    interactionMode: cfg.interactionMode,
    features: cfg.features,
    sandbox: { enabled: cfg.sandbox?.enabled ?? true },
    autoReview: cfg.autoReview,
    compaction: cfg.compaction,
  };
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
 * Priority: provider.model > legacy default:true > first model > null
 */
function findDefaultModel(cfg: KiteCodeConfig): { provider: string; name: string } | null {
  for (const [provName, prov] of Object.entries(cfg.provider)) {
    if (prov.model && prov.models?.length) return { provider: provName, name: prov.model };
    // Legacy: model entry with default:true
    if (prov.models) {
      for (const m of prov.models) {
        if (modelEntryObject(m)?.default) {
          const name = modelEntryName(m);
          if (name) return { provider: provName, name };
        }
      }
    }
  }
  // Fallback: first model of first provider with models
  for (const [provName, prov] of Object.entries(cfg.provider)) {
    if (prov.models?.length) {
      const name = modelEntryName(prov.models[0]);
      if (name) return { provider: provName, name };
    }
  }
  return null;
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
function defaultModelsForProvider(
  type: ModelProviderType,
): { name: string; default: boolean; contextWindow?: number }[] {
  switch (type) {
    case 'deepseek':
      return [
        { name: 'deepseek-v4-flash', default: true, contextWindow: 1048576 },
        { name: 'deepseek-v4-pro', default: false, contextWindow: 1048576 },
      ];
    case 'openai':
      return [
        { name: 'gpt-4o', default: true, contextWindow: 128000 },
        { name: 'gpt-4.1', default: false, contextWindow: 1000000 },
      ];
    case 'ollama':
      return [{ name: 'llama3.2', default: true, contextWindow: 131072 }];
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
