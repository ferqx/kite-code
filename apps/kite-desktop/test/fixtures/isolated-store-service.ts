#!/usr/bin/env bun
// Test-only writer admission for a private Desktop fixture, never a release entrypoint.
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { runKiteServiceMain } from '../../../kite-service/src/executable';

const root = process.env.KITE_DESKTOP_TEST_ROOT;
if (!root || realpathSync.native(root) !== root) throw new Error('Isolated test root is required.');
const runtime = join(root, 'runtime');
const config = join(root, 'config');
if (
  process.env.KITE_CODE_HOME !== runtime ||
  process.env.KITE_CODE_CONFIG_HOME !== config ||
  process.env.HOME !== join(root, 'home') ||
  realpathSync.native(runtime) !== runtime ||
  realpathSync.native(config) !== config
)
  throw new Error('Desktop test Store escaped its isolated root.');

await runKiteServiceMain(undefined, {
  assertRetiredStoreWritersStopped(databasePath) {
    if (databasePath !== join(runtime, 'kite-session.sqlite'))
      throw new Error('Desktop test Store path changed.');
  },
});
