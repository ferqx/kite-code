import type { AgentConfig } from '@/core/config';

export type ModelCapabilitySource = 'explicit_config' | 'adapter_runtime' | 'compatibility_config';

export interface ResolvedModelCapabilities {
  providerName: string;
  modelName: string;
  contextWindowTokens?: number;
  contextWindowSource?: ModelCapabilitySource;
  maxOutputTokens?: number;
  maxOutputTokensSource?: ModelCapabilitySource;
  tokenizerFamily?: string;
  tokenizerSource?: ModelCapabilitySource;
  supportsUsageMetadata?: boolean;
  supportsUsageMetadataSource?: ModelCapabilitySource;
  supportsPromptCache?: boolean;
  supportsPromptCacheSource?: ModelCapabilitySource;
  supportsToolCalls?: boolean;
  supportsToolCallsSource?: ModelCapabilitySource;
  streaming: boolean;
  streamingSource?: ModelCapabilitySource;
}

export interface ModelCapabilityMetadata {
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  tokenizerFamily?: string;
  supportsUsageMetadata?: boolean;
  supportsPromptCache?: boolean;
  supportsToolCalls?: boolean;
  streaming?: boolean;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function firstDefined<T>(
  entries: Array<[T | undefined, ModelCapabilitySource]>,
): { value: T; source: ModelCapabilitySource } | undefined {
  const match = entries.find(([value]) => value !== undefined);
  return match ? { value: match[0] as T, source: match[1] } : undefined;
}

/** Resolve fields independently; model names never participate in capability resolution. */
export function resolveModelCapabilities(input: {
  config: AgentConfig;
  adapter?: ModelCapabilityMetadata;
}): ResolvedModelCapabilities {
  const explicit = input.config.modelCapabilities ?? {};
  const adapter = input.adapter ?? {};
  const compatibility = input.config.modelKwargs ?? {};

  const contextWindow = firstDefined<number>([
    [positiveNumber(explicit.contextWindowTokens), 'explicit_config'],
    [positiveNumber(adapter.contextWindowTokens), 'adapter_runtime'],
    [positiveNumber(compatibility.contextWindowTokens), 'compatibility_config'],
  ]);
  const maxOutput = firstDefined<number>([
    [positiveNumber(explicit.maxOutputTokens), 'explicit_config'],
    [positiveNumber(adapter.maxOutputTokens), 'adapter_runtime'],
    [
      positiveNumber(compatibility.maxOutputTokens) ?? positiveNumber(compatibility.maxTokens),
      'compatibility_config',
    ],
  ]);
  const tokenizer = firstDefined<string>([
    [
      typeof explicit.tokenizerFamily === 'string' ? explicit.tokenizerFamily : undefined,
      'explicit_config',
    ],
    [
      typeof adapter.tokenizerFamily === 'string' ? adapter.tokenizerFamily : undefined,
      'adapter_runtime',
    ],
    [
      typeof compatibility.tokenizerFamily === 'string' ? compatibility.tokenizerFamily : undefined,
      'compatibility_config',
    ],
  ]);
  const usage = firstDefined<boolean>([
    [booleanValue(explicit.supportsUsageMetadata), 'explicit_config'],
    [booleanValue(adapter.supportsUsageMetadata), 'adapter_runtime'],
    [booleanValue(compatibility.supportsUsageMetadata), 'compatibility_config'],
  ]);
  const cache = firstDefined<boolean>([
    [booleanValue(explicit.supportsPromptCache), 'explicit_config'],
    [booleanValue(adapter.supportsPromptCache), 'adapter_runtime'],
    [booleanValue(compatibility.supportsPromptCache), 'compatibility_config'],
  ]);
  const toolCalls = firstDefined<boolean>([
    [booleanValue(adapter.supportsToolCalls), 'adapter_runtime'],
    [booleanValue(compatibility.supportsToolCalls), 'compatibility_config'],
  ]);
  const streaming = firstDefined<boolean>([
    [booleanValue(explicit.streaming), 'explicit_config'],
    [booleanValue(adapter.streaming), 'adapter_runtime'],
    [booleanValue(compatibility.streaming), 'compatibility_config'],
  ]);

  return {
    providerName: input.config.providerName,
    modelName: input.config.modelName,
    ...(contextWindow
      ? {
          contextWindowTokens: contextWindow.value,
          contextWindowSource: contextWindow.source,
        }
      : {}),
    ...(maxOutput
      ? { maxOutputTokens: maxOutput.value, maxOutputTokensSource: maxOutput.source }
      : {}),
    ...(tokenizer ? { tokenizerFamily: tokenizer.value, tokenizerSource: tokenizer.source } : {}),
    ...(usage
      ? {
          supportsUsageMetadata: usage.value,
          supportsUsageMetadataSource: usage.source,
        }
      : {}),
    ...(cache ? { supportsPromptCache: cache.value, supportsPromptCacheSource: cache.source } : {}),
    ...(toolCalls
      ? {
          supportsToolCalls: toolCalls.value,
          supportsToolCallsSource: toolCalls.source,
        }
      : {}),
    streaming: streaming?.value ?? true,
    ...(streaming ? { streamingSource: streaming.source } : {}),
  };
}

export function usableInputBudget(
  capabilities: ResolvedModelCapabilities,
  requestMaxOutputTokens?: number,
  providerSafetyRatio?: number,
): {
  usableInputTokens?: number;
  reservedOutputTokens?: number;
  providerSafetyMarginTokens: number;
} {
  const reservedOutputTokens =
    positiveNumber(requestMaxOutputTokens) ?? capabilities.maxOutputTokens;
  if (!capabilities.contextWindowTokens || !reservedOutputTokens) {
    return {
      ...(reservedOutputTokens ? { reservedOutputTokens } : {}),
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
