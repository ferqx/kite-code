import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const native = process.platform === 'win32' ? test : test.skip;
for (const mode of [
  'normal',
  'nonzero',
  'spawn-failure',
  'event-error',
  'stdout-limit',
  'stderr-limit',
  'abort',
  'close-abort',
  'timeout',
  'unknown',
  'replace',
  'cleanup-failure',
]) {
  native(
    `Windows Office ordinary FD lifecycle: ${mode}`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'kite-office-fd-test-'));
      const temp = join(root, 'temp');
      mkdirSync(temp);
      try {
        const child = Bun.spawn(
          [process.execPath, join(import.meta.dir, 'windows-process.fixture.ts'), mode],
          {
            env: { ...process.env, TEMP: temp, TMP: temp },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
        expect(JSON.parse(stdout).passed).toBe(true);
      } finally {
        // Only this fixture's private tree, after its child has exited.
        rmSync(root, { recursive: true, force: true });
      }
    },
    10000,
  );
}
