import { rejectRetiredEntrypoint } from '../../../scripts/development/retired-entrypoints.ts';

export let runCli: typeof import('./cli/executable').runCli;
export let runTui: typeof import('./tui/executable').runTui;

if (import.meta.main) rejectRetiredEntrypoint('terminal');
else {
  const cli = await import('./cli/executable.ts');
  const tui = await import('./tui/executable.tsx');
  runCli = cli.runCli;
  runTui = tui.runTui;
}
