#!/usr/bin/env bun

import { runWorkspaceWorkerMain } from '../../../apps/kite-service/src/workspace-worker/process-main';
import { createProductionWorkspaceWorkerRuntime } from '../../../apps/kite-service/src/workspace-worker/production';

/**
 * Managed Workspace Worker companion entrypoint. Runtime/Application composition is an explicit
 * production dependency and is deliberately not replaced with an empty implementation here.
 */
await runWorkspaceWorkerMain(process.argv.slice(2), {
  environment: process.env,
  createRuntime: createProductionWorkspaceWorkerRuntime,
});
