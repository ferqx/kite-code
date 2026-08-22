import { RUNTIME_NOTIFICATION_SCHEMA_V1, type RuntimeNotification } from '@kite/runtime-contract';
import type { RuntimeEvent } from './runtime/state25-runtime';

interface LegacyStreamIdentity {
  readonly sessionId: string;
  readonly workId: string;
  readonly turnId: string;
  readonly actorId: string;
  readonly attemptId: string;
  readonly streamId: string;
  readonly sequence: number;
}

export function projectRuntimeEphemeralNotificationV1(
  event: RuntimeEvent,
  identity: LegacyStreamIdentity,
): Extract<RuntimeNotification, { durability: 'ephemeral' }> | undefined {
  const envelope = {
    schema: RUNTIME_NOTIFICATION_SCHEMA_V1,
    durability: 'ephemeral' as const,
    compositionRevision: 'legacy-rmv1-state25-store4',
    ...identity,
  };
  if (event.type === 'model.text_delta') {
    return { ...envelope, payload: { type: 'model_delta', text: event.text } };
  }
  if (event.type === 'model.reasoning_delta' || event.type === 'model.reasoning_completed') {
    return { ...envelope, payload: { type: 'reasoning_delta', text: event.text } };
  }
  if (event.type === 'tool.progress') {
    return {
      ...envelope,
      payload: {
        type: 'tool_progress',
        toolId: event.toolCallId,
        status: 'progress',
        summary: event.chunk,
        stream: event.stream,
        lineCount: event.lineCount,
      },
    };
  }
  return undefined;
}
