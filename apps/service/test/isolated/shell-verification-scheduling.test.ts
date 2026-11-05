import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';

test.skipIf(process.platform !== 'win32')(
  'Windows asset verification permits another Session to stop and a third to execute, and awaits its cancelled read before releasing',
  async () => {
    const root = temporaryDirectory('kite-service-verification-');
    const fixture = fileURLToPath(
      new URL('../fixtures/shell-verification-scheduling.ts', import.meta.url),
    );
    const child = Bun.spawn([process.execPath, fixture, root], {
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
      timeout: 45000,
    });
    try {
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
      expect(stdout.trim()).toBe('cross_session_verification_scheduling_passed');
    } finally {
      child.kill();
      await child.exited;
      removeTemporaryDirectory(root);
    }
  },
  50000,
);
