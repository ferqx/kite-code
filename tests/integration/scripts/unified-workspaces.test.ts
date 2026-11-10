import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { checkUnifiedAgentBoundary } from '../../../scripts/check-unified-agent-boundary';
import {
  checkUnifiedWorkspaces,
  UNIFIED_WORKSPACES,
} from '../../../scripts/check-unified-workspaces';

const roots: string[] = [];
function put(root: string, path: string, value: unknown) {
  const file = resolve(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'kite-unified-workspaces-'));
  roots.push(root);
  const scripts = {
    build: 'bun run scripts/run-runtime-workspace-script.ts build',
    test: 'bun run scripts/run-default-tests.ts',
    'test:all': 'bun run test',
    typecheck: 'bun check -b -p tsconfig.typecheck.json',
    agent: 'bun run scripts/release/entrypoints/cli.ts',
    tui: 'bun run scripts/release/entrypoints/tui.ts',
    'prod:tui': 'NODE_ENV=production bun run scripts/release/entrypoints/tui.ts',
    server: 'bun run scripts/development/ensure-web.ts',
    desktop: 'bun run scripts/release/native.ts launch',
    'release:terminal': 'bun run scripts/release/terminal.ts',
    'release:build': 'bun run scripts/release/unified.ts build',
    'release:verify': 'bun run scripts/release/unified.ts verify',
    'release:smoke': 'bun run scripts/release/unified.ts smoke',
    'release:install': 'bun run scripts/release/unified.ts install',
    'release:native': 'bun run scripts/release/native.ts',
    'check:runtime-packages': 'bun run scripts/check-unified-workspaces.ts',
  };
  put(root, 'package.json', {
    module: 'scripts/release/source-terminal.ts',
    workspaces: UNIFIED_WORKSPACES,
    scripts,
    devDependencies: { '@kite-ai/agent': 'workspace:*' },
  });
  for (const script of Object.values(scripts)) {
    const path = script.match(/bun run (\S+\.ts)/)?.[1];
    if (path) put(root, path, 'export {};');
  }
  put(root, 'scripts/release/source-terminal.ts', 'export {};');
  put(root, 'tsconfig.typecheck.json', {
    files: [],
    references: ['.', ...UNIFIED_WORKSPACES].map((path) => ({
      path: path === '.' ? './tsconfig.json' : `./${path}/tsconfig.json`,
    })),
  });
  for (const path of UNIFIED_WORKSPACES) {
    put(root, `${path}/package.json`, {
      name: `@kite-ai/${path.split('/')[1]}`,
      private: true,
      type: 'module',
      exports: { '.': './src/index.ts' },
      scripts: {
        build: 'bun build src/index.ts',
        typecheck: 'bun check -p tsconfig.json',
        test: 'bun test test',
      },
      dependencies: path === 'apps/service' ? { '@kite-ai/agent': 'workspace:*' } : {},
    });
    put(root, `${path}/src/index.ts`, 'export {};');
  }
  return root;
}
function edit(
  root: string,
  path: string,
  change: (manifest: {
    module?: string;
    workspaces?: readonly string[];
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
    dependencies: Record<string, string>;
    exports: Record<string, string>;
  }) => void,
) {
  const value = JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  change(value);
  put(root, path, value);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test('exact current manifests and trusted formal aliases pass without inspecting installed old links', () => {
  const root = fixture();
  put(root, 'node_modules/@kite-ai/runtime-host/package.json', { name: '@kite-ai/runtime-host' });
  const report = checkUnifiedWorkspaces(root);
  expect(report.violations).toEqual([]);
  expect(report.checked).toEqual(UNIFIED_WORKSPACES);
});
test('generated Web asset export must exist even when its type branch is present', () => {
  const root = fixture();
  const path = 'apps/web/package.json';
  const manifest = JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  manifest.exports['./assets'] = {
    types: './src/assets-port.ts',
    default: './dist/assets.js',
  };
  put(root, path, manifest);
  put(root, 'apps/web/src/assets-port.ts', 'export {};');
  const refusal = {
    code: 'workspace-export-invalid',
    path,
    message: './assets:default: ./dist/assets.js',
  };
  expect(checkUnifiedWorkspaces(root).violations).toContainEqual(refusal);
  const asset = 'apps/web/dist/assets.js';
  put(root, asset, 'export {};');
  expect(checkUnifiedWorkspaces(root).violations).toEqual([]);
  rmSync(resolve(root, asset));
  expect(checkUnifiedWorkspaces(root).violations).toContainEqual(refusal);
});

test('wildcard, order drift, unknown workspace and old root dependency reject', () => {
  for (const workspaces of [
    ['packages/*', 'apps/*'],
    [...UNIFIED_WORKSPACES].reverse(),
    [...UNIFIED_WORKSPACES, 'packages/extra'],
  ]) {
    const root = fixture();
    edit(root, 'package.json', (m) => (m.workspaces = workspaces));
    expect(
      checkUnifiedWorkspaces(root).violations.some((v) => v.code === 'workspaces-not-exact'),
    ).toBe(true);
  }
  const root = fixture();
  edit(root, 'package.json', (m) => (m.devDependencies['@kite-ai/runtime-host'] = 'workspace:*'));
  expect(
    checkUnifiedWorkspaces(root).violations.some(
      (v) => v.code === 'workspace-dependency-forbidden',
    ),
  ).toBe(true);
});

test('aggregate typecheck cannot omit projects, widen roots or override their compiler settings', () => {
  const references = ['.', ...UNIFIED_WORKSPACES].map((path) => ({
    path: path === '.' ? './tsconfig.json' : `./${path}/tsconfig.json`,
  }));
  for (const config of [
    { files: [], references: references.slice(1) },
    { files: [], references: references.slice(0, -1) },
    { files: [], references: [...references].reverse() },
    { files: [], references: [...references, references[0]] },
    { files: [], references: [...references, { path: './apps/kite-cli/tsconfig.json' }] },
    { files: ['unlisted.ts'], references },
    { files: [], references, compilerOptions: { strict: false } },
  ]) {
    const root = fixture();
    put(root, 'tsconfig.typecheck.json', config);
    expect(
      checkUnifiedWorkspaces(root).violations.some((v) => v.code === 'typecheck-projects-invalid'),
    ).toBe(true);
  }
});

test('combined boundary preserves standalone refusals and pending diagnostics', () => {
  for (const [path, source] of [
    ['packages/agent/src/permissions/check.ts', 'import "@kite-ai/service";'],
    ['packages/agent/src/loop.ts', 'import "node:fs";'],
    ['packages/ai/src/index.ts', 'import "@kite-ai/agent";'],
    ['packages/trajectory/src/index.ts', 'import "node:fs";'],
    ['packages/trajectory/src/index.ts', 'import "@kite-ai/client";'],
    ['packages/trajectory/src/index.ts', 'import "react";'],
    ['packages/trajectory/src/index.ts', 'void fetch("https://example.invalid");'],
    ['packages/ui/src/index.ts', 'import "node:fs";'],
    ['apps/service/src/index.ts', 'export function createPermissionPolicy() { return {}; }'],
    ['apps/desktop/electron/bridge.ts', 'import "@kite-ai/runtime-host";'],
  ] as const) {
    const root = fixture();
    put(root, path, source);
    const standalone = checkUnifiedAgentBoundary(root);
    const combined = checkUnifiedWorkspaces(root);
    expect(standalone.violations.length).toBeGreaterThan(0);
    expect(combined.boundary).toEqual(standalone);
    for (const violation of standalone.violations)
      expect(combined.violations).toContainEqual({
        code: 'source-boundary',
        path: violation.file,
        message: `${violation.rule}:${violation.line} ${violation.detail}`,
      });
  }
});

test('transitive new workspace cannot hide old or unknown internal package, export escape or missing scripts', () => {
  const root = fixture();
  edit(
    root,
    'packages/agent/package.json',
    (m) =>
      (m.dependencies = {
        '@kite-ai/runtime-storage-sqlite': 'workspace:*',
        '@kite-ai/not-owned': 'workspace:*',
      }),
  );
  edit(root, 'packages/client/package.json', (m) => {
    m.exports['./escape'] = '../../runtime-client/src/index.ts';
    delete m.scripts.test;
  });
  const violations = checkUnifiedWorkspaces(root).violations;
  expect(violations.filter((v) => v.code === 'workspace-dependency-forbidden')).toHaveLength(2);
  expect(violations.some((v) => v.code === 'workspace-export-invalid')).toBe(true);
  expect(violations.some((v) => v.code === 'workspace-script-missing')).toBe(true);
});
test('formal module, script override or trusted wrapper barrel back to old source reject', () => {
  const root = fixture();
  edit(root, 'package.json', (m) => {
    m.module = 'apps/kite-cli/src/index.ts';
    m.scripts.desktop = 'bun run --cwd apps/kite-desktop dev';
    m.scripts['release:build'] = 'bun run scripts/release/build-oss-candidate.ts';
  });
  const report = checkUnifiedWorkspaces(root);
  expect(report.violations.some((v) => v.code === 'formal-module-invalid')).toBe(true);
  expect(report.violations.filter((v) => v.code === 'formal-script-invalid')).toHaveLength(2);
  const source = fixture();
  put(source, 'scripts/release/source-terminal.ts', 'export * from "./bridge";');
  put(source, 'scripts/release/bridge.ts', 'export * from "../../apps/kite-cli/src/index";');
  put(source, 'apps/kite-cli/src/index.ts', 'export {};');
  expect(checkUnifiedWorkspaces(source).violations.some((v) => v.code === 'source-boundary')).toBe(
    true,
  );
});

test('existing conditional types/runtime exports stay valid while any escaping branch rejects', () => {
  const root = fixture();
  put(root, 'apps/web/src/assets.ts', 'export {};');
  put(root, 'apps/web/dist/assets.js', 'export {};');
  const value = JSON.parse(readFileSync(resolve(root, 'apps/web/package.json'), 'utf8'));
  value.exports['./assets'] = { types: './src/assets.ts', default: './dist/assets.js' };
  put(root, 'apps/web/package.json', value);
  expect(checkUnifiedWorkspaces(root).violations).toEqual([]);
  value.exports['./assets'].default = '../../kite-web/src/index.ts';
  put(root, 'apps/web/package.json', value);
  expect(
    checkUnifiedWorkspaces(root).violations.some((v) => v.code === 'workspace-export-invalid'),
  ).toBe(true);
});

test('unlisted root alias, nested workspace build and CI source imports cannot reattach legacy', () => {
  for (const command of [
    'bun run hidden',
    'bun run --cwd apps/kite-service build',
    'bun test apps/kite-cli/test',
  ]) {
    const root = fixture();
    edit(root, 'package.json', (m) => {
      m.scripts.extra = command;
      m.scripts.hidden = 'bun run apps/kite-service/src/executable.ts';
    });
    expect(
      checkUnifiedWorkspaces(root).violations.some((v) => v.code === 'formal-legacy-command'),
    ).toBe(true);
  }
  const root = fixture();
  put(root, 'scripts/release/extra.ts', 'export * from "./bridge";');
  put(root, 'scripts/release/bridge.ts', 'export * from "../../packages/runtime-host/src/index";');
  put(root, 'packages/runtime-host/src/index.ts', 'export {};');
  edit(root, 'package.json', (m) => (m.scripts.extra = 'bun run scripts/release/extra.ts'));
  expect(checkUnifiedWorkspaces(root).violations.some((v) => v.code === 'source-boundary')).toBe(
    true,
  );
  const historical = fixture();
  put(historical, 'packages/runtime-host/src/index.ts', 'export class RuntimeState {}');
  expect(checkUnifiedWorkspaces(historical).violations).toEqual([]);
});
