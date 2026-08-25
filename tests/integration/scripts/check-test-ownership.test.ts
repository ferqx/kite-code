import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeTestOwnership } from '../../../scripts/check-test-ownership';

const roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'kite-test-ownership-'));
  roots.push(root);
  mkdirSync(join(root, 'packages', 'owner', 'test'), { recursive: true });
  mkdirSync(join(root, 'apps', 'kite', 'test'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  return root;
}

function write(root: string, path: string, source = 'export {};\n'): void {
  const absolute = join(root, path);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, source);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('test ownership gate', () => {
  test('accepts owner, integration, isolated and qualification suites', () => {
    const root = fixture();
    write(root, 'packages/owner/test/unit.test.ts');
    write(root, 'apps/kite/test/ui.test.ts');
    write(root, 'tests/integration/runtime.test.ts', "import '@kite-ai/runtime-host';\n");
    write(root, 'tests/isolated/config.test.ts', 'process.env.HOME = "/tmp/test";\n');
    write(root, 'tests/qualification/fault.test.ts', 'Bun.spawn(["true"]);\n');
    expect(analyzeTestOwnership(root)).toEqual([]);
  });

  test('rejects root scatter, generic Runtime ownership and deep imports', () => {
    const root = fixture();
    write(root, 'tests/scattered.test.ts');
    write(root, 'tests/runtime/kernel.test.ts');
    write(
      root,
      'tests/integration/deep.test.ts',
      "import '../../packages/runtime-host/src/index';\n",
    );
    expect(analyzeTestOwnership(root).map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        'ROOT_TEST_UNCLASSIFIED',
        'GENERIC_RUNTIME_SUITE_PRESENT',
        'INTEGRATION_INTERNAL_IMPORT',
      ]),
    );
  });

  test('requires process-global tests to use isolated and current-domain names', () => {
    const root = fixture();
    write(root, 'apps/kite/test/config.test.ts', 'process.env.KITE_CODE_HOME = "/tmp/test";\n');
    write(root, 'tests/integration/state27-parity.test.ts', 'process.env.HOME = "/tmp/test";\n');
    expect(analyzeTestOwnership(root).map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        'OWNER_TEST_REQUIRES_ISOLATION',
        'PARALLEL_TEST_MUTATES_PROCESS',
        'MIGRATION_TEST_NAME',
      ]),
    );
  });
});
