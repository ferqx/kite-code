import { normalizeAgentEvent, type RuntimeEvent } from '@kite/agent-kernel';
import type { McpRuntimeProvider } from '@kite/builtin-runtime/mcp';
import type { RuntimeState } from '@kite/runtime-host';
import { ProviderReadinessCoordinatorV1 } from '#app/bootstrap/runtime/provider-readiness';
import { reduceRuntimeState } from '#runtime-support/runtime-state25-reducer';

export function createProviderReadinessTestHarnessV1(
  provider: McpRuntimeProvider,
  initialState: RuntimeState,
  beforePersist?: (event: RuntimeEvent) => boolean | undefined,
): {
  providerReadinessCoordinator: ProviderReadinessCoordinatorV1;
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
    providerReadinessCoordinator: new ProviderReadinessCoordinatorV1(provider),
    getRuntimeState: () => state,
    persistRuntimeEvent: async (event) => persistRuntimeEvents([event]),
    persistRuntimeEvents,
  };
}
