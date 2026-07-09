import type { AgentEvent } from '@/protocol/events.js';
import type { RuntimeEvent } from './events.js';

export interface RuntimeEventPump {
  emitRuntimeEvent(event: RuntimeEvent): void;
  drain(): AgentEvent[];
}

export function createRuntimeEventPump(
  processEvent: (event: RuntimeEvent) => AgentEvent[],
  emitAgentEvent?: (event: AgentEvent) => void,
): RuntimeEventPump {
  const pending: AgentEvent[] = [];

  return {
    emitRuntimeEvent(event: RuntimeEvent): void {
      const projectedEvents = processEvent(event);
      if (emitAgentEvent) {
        for (const projectedEvent of projectedEvents) {
          emitAgentEvent(projectedEvent);
        }
        return;
      }
      pending.push(...projectedEvents);
    },

    drain(): AgentEvent[] {
      return pending.splice(0);
    },
  };
}
