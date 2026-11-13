import { join } from 'node:path';
import { expect, test } from '#kite-test';
import { spawnSync as runFixtureProcess } from '../../../scripts/tooling/process';
import { testNodeCommand } from '../../../scripts/tooling/test-command';

const root = join(import.meta.dirname, '../../..');

test('passes recursive current links and map validation', () => {
  const result = runFixtureProcess(testNodeCommand('scripts/check-docs.ts'), {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});
