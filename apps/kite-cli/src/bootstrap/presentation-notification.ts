import { RUNTIME_NOTIFICATION_SCHEMA_, type RuntimeNotification } from '@kite-ai/runtime-contract';
import { projectRuntimeClientEvent } from '../runtime-client/event-projector';
import type { RuntimeEvent } from './runtime/state-runtime';

interface RuntimeStreamIdentity {
  readonly sessionId: string;
  readonly workId: string;
  readonly turnId: string;
  readonly actorId: string;
  readonly attemptId: string;
  readonly streamId: string;
  readonly sequence: number;
}

export function projectRuntimeEphemeralNotification(
  event: RuntimeEvent,
  identity: RuntimeStreamIdentity,
): Extract<RuntimeNotification, { durability: 'ephemeral' }> | undefined {
  const envelope = {
    schema: RUNTIME_NOTIFICATION_SCHEMA_,
    durability: 'ephemeral' as const,
    compositionRevision: 'runtime-state-store',
    ...identity,
  };
  if (
    event.type !== 'model.text_delta' &&
    event.type !== 'model.reasoning_delta' &&
    event.type !== 'model.reasoning_completed' &&
    event.type !== 'tool.progress'
  ) {
    return undefined;
  }
  // CLI and TUI carriers share the same exhaustive App-owned projection.
  // Keeping a second hand-written mapper here previously redacted local
  // reasoning and passed raw, unbounded progress text on another path.
  const projected = projectRuntimeClientEvent(event, { sessionRevision: 0 });
  return projected === undefined ? undefined : { ...envelope, event: projected };
}
