import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { runTUIProcess } from '../../host/tui-main';

const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const stopPath = process.argv[3];
const checkStop =
  process.platform === 'win32' && stopPath
    ? setInterval(() => {
        if (!existsSync(stopPath)) return;
        clearInterval(checkStop);
        if (readFileSync(stopPath, 'utf8') !== 'draft-force-exit' || !process.emit('SIGTERM'))
          throw Error('draft host exit handler unavailable');
        writeFileSync(`${stopPath}.ack`, 'draft-force-exit-dispatched', {
          mode: 0o600,
          flag: 'wx',
        });
      }, 20)
    : undefined;
try {
  process.exitCode = await runTUIProcess({
    testDiagnostics: true,
    artifact: input.artifact,
    profile: 'draft',
    argv: ['--workspace', input.workspace, '--thread', 'a', '--data-root', input.dataRoot],
    onLaunched: ({ pid }) => writeFileSync(input.pidPath, String(pid), { mode: 0o600 }),
  });
} finally {
  clearInterval(checkStop);
}
