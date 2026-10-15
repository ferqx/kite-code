import { readFileSync, writeFileSync } from 'node:fs';
import { runTUIProcess } from '../../host/tui-main';

const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const forceExit = (message: unknown) => {
  if (message !== 'draft-force-exit') return;
  if (!process.emit('SIGTERM')) throw Error('draft host exit handler unavailable');
  process.send?.('draft-force-exit-dispatched');
};
// The Windows-only test channel invokes the existing shutdown handler; it
// does not claim that an external Windows SIGTERM is catchable.
if (process.platform === 'win32') process.on('message', forceExit);
try {
  process.exitCode = await runTUIProcess({
    testDiagnostics: true,
    artifact: input.artifact,
    profile: 'draft',
    argv: ['--workspace', input.workspace, '--thread', 'a', '--data-root', input.dataRoot],
    onLaunched: ({ pid }) => writeFileSync(input.pidPath, String(pid), { mode: 0o600 }),
  });
} finally {
  if (process.platform === 'win32') {
    process.removeListener('message', forceExit);
    process.disconnect?.();
  }
}
