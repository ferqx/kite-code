import type { ModelAdapterSnapshot } from './request-snapshot';

export { ModelAttemptError } from './model-attempt';

export {
  type ModelAdapterSnapshot,
  type ReasoningEffort,
  reasoningEffortLevels,
  reasoningEfforts,
} from './request-snapshot';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  /** Complete JSON argument text. A call is not dispatchable before finish. */
  readonly arguments: string;
}

export interface ModelMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  /** Inline immutable image bytes, encoded as base64; user input or exact tool result. */
  readonly images?: readonly ModelImage[];
  readonly toolCalls?: readonly ModelToolCall[];
  readonly toolCallId?: string;
  readonly sourceIds?: readonly string[];
  /** Opaque adapter continuation. Private model history, never display text or authority. */
  readonly continuation?: Json;
}

export const imageMediaTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export interface ModelImage {
  readonly mediaType: (typeof imageMediaTypes)[number];
  readonly data: string;
}
export function isModelImage(value: unknown): value is ModelImage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const image = value as Record<string, unknown>;
  return (
    Object.keys(image).sort().join(',') === 'data,mediaType' &&
    imageMediaTypes.includes(image.mediaType as ModelImage['mediaType']) &&
    typeof image.data === 'string' &&
    image.data.length > 0 &&
    image.data.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
  );
}

export interface ModelTool {
  readonly id: string;
  readonly definitionVersion: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, Json>>;
}

export interface ModelRequest {
  readonly modelId: string;
  readonly requestId: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelTool[];
}

export interface ModelUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Reported total; never reconstructed from partial input/output measurements. */
  readonly totalTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
  /** The Provider usage object only, excluding response text, headers and credentials. */
  readonly raw?: Readonly<Record<string, Json>>;
}

export type ModelEvent =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'reasoning_delta'; readonly text: string }
  /** A request usage snapshot, independent of successful response completion. */
  | { readonly type: 'usage'; readonly usage: ModelUsage }
  | ({ readonly type: 'tool_call' } & ModelToolCall)
  | {
      readonly type: 'finish';
      readonly reason: 'stop' | 'tool_calls' | 'length' | 'cancelled';
      readonly usage: ModelUsage;
      readonly continuation?: Json;
    };

export interface ModelAdapter {
  /** Pure binding facts, captured before dispatch. Absence means adapter metadata is unavailable. */
  describeRequest?(request: ModelRequest): ModelAdapterSnapshot;
  stream(
    request: ModelRequest,
    options: { readonly signal: AbortSignal },
  ): AsyncIterable<ModelEvent>;
}

export interface FixedModel extends ModelAdapter {
  /** Immutable copies of the requests this adapter actually received. */
  readonly requests: readonly ModelRequest[];
}

/** Deterministic local adapter. No Provider, network, retries or implicit finish. */
export function createFixedModel(
  responses: readonly (readonly (ModelEvent | Error)[])[],
): FixedModel {
  const requests: ModelRequest[] = [];
  let nextResponse = 0;
  return {
    get requests() {
      return requests.map((request) => structuredClone(request));
    },
    async *stream(request, { signal }) {
      signal.throwIfAborted();
      requests.push(structuredClone(request));
      const events = responses[nextResponse++];
      if (!events) throw new Error('Fixed model response sequence exhausted.');
      for (const event of events) {
        signal.throwIfAborted();
        if (event instanceof Error) throw event;
        yield structuredClone(event);
      }
    },
  };
}
