import type { ModelMessage } from '@kite-ai/ai';
import { canonicalJson } from './json';
import type { Json } from './storage/types';

/** Review text contains semantic history only, never an adapter's private replay state. */
export function semanticReviewContext(context: Json): Json {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return context;
  // An immutable modelInput must be verified and expanded by Runtime before projection.
  if (!Array.isArray(context.messages)) return context;
  return {
    ...context,
    messages: (context.messages as unknown as ModelMessage[]).map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.toolCalls === undefined ? {} : { toolCalls: message.toolCalls }),
      ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
      ...(message.sourceIds === undefined ? {} : { sourceIds: message.sourceIds }),
    })) as unknown as Json,
  };
}

/** Call only after authenticating the original review message, never from its text alone. */
export function semanticReviewContent(content: string): string {
  let payload: Record<string, Json> | null = null;
  try {
    payload = JSON.parse(content);
  } catch {
    return content;
  }
  if (payload?.purpose !== 'authorization_review') return content;
  const projected = semanticReviewContext(payload.decisionContext!);
  return canonicalJson(projected) === canonicalJson(payload.decisionContext!)
    ? content
    : canonicalJson({ ...payload, decisionContext: projected });
}
