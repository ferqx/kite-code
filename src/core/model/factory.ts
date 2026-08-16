// src/core/model/factory.ts
// Create AI SDK LanguageModel from AgentConfig.
// Replaces the old LangChain ChatOpenAI/ChatDeepSeek/ChatOllama subclasses.

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { type LanguageModel, wrapLanguageModel } from 'ai';
import type { AgentConfig } from '@/core/config/index';
import { createDeepSeekMiddleware } from './deepseek';
import type { ModelCapabilityMetadata } from './model-capabilities';

/** Provider binding consumed only by the governed Model transport. */
export type SupportedChatModel = {
  model: LanguageModel;
  /** Explicit false makes progressive capability disclosure fail closed. */
  supportsToolCalls?: boolean;
  capabilityMetadata?: ModelCapabilityMetadata;
  /** Provider-owned request options for deterministic internal summaries. */
  compactionProviderOptions?: ModelProviderOptions;
};

type ModelProviderOptionValue =
  | null
  | string
  | number
  | boolean
  | { [key: string]: ModelProviderOptionValue | undefined }
  | ModelProviderOptionValue[];

export type ModelProviderOptions = Record<
  string,
  { [key: string]: ModelProviderOptionValue | undefined }
>;

export interface ChatModelFactoryOptions {
  /** Optional transport hook for metadata-only request evidence in explicit live evaluations. */
  fetch?: typeof globalThis.fetch;
}

/** 根据配置创建 AI SDK 聊天模型 / Create an AI SDK chat model from config */
export function createChatModel(
  config: AgentConfig,
  options: ChatModelFactoryOptions = {},
): SupportedChatModel {
  const provider = createOpenAICompatible({
    name: config.providerType,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    fetch: options.fetch,
    headers:
      config.providerType === 'deepseek' || config.providerType === 'ollama'
        ? undefined
        : undefined,
  });

  const middlewares = [];

  // DeepSeek reasoning_content passback — only needed for DeepSeek providers
  if (config.providerType === 'deepseek') {
    middlewares.push(createDeepSeekMiddleware());
  }

  const boundModel = provider(config.modelName);
  const model =
    middlewares.length > 0
      ? wrapLanguageModel({ model: boundModel, middleware: middlewares })
      : boundModel;

  return {
    model,
    supportsToolCalls: config.modelKwargs?.supportsToolCalls !== false,
    ...(config.providerType === 'deepseek' && config.modelName.startsWith('deepseek-v4-')
      ? { compactionProviderOptions: { deepseek: { thinking: { type: 'disabled' } } } }
      : {}),
  };
}
