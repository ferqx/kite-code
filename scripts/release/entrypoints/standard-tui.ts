import { resolve } from 'node:path';
import { runRegisteredTerminalTUI } from '@kite-ai/cli/host';
import { registeredEntrypoint } from './registered-entry';

if (import.meta.main)
  await registeredEntrypoint(() =>
    runRegisteredTerminalTUI(process.argv.slice(2), resolve(import.meta.dir, '..')),
  );
