import { rejectRetiredEntrypoint } from '../../../scripts/development/retired-entrypoints';

export let runCli: typeof import('./cli/executable').runCli;
export let runTui: typeof import('./tui/executable').runTui;

if (import.meta.main) rejectRetiredEntrypoint('terminal');
else {
  const cli = require('./cli/executable');
  const tui = require('./tui/executable');
  runCli = cli.runCli;
  runTui = tui.runTui;
}
