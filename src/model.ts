import { ChatDeepSeek } from "@langchain/deepseek";
import type { AgentConfig } from "./config";

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
