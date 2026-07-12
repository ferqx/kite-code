// src/core/model/factory.ts
// Create AI SDK LanguageModel from AgentConfig.
// Replaces the old LangChain ChatOpenAI/ChatDeepSeek/ChatOllama subclasses.

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { type LanguageModel, wrapLanguageModel } from 'ai';
import type { AgentConfig } from '@/core/config/index';
import {
  createDeepSeekMiddleware,
  type ModelRetryListener,
  transientRetryMiddleware,
} from './deepseek';

/** 支持工具绑定的聊天模型 / Tool-bindable chat model (new shape: LanguageModel + setRetryListener) */
export type SupportedChatModel = {
  model: LanguageModel;
  setRetryListener: (listener: ModelRetryListener | null) => void;
};

/** 根据配置创建 AI SDK 聊天模型 / Create an AI SDK chat model from config */
export function createChatModel(config: AgentConfig): SupportedChatModel {
  const provider = createOpenAICompatible({
    name: config.providerType,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    headers:
      config.providerType === 'deepseek' || config.providerType === 'ollama'
        ? undefined
        : undefined,
  });

  let retryListener: ModelRetryListener | null = null;

  const middlewares = [
    transientRetryMiddleware({
      get onRetry() {
        return retryListener ?? undefined;
      },
    }),
  ];

  // DeepSeek reasoning_content passback — only needed for DeepSeek providers
  if (config.providerType === 'deepseek') {
    middlewares.push(createDeepSeekMiddleware());
  }

  const model = wrapLanguageModel({
    model: provider(config.modelName),
    middleware: middlewares,
  });

  return {
    model,
    setRetryListener: (fn) => {
      retryListener = fn;
    },
  };
}
