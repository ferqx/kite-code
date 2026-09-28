import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { analyzeTestOwnership } from '../../../scripts/check-test-ownership';
import { planSuiteTests, planTestSuites } from '../../../scripts/test-plan';
import {
  collectTestFiles,
  partitionTestFiles,
  shardTestFiles,
  testParallelism,
} from '../../../scripts/test-suite';

const repoRoot = join(import.meta.dir, '..', '..', '..');

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'kite-test-plan-'));
  mkdirSync(join(root, 'tests', 'integration'), { recursive: true });
  return root;
}

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
    expect(existsSync(join(repoRoot, 'tests', 'runtime'))).toBe(false);
  });

  test('partitions process-global files away from parallel-safe tests', () => {
    const files = [
      join(repoRoot, 'tests', 'integration', 'freeze.test.ts'),
      join(repoRoot, 'tests', 'isolated', 'scripts', 'test-suite-runner.test.ts'),
      join(repoRoot, 'tests', 'isolated', 'exclusive', 'shell-exec.test.ts'),
    ];
    const partition = partitionTestFiles(files);
    expect(partition.parallel).toEqual([files[0]!]);
    expect(partition.isolated).toEqual([files[1]!]);
    expect(partition.exclusive).toEqual([files[2]!]);
    expect(testParallelism()).toBeGreaterThanOrEqual(1);
    expect(testParallelism()).toBeLessThanOrEqual(4);
    if (process.platform === 'linux') expect(testParallelism()).toBeLessThanOrEqual(2);
  });

  test('plans each file once and only shards suites with at least 16 ordinary files', () => {
    const root = fixture();
    try {
      const suite = join(root, 'tests', 'integration');
      const parallel = Array.from({ length: 16 }, (_, index) => {
        const file = join(suite, `ordinary-${index}.test.ts`);
        writeFileSync(file, 'export {};\n');
        return file;
      });
      const isolated = join(root, 'tests', 'isolated', 'separate.test.ts');
      const exclusive = join(root, 'tests', 'isolated', 'exclusive', 'serial.test.ts');
      const implicitExclusive = join(suite, 'process.test.ts');
      mkdirSync(join(root, 'tests', 'isolated', 'exclusive'), { recursive: true });
      writeFileSync(isolated, 'export {};\n');
      writeFileSync(exclusive, 'export {};\n');
      writeFileSync(implicitExclusive, "Bun.spawn(['true']);\n");
      const integration = planSuiteTests(root, 'tests/integration', 4);
      const isolation = planSuiteTests(root, 'tests/isolated', 4);
      const planned = [
        ...integration.concurrent,
        ...integration.exclusive,
        ...isolation.concurrent,
        ...isolation.exclusive,
      ].flatMap((job) => job.files);
      expect(planned.sort()).toEqual([...parallel, isolated, exclusive, implicitExclusive].sort());
      expect(new Set(planned).size).toBe(planned.length);
      expect(integration.concurrent).toHaveLength(4);
      expect(integration.counts).toEqual({ parallel: 16, isolated: 0, exclusive: 1 });
      expect(isolation.counts).toEqual(
        process.platform === 'win32'
          ? { parallel: 0, isolated: 0, exclusive: 2 }
          : { parallel: 0, isolated: 1, exclusive: 1 },
      );
      if (process.platform === 'win32') {
        expect(isolation.exclusive.flatMap((job) => job.files).sort()).toEqual(
          [isolated, exclusive].sort(),
        );
      } else {
        expect(isolation.concurrent[0]?.files).toEqual([isolated]);
        expect(isolation.exclusive[0]?.files).toEqual([exclusive]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('covers the complete default Bun file inventory once across all suites', () => {
    const suites = [
      'packages/agent-api-contract/test',
      'packages/agent-api-client/test',
      'packages/runtime-contract/test',
      'packages/runtime-protocol/test',
      'packages/runtime-server/test',
      'packages/runtime-client/test',
      'packages/kite-app-contract/test',
      'packages/kite-local-runtime/test',
      'packages/agent-kernel/test',
      'packages/runtime-spi/test',
      'packages/runtime-host/test',
      'packages/runtime-storage-sqlite/test',
      'packages/builtin-runtime/test',
      'apps/kite-cli/test',
      'apps/kite-service/test',
      'packages/kite-client-ui/test',
      'apps/kite-desktop/test',
      'tests/integration',
      'tests/golden',
      'tests/release',
      'tests/e2e/local',
      'tests/tui-system/harness',
      'tests/isolated',
    ];
    const expected = suites.flatMap((suite) => collectTestFiles(join(repoRoot, suite))).sort();
    const plan = planTestSuites(repoRoot, suites, 4);
    const planned = [...plan.concurrent, ...plan.exclusive].flatMap((job) => job.files);
    expect(planned.sort()).toEqual(expected);
    expect(new Set(planned).size).toBe(planned.length);
    expect(plan.counts.parallel + plan.counts.isolated + plan.counts.exclusive).toBe(
      expected.length,
    );
  });

  test('ownership gate accepts exclusive placement and catches indirect child-process startup', () => {
    const root = fixture();
    try {
      const files = [
        'tests/isolated/exclusive/serial.test.ts',
        'apps/kite-desktop/test/host-service-process.test.ts',
      ];
      mkdirSync(join(root, 'packages'), { recursive: true });
      for (const file of files) {
        const absolute = join(root, file);
        mkdirSync(join(absolute, '..'), { recursive: true });
        writeFileSync(
          absolute,
          file.includes('host-service-process') ? 'ServiceProcess.start({});\n' : 'export {};\n',
        );
      }
      const violations = analyzeTestOwnership(root);
      expect(violations.map((item) => item.code)).toEqual(['OWNER_TEST_REQUIRES_ISOLATION']);
      expect(violations.some((item) => item.path === files[0])).toBe(false);
      expect(
        existsSync(join(repoRoot, 'apps/kite-cli/test/tui-runtime-client-conformance.test.ts')),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
