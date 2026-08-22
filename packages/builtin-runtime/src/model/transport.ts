import type {
  CanonicalJsonObjectV1,
  CanonicalJsonValueV1,
  CanonicalModelMessageV1,
  ModelFinishReasonV1,
  ModelSurfaceV1,
} from '@kite/runtime-spi';
import {
  generateText,
  jsonSchema,
  type ModelMessage,
  stepCountIs,
  streamText,
  type ToolSet,
  tool,
} from 'ai';
import type { SupportedChatModel } from './factory';
import { canonicalModelJsonV1, computeModelSurfaceDigestV1 } from './surface-canonicalizer';

export interface ModelTransportResponseV1 {
  message: Extract<CanonicalModelMessageV1, { role: 'assistant' }>;
  finishReason: ModelFinishReasonV1;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    cacheReadTokens: number | null;
  };
  providerMetadata: CanonicalJsonObjectV1;
}

/**
 * Exactly one Provider attempt compiled from the already-frozen Surface.
 * It owns no retry loop, admission decision, artifact write, or Runtime event.
 */
export async function invokeModelTransportSingleAttemptV1(input: {
  model: SupportedChatModel;
  surface: ModelSurfaceV1;
  signal?: AbortSignal;
  onTextCumulative?: (text: string) => void;
  onReasoningCumulative?: (text: string, segmentId: string) => void;
  onReasoningCompleted?: (text: string, segmentId: string) => void;
}): Promise<ModelTransportResponseV1> {
  // Revalidate at the final boundary. A mutable caller cannot drift after
  // admission and still reach the Provider under the earlier identity.
  computeModelSurfaceDigestV1(input.surface);
  const request = requestFromSurface(input.surface, input.model, input.signal);
  if (input.surface.request.transport === 'generate') {
    return normalizeTransportResult(await generateText(request));
  }

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
  const ensureReasoningSegment = (providerId?: string): string => {
    if (!reasoningSegmentId) {
      reasoningSegmentOrdinal += 1;
      reasoningSegmentId = providerId || `reasoning-${reasoningSegmentOrdinal}`;
      reasoningSegment = '';
    }
    return reasoningSegmentId;
  };
  const completeReasoningSegment = (): void => {
    if (!reasoningSegmentId) return;
    if (reasoningSegment) {
      input.onReasoningCompleted?.(reasoningSegment, reasoningSegmentId);
    }
    reasoningSegmentId = undefined;
    reasoningSegment = '';
  };
  for await (const part of result.fullStream) {
    if (part.type.startsWith('tool-')) completeReasoningSegment();
    if (part.type === 'text-delta') {
      completeReasoningSegment();
      text += part.text;
      input.onTextCumulative?.(text);
    } else if (part.type === 'reasoning-delta') {
      const segmentId = ensureReasoningSegment(
        'id' in part && typeof part.id === 'string' ? part.id : undefined,
      );
      reasoning += part.text;
      reasoningSegment += part.text;
      input.onReasoningCumulative?.(reasoning, segmentId);
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
  return normalizeTransportResult(await result.finalStep);
}

function requestFromSurface(
  surface: ModelSurfaceV1,
  model: SupportedChatModel,
  signal: AbortSignal | undefined,
) {
  const providerOptions =
    surface.request.providerOptions.kind === 'inline'
      ? (JSON.parse(canonicalModelJsonV1(surface.request.providerOptions.value)) as NonNullable<
          Parameters<typeof generateText>[0]['providerOptions']
        >)
      : undefined;
  if (surface.request.providerOptions.kind !== 'inline') {
    throw new Error('Artifact-backed Provider options must be resolved before transport dispatch.');
  }
  const tools = Object.fromEntries(
    surface.request.tools.map((declaration) => [
      declaration.name,
      tool({
        ...(declaration.description ? { description: declaration.description } : {}),
        inputSchema: jsonSchema(declaration.inputSchema as Record<string, unknown>),
      }),
    ]),
  ) as ToolSet;
  return {
    model: model.model,
    tools: Object.keys(tools).length > 0 ? tools : undefined,
    messages: surface.request.messages.map(toSdkMessage),
    system: surface.request.system || undefined,
    stopWhen: stepCountIs(1),
    abortSignal: signal,
    temperature: surface.request.temperature,
    maxRetries: surface.request.sdkRetry.maxRetries,
    providerOptions,
    ...(surface.request.maxOutputTokens
      ? { maxOutputTokens: surface.request.maxOutputTokens }
      : {}),
  };
}

function toSdkMessage(message: CanonicalModelMessageV1): ModelMessage {
  if (message.role === 'user') {
    return { role: 'user', content: message.content.map((part) => part.text).join('') || ' ' };
  }
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content.map((part) => {
        if (part.type === 'text') return { type: 'text' as const, text: part.text };
        if (part.type === 'reasoning') return { type: 'reasoning' as const, text: part.text };
        return {
          type: 'tool-call' as const,
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        };
      }),
    };
  }
  return {
    role: 'tool',
    content: message.content.map((part) => ({
      type: 'tool-result' as const,
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      output: { type: 'text' as const, value: part.output.value },
    })),
  };
}

function normalizeTransportResult(result: {
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
}): ModelTransportResponseV1 {
  const content: Extract<CanonicalModelMessageV1, { role: 'assistant' }>['content'][number][] = [];
  if (result.text) content.push({ type: 'text', text: result.text });
  for (const call of result.toolCalls ?? []) {
    content.push({
      type: 'tool_call',
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: canonicalJsonValue(call.input),
    });
  }
  if (result.reasoningText) content.push({ type: 'reasoning', text: result.reasoningText });
  return {
    message: { role: 'assistant', content },
    finishReason: normalizeFinishReason(result.rawFinishReason ?? result.finishReason),
    usage: {
      inputTokens: nonNegativeIntegerOrNull(result.usage?.inputTokens),
      outputTokens: nonNegativeIntegerOrNull(result.usage?.outputTokens),
      totalTokens: nonNegativeIntegerOrNull(result.usage?.totalTokens),
      cacheReadTokens: nonNegativeIntegerOrNull(result.usage?.inputTokenDetails?.cacheReadTokens),
    },
    providerMetadata: {
      responseId: result.response?.id ?? null,
      rawFinishReason: result.rawFinishReason ?? null,
    },
  };
}

function canonicalJsonValue(value: unknown): CanonicalJsonValueV1 {
  return JSON.parse(canonicalModelJsonV1(value)) as CanonicalJsonValueV1;
}

function normalizeFinishReason(value: string | undefined): ModelFinishReasonV1 {
  switch (value) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content-filter':
    case 'content_filter':
      return 'content_filter';
    case 'tool-calls':
    case 'tool_calls':
      return 'tool_calls';
    case 'error':
      return 'error';
    case 'other':
      return 'other';
    default:
      return 'unknown';
  }
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
