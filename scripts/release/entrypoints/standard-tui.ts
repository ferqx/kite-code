import { resolve } from 'node:path';
import { runRegisteredTerminalTUI } from '@kite-ai/cli/host';
import { registeredEntrypoint } from './registered-entry';

if (Reflect.get(import.meta, 'main') === true)
  await registeredEntrypoint(() =>
    runRegisteredTerminalTUI(process.argv.slice(2), resolve(import.meta.dirname, '..')),
  );
