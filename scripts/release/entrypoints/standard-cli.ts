import { resolve } from 'node:path';
import { runRegisteredTerminalCLI } from '@kite-ai/cli/host';
import { registeredEntrypoint } from './registered-entry';

if (Reflect.get(import.meta, 'main') === true)
  await registeredEntrypoint(() =>
    runRegisteredTerminalCLI(process.argv.slice(2), resolve(import.meta.dirname, '..')),
  );
