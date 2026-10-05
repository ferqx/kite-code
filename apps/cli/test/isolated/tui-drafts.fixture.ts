import { readFileSync, writeFileSync } from 'node:fs';
import { runTUIProcess } from '../../host/tui-main';

const input = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
process.exitCode = await runTUIProcess({
  artifact: input.artifact,
  profile: 'draft',
  argv: ['--workspace', input.workspace, '--thread', 'a', '--data-root', input.dataRoot],
  onLaunched: ({ pid }) => writeFileSync(input.pidPath, String(pid), { mode: 0o600 }),
});
