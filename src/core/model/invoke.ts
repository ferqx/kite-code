// src/core/model/invoke.ts
// Invoke a model with tools — AI SDK single-step generation, optionally streamed.
// Message conversion from internal BaseMessage[] to AI SDK ModelMessage[] lives here.

import { generateText, type ModelMessage, stepCountIs, streamText, type ToolSet } from 'ai';
import {
  type AIMessage,
  aiMessage,
  type BaseMessage,
  isAIMessage,
  isHumanMessage,
  isSystemMessage,
  isToolMessage,
  type ToolMessage,
} from '@/core/messages';
import {
  type ModelRetryListener,
  type TransientModelRetryOptions,
  withTransientModelRetry,
} from './deepseek';
import type { SupportedChatModel } from './factory';

/**
 * Invoke a bound model without depending on the execution graph.
 * Uses generateText with stopWhen: stepCountIs(1) to prevent the AI SDK
 * from executing tools — the Runtime Kernel handles tool execution separately.
 */
export async function invokeBoundModel(params: {
  model: SupportedChatModel;
  tools: ToolSet;
  messages: BaseMessage[];
  signal?: AbortSignal;
  maxOutputTokens?: number;
  streaming?: boolean;
  onTextDelta?: (text: string) => void;
  onReasoningDelta?: (text: string, segmentId: string) => void;
  onReasoningCompleted?: (text: string, segmentId: string) => void;
  onRetry?: ModelRetryListener;
  /** Test seam for deterministic retry timing; production uses the bounded defaults. */
  streamRetryOptions?: Omit<TransientModelRetryOptions, 'onRetry'>;
}): Promise<AIMessage> {
  // Separate system messages from chat messages — generateText requires
  // system prompts via `system`/`instructions`, not in `messages`.
  const allModelMessages = toModelMessages(params.messages);
  const systemMessages = allModelMessages.filter((m) => m.role === 'system');
  const chatMessages = allModelMessages.filter((m) => m.role !== 'system');
  const systemText = systemMessages
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter(Boolean)
    .join('\n\n');

  // The Runtime Kernel owns tool execution and policy enforcement. AI SDK's
  // generateText will execute a tool when its `execute` handler is present,
  // even when stopWhen limits the call to one model step. Pass only the tool
  // declarations here so a model response cannot mutate the workspace before
  // the durable Runtime Controller validates and executes it.
  const modelTools = Object.fromEntries(
    Object.entries(params.tools).map(([name, definition]) => {
      const copy = { ...definition } as typeof definition & { execute?: unknown };
      delete copy.execute;
      return [name, copy];
    }),
  ) as ToolSet;

  const request = {
    model: params.model.model,
    tools: Object.keys(modelTools).length > 0 ? modelTools : undefined,
    messages: chatMessages,
    system: systemText || undefined,
    stopWhen: stepCountIs(1),
    abortSignal: params.signal,
    temperature: 0,
    maxRetries: 0, // retries handled by transientRetryMiddleware
    ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
  };

  if (params.streaming) {
    let attemptNumber = 0;
    let lastAttemptText = '';
    let lastAttemptReasoning = '';
    let retryBaselineText = '';
    let retryBaselineReasoning = '';
    return withTransientModelRetry(
      async () => {
        attemptNumber++;
        let streamError: unknown;
        const result = streamText({
          ...request,
          onError: ({ error }) => {
            streamError = error;
          },
        });
        let text = '';
        let reasoning = '';
        let reasoningSegment = '';
        let reasoningSegmentId: string | undefined;
        let reasoningSegmentOrdinal = 0;
        let emittedReasoningLength = 0;
        const ensureReasoningSegment = (providerId?: string) => {
          if (!reasoningSegmentId) {
            reasoningSegmentOrdinal++;
            reasoningSegmentId =
              providerId || `reasoning-${attemptNumber}-${reasoningSegmentOrdinal}`;
            reasoningSegment = '';
          }
          return reasoningSegmentId;
        };
        const completeReasoningSegment = () => {
          if (!reasoningSegmentId) return;
          if (reasoningSegment) {
            params.onReasoningCompleted?.(reasoningSegment, reasoningSegmentId);
          }
          reasoningSegmentId = undefined;
          reasoningSegment = '';
        };
        lastAttemptText = '';
        lastAttemptReasoning = '';
        for await (const part of result.fullStream) {
          if (part.type.startsWith('tool-')) completeReasoningSegment();
          if (part.type === 'text-delta') {
            completeReasoningSegment();
            text += part.text;
            lastAttemptText = text;
            const visibleText =
              attemptNumber === 1
                ? text
                : retryBaselineText.startsWith(text)
                  ? ''
                  : text.startsWith(retryBaselineText)
                    ? text.slice(retryBaselineText.length)
                    : text;
            if (visibleText) params.onTextDelta?.(visibleText);
          } else if (part.type === 'reasoning-delta') {
            const segmentId = ensureReasoningSegment(
              'id' in part && typeof part.id === 'string' ? part.id : undefined,
            );
            reasoning += part.text;
            lastAttemptReasoning = reasoning;
            const visibleReasoning =
              attemptNumber === 1
                ? reasoning
                : retryBaselineReasoning.startsWith(reasoning)
                  ? ''
                  : reasoning.startsWith(retryBaselineReasoning)
                    ? reasoning.slice(retryBaselineReasoning.length)
                    : reasoning;
            const visibleDelta = visibleReasoning.slice(emittedReasoningLength);
            emittedReasoningLength = visibleReasoning.length;
            if (visibleDelta) {
              reasoningSegment += visibleDelta;
              params.onReasoningDelta?.(reasoningSegment, segmentId);
            }
          } else if (part.type === 'reasoning-start') {
            completeReasoningSegment();
            ensureReasoningSegment(typeof part.id === 'string' ? part.id : undefined);
          } else if (part.type === 'reasoning-end') {
            completeReasoningSegment();
          } else if (part.type === 'error') {
            throw part.error;
          } else if (part.type === 'abort') {
            throw new DOMException(part.reason ?? 'Model stream aborted', 'AbortError');
          }
        }
        completeReasoningSegment();
        if (streamError) throw streamError;
        return toAIMessage(await result.finalStep);
      },
      {
        ...params.streamRetryOptions,
        onRetry: (attempt, maxAttempts, error, delayMs) => {
          retryBaselineText = lastAttemptText;
          retryBaselineReasoning = lastAttemptReasoning;
          params.onRetry?.(attempt, maxAttempts, error, delayMs);
        },
      },
    );
  }

  return toAIMessage(await generateText(request));
}

// ── Message conversion: internal BaseMessage → AI SDK ModelMessage ──

function contentAsString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (block && typeof block === 'object' && 'text' in (block as Record<string, unknown>)) {
          return String((block as Record<string, unknown>).text);
        }
        return '';
      })
      .join('');
  }
  return String(content ?? '');
}

function toModelMessages(messages: BaseMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (isHumanMessage(msg)) {
      const text = contentAsString(msg.content);
      return {
        role: 'user' as const,
        content: text || ' ',
      };
    }
    if (isSystemMessage(msg)) {
      return {
        role: 'system' as const,
        content: contentAsString(msg.content),
      };
    }
    if (isAIMessage(msg)) {
      return toAssistantModelMessage(msg);
    }
    if (isToolMessage(msg)) {
      return toToolModelMessage(msg);
    }
    // Fallback: treat as user message
    const fallback = msg as { content?: unknown };
    return {
      role: 'user' as const,
      content: contentAsString(fallback.content),
    };
  });
}

function toAssistantModelMessage(msg: AIMessage): ModelMessage {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK content union is broad
  const parts: Array<any> = [];

  // Text content
  const text = contentAsString(msg.content);
  if (text) {
    parts.push({ type: 'text', text });
  }

  // Tool calls
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      parts.push({
        type: 'tool-call' as const,
        toolCallId: tc.id ?? '',
        toolName: tc.name,
        input: tc.args as Record<string, unknown>,
      });
    }
  }

  // Reasoning content (DeepSeek)
  const reasoning = (msg.additional_kwargs as Record<string, unknown> | undefined)
    ?.reasoning_content;
  if (typeof reasoning === 'string' && reasoning.length > 0) {
    parts.push({ type: 'reasoning' as const, text: reasoning });
  }

  return {
    role: 'assistant' as const,
    content: parts.length > 0 ? parts : text || '',
  };
}

function toToolModelMessage(msg: ToolMessage): ModelMessage {
  const outputText = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  return {
    role: 'tool' as const,
    content: [
      {
        type: 'tool-result' as const,
        toolCallId: msg.tool_call_id,
        toolName: msg.name ?? '',
        output: { type: 'text' as const, value: outputText },
      },
    ],
  };
}

// ── Result conversion: generateText result → internal AIMessage ──

function toAIMessage(result: {
  text?: string;
  toolCalls?: ReadonlyArray<{
    toolCallId: string;
    toolName: string;
    input: unknown;
  }>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number };
  };
  rawFinishReason?: string;
  finishReason?: string;
  reasoningText?: string;
  response?: { id?: string };
}): AIMessage {
  return aiMessage({
    content: result.text ?? '',
    tool_calls: (result.toolCalls ?? []).map((tc) => ({
      id: tc.toolCallId,
      name: tc.toolName,
      args: tc.input as Record<string, unknown>,
      type: 'tool_call' as const,
    })),
    response_metadata: {
      usage: result.usage
        ? {
            prompt_tokens: result.usage.inputTokens,
            input_tokens: result.usage.inputTokens,
            completion_tokens: result.usage.outputTokens,
            total_tokens: result.usage.totalTokens,
            prompt_cache_hit_tokens: result.usage.inputTokenDetails?.cacheReadTokens,
          }
        : undefined,
      finishReason: result.rawFinishReason ?? result.finishReason,
    },
    additional_kwargs: {
      reasoning_content: result.reasoningText ?? '',
    },
    id: result.response?.id,
  });
}
