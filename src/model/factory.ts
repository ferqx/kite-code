import { ChatOpenAI } from "@langchain/openai";
import { ChatOllama } from "@langchain/ollama";
import type { AgentConfig } from "../config/index";
import { createDeepSeekModel } from "./deepseek";

const MODEL_REQUEST_TIMEOUT_MS = 30_000;
const OLLAMA_RETRY_MAX = 2;
const OLLAMA_RETRY_BASE_DELAY_MS = 2_000;

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
  return new ChatOpenAI({
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
  });
}

/** 创建 Ollama 聊天模型，带 5xx 重试 / Create Ollama chat model with 5xx retry */
export function createOllamaModel(config: AgentConfig): ChatOllama {
  return new ChatOllama({
    baseUrl: config.baseURL,
    model: config.modelName,
    temperature: 0,
    fetch: createRetryingFetch(OLLAMA_RETRY_MAX, OLLAMA_RETRY_BASE_DELAY_MS) as any,
  });
}

/** 创建带 5xx 重试的 fetch 函数 / Create fetch with 5xx retry */
function createRetryingFetch(
  maxRetries: number,
  baseDelayMs: number,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await globalThis.fetch(input, init);
        if (response.ok || response.status < 500 || attempt >= maxRetries) {
          return response;
        }
        await sleep(baseDelayMs * (attempt + 1));
      } catch (error) {
        lastError = error;
        if (attempt >= maxRetries) throw error;
        await sleep(baseDelayMs * (attempt + 1));
      }
    }
    throw lastError;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
