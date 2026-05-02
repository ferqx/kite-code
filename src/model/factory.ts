import { ChatOpenAI } from "@langchain/openai";
import { ChatOllama } from "@langchain/ollama";
import type { AgentConfig } from "../config/index";
import { createDeepSeekModel } from "./deepseek";

const MODEL_REQUEST_TIMEOUT_MS = 30_000;

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

/** 创建 Ollama 聊天模型 / Create an Ollama chat model */
export function createOllamaModel(config: AgentConfig): ChatOllama {
  return new ChatOllama({
    baseUrl: config.baseURL,
    maxRetries: 0,
    model: config.modelName,
    temperature: 0,
  });
}
