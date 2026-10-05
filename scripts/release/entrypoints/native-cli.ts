import { resolve } from 'node:path';
import { runNativeTerminalCLI } from '@kite-ai/cli/host';
import { registeredEntrypoint } from './registered-entry';

if (import.meta.main)
  await registeredEntrypoint(() =>
    runNativeTerminalCLI(process.argv.slice(2), resolve(import.meta.dir, '../..')),
  );
