import { expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  terminateOwnedProcessTree,
  verifiedOwnedProcessGroupId,
  waitForPtyExitCode,
} from './pty-process';

const fixture = join(import.meta.dir, '..', 'fixtures', 'tui-lifecycle-resource.tsx');

test('runs repeated InputLine focus-listener mount and unmount in one owned child process', async () => {
  const proc = Bun.spawn([process.execPath, fixture], {
    cwd: process.cwd(),
    env: process.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: process.platform !== 'win32',
  });
  const processGroupId = verifiedOwnedProcessGroupId(proc.pid);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      waitForPtyExitCode(proc.exited, 5_000),
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain('TUI_LIFECYCLE_COMPLETE');
  } finally {
    await terminateOwnedProcessTree(proc, processGroupId).catch(() => {});
  }
});
