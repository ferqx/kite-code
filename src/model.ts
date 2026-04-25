import { ChatDeepSeek } from "@langchain/deepseek";
import type { AgentConfig } from "./config";

/** 创建 DeepSeek 聊天模型实例 / Create DeepSeek chat model instance */
export function createDeepSeekModel(config: AgentConfig): ChatDeepSeek {
  return new ChatDeepSeek({
    apiKey: config.apiKey,
    configuration: {
      baseURL: config.baseURL,
    },
    model: config.modelName,
    temperature: 0,
  });
}
