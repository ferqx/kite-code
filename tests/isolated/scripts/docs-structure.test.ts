import { expect, test } from 'bun:test';
import { join } from 'node:path';

const root = join(import.meta.dir, '../../..');

test('passes recursive current links and map validation', () => {
  const result = Bun.spawnSync(['bun', 'run', 'scripts/check-docs.ts'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});
