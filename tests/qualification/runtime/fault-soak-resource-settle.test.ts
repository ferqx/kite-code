import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, test } from '#kite-test';
import { spawn as spawnFixtureProcess } from '../../../scripts/tooling/process';
import { testRuntimeFlags } from '../../../scripts/tooling/test-command';
import { settleSameProcessResourceSample } from './harness/fault-soak-resource-settle';

async function runRepeatCountFixture(mode: 'single' | 'repeated' | 'prewarmed'): Promise<void> {
  const fixture = resolve('tests/qualification/runtime/harness/fault-soak-repeat-count.fixture.ts');
  const root = mkdtempSync(join(tmpdir(), 'kite-test-fault-soak-repeat-'));
  const telemetry = join(root, 'samples.jsonl');
  const expectedCount = mode === 'single' ? 1 : mode === 'prewarmed' ? 4 : 2;
  try {
    const proc = spawnFixtureProcess(
      [
        process.execPath,
        ...testRuntimeFlags,
        'scripts/runtime/run-fault-soak-test-case.ts',
        '--preload',
        'tests/qualification/runtime/harness/fault-soak-telemetry-preload.ts',
        '--repeat-count',
        '2',
        ...(mode === 'single' ? [] : ['--repeat-file', 'fault-soak-repeat-count.fixture.ts']),
        ...(mode === 'prewarmed'
          ? ['--prewarm-count', '2', '--prewarm-file', 'fault-soak-repeat-count.fixture.ts']
          : []),
        '--',
        fixture,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          KITE_FAULT_SOAK_REPEAT_COUNT: '9',
          KITE_FAULT_SOAK_EXPECTED_REPEAT_COUNT: String(expectedCount),
          KITE_FAULT_SOAK_TELEMETRY_FILE: telemetry,
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
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    const records = readFileSync(telemetry, 'utf8')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as { pid: number; sequence: number; lifecycleGroupNonce: string },
      );
    expect(records.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: expectedCount }, (_, index) => index + 1),
    );
    expect(new Set(records.map(({ pid }) => pid)).size).toBe(1);
    expect(new Set(records.map(({ lifecycleGroupNonce }) => lifecycleGroupNonce)).size).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    await runRepeatCountFixture('repeated');
    await runRepeatCountFixture('prewarmed');
    await runRepeatCountFixture('single');
  });
});
