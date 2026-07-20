import type { AgentConfig } from '@/core/config';

export interface ResolvedModelCapabilities {
  providerName: string;
  modelName: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  tokenizerFamily?: string;
  supportsUsageMetadata: boolean;
  supportsPromptCache: boolean;
}

export interface ModelCapabilityMetadata {
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  tokenizerFamily?: string;
  supportsUsageMetadata?: boolean;
  supportsPromptCache?: boolean;
}

const BUILTIN_MODEL_CAPABILITIES: Record<string, ModelCapabilityMetadata> = {
  'deepseek/deepseek-v4-flash': {
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 32_768,
    tokenizerFamily: 'cl100k_base',
    supportsUsageMetadata: true,
    supportsPromptCache: true,
  },
  'deepseek/deepseek-v4-pro': {
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 32_768,
    tokenizerFamily: 'cl100k_base',
    supportsUsageMetadata: true,
    supportsPromptCache: true,
  },
  'openai/gpt-4o': {
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    tokenizerFamily: 'o200k_base',
    supportsUsageMetadata: true,
    supportsPromptCache: true,
  },
  'openai/gpt-4.1': {
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 32_768,
    tokenizerFamily: 'o200k_base',
    supportsUsageMetadata: true,
    supportsPromptCache: true,
  },
  'ollama/llama3.2': {
    contextWindowTokens: 131_072,
    maxOutputTokens: 8_192,
    tokenizerFamily: 'unknown',
    supportsUsageMetadata: true,
    supportsPromptCache: false,
  },
};

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** Resolve one authoritative capability view for disclosure and context governance. */
export function resolveModelCapabilities(input: {
  config: AgentConfig;
  adapter?: ModelCapabilityMetadata;
}): ResolvedModelCapabilities {
  const { config } = input;
  const explicit = config.modelCapabilities ?? {};
  const builtin = BUILTIN_MODEL_CAPABILITIES[`${config.providerName}/${config.modelName}`] ?? {};
  const adapter = input.adapter ?? {};
  const compatibility = config.modelKwargs ?? {};

  const contextWindowTokens =
    positiveNumber(explicit.contextWindowTokens) ??
    positiveNumber(builtin.contextWindowTokens) ??
    positiveNumber(adapter.contextWindowTokens) ??
    positiveNumber(compatibility.contextWindowTokens);
  const maxOutputTokens =
    positiveNumber(explicit.maxOutputTokens) ??
    positiveNumber(builtin.maxOutputTokens) ??
    positiveNumber(adapter.maxOutputTokens) ??
    positiveNumber(compatibility.maxOutputTokens) ??
    positiveNumber(compatibility.maxTokens);
  const tokenizerFamily =
    explicit.tokenizerFamily ??
    builtin.tokenizerFamily ??
    adapter.tokenizerFamily ??
    (typeof compatibility.tokenizerFamily === 'string' ? compatibility.tokenizerFamily : undefined);
  const supportsUsageMetadata =
    booleanValue(explicit.supportsUsageMetadata) ??
    booleanValue(builtin.supportsUsageMetadata) ??
    booleanValue(adapter.supportsUsageMetadata) ??
    booleanValue(compatibility.supportsUsageMetadata) ??
    false;
  const supportsPromptCache =
    booleanValue(explicit.supportsPromptCache) ??
    booleanValue(builtin.supportsPromptCache) ??
    booleanValue(adapter.supportsPromptCache) ??
    booleanValue(compatibility.supportsPromptCache) ??
    false;

  return {
    providerName: config.providerName,
    modelName: config.modelName,
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(tokenizerFamily ? { tokenizerFamily } : {}),
    supportsUsageMetadata,
    supportsPromptCache,
  };
}

export function usableInputBudget(
  capabilities: ResolvedModelCapabilities,
  requestMaxOutputTokens?: number,
  /** PR 7: Provider safety ratio from config (default 0.02 = 2%). */
  providerSafetyRatio?: number,
): {
  usableInputTokens?: number;
  reservedOutputTokens: number;
  providerSafetyMarginTokens: number;
} {
  const reservedOutputTokens =
    positiveNumber(requestMaxOutputTokens) ?? capabilities.maxOutputTokens ?? 4_096;
  if (!capabilities.contextWindowTokens) {
    return {
      reservedOutputTokens,
      providerSafetyMarginTokens: 0,
    };
  }
  const safetyRatio = providerSafetyRatio ?? 0.02;
  const providerSafetyMarginTokens = Math.max(
    1_024,
    Math.floor(capabilities.contextWindowTokens * safetyRatio),
  );
  return {
    usableInputTokens: Math.max(
      0,
      capabilities.contextWindowTokens - reservedOutputTokens - providerSafetyMarginTokens,
    ),
    reservedOutputTokens,
    providerSafetyMarginTokens,
  };
}
