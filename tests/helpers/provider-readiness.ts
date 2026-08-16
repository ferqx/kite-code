import { ProviderReadinessCoordinatorV1 } from '@/core/execution/tool-pipeline';
import type { McpRuntimeProvider } from '@/core/mcp';
import { reduceRuntimeState } from '@/core/runtime/reducer';
import type { RuntimeState } from '@/core/runtime/state';

export function createProviderReadinessTestHarnessV1(
  provider: McpRuntimeProvider,
  initialState: RuntimeState,
  beforePersist?: (event: import('@/core/runtime/events').RuntimeEvent) => boolean | undefined,
): {
  providerReadinessCoordinator: ProviderReadinessCoordinatorV1;
  getRuntimeState: () => Readonly<RuntimeState>;
  persistRuntimeEvent: (event: import('@/core/runtime/events').RuntimeEvent) => Promise<boolean>;
  persistRuntimeEvents: (
    events: import('@/core/runtime/events').RuntimeEvent[],
  ) => Promise<boolean>;
} {
  let state = initialState;
  const persistRuntimeEvents = async (
    events: import('@/core/runtime/events').RuntimeEvent[],
  ): Promise<boolean> => {
    if (events.some((event) => beforePersist?.(event) === false)) return false;
    for (const event of events) state = reduceRuntimeState(state, event);
    return true;
  };
  return {
    providerReadinessCoordinator: new ProviderReadinessCoordinatorV1(provider),
    getRuntimeState: () => state,
    persistRuntimeEvent: async (event) => persistRuntimeEvents([event]),
    persistRuntimeEvents,
  };
}
