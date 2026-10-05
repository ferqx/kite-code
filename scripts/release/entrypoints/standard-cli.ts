import { resolve } from 'node:path';
import { runRegisteredTerminalCLI } from '@kite-ai/cli/host';
import { registeredEntrypoint } from './registered-entry';

if (import.meta.main)
  await registeredEntrypoint(() =>
    runRegisteredTerminalCLI(process.argv.slice(2), resolve(import.meta.dir, '..')),
  );
