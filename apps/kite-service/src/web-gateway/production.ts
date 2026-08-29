import type { CoordinatorRequestClient } from '@kite-ai/kite-local-runtime/coordinator';
import { createWebGatewayCarrier, type WebGatewayCarrier } from './carrier';
import { createOfflineWebHistoryPort } from './offline-history';
import type { WebGatewayMainEnvironment } from './process-main';
import { createWorkspaceWorkerWebGatewayUpstream } from './upstream';

export const WEB_GATEWAY_CONTRACT_REVISION_ = 'kite-app-web-observer-v1' as const;

/**
 * Compose the production browser BFF over a narrow Coordinator client and direct read-only
 * Worker bindings. The returned carrier closes both layers and never owns a Worker lifecycle.
 */
export function createProductionWebGatewayCarrier(
  environment: WebGatewayMainEnvironment,
  coordinator: CoordinatorRequestClient,
  requestShutdown: () => void,
): WebGatewayCarrier {
  const upstream = createWorkspaceWorkerWebGatewayUpstream({
    coordinator,
    gatewayInstanceId: environment.instanceId,
    contractRevision: WEB_GATEWAY_CONTRACT_REVISION_,
    offlineHistory: createOfflineWebHistoryPort(environment.home),
  });
  let closePromise: Promise<void> | undefined;
  let carrier: WebGatewayCarrier;
  try {
    carrier = createWebGatewayCarrier({
      staticAssetRoot: environment.staticAssetRoot,
      createObserver: upstream.createObserver,
      instanceId: environment.instanceId,
      nativeControl: {
        credential: environment.controlCredential,
        buildId: environment.buildId,
        requestStop: requestShutdown,
      },
    });
  } catch (error) {
    void upstream.close().catch(() => undefined);
    throw error;
  }
  return Object.freeze({
    get origin() {
      return carrier.origin;
    },
    get launchUrl() {
      return carrier.launchUrl;
    },
    mintLaunchUrl: () => carrier.mintLaunchUrl(),
    close() {
      closePromise ??= closeAll(carrier, upstream);
      return closePromise;
    },
    [Symbol.asyncDispose]() {
      return this.close();
    },
  });
}

async function closeAll(
  carrier: WebGatewayCarrier,
  upstream: { readonly close: () => Promise<void> },
): Promise<void> {
  const results = await Promise.allSettled([carrier.close(), upstream.close()]);
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures);
}
