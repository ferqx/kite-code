import type { RuntimeHostExecutionBridge } from '@kite/runtime-host';
import { defineRuntimeModule, type RuntimeModule } from '@kite/runtime-spi';

/**
 * The App-owned execution adapter is intentionally empty of capability
 * operations. Builtin modules own those operations; this module only binds
 * the one App bridge that Runtime Host is allowed to select.
 */
export const KITE_RUNTIME_OPERATION_IDS_ = Object.freeze([] as const);

export function createKiteRuntimeExecutionModule<TContext>(input: {
  readonly executionAdapterId: string;
  readonly createBridge: (context: TContext) => RuntimeHostExecutionBridge;
}): RuntimeModule {
  return defineRuntimeModule({
    moduleId: 'kite-runtime-execution',
    providerId: 'kite-runtime-execution',
    revision: 'app-runtime-current',
    operationIds: KITE_RUNTIME_OPERATION_IDS_,
    register: (registry) => {
      registry.registerExecutionAdapter({
        adapterId: input.executionAdapterId,
        revision: 'app-runtime-current',
        create: input.createBridge,
      });
    },
  });
}
