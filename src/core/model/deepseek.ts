// src/core/model/deepseek.ts
// DeepSeek reasoning middleware and Gateway-owned transient error classifier.

import type { LanguageModelMiddleware } from 'ai';

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
