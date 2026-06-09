import { ChatDeepSeek } from "@langchain/deepseek";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { AgentConfig } from "@/core/config/index";

/** 模型重试监听器 / Model retry listener */
export type ModelRetryListener = (attempt: number, error: unknown, delayMs: number) => void;

/** 支持设置 retry listener 的聊天模型接口 / Chat model interface supporting retry listener injection */
export interface RetryListenerHost {
  setRetryListener(listener: ModelRetryListener | null): void;
}

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
  /** 重试时调用的回调 / Callback invoked on each retry */
  onRetry?: ModelRetryListener;
}

const DEFAULT_TRANSIENT_RETRY_OPTIONS: Required<Omit<TransientModelRetryOptions, "onRetry">> = {
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

  /** 当前调用的重试监听器 / Retry listener for the current invocation */
  _retryListener: ModelRetryListener | null = null;

  /**
   * 覆写非流式消息转换，确保 response_metadata.usage 始终包含原始 usage 数据。
   * 父类仅在 system_fingerprint 存在时才写入 usage，而 DeepSeek 响应可能不带
   * system_fingerprint，导致 prompt_cache_hit_tokens 等字段丢失。
   *
   * Override non-streaming message conversion to ensure response_metadata.usage
   * always contains the raw usage data. The parent only includes usage when
   * system_fingerprint is present, but DeepSeek responses may omit it, causing
   * prompt_cache_hit_tokens etc. to be lost.
   */
  override _convertCompletionsMessageToBaseMessage(message: any, rawResponse: any): BaseMessage {
    const base = super._convertCompletionsMessageToBaseMessage(message, rawResponse);
    // 如果父类已经写入 usage 且含有缓存字段，直接返回 / If parent already wrote usage with cache fields, return as-is
    const existing = (base.response_metadata as Record<string, unknown>)?.usage as Record<string, unknown> | undefined;
    if (existing?.prompt_cache_hit_tokens != null || existing?.prompt_cache_miss_tokens != null) return base;
    // 父类未写入 usage 或缺少缓存字段：从 rawResponse 补全 / Parent missed usage or cache fields: patch from rawResponse
    const rawUsage = rawResponse?.usage as Record<string, unknown> | undefined;
    if (!rawUsage) return base;
    base.response_metadata = {
      ...base.response_metadata,
      usage: { ...rawUsage },
    };
    return base;
  }

  /** 设置重试监听器 / Set the retry listener */
  setRetryListener(listener: ModelRetryListener | null): void {
    this._retryListener = listener;
  }

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
      // 按位置顺序收集 reasoning_content（而非按内容匹配）。
      // SystemMessage 合并不影响 assistant 消息数量，位置匹配是可靠的。
      // 之前的内容前缀 key（content.slice(0,200)）在多个 tool-call 消息
      // 共享空 content 时发生 key 碰撞 → 最新消息的 rc 覆盖所有旧消息 →
      // API 序列化后的 prefix token 与上一轮不同 → DeepSeek 缓存 miss。
      //
      // Collect reasoning_content by positional order (rather than content match).
      // SystemMessage merging doesn't affect assistant message count, so positional
      // matching is reliable. The previous content-prefix key (content.slice(0,200))
      // caused key collisions when multiple tool-call messages shared empty content →
      // the latest message's rc overwrote all prior ones → different serialized prefix
      // tokens vs the prior request → DeepSeek cache miss.
      const originals = this._originalMessages;
      const reasonings: string[] = [];
      for (const original of originals) {
        if (!AIMessage.isInstance(original)) continue;
        const reasoning = (original.additional_kwargs as Record<string, unknown>)?.reasoning_content;
        reasonings.push(typeof reasoning === "string" ? reasoning : "");
      }

      let assistantIdx = 0;
      for (const mapped of request.messages) {
        if (mapped.role !== "assistant") continue;
        if (assistantIdx >= reasonings.length) break;
        if ("reasoning_content" in mapped && mapped.reasoning_content !== undefined) {
          assistantIdx++;
          continue;
        }
        const reasoning = reasonings[assistantIdx];
        if (reasoning) {
          mapped.reasoning_content = reasoning;
        }
        assistantIdx++;
      }

      // DeepSeek all-or-nothing requirement: if ANY assistant message has reasoning_content,
      // ALL assistant messages must have it (even empty strings). Otherwise API returns 400.
      const anyReasoning = request.messages.some(
        (m: any) => m.role === "assistant" && "reasoning_content" in m,
      );
      if (anyReasoning) {
        for (const m of request.messages) {
          if (m.role === "assistant" && (!("reasoning_content" in m) || m.reasoning_content === undefined)) {
            m.reasoning_content = "";
          }
        }
      }
    }
    return withTransientModelRetry(
      () => super.completionWithRetry(request, requestOptions),
      { onRetry: this._retryListener ?? undefined },
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
      const delayMs = baseDelay + jitter;
      // attempt 即重试次数（1-indexed）：attempt=1 表示第 1 次重试 / attempt is the retry number (1-indexed): attempt=1 means first retry
      retryOptions.onRetry?.(attempt, error, delayMs);
      await retryOptions.sleep(delayMs);
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
  if (typeof status === "number") {
    if (status >= 400 && status < 500) return false; // 4xx never retryable
    if (status >= 500) return true; // 5xx always retryable (502/503/504 are transient server errors)
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
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
  });
}
