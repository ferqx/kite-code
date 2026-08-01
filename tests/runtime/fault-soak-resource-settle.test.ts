import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { settleSameProcessResourceSample } from './harness/fault-soak-resource-settle';

async function runRepeatCountFixture(repeated: boolean): Promise<void> {
  const fixture = resolve('tests/runtime/harness/fault-soak-repeat-count.fixture.ts');
  const proc = Bun.spawn(
    [
      process.execPath,
      'scripts/runtime/run-fault-soak-test-case.ts',
      '--preload',
      'tests/runtime/harness/fault-soak-telemetry-preload.ts',
      '--repeat-count',
      '2',
      ...(repeated ? ['--repeat-file', 'fault-soak-repeat-count.fixture.ts'] : []),
      '--',
      fixture,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        KITE_FAULT_SOAK_REPEAT_COUNT: '9',
        KITE_FAULT_SOAK_EXPECTED_REPEAT_COUNT: repeated ? '2' : '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(`${stdout}\n${stderr}`).not.toContain('(fail)');
  expect(exitCode).toBe(0);
}

describe('fault-soak resource sample settling', () => {
  test('leaves fresh-process diagnostic samples untouched', async () => {
    const calls: string[] = [];
    await settleSameProcessResourceSample(1, {
      collectGarbage: () => calls.push('gc'),
      yieldTurn: async () => {
        calls.push('yield');
      },
    });
    expect(calls).toEqual([]);
  });

  test('collects around a finalizer turn before same-process sampling', async () => {
    const calls: string[] = [];
    await settleSameProcessResourceSample(9, {
      collectGarbage: () => calls.push('gc'),
      yieldTurn: async () => {
        calls.push('yield');
      },
    });
    expect(calls).toEqual(['yield', 'gc', 'yield', 'gc', 'yield']);
  });

  test('fails closed when forced collection fails', async () => {
    await expect(
      settleSameProcessResourceSample(9, {
        collectGarbage: () => {
          throw new Error('forced collection failed');
        },
        yieldTurn: async () => {},
      }),
    ).rejects.toThrow('forced collection failed');
  });

  test('passes the selected file repeat count explicitly to each child', async () => {
    await runRepeatCountFixture(true);
    await runRepeatCountFixture(false);
  });
});
