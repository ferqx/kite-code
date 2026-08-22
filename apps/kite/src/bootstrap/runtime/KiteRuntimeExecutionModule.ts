import type { RuntimeHostExecutionBridge } from '@kite/runtime-host';
import { defineRuntimeModuleV1, type RuntimeModuleV1 } from '@kite/runtime-spi';

/**
 * The App-owned execution adapter is intentionally empty of capability
 * operations. Builtin modules own those operations; this module only binds
 * the one App bridge that Runtime Host is allowed to select.
 */
export const KITE_RUNTIME_OPERATION_IDS_V1 = Object.freeze([] as const);

export function createKiteRuntimeExecutionModule<TContext>(input: {
  readonly executionAdapterId: string;
  readonly createBridge: (context: TContext) => RuntimeHostExecutionBridge;
}): RuntimeModuleV1 {
  return defineRuntimeModuleV1({
    moduleId: 'kite-runtime-execution',
    providerId: 'kite-runtime-execution',
    revision: 'rmv1-16',
    operationIds: KITE_RUNTIME_OPERATION_IDS_V1,
    register: (registry) => {
      registry.registerExecutionAdapter({
        adapterId: input.executionAdapterId,
        revision: 'rmv1-16',
        create: input.createBridge,
      });
    },
  });
}
