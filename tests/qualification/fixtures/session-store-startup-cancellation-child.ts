#!/usr/bin/env bun
// Test-only Service entrypoint. Its HOME is a fresh private fixture owned by the parent test.
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeServiceStartupDiagnostic } from '@kite-ai/kite-local-runtime/startup-diagnostic';
import { runKiteAppServerMain } from '../../../apps/kite-service/src/app-server';

const home = process.env.KITE_QUALIFICATION_HOME;
const scenario = process.env.KITE_QUALIFICATION_SCENARIO;
if (!home || realpathSync.native(home) !== home || !scenario)
  throw new Error('A private qualification HOME and scenario are required.');
const runtimeRoot = join(home, '.kite-code');
const databasePath = join(runtimeRoot, 'kite-session.sqlite');
const marker = (name: string): string => join(home, name);

await runKiteAppServerMain(['app-server', 'run-stdio'], {
  environment: {
    HOME: home,
    USERPROFILE: home,
    KITE_CODE_HOME: runtimeRoot,
    KITE_CODE_CONFIG_HOME: runtimeRoot,
    KITE_APP_SERVER_BUILD_ID: 'qualification-startup-cancellation',
  },
  assertRetiredStoreWritersStopped(path) {
    if (path !== databasePath) throw new Error('Qualification Store escaped its private HOME.');
  },
  onStoreStartupProgress(stage) {
    if (
      stage === 'publishing' &&
      (scenario === 'publishing-signal' || scenario === 'pending-publishing-signal')
    ) {
      writeFileSync(marker('publishing'), 'reached', { mode: 0o600 });
      process.kill(process.pid, 'SIGTERM');
    }
    if (stage === 'ready' && scenario === 'current-ready')
      writeFileSync(marker('ready'), 'reached', { mode: 0o600 });
  },
  async beforeStorePublication() {
    if (scenario !== 'gate-cancel') return 'commit';
    writeFileSync(marker('gate-ready'), 'reached', { mode: 0o600 });
    while (!existsSync(marker('gate-release'))) await Bun.sleep(10);
    return 'commit';
  },
}).catch((error: unknown) => {
  process.stderr.write(encodeServiceStartupDiagnostic(error) ?? '[kite-service] service failed\n');
  process.exitCode = 1;
});
