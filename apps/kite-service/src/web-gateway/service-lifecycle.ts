import {
  inspectWebGatewayStaticAssets,
  type WebGatewayStaticAssetIdentity,
  WebGatewayStaticAssetsError,
} from './static-assets';

export type SingleServiceWebState = 'absent' | 'ready';

export type SingleServiceWebDiagnostic =
  | 'web_assets_missing'
  | 'web_readiness_failed'
  | 'web_stop_failed';

export interface SingleServiceWebRouteOwner {
  readonly origin: string;
  /** Close Browser sockets/routes only. */
  close(): Promise<void> | void;
}

export type SingleServiceWebEnsureResult =
  | {
      readonly outcome: 'ready';
      readonly state: 'ready';
      readonly origin: string;
      readonly launchUrl: string;
      readonly assetDigest: string;
    }
  | {
      readonly outcome: 'unavailable';
      readonly state: SingleServiceWebState;
      readonly diagnostic: SingleServiceWebDiagnostic;
    };

export interface SingleServiceWebStopResult {
  readonly outcome: 'applied' | 'noop' | 'unavailable';
  readonly state: SingleServiceWebState;
  readonly diagnostic?: 'web_stop_failed';
}

export type SingleServiceWebStatusResult =
  | { readonly outcome: 'ready'; readonly state: 'absent' }
  | {
      readonly outcome: 'ready';
      readonly state: 'ready';
      readonly origin: string;
      readonly assetDigest: string;
    };

export interface SingleServiceWebLifecycleOptions {
  /**
   * Attach Browser-only routes to the Service-owned HTTP listener. This factory must not create a
   * process, listener, descriptor, token file, launch intent, or durable state.
   */
  readonly createRouteOwner: (
    assets: WebGatewayStaticAssetIdentity,
  ) => SingleServiceWebRouteOwner | Promise<SingleServiceWebRouteOwner>;
  /** Test seam; production uses the strict fixed-surface asset inspector. */
  readonly inspectAssets?: (root: string) => WebGatewayStaticAssetIdentity;
}

export interface SingleServiceWebLifecycle extends AsyncDisposable {
  readonly state: SingleServiceWebState;
  readonly assetIdentity: WebGatewayStaticAssetIdentity | undefined;
  ensure(staticAssetRoot: string): Promise<SingleServiceWebEnsureResult>;
  status(): Promise<SingleServiceWebStatusResult>;
  stop(): Promise<SingleServiceWebStopResult>;
}

interface ActiveWebRoutes {
  readonly assets: WebGatewayStaticAssetIdentity;
  readonly owner: SingleServiceWebRouteOwner;
}

/**
 * Service-owned, in-memory Browser lifecycle. Operations are serialized so concurrent `kite web`
 * calls reuse one route owner and return its stable loopback URL. Asset validation runs before
 * any route/auth state is created; a failure therefore leaves the current Browser state unchanged.
 */
export function createSingleServiceWebLifecycle(
  options: SingleServiceWebLifecycleOptions,
): SingleServiceWebLifecycle {
  const inspectAssets = options.inspectAssets ?? inspectWebGatewayStaticAssets;
  let active: ActiveWebRoutes | undefined;
  let tail = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const lifecycle: SingleServiceWebLifecycle = {
    get state() {
      return active === undefined ? 'absent' : 'ready';
    },
    get assetIdentity() {
      return active?.assets;
    },
    ensure: (staticAssetRoot) =>
      serialize(async () => {
        let assets: WebGatewayStaticAssetIdentity;
        try {
          assets = inspectAssets(staticAssetRoot);
        } catch (error) {
          if (!(error instanceof WebGatewayStaticAssetsError)) throw error;
          return unavailable(active, 'web_assets_missing');
        }

        if (active && sameAssets(active.assets, assets)) {
          return ready(active);
        }

        if (active) {
          try {
            await active.owner.close();
            active = undefined;
          } catch {
            return unavailable(active, 'web_stop_failed');
          }
        }

        let owner: SingleServiceWebRouteOwner;
        try {
          owner = await options.createRouteOwner(assets);
        } catch {
          return unavailable(active, 'web_readiness_failed');
        }
        try {
          active = Object.freeze({ assets, owner });
          return ready(active);
        } catch {
          try {
            await owner.close();
            return unavailable(active, 'web_readiness_failed');
          } catch {
            active = Object.freeze({ assets, owner });
            return unavailable(active, 'web_stop_failed');
          }
        }
      }),
    status: () =>
      serialize(async () => {
        if (!active) return Object.freeze({ outcome: 'ready', state: 'absent' });
        return Object.freeze({
          outcome: 'ready',
          state: 'ready',
          origin: active.owner.origin,
          assetDigest: active.assets.digest,
        });
      }),
    stop: () =>
      serialize(async () => {
        if (!active) return Object.freeze({ outcome: 'noop', state: 'absent' });
        try {
          await active.owner.close();
          active = undefined;
          return Object.freeze({ outcome: 'applied', state: 'absent' });
        } catch {
          return Object.freeze({
            outcome: 'unavailable',
            state: 'ready',
            diagnostic: 'web_stop_failed',
          });
        }
      }),
    [Symbol.asyncDispose]: async () => {
      const result = await lifecycle.stop();
      if (result.outcome === 'unavailable') {
        throw new Error('Single-Service Web routes could not be closed.');
      }
    },
  };
  return Object.freeze(lifecycle);
}

function sameAssets(
  left: WebGatewayStaticAssetIdentity,
  right: WebGatewayStaticAssetIdentity,
): boolean {
  return left.root === right.root && left.digest === right.digest;
}

function ready(active: ActiveWebRoutes): SingleServiceWebEnsureResult {
  return Object.freeze({
    outcome: 'ready',
    state: 'ready',
    origin: active.owner.origin,
    launchUrl: active.owner.origin,
    assetDigest: active.assets.digest,
  });
}

function unavailable(
  active: ActiveWebRoutes | undefined,
  diagnostic: SingleServiceWebDiagnostic,
): SingleServiceWebEnsureResult {
  return Object.freeze({
    outcome: 'unavailable',
    state: active === undefined ? 'absent' : 'ready',
    diagnostic,
  });
}
