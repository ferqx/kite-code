import { ChatOpenAI } from "@langchain/openai";
import { ChatOllama } from "@langchain/ollama";
import { BaseMessage } from "@langchain/core/messages";
import { ChatResult } from "@langchain/core/outputs";
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { AgentConfig } from "@/core/config/index";
import { createDeepSeekModel, withTransientModelRetry, type ModelRetryListener } from "./deepseek";

const MODEL_REQUEST_TIMEOUT_MS = 30_000;

/**
 * ChatOpenAI with transient error retry.
 *
 * Overriding `_generate` rather than `completionWithRetry` because the latter
 * is not part of the public ChatOpenAI type signature. The `_generate` path
 * covers all current model invocations (the agent only uses `.invoke()`), but
 * note that switching to `.stream()` would bypass this retry wrapper.
 */
class RetryingChatOpenAI extends ChatOpenAI {
  _retryListener: ModelRetryListener | null = null;

  override async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    return withTransientModelRetry(
      () => super._generate(messages, options, runManager),
      { onRetry: this._retryListener ?? undefined },
    );
  }
}

/**
 * ChatOllama with transient error retry.
 *
 * Using `_generate` override (same strategy as RetryingChatOpenAI)
 * instead of a custom fetch wrapper so that all three providers use
 * the same retry policy (`withTransientModelRetry`).
 */
class RetryingChatOllama extends ChatOllama {
  _retryListener: ModelRetryListener | null = null;

  override async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    return withTransientModelRetry(
      () => super._generate(messages, options, runManager),
      { onRetry: this._retryListener ?? undefined },
    );
  }
}

/** 支持工具绑定的聊天模型 / Tool-bindable chat model */
export type SupportedChatModel =
  | ReturnType<typeof createDeepSeekModel>
  | ChatOpenAI
  | ChatOllama;

/** 根据配置创建 LangChain 聊天模型 / Create a LangChain chat model from config */
export function createChatModel(config: AgentConfig): SupportedChatModel {
  switch (config.providerType) {
    case "deepseek":
      return createDeepSeekModel(config);
    case "openai":
    case "openai-compatible":
      return createOpenAICompatibleModel(config);
    case "ollama":
      return createOllamaModel(config);
  }
}

/** 创建 OpenAI 或 OpenAI-compatible 聊天模型 / Create an OpenAI-compatible chat model */
export function createOpenAICompatibleModel(config: AgentConfig): ChatOpenAI {
  return new RetryingChatOpenAI({
    apiKey: config.apiKey,
    maxRetries: 0,
    configuration: {
      baseURL: config.baseURL,
      maxRetries: 0,
      timeout: MODEL_REQUEST_TIMEOUT_MS,
    },
    model: config.modelName,
    temperature: 0,
    timeout: MODEL_REQUEST_TIMEOUT_MS,
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
  });
}

/** 创建 Ollama 聊天模型 / Create an Ollama chat model */
export function createOllamaModel(config: AgentConfig): ChatOllama {
  return new RetryingChatOllama({
    baseUrl: config.baseURL,
    model: config.modelName,
    temperature: 0,
  });
}
