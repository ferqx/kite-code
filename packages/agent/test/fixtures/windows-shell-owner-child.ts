import { join } from 'node:path';
import type { JobContext } from '../../src/extensions';
import { createWindowsShellJob } from '../../src/jobs/windows-shell';
import { windowsShellFixture } from './windows-shell-runtime';

const root = process.argv[2]!;
const assets = await windowsShellFixture();
const powershell = join(
  process.env.SystemRoot!,
  'System32/WindowsPowerShell/v1.0/powershell.exe',
).replaceAll('\\', '/');
const script = `$p=Start-Process -FilePath "${powershell}" -ArgumentList "-NoProfile -NonInteractive -Command Start-Sleep -Seconds 60" -PassThru -NoNewWindow;Write-Output ("PIDS "+$PID+" "+$p.Id);Start-Sleep -Seconds 60`;
const job = createWindowsShellJob({
  cwd: join(root, 'workspace'),
  controlBase: join(root, 'control'),
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  ),
  supervisorPath: assets.runner,
  shellExecutable: assets.shell,
  fullShellExecutable: assets.fullShell,
  coreutilsPath: assets.coreutils,
  stateRoot: assets.stateRoot,
  executionScope: () => ({ filesystem: 'workspace_write', network: 'none' }),
});
const handle = await job.start(
  { command: `'${powershell}' -NoProfile -NonInteractive -Command '${script}'` },
  {
    sessionId: 's',
    executionId: crypto.randomUUID(),
    signal: new AbortController().signal,
  } as JobContext,
);
void (async () => {
  let output = '';
  for await (const event of job.observe(handle)) {
    if (event.type === 'output') {
      output += event.content;
      const match = output.match(/PIDS (\d+) (\d+)/);
      if (match) {
        console.log(JSON.stringify({ pids: match.slice(1).map(Number) }));
        return;
      }
    }
    if (event.type === 'terminal') throw Error(JSON.stringify(event.result));
  }
})();
// Deliberately omit disposal: process exit must close the original Job handle,
// and the OS must stop every nested descendant without a live JS controller.
for await (const _ of Bun.stdin.stream()) {
}
process.exit(0);
