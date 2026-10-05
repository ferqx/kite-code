import { appendFileSync } from 'node:fs';
import { runTUIHost } from '../../host/tui';

const settings = JSON.parse(process.env.TUI_PREFERENCES_SETTINGS!) as {
  root: string;
  dataRoot: string;
  workspace: string;
  artifact?: Parameters<typeof runTUIHost>[0]['artifact'];
  server?: string;
};
const exit = new AbortController();
process.once('SIGTERM', () => exit.abort());
await runTUIHost({
  exitSignal: exit.signal,
  onLaunched: ({ pid }) => appendFileSync(`${settings.root}/owned-pid`, `${pid}\n`),
  ...(settings.artifact ? { artifact: settings.artifact } : { server: settings.server }),
  dataRoot: settings.dataRoot,
  profile: 'development',
  thread: 'a',
  cwd: settings.workspace,
});
