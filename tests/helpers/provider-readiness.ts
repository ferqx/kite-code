import { normalizeAgentEvent, type RuntimeEvent } from '@kite-ai/agent-kernel';
import type { McpRuntimeProvider } from '@kite-ai/builtin-runtime/mcp';
import type { RuntimeState } from '@kite-ai/runtime-host/kernel-adapter';
import { ProviderReadinessCoordinator } from '#app/bootstrap/runtime/provider-readiness';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';

export function createProviderReadinessTestHarness(
  provider: McpRuntimeProvider,
  initialState: RuntimeState,
  beforePersist?: (event: RuntimeEvent) => boolean | undefined,
): {
  providerReadinessCoordinator: ProviderReadinessCoordinator;
  getRuntimeState: () => Readonly<RuntimeState>;
  persistRuntimeEvent: (event: RuntimeEvent) => Promise<boolean>;
  persistRuntimeEvents: (events: RuntimeEvent[]) => Promise<boolean>;
} {
  let state = initialState;
  const persistRuntimeEvents = async (events: RuntimeEvent[]): Promise<boolean> => {
    if (events.some((event) => beforePersist?.(event) === false)) return false;
    for (const event of events) {
      const previousRevision = state.revision;
      state = {
        ...reduceRuntimeState(
          state,
          normalizeAgentEvent(event, state, new Date().toISOString()) as RuntimeEvent,
        ),
        revision: previousRevision + 1,
      };
    }
    return true;
  };
  return {
    providerReadinessCoordinator: new ProviderReadinessCoordinator(provider),
    getRuntimeState: () => state,
    persistRuntimeEvent: async (event) => persistRuntimeEvents([event]),
    persistRuntimeEvents,
  };
}
