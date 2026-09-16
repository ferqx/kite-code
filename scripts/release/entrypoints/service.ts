#!/usr/bin/env bun

import { encodeServiceStartupDiagnostic } from '@kite-ai/kite-local-runtime/startup-diagnostic';
import { runKiteServiceMain } from '../../../apps/kite-service/src/executable';

await runKiteServiceMain().catch((error: unknown) => {
  process.stderr.write(encodeServiceStartupDiagnostic(error) ?? '[kite-service] service failed\n');
  process.exitCode = 1;
});
