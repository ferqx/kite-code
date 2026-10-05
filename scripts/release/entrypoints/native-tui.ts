import { resolve } from 'node:path';
import { runNativeTerminalTUI } from '@kite-ai/cli/host';
import { registeredEntrypoint } from './registered-entry';

if (import.meta.main)
  await registeredEntrypoint(() =>
    runNativeTerminalTUI(process.argv.slice(2), resolve(import.meta.dir, '../..')),
  );
