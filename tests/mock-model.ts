import { BaseChatModel, type BaseChatModelParams } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { BaseLanguageModelCallOptions } from "@langchain/core/language_models/base";
import type { ChatResult } from "@langchain/core/outputs";

export interface MockResponse {
  message: BaseMessage;
  delay?: number;
  error?: string;
}

/**
 * 可配置延迟/错误的 Mock Chat Model。
 * 仅覆盖 _generate，在每次调用时注入行为。
 */
export class StreamingMockModel extends BaseChatModel {
  lc_namespace = ["test", "mock"];
  private _responses: MockResponse[];
  private _callCount = 0;

  constructor(params: { responses: MockResponse[] } & BaseChatModelParams) {
    super(params);
    this._responses = params.responses;
  }

  get responses(): BaseMessage[] {
    return this._responses.map((r) => r.message);
  }

  _llmType(): string {
    return "streaming-mock";
  }

  bindTools(tools: any[]): this {
    const Cls = this.constructor as new (params: { responses: MockResponse[] } & BaseChatModelParams) => StreamingMockModel;
    const bound = new Cls({ responses: this._responses });
    (bound as any).kwargs = { ...((this as any).kwargs ?? {}), tools };
    (bound as any).lc_kwargs = { ...((this as any).lc_kwargs ?? {}), tools };
    return bound as unknown as this;
  }

  async _generate(
    _messages: BaseMessage[],
    _options: BaseLanguageModelCallOptions,
  ): Promise<ChatResult> {
    const idx = this._callCount % this._responses.length;
    this._callCount++;
    const response = this._responses[idx];

    if (!response?.message) {
      return {
        generations: [{ message: new AIMessage({ content: "", additional_kwargs: {} }), text: "" }],
      };
    }

    if (response.delay && response.delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, response.delay));
    }

    if (response.error) {
      throw new Error(response.error);
    }

    const msg = response.message;
    return {
      generations: [{ message: msg, text: typeof (msg as AIMessage).content === "string" ? (msg as AIMessage).content as string : "" }],
    };
  }
}
