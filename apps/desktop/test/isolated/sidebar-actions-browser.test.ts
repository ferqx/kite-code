import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

test('sidebar reveal stays independent of button disabled styles in the production browser build', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, '../session-shell-browser-runner.fixture.ts'),
      '--sidebar-actions',
      ...(existsSync(chromium.executablePath()) ? ['--bundled-chromium'] : []),
    ],
    {
      cwd: resolve(import.meta.dir, '../../../..'),
      // Bun tests set NODE_ENV=test; this child builds the actual production React runtime.
      env: { ...process.env, NODE_ENV: 'production' },
      stdout: 'pipe',
      stderr: 'pipe',
      signal: AbortSignal.timeout(150_000),
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
  expect(stdout).toContain('"sidebarActionCases":2');
}, 160_000);
