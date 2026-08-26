import {
  type BuiltinRuntimeToolPipelineCallbacks,
  type BuiltinToolCatalogProjection,
  createBuiltinRuntimeToolPipelineCallbacks,
} from '@kite-ai/builtin-runtime';
import {
  createRuntimeHostStateToolGovernance,
  type RuntimeHostStateToolGovernancePort,
} from '@kite-ai/runtime-host/kernel-adapter';
import type { CapabilityTurnContext } from '@kite-ai/runtime-spi';

/**
 * The per-turn App projection of the one frozen Builtin catalog.
 *
 * The callbacks and Host governance port are intentionally built from the
 * exact projection returned by `forTurn`.  No registry, snapshot, execution
 * port, or turn bundle is cached here: a different turn context must produce
 * a different, identity-preserving bundle.
 */
export interface AppToolPipelineTurnComposition {
  readonly projection: BuiltinToolCatalogProjection;
  readonly callbacks: BuiltinRuntimeToolPipelineCallbacks;
  readonly governance: RuntimeHostStateToolGovernancePort;
}

/** Stable App-owned seam shared by model, tool, and runtime paths. */
export interface AppToolPipelineComposition {
  /** The exact frozen projection from which all turn projections derive. */
  readonly baseProjection: BuiltinToolCatalogProjection;
  /**
   * Create one turn-local callback/governance bundle.  `baseProjection.forTurn`
   * is called exactly once for each invocation.
   */
  readonly forTurn: (context: Readonly<CapabilityTurnContext>) => AppToolPipelineTurnComposition;
}

/**
 * Compose the App pipeline seam from the already-created Builtin projection.
 * This function creates no registry, snapshot, or capability execution port.
 */
export function createAppToolPipelineComposition(
  baseProjection: BuiltinToolCatalogProjection,
): AppToolPipelineComposition {
  assertFrozenBuiltinProjection(baseProjection);

  const forTurn = (context: Readonly<CapabilityTurnContext>): AppToolPipelineTurnComposition => {
    const projection = baseProjection.forTurn(context);
    if (!projection || projection === baseProjection) {
      // A turn projection may legitimately share immutable internals, but it
      // must be an actual projection result owned by the Builtin catalog.
      throw new Error('Builtin turn projection was not created from the base catalog.');
    }
    const callbacks = createBuiltinRuntimeToolPipelineCallbacks(projection);
    const governance = createRuntimeHostStateToolGovernance({
      verifyClassifiedIdentity: callbacks.verifyClassifiedIdentity,
    });
    return Object.freeze({ projection, callbacks, governance });
  };

  return Object.freeze({ baseProjection, forTurn });
}

function assertFrozenBuiltinProjection(projection: Readonly<BuiltinToolCatalogProjection>): void {
  if (
    !Object.isFrozen(projection) ||
    !Object.isFrozen(projection.entries) ||
    !Object.isFrozen(projection.toolSet)
  ) {
    throw new Error('App Tool Pipeline composition requires a frozen Builtin projection.');
  }
}
