import { ChatDeepSeek } from "@langchain/deepseek";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { AgentConfig } from "./config";

/**
 * ChatDeepSeek 扩展：在 _generate 中注入 reasoning_content 到 API 请求体。
 * Extended ChatDeepSeek: injects reasoning_content into API request body in _generate.
 *
 * DeepSeek thinking 模型（如 deepseek-v4-flash）要求工具调用轮次的 reasoning_content 回传 API。
 * LangChain 的 convertMessagesToCompletionsMessageParams 不会从 additional_kwargs 复制该字段。
 * 我们 override _generate 来在发送前将 reasoning_content 注入 messagesMapped。
 *
 * DeepSeek thinking models (e.g. deepseek-v4-flash) require reasoning_content passback for
 * tool-call turns. LangChain's converter doesn't copy it from additional_kwargs.
 * We override _generate to inject reasoning_content into messagesMapped before sending.
 */
class PatchedChatDeepSeek extends ChatDeepSeek {
  /** @internal 暂存原始消息以便在 completionWithRetry 中回查 / Stash original messages for lookup in completionWithRetry */
  private _originalMessages: BaseMessage[] | null = null;

  /** @internal */
  override async _generate(
    messages: BaseMessage[],
    options: any,
    runManager?: any,
  ): Promise<any> {
    this._originalMessages = messages;
    try {
      return await super._generate(messages, options, runManager);
    } finally {
      this._originalMessages = null;
    }
  }

  /** @internal 在发送前注入 reasoning_content / Inject reasoning_content before sending */
  override async completionWithRetry(
    request: any,
    requestOptions?: any,
  ): Promise<any> {
    if (
      this._originalMessages &&
      request.messages &&
      Array.isArray(request.messages)
    ) {
      // 为 messagesMapped 中的每条消息，找到对应原始消息的 reasoning_content 并注入
      // For each mapped message, find corresponding original message's reasoning_content and inject
      const originals = this._originalMessages;
      let mappedIndex = 0;
      for (let i = 0; i < originals.length && mappedIndex < request.messages.length; i++) {
        const original = originals[i];
        if (!AIMessage.isInstance(original)) {
          mappedIndex++;
          continue;
        }
        const reasoning = (original.additional_kwargs as Record<string, unknown>)?.reasoning_content;
        if (typeof reasoning === "string" && reasoning) {
          const mapped = request.messages[mappedIndex];
          if (mapped && mapped.role === "assistant" && !mapped.reasoning_content) {
            mapped.reasoning_content = reasoning;
          }
        }
        mappedIndex++;
      }
    }
    return super.completionWithRetry(request, requestOptions);
  }
}

/** 创建 DeepSeek 聊天模型实例 / Create DeepSeek chat model instance */
export function createDeepSeekModel(config: AgentConfig): ChatDeepSeek {
  return new PatchedChatDeepSeek({
    apiKey: config.apiKey,
    configuration: {
      baseURL: config.baseURL,
    },
    model: config.modelName,
    temperature: 0,
  });
}
