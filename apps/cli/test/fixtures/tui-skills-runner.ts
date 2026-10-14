import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTUIHost } from '../../host/tui';

const settings = JSON.parse(process.env.TUI_SKILLS_SETTINGS!) as {
  root: string;
  dataRoot: string;
  workspace: string;
  artifact?: Parameters<typeof runTUIHost>[0]['artifact'];
  server?: string;
  control: string;
};
const actual = globalThis.fetch;
let starts = 0;
globalThis.fetch = Object.assign(
  async (...args: Parameters<typeof fetch>) => {
    const response = await actual(...args);
    const url = new URL(String(args[0]));
    if (url.pathname.includes('/skills')) {
      const value = await response.clone().json();
      appendFileSync(
        join(settings.root, 'catalogue-reads'),
        `${JSON.stringify({ url: url.pathname, query: url.search, value })}\n`,
      );
      if (!url.searchParams.has('afterId') && ++starts === 2) {
        writeFileSync(join(settings.root, 'held-page'), 'held');
        await actual(`${settings.control}held-page`);
      }
    }
    return response;
  },
  { preconnect: actual.preconnect },
);
const exit = new AbortController();
process.once('SIGTERM', () => exit.abort());
await runTUIHost({
  testDiagnostics: true,
  exitSignal: exit.signal,
  onLaunched: ({ pid }) => writeFileSync(join(settings.root, 'owned-pid'), String(pid)),
  ...(settings.artifact ? { artifact: settings.artifact } : { server: settings.server }),
  dataRoot: settings.dataRoot,
  profile: 'development',
  thread: 'a',
  cwd: settings.workspace,
});
