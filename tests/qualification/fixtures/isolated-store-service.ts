#!/usr/bin/env bun
// Test-only admission: the parent test creates a fresh private HOME and is its only writer.
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { runKiteServiceMain } from '../../../apps/kite-service/src/executable';

const home = process.env.KITE_QUALIFICATION_HOME;
if (!home || realpathSync.native(home) !== home)
  throw new Error('An isolated qualification HOME is required.');
await runKiteServiceMain(undefined, {
  assertRetiredStoreWritersStopped(databasePath) {
    if (databasePath !== join(home, '.kite-code', 'kite-session.sqlite'))
      throw new Error('Qualification Store escaped the isolated HOME.');
  },
}).catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({ category: error instanceof Error ? error.name : 'unknown' }),
  );
  process.exitCode = 1;
});
