// src/core/model/deepseek.ts
// Transient retry + DeepSeek reasoning middleware for AI SDK LanguageModelV4.
// Keeps retry logic from the old LangChain subclass, now applied via wrapLanguageModel middleware.

import type { LanguageModelMiddleware } from 'ai';

/** 模型重试监听器 / Model retry listener */
export type ModelRetryListener = (
  attempt: number,
  maxAttempts: number,
  error: unknown,
  delayMs: number,
) => void;

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
  /** 重试总时间上限 / Maximum total retry duration across all attempts */
  maxTotalRetryMs?: number;
  /** 可注入 sleep，便于测试 / Injectable sleep for tests */
  sleep?: (delayMs: number) => Promise<void>;
  /** 重试时调用的回调 / Callback invoked on each retry */
  onRetry?: ModelRetryListener;
}

const DEFAULT_TRANSIENT_RETRY_OPTIONS: Required<Omit<TransientModelRetryOptions, 'onRetry'>> = {
  maxAttempts: 5,
  initialDelayMs: 500,
  maxDelayMs: 4_000,
  jitterMs: 250,
  maxTotalRetryMs: 30_000,
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
};

/** 只对瞬时连接错误重试模型请求 / Retry model requests only for transient connection errors */
export async function withTransientModelRetry<T>(
  operation: () => Promise<T>,
  options: TransientModelRetryOptions = {},
): Promise<T> {
  const retryOptions = { ...DEFAULT_TRANSIENT_RETRY_OPTIONS, ...options };
  let lastError: unknown;
  const retryStartedAt = Date.now();

  for (let attempt = 1; attempt <= retryOptions.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const elapsedRetryMs = Date.now() - retryStartedAt;
      if (
        attempt >= retryOptions.maxAttempts ||
        !isTransientModelConnectionError(error) ||
        elapsedRetryMs >= retryOptions.maxTotalRetryMs
      ) {
        throw error;
      }

      const baseDelay = Math.min(
        retryOptions.maxDelayMs,
        retryOptions.initialDelayMs * 2 ** (attempt - 1),
      );
      const jitter =
        retryOptions.jitterMs > 0 ? Math.floor(Math.random() * retryOptions.jitterMs) : 0;
      const delayMs = Math.min(baseDelay + jitter, retryOptions.maxTotalRetryMs - elapsedRetryMs);
      // attempt 即重试次数（1-indexed）：attempt=1 表示第 1 次重试 / attempt is the retry number (1-indexed): attempt=1 means first retry
      retryOptions.onRetry?.(attempt, retryOptions.maxAttempts, error, delayMs);
      await retryOptions.sleep(delayMs);
    }
  }

  throw lastError;
}

/** 判断是否为可重试的模型连接错误 / Check whether an error is a retryable model connection error */
export function isTransientModelConnectionError(error: unknown): boolean {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const status =
    typeof record.statusCode === 'number'
      ? record.statusCode
      : typeof record.status === 'number'
        ? record.status
        : undefined;
  if (typeof status === 'number') {
    if (status === 429) return true; // Rate limiting is transient within the bounded retry budget.
    if (status >= 400 && status < 500) return false;
    if (status >= 500) return true; // 5xx always retryable (502/503/504 are transient server errors)
  }

  const combined = errorText(error);

  return /APIConnection(Error|Timeout)|Connection error|FailedToOpenSocket|ConnectionRefused|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket|network/i.test(
    combined,
  );
}

function errorText(error: unknown, depth = 0): string {
  if (depth > 3) {
    return '';
  }
  if (error instanceof Error) {
    const record = error as Error & { code?: unknown; cause?: unknown };
    return [
      error.name,
      error.message,
      typeof record.code === 'string' ? record.code : '',
      errorText(record.cause, depth + 1),
    ].join(' ');
  }
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return [
      typeof record.name === 'string' ? record.name : '',
      typeof record.message === 'string' ? record.message : '',
      typeof record.code === 'string' ? record.code : '',
      errorText(record.cause, depth + 1),
    ].join(' ');
  }
  return String(error);
}

// ── AI SDK Middleware ──

/**
 * Transient retry middleware — wraps doGenerate with withTransientModelRetry.
 * Replaces the old RetryingChatOpenAI/RetryingChatOllama/PatchedChatDeepSeek
 * subclass _generate override pattern.
 */
export function transientRetryMiddleware(options: {
  onRetry?: ModelRetryListener;
}): LanguageModelMiddleware {
  return {
    wrapGenerate: async ({ doGenerate }: { doGenerate: () => Promise<unknown> }) => {
      return withTransientModelRetry(() => doGenerate(), {
        onRetry: options.onRetry,
      });
    },
  } as unknown as LanguageModelMiddleware;
}

/**
 * DeepSeek reasoning_content passback middleware.
 *
 * DeepSeek thinking 模型（如 deepseek-v4-flash）要求工具调用轮次的 reasoning_content 回传 API。
 * 此 middleware 在 transformParams 阶段遍历 prompt messages，
 * 按 HumanMessage 边界划分 turn，计算 reasoning_content 并注入。
 *
 * DeepSeek thinking models require reasoning_content passback for tool-call turns.
 * This middleware walks prompt messages in transformParams, splits by user-message
 * boundaries into turns, computes reasoning_content per turn, and patches messages.
 */
export function createDeepSeekMiddleware(): LanguageModelMiddleware {
  return {
    transformParams: async ({ params }: { params: Record<string, unknown> }) => {
      const prompt = (params as Record<string, unknown>).prompt as
        | Array<Record<string, unknown>>
        | undefined;
      if (!prompt || !Array.isArray(prompt)) return params;
      // Walk messages, partition by user-message boundaries, and collect
      // reasoning_content per turn. The logic mirrors the old
      // PatchedChatDeepSeek.completionWithRetry override.
      const reasonings: string[] = [];
      const pending: string[] = [];
      let turnHasToolCalls = false;

      function flushTurn() {
        for (const rc of pending) {
          reasonings.push(turnHasToolCalls ? rc : '');
        }
        pending.length = 0;
        turnHasToolCalls = false;
      }

      for (const msg of prompt) {
        if (msg.role === 'user') {
          flushTurn();
          continue;
        }
        if (msg.role !== 'assistant') continue;

        const content = msg.content;
        if (Array.isArray(content)) {
          const hasToolCalls = content.some(
            (part) => (part as { type?: string }).type === 'tool-call',
          );
          if (hasToolCalls) turnHasToolCalls = true;

          // Collect reasoning_content from assistant messages
          const reasoningPart = content.find(
            (part) => (part as { type?: string }).type === 'reasoning',
          );
          const reasoningText =
            reasoningPart && 'text' in (reasoningPart as Record<string, unknown>)
              ? String((reasoningPart as Record<string, unknown>).text)
              : '';
          pending.push(reasoningText);
        }
      }
      flushTurn();

      // Apply reasoning_content to assistant messages in order
      let assistantIdx = 0;
      for (const msg of prompt) {
        if (msg.role !== 'assistant') continue;
        if (assistantIdx >= reasonings.length) break;

        if (!Array.isArray(msg.content)) continue;

        // Check if reasoning_content already exists (set by provider)
        const hasReasoning = msg.content.some(
          (part) => (part as { type?: string }).type === 'reasoning',
        );
        if (hasReasoning) {
          assistantIdx++;
          continue;
        }

        const reasoning = reasonings[assistantIdx];
        if (reasoning) {
          msg.content = [...msg.content, { type: 'reasoning' as const, text: reasoning }];
        }
        assistantIdx++;
      }

      // DeepSeek all-or-nothing requirement: if ANY assistant message has reasoning_content,
      // ALL assistant messages must have it (even empty strings).
      const anyReasoning = prompt.some(
        (msg) =>
          msg.role === 'assistant' &&
          Array.isArray(msg.content) &&
          msg.content.some((part) => (part as { type?: string }).type === 'reasoning'),
      );
      if (anyReasoning) {
        for (const msg of prompt) {
          if (
            msg.role === 'assistant' &&
            Array.isArray(msg.content) &&
            !msg.content.some((part) => (part as { type?: string }).type === 'reasoning')
          ) {
            msg.content = [...msg.content, { type: 'reasoning' as const, text: '' }];
          }
        }
      }

      return params;
    },
  } as unknown as LanguageModelMiddleware;
}
