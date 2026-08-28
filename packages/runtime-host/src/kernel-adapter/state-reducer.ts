import { type RuntimeEvent, reduceAgentState } from '@kite-ai/agent-kernel';
import type { RuntimeState } from './initial';

/**
 * Replay one already-admitted canonical event for an exact historical Host projection.
 * This is not an alternate mutation or admission path.
 */
export function runtimeHostStateProjectAcceptedEvent(
  state: Readonly<RuntimeState>,
  event: RuntimeEvent,
): RuntimeState {
  return reduceAgentState(state, event);
}
