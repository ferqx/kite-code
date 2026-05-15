import { BaseChatModel, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseLanguageModelCallOptions } from "@langchain/core/language_models/base";
import { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { ChatResult } from "@langchain/core/outputs";

export interface MockResponse {
  /** 模型返回的消息 / Model response message */
  message: BaseMessage;
  /** 模拟延迟(ms) / Simulated delay in ms */
  delay?: number;
  /** 模拟错误 / Throw an error instead of responding */
  error?: string;
}

interface MockModelParams extends BaseChatModelParams {
  responses: MockResponse[];
}

/**
 * 可配置延迟/错误的 Mock Chat Model / Configurable mock with delay and error injection.
 * 用于测试 agent loop 在异常条件下的行为 / Tests agent loop behavior under abnormal conditions.
 */
export class StreamingMockModel extends BaseChatModel {
  lc_namespace = ["test", "mock"];
  private responses: MockResponse[];
  private callCount = 0;

  constructor(params: MockModelParams) {
    super(params);
    this.responses = params.responses;
  }

  _llmType(): string {
    return "streaming-mock";
  }

  bindTools(_tools: any[]): this {
    return this;
  }

  async _generate(
    _messages: BaseMessage[],
    _options: BaseLanguageModelCallOptions,
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const idx = this.callCount % this.responses.length;
    this.callCount++;
    const response = this.responses[idx];

    if (!response) {
      return {
        generations: [{ message: new AIMessage({ content: "" }), text: "" }],
      };
    }

    // Simulate delay
    if (response.delay && response.delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, response.delay));
    }

    // Simulate error
    if (response.error) {
      throw new Error(response.error);
    }

    return {
      generations: [{ message: response.message, text: (response.message as AIMessage).content as string }],
    };
  }
}
