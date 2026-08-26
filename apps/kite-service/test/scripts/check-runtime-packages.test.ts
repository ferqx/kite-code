import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { analyzeRuntimePackages } from '../../../../scripts/runtime-packages/check-runtime-packages';

const fixtureRoots: string[] = [];

afterAll(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
});

function createFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'kite-runtime-packages-'));
  fixtureRoots.push(root);
  cpSync(join(process.cwd(), 'package.json'), join(root, 'package.json'));
  cpSync(join(process.cwd(), 'packages'), join(root, 'packages'), { recursive: true });
  cpSync(join(process.cwd(), 'apps'), join(root, 'apps'), { recursive: true });
  cpSync(join(process.cwd(), 'scripts'), join(root, 'scripts'), { recursive: true });
  cpSync(join(process.cwd(), 'tests'), join(root, 'tests'), { recursive: true });
  return root;
}

function updateText(root: string, path: string, update: (current: string) => string): void {
  const absolute = join(root, path);
  writeFileSync(absolute, update(readFileSync(absolute, 'utf8')));
}

function updateJson(
  root: string,
  path: string,
  update: (value: Record<string, unknown>) => void,
): void {
  const absolute = join(root, path);
  const value = JSON.parse(readFileSync(absolute, 'utf8')) as Record<string, unknown>;
  update(value);
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`);
}

function expectViolation(root: string, code: string): void {
  const analysis = analyzeRuntimePackages(root);
  expect(analysis.violations.map((entry) => entry.code)).toContain(code);
}

describe('runtime workspace package gate', () => {
  test('accepts the authoritative package and two-App graph', () => {
    const analysis = analyzeRuntimePackages(process.cwd());
    expect(analysis.violations).toEqual([]);
    expect(analysis.packages).toHaveLength(13);
    expect(analysis.compositionRoots).toEqual(['apps/kite-service/src/bootstrap.ts']);
  });

  test('rejects package cycles even when the new edge is declared', () => {
    const root = createFixture();
    updateJson(root, 'packages/runtime-contract/package.json', (value) => {
      value.dependencies = { '@kite-ai/runtime-spi': 'workspace:*' };
    });
    updateText(
      root,
      'packages/runtime-contract/src/index.ts',
      (value) => `import '@kite-ai/runtime-spi';\n${value}`,
    );
    expectViolation(root, 'PACKAGE_CYCLE');
  });

  test('rejects unexported deep imports', () => {
    const root = createFixture();
    updateText(root, 'apps/kite-service/src/bootstrap.ts', (value) =>
      value.replace("from '@kite-ai/runtime-host'", "from '@kite-ai/runtime-host/src/index.ts'"),
    );
    expectViolation(root, 'DEEP_IMPORT_NOT_EXPORTED');
  });

  test('rejects relative imports across package roots', () => {
    const root = createFixture();
    updateText(
      root,
      'packages/runtime-spi/src/index.ts',
      (value) => `import '../../runtime-contract/src/index.ts';\n${value}`,
    );
    expectViolation(root, 'CROSS_PACKAGE_RELATIVE_IMPORT');
  });

  test.each([
    ["import type {} from '@kite-ai/builtin-runtime';", 'type-only'],
    ["void import('@kite-ai/builtin-runtime');", 'dynamic'],
    ["require('@kite-ai/builtin-runtime');", 'require'],
  ])('rejects forbidden %s imports', (statement) => {
    const root = createFixture();
    updateText(root, 'packages/runtime-host/src/index.ts', (value) => `${statement}\n${value}`);
    expectViolation(root, 'FORBIDDEN_DIRECT_DEPENDENCY');
  });

  test('reports forbidden dependencies through upstream package closures', () => {
    const root = createFixture();
    updateJson(root, 'packages/runtime-contract/package.json', (value) => {
      value.dependencies = { '@kite-ai/agent-kernel': 'workspace:*' };
    });
    updateText(
      root,
      'packages/runtime-contract/src/index.ts',
      (value) => `import '@kite-ai/agent-kernel';\n${value}`,
    );
    expectViolation(root, 'FORBIDDEN_TRANSITIVE_DEPENDENCY');
  });

  test.each([
    ["import 'node:crypto';", 'FORBIDDEN_NODE_IMPORT'],
    ['export const wallClock = Date.now();', 'FORBIDDEN_KERNEL_CLOCK_RANDOM'],
    ['export const randomValue = Math.random();', 'FORBIDDEN_KERNEL_CLOCK_RANDOM'],
    ['export const timer = setTimeout(() => undefined, 1);', 'FORBIDDEN_KERNEL_AMBIENT_GLOBAL'],
    ['export const clock = performance.now();', 'FORBIDDEN_KERNEL_AMBIENT_GLOBAL'],
    ['export const transport = fetch;', 'FORBIDDEN_KERNEL_AMBIENT_GLOBAL'],
  ])('rejects kernel ambient authority: %s', (statement, code) => {
    const root = createFixture();
    updateText(root, 'packages/agent-kernel/src/index.ts', (value) => `${statement}\n${value}`);
    expectViolation(root, code);
  });

  test.each([
    [
      'packages/runtime-host/src/index.ts',
      "import 'bun:sqlite';",
      'FORBIDDEN_CONCRETE_PROVIDER_IMPORT',
    ],
    ['packages/builtin-runtime/src/index.ts', "import 'react';", 'FORBIDDEN_UI_IMPORT'],
  ])('rejects package-specific external authority in %s', (path, statement, code) => {
    const root = createFixture();
    updateText(root, path, (value) => `${statement}\n${value}`);
    expectViolation(root, code);
  });

  test.each([
    ['packages/runtime-protocol/src/index.ts', "import 'node:crypto';", 'FORBIDDEN_NODE_IMPORT'],
    ['packages/runtime-server/src/index.ts', "import 'bun:sqlite';", 'FORBIDDEN_BUN_IMPORT'],
    ['packages/runtime-client/src/index.ts', "import 'node:stream';", 'FORBIDDEN_NODE_IMPORT'],
  ])('keeps Runtime gateway core browser-safe and transport-neutral in %s', (path, statement, code) => {
    const root = createFixture();
    updateText(root, path, (value) => `${statement}\n${value}`);
    expectViolation(root, code);
  });

  test.each([
    ['packages/runtime-server/src/index.ts', "import '@kite-ai/runtime-host';"],
    ['packages/runtime-client/src/index.ts', "import '@kite-ai/runtime-server';"],
    ['packages/runtime-client/src/index.ts', "import '@kite-ai/runtime-storage-sqlite';"],
  ])('rejects Runtime gateway authority inversion in %s', (path, statement) => {
    const root = createFixture();
    updateText(root, path, (value) => `${statement}\n${value}`);
    expectViolation(root, 'FORBIDDEN_DIRECT_DEPENDENCY');
  });

  test('rejects wildcard and missing public export targets', () => {
    const wildcardRoot = createFixture();
    updateJson(wildcardRoot, 'packages/runtime-contract/package.json', (value) => {
      value.exports = { '.': './src/index.ts', './*': './src/*' };
    });
    expectViolation(wildcardRoot, 'PUBLIC_EXPORT_WILDCARD');

    const missingRoot = createFixture();
    updateJson(missingRoot, 'packages/runtime-contract/package.json', (value) => {
      value.exports = { '.': './src/missing.ts' };
    });
    expectViolation(missingRoot, 'EXPORT_TARGET_MISSING');
  });

  test('rejects forbidden symbols exposed by a public contract', () => {
    const root = createFixture();
    updateText(
      root,
      'packages/runtime-contract/src/index.ts',
      (value) => `${value}\nexport interface AgentState { readonly secret: string }\n`,
    );
    expectViolation(root, 'PUBLIC_EXPORT_FORBIDDEN');
  });

  test('rejects Host, Store, Provider, or Executor authority exported by Kernel', () => {
    const root = createFixture();
    updateText(
      root,
      'packages/agent-kernel/src/index.ts',
      (value) => `export interface RuntimeStore { close(): void }\n${value}`,
    );
    expectViolation(root, 'PUBLIC_EXPORT_FORBIDDEN');
  });

  test('rejects direct Runtime authority imports from CLI/TUI clients', () => {
    const root = createFixture();
    updateText(
      root,
      'apps/kite-cli/src/tui/runtime-presentation.ts',
      (value) => `import '@/core/runtime/store';\n${value}`,
    );
    expectViolation(root, 'CLIENT_RUNTIME_AUTHORITY_IMPORT');
  });

  test('rejects CLI, React, and Ink imports from the Runtime Service', () => {
    for (const specifier of ['@kite-ai/kite-cli', '#kite-cli/bootstrap', 'react', 'ink']) {
      const root = createFixture();
      updateText(
        root,
        'apps/kite-service/src/index.ts',
        (value) => `import '${specifier}';\n${value}`,
      );
      expectViolation(root, 'SERVICE_UI_OR_CLI_IMPORT');
    }
  });

  test('rejects a Client import of the legacy implementation', () => {
    const root = createFixture();
    updateText(
      root,
      'apps/kite-cli/src/cli/index.ts',
      (value) => `import '../bootstrap/legacy/RemovedRuntimeBridge';\n${value}`,
    );
    expectViolation(root, 'CLIENT_LEGACY_IMPLEMENTATION_IMPORT');
  });

  test('rejects concrete format authority in the Contract', () => {
    const root = createFixture();
    updateText(
      root,
      'packages/runtime-contract/src/index.ts',
      (value) => `${value}\n// State 26 format owner\n`,
    );
    expectViolation(root, 'FORMAT_AUTHORITY_LEAK');
  });

  test('rejects recreating the transitional root Runtime shim', () => {
    const root = createFixture();
    const sourceDirectory = join(root, 'src');
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(
      join(sourceDirectory, 'index.ts'),
      "export { runCli } from '../apps/kite-cli/src/cli/executable';\n",
    );
    expectViolation(root, 'ROOT_RUNTIME_SHIM_PRESENT');
  });

  test('rejects moving the root package module back to the transitional shim', () => {
    const root = createFixture();
    updateJson(root, 'package.json', (value) => {
      value.module = 'src/index.ts';
    });
    expectViolation(root, 'ROOT_PACKAGE_MODULE_INVALID');
  });

  test.each([
    ['authority wildcard', "export * from './bootstrap';\n"],
    ['Core Runtime export', "export * from '../../../../src/core/runtime/agent';\n"],
  ])('rejects an App public entry %s', (_caseName, entrySource) => {
    const root = createFixture();
    updateText(root, 'apps/kite-cli/src/index.ts', () => entrySource);
    expectViolation(root, 'APP_PUBLIC_ENTRY_INVALID');
  });

  test('rejects drift between a named re-export and its source module', () => {
    const root = createFixture();
    updateText(
      root,
      'apps/kite-cli/src/index.ts',
      () => "export { missingRuntimeFactory } from './bootstrap';\n",
    );
    expectViolation(root, 'PUBLIC_EXPORT_SYMBOL_DRIFT');
  });

  test('rejects a root test script that omits workspace consumers', () => {
    const root = createFixture();
    updateJson(root, 'package.json', (value) => {
      const scripts = value.scripts as Record<string, string>;
      scripts.test = 'bun test tests/integration/';
    });
    expectViolation(root, 'ROOT_WORKSPACE_SCRIPT_INCOMPLETE');
  });

  test('requires an explicit CLI package-export consumer', () => {
    const root = createFixture();
    rmSync(join(root, 'apps/kite-cli/test/package-exports.test.ts'));
    expectViolation(root, 'PACKAGE_CONSUMER_MISSING');
  });

  test('rejects a root script that executes a missing source file', () => {
    const root = createFixture();
    updateJson(root, 'package.json', (value) => {
      const scripts = value.scripts as Record<string, string>;
      scripts.web = 'bun run src/web-server/index.tsx';
    });
    expectViolation(root, 'ROOT_SCRIPT_SOURCE_MISSING');
  });

  test('rejects undeclared internal package imports', () => {
    const root = createFixture();
    updateJson(root, 'packages/builtin-runtime/package.json', (value) => {
      const dependencies = value.dependencies as Record<string, string>;
      delete dependencies['@kite-ai/runtime-spi'];
    });
    expectViolation(root, 'UNDECLARED_INTERNAL_DEPENDENCY');
  });

  test('rejects a second concrete App composition root', () => {
    const root = createFixture();
    const path = join(root, 'apps/kite-service/src/alternate.ts');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      [
        "import '@kite-ai/runtime-host';",
        "import '@kite-ai/runtime-storage-sqlite';",
        "import '@kite-ai/builtin-runtime';",
        'export const alternate = true;',
      ].join('\n'),
    );
    expectViolation(root, 'COMPOSITION_ROOT_MULTIPLE');
  });

  test.each([
    ["import { createRuntimeHost } from '@kite-ai/runtime-host';", 'createRuntimeHost'],
    [
      "import { createRuntimeModuleRegistry } from '@kite-ai/runtime-spi';",
      'createRuntimeModuleRegistry',
    ],
    [
      "import { createBuiltinRuntimeModules } from '@kite-ai/builtin-runtime';",
      'createBuiltinRuntimeModules',
    ],
    [
      "import { createSqliteRuntimeStorage } from '@kite-ai/runtime-storage-sqlite';",
      'createSqliteRuntimeStorage',
    ],
    ["import '@kite-ai/runtime-storage-sqlite';", '*'],
  ])('rejects non-bootstrap composition authority %s', (statement, _binding) => {
    const root = createFixture();
    const path = join(root, 'apps/kite-service/src/alternate-authority.ts');
    writeFileSync(path, `${statement}\nexport const alternateAuthority = true;\n`);
    expectViolation(root, 'COMPOSITION_ROOT_BYPASS');
  });
});
