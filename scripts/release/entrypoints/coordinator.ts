#!/usr/bin/env bun

import { runKiteCoordinatorMain } from '../../../apps/kite-service/src/coordinator/main';
import { createProductionKiteCoordinatorComposition } from '../../../apps/kite-service/src/coordinator/production';

/**
 * Managed Coordinator companion entrypoint. The factory consumes only manager-owned explicit
 * environment and composes the control plane without importing any Browser or Runtime data.
 */
await runKiteCoordinatorMain(process.argv.slice(2), {
  environment: process.env,
  createComposition: createProductionKiteCoordinatorComposition,
});
