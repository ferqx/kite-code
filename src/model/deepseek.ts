import { ChatDeepSeek } from "@langchain/deepseek";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { AgentConfig } from "../config/index";

/** 可重试模型连接错误配置 / Retry options for transient model connection errors */
export interface TransientModelRetryOptions {
  /** 最大尝试次数，包含首次调用 / Max attempts including the first call */
  maxAttempts?: number;
  /** 首次重试延迟 / Initial retry delay */
  initialDelayMs?: number;
  /** 最大重试延迟 / Maximum retry delay */
  maxDelayMs?: number;
  /** 随机抖动上限 / Maximum random jitter */
  jitterMs?: number;
  /** 可注入 sleep，便于测试 / Injectable sleep for tests */
  sleep?: (delayMs: number) => Promise<void>;
}

const DEFAULT_TRANSIENT_RETRY_OPTIONS: Required<TransientModelRetryOptions> = {
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 4_000,
  jitterMs: 250,
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
};

const MODEL_REQUEST_TIMEOUT_MS = 30_000;

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
    return withTransientModelRetry(
      () => super.completionWithRetry(request, requestOptions),
    );
  }
}

/** 只对瞬时连接错误重试模型请求 / Retry model requests only for transient connection errors */
export async function withTransientModelRetry<T>(
  operation: () => Promise<T>,
  options: TransientModelRetryOptions = {},
): Promise<T> {
  const retryOptions = { ...DEFAULT_TRANSIENT_RETRY_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= retryOptions.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (
        attempt >= retryOptions.maxAttempts ||
        !isTransientModelConnectionError(error)
      ) {
        throw error;
      }

      const baseDelay = Math.min(
        retryOptions.maxDelayMs,
        retryOptions.initialDelayMs * 2 ** (attempt - 1),
      );
      const jitter =
        retryOptions.jitterMs > 0
          ? Math.floor(Math.random() * retryOptions.jitterMs)
          : 0;
      await retryOptions.sleep(baseDelay + jitter);
    }
  }

  throw lastError;
}

/** 判断是否为可重试的模型连接错误 / Check whether an error is a retryable model connection error */
export function isTransientModelConnectionError(error: unknown): boolean {
  const record =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  const status = record.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return false;
  }

  const combined = errorText(error);

  return /APIConnection(Error|Timeout)|Connection error|FailedToOpenSocket|ConnectionRefused|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket|network/i.test(
    combined,
  );
}

function errorText(error: unknown, depth = 0): string {
  if (depth > 3) {
    return "";
  }
  if (error instanceof Error) {
    const record = error as Error & { code?: unknown; cause?: unknown };
    return [
      error.name,
      error.message,
      typeof record.code === "string" ? record.code : "",
      errorText(record.cause, depth + 1),
    ].join(" ");
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return [
      typeof record.name === "string" ? record.name : "",
      typeof record.message === "string" ? record.message : "",
      typeof record.code === "string" ? record.code : "",
      errorText(record.cause, depth + 1),
    ].join(" ");
  }
  return String(error);
}

/** 创建 DeepSeek 聊天模型实例 / Create DeepSeek chat model instance */
export function createDeepSeekModel(config: AgentConfig): ChatDeepSeek {
  return new PatchedChatDeepSeek({
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
