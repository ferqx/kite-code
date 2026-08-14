import { expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  terminateOwnedProcessTree,
  verifiedOwnedProcessGroupId,
  waitForPtyExitCode,
} from './pty-process';

const fixture = join(import.meta.dir, '..', 'fixtures', 'tui-lifecycle-resource.tsx');

test('runs repeated InputLine focus-reporting mount and unmount in one owned child process', async () => {
  const inheritsFaultSoakProcessGroup = Boolean(process.env.KITE_FAULT_SOAK_PROCESS_NONCE);
  const proc = Bun.spawn([process.execPath, fixture], {
    cwd: process.cwd(),
    env: process.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: process.platform !== 'win32' && !inheritsFaultSoakProcessGroup,
  });
  const processGroupId =
    process.platform !== 'win32' && !inheritsFaultSoakProcessGroup
      ? verifiedOwnedProcessGroupId(proc.pid)
      : undefined;
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      waitForPtyExitCode(proc.exited, 5_000),
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain('TUI_LIFECYCLE_COMPLETE');
  } finally {
    if (process.platform === 'win32' || processGroupId !== undefined) {
      await terminateOwnedProcessTree(proc, processGroupId).catch(() => {});
    } else if (proc.exitCode === null) {
      proc.kill('SIGKILL');
      await proc.exited.catch(() => {});
    }
  }
});
