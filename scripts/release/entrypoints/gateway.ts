#!/usr/bin/env bun

import { runWebGatewayMain } from '../../../apps/kite-service/src/web-gateway/process-main';
import { createProductionWebGatewayCarrier } from '../../../apps/kite-service/src/web-gateway/production';
import { createManagedLocalCoordinatorClientComposition } from '../local-coordinator-client';

/**
 * Managed Web Gateway companion entrypoint. Carrier/Observer composition must be supplied by
 * the production owner; absent that factory, the exact main fails closed.
 */
await runWebGatewayMain(process.argv.slice(2), {
  environment: process.env,
  createCarrier: (environment, requestShutdown) => {
    const coordinator = createManagedLocalCoordinatorClientComposition({
      argv: ['kite-web-gateway', '--kite-home', environment.home],
      executableMode: process.env.KITE_STANDALONE_EXECUTABLE === '1' ? 'installed' : 'source',
    });
    return createProductionWebGatewayCarrier(environment, coordinator.client, requestShutdown);
  },
});
