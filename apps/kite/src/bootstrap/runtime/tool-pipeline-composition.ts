import {
  type BuiltinRuntimeToolPipelineCallbacksV1,
  type BuiltinToolCatalogProjectionV1,
  createBuiltinRuntimeToolPipelineCallbacksV1,
} from '@kite/builtin-runtime';
import {
  createRuntimeHostState26ToolGovernanceV1,
  type RuntimeHostState26ToolGovernancePortV1,
} from '@kite/runtime-host';
import type { CapabilityTurnContextV1 } from '@kite/runtime-spi';

/**
 * The per-turn App projection of the one frozen Builtin catalog.
 *
 * The callbacks and Host governance port are intentionally built from the
 * exact projection returned by `forTurn`.  No registry, snapshot, execution
 * port, or turn bundle is cached here: a different turn context must produce
 * a different, identity-preserving bundle.
 */
export interface AppToolPipelineTurnCompositionV1 {
  readonly projection: BuiltinToolCatalogProjectionV1;
  readonly callbacks: BuiltinRuntimeToolPipelineCallbacksV1;
  readonly governance: RuntimeHostState26ToolGovernancePortV1;
}

/** Stable App-owned seam shared by model, tool, and runtime paths. */
export interface AppToolPipelineCompositionV1 {
  /** The exact frozen projection from which all turn projections derive. */
  readonly baseProjection: BuiltinToolCatalogProjectionV1;
  /**
   * Create one turn-local callback/governance bundle.  `baseProjection.forTurn`
   * is called exactly once for each invocation.
   */
  readonly forTurn: (
    context: Readonly<CapabilityTurnContextV1>,
  ) => AppToolPipelineTurnCompositionV1;
}

/**
 * Compose the App pipeline seam from the already-created Builtin projection.
 * This function creates no registry, snapshot, or capability execution port.
 */
export function createAppToolPipelineCompositionV1(
  baseProjection: BuiltinToolCatalogProjectionV1,
): AppToolPipelineCompositionV1 {
  assertFrozenBuiltinProjectionV1(baseProjection);

  const forTurn = (
    context: Readonly<CapabilityTurnContextV1>,
  ): AppToolPipelineTurnCompositionV1 => {
    const projection = baseProjection.forTurn(context);
    if (!projection || projection === baseProjection) {
      // A turn projection may legitimately share immutable internals, but it
      // must be an actual projection result owned by the Builtin catalog.
      throw new Error('Builtin turn projection was not created from the base catalog.');
    }
    const callbacks = createBuiltinRuntimeToolPipelineCallbacksV1(projection);
    const governance = createRuntimeHostState26ToolGovernanceV1({
      verifyClassifiedIdentity: callbacks.verifyClassifiedIdentity,
    });
    return Object.freeze({ projection, callbacks, governance });
  };

  return Object.freeze({ baseProjection, forTurn });
}

function assertFrozenBuiltinProjectionV1(
  projection: Readonly<BuiltinToolCatalogProjectionV1>,
): void {
  if (
    !Object.isFrozen(projection) ||
    !Object.isFrozen(projection.entries) ||
    !Object.isFrozen(projection.toolSet)
  ) {
    throw new Error('App Tool Pipeline composition requires a frozen Builtin projection.');
  }
}
