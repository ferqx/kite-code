import { expect, test } from 'bun:test';
import { join } from 'node:path';

const fixture = join(import.meta.dir, '..', 'fixtures', 'tui-lifecycle-resource.tsx');

test('runs repeated InputLine focus-listener mount and unmount in one owned child process', async () => {
  const proc = Bun.spawn([process.execPath, fixture], {
    cwd: process.cwd(),
    env: process.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
  expect(stdout).toContain('TUI_LIFECYCLE_COMPLETE');
});
