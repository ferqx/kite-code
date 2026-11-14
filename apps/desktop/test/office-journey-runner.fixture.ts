/** Explicit opt-in: builds and runs a fresh synthetic full-client journey, without user credentials. */
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform === 'win32') throw Error('office_journey_requires_posix_shell');
const repo = resolve(import.meta.dir, '../../..');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-office-e2e-')));
console.log(`Office E2E evidence (retained on success and failure): ${root}`);
const env = { ...process.env, KITE_OFFICE_PRODUCT_FIXTURE_DIRECTORY: root };
for (const args of [
  ['run', 'build'],
  ['run', 'apps/desktop/test/office-basics-product-electron.fixture.ts', '--prepare', '--e2e'],
  ['run', 'apps/desktop/test/office-basics-product-electron.fixture.ts', '--run', '--e2e'],
]) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: repo,
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await child.exited;
  if (code) {
    process.exitCode = code;
    break;
  }
}
