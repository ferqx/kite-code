import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  collectTestFiles,
  partitionTestFiles,
  shardTestFiles,
  testParallelism,
} from '../../../scripts/test-suite';

const repoRoot = join(import.meta.dir, '..', '..', '..');

describe('test discovery boundaries V2', () => {
  test('keeps every root test in an explicit suite', () => {
    const allowed = new Set([
      'integration',
      'isolated',
      'qualification',
      'tui-system',
      'e2e',
      'release',
      'golden',
    ]);
    const paths = collectTestFiles(join(repoRoot, 'tests')).map((path) =>
      relative(join(repoRoot, 'tests'), path).replaceAll('\\', '/'),
    );
    expect(paths.filter((path) => !allowed.has(path.split('/')[0]!))).toEqual([]);
    expect(readdirSync(join(repoRoot, 'tests', 'runtime'), { withFileTypes: true })).toEqual([]);
  });

  test('partitions process-global files away from parallel-safe tests', () => {
    const files = [
      join(repoRoot, 'tests', 'integration', 'freeze.test.ts'),
      join(repoRoot, 'tests', 'isolated', 'shell-exec.test.ts'),
    ];
    const partition = partitionTestFiles(files);
    expect(partition.parallel).toEqual([files[0]!]);
    expect(partition.isolated).toEqual([files[1]!]);
    expect(testParallelism()).toBeGreaterThanOrEqual(1);
    expect(testParallelism()).toBeLessThanOrEqual(4);
  });

  test('keeps live sources out of default Bun test discovery', () => {
    const liveFiles = collectTestFiles(join(repoRoot, 'tests', 'e2e', 'live'));
    expect(liveFiles).toEqual([]);
    const liveCode = readdirSync(join(repoRoot, 'tests', 'e2e', 'live'), {
      recursive: true,
    }).filter((path) => String(path).endsWith('.live.ts'));
    expect(liveCode.length).toBeGreaterThan(0);
  });

  test('distributes parallel-safe files across bounded stable process shards', () => {
    const files = collectTestFiles(join(repoRoot, 'packages', 'agent-kernel', 'test')).slice(0, 9);
    const shards = shardTestFiles(files, 4);
    expect(shards).toHaveLength(4);
    expect(shards.flat().sort()).toEqual(files.sort());
    expect(shardTestFiles(files, 99).length).toBe(files.length);
  });

  test('preserves stable top-level commands while replacing the old ignore runner', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const runner = readFileSync(join(repoRoot, 'scripts', 'run-default-tests.ts'), 'utf8');
    expect(pkg.scripts.test).toBe('bun run scripts/run-default-tests.ts');
    expect(pkg.scripts['test:all']).toBe('bun run test && bun run test:tui:system');
    expect(pkg.scripts['test:runtime:fault']).toContain('tests/qualification/runtime/');
    expect(pkg.scripts['test:sandbox:smoke:native']).toContain('tests/qualification/');
    expect(runner).not.toContain('PROCESS_ISOLATED_TEST_FILES');
    expect(runner).not.toContain('path-ignore-patterns');
    expect(runner).toContain('testParallelism');
  });
});
