import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { checkUnifiedAgentBoundary } from '../../../scripts/check-unified-agent-boundary';

const roots: string[] = [];
function fixture(sources: Record<string, string>): string {
  const root = mkdtempSync(resolve(tmpdir(), 'kite-unified-boundary-'));
  roots.push(root);
  for (const [path, content] of Object.entries(sources)) {
    const file = resolve(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  for (const [name, path] of Object.entries({
    ai: 'packages/ai',
    agent: 'packages/agent',
    client: 'packages/client',
    ui: 'packages/ui',
    service: 'apps/service',
    cli: 'apps/cli',
    desktop: 'apps/desktop',
    web: 'apps/web',
  })) {
    if (
      !Object.keys(sources).some((file) => file.startsWith(`${path}/src/`)) ||
      sources[`${path}/package.json`]
    )
      continue;
    const exports: Record<string, string> = {};
    for (const file of Object.keys(sources).filter((file) => file.startsWith(`${path}/src/`))) {
      const subpath = file.slice(`${path}/src/`.length).replace(/\.tsx?$/, '');
      exports[subpath === 'index' ? '.' : `./${subpath}`] =
        `./src/${file.slice(`${path}/src/`.length)}`;
    }
    writeFileSync(
      resolve(root, path, 'package.json'),
      JSON.stringify({ name: `@kite-ai/${name}`, exports }),
    );
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('absent target source and legacy retirement remain pending', () => {
  const root = fixture({ 'packages/runtime-host/src/index.ts': 'export class OldHost {}' });
  const report = checkUnifiedAgentBoundary(root);
  expect(report.violations).toEqual([]);
  expect(report.pending).toContain('client: no target source to check');
  expect(report.pending).toContain('loop: no target source to check');
  expect(report.legacyRetirement).toBe('pending');
});

test('portable contracts and loop storage port are permitted', () => {
  const root = fixture({
    'packages/ai/src/index.ts': 'export interface ModelAdapter {}',
    'packages/agent/src/loop.ts':
      'import type { ModelAdapter } from "@kite-ai/ai"; import type { Store } from "./storage/port";',
    'packages/agent/src/storage/port.ts': 'export interface Store {}',
    'packages/client/src/index.ts': 'export const request = () => fetch("http://localhost");',
    'packages/ui/src/index.ts': 'import type { View } from "@kite-ai/client";',
  });
  expect(checkUnifiedAgentBoundary(root).violations).toEqual([]);
});

test('loop cannot reach concrete SQL, HTTP or tool implementation through barrels', () => {
  for (const forbidden of ['bun:sqlite', 'hono', '../tools/shell']) {
    const root = fixture({
      'packages/agent/src/loop.ts': 'export * from "./execution/barrel";',
      'packages/agent/src/execution/barrel.ts': `export * from ${JSON.stringify(forbidden)};`,
      'packages/agent/src/tools/shell.ts': 'export const shell = true;',
    });
    const report = checkUnifiedAgentBoundary(root);
    expect(report.violations.some((item) => item.rule === 'loop-dependency')).toBe(true);
  }
});

test('dynamic imports, require and type imports cannot bypass ai or portable boundaries', () => {
  const root = fixture({
    'packages/ai/src/index.ts': 'type Session = import("@kite-ai/agent").Session;',
    'packages/client/src/index.ts': 'const module = import("./barrel");',
    'packages/client/src/barrel.ts': 'const sqlite = require("bun:sqlite");',
    'packages/ui/src/index.ts': 'export type { Runtime } from "@kite-ai/agent";',
  });
  const report = checkUnifiedAgentBoundary(root);
  expect(report.violations.some((item) => item.rule === 'ai-dependency')).toBe(true);
  expect(report.violations.filter((item) => item.rule === 'portable-dependency')).toHaveLength(2);
});

test('target code cannot import old engine or introduce business classes or whole State', () => {
  const root = fixture({
    'packages/agent/src/runtime.ts':
      'import { Host } from "@kite-ai/runtime-host"; export class CodingAgent {}',
    'packages/agent/src/session/control.ts': 'export type State = AgentState;',
    'packages/agent/src/loop.ts': 'const name = "shell_execute";',
  });
  const report = checkUnifiedAgentBoundary(root);
  expect(report.violations.some((item) => item.rule === 'target-no-legacy-engine')).toBe(true);
  expect(
    report.violations.filter((item) => item.rule === 'core-no-business-branch-or-whole-state'),
  ).toHaveLength(3);
});

test('CLI returns a failure exit code for an actual violating fixture', async () => {
  const root = fixture({
    'packages/client/src/index.ts': 'import { Database } from "bun:sqlite";',
  });
  const process = Bun.spawn(
    [
      Bun.which('bun')!,
      resolve(import.meta.dir, '../../../scripts/check-unified-agent-boundary.ts'),
      root,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [exitCode, error] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  expect(exitCode).toBe(1);
  expect(error).toContain('portable-dependency');
});

test('thin CLI SIGINT, Desktop UI and Web browser client stay portable', () => {
  const root = fixture({
    'apps/cli/src/index.ts':
      'import process from "node:process"; import type { AgentClient } from "@kite-ai/client"; process.on("SIGINT", () => {});',
    'apps/desktop/src/index.tsx': 'export { PublicViewCard } from "@kite-ai/ui";',
    'packages/ui/src/index.ts': 'export const PublicViewCard = true;',
    'packages/client/src/index.ts': 'export interface AgentClient {}',
    'apps/web/src/index.ts': 'export { BrowserClient } from "@kite-ai/client/browser";',
    'packages/client/src/browser.ts': 'export interface BrowserClient {}',
  });
  const report = checkUnifiedAgentBoundary(root);
  expect(report.violations).toEqual([]);
  expect(report.checked).toContain('cli: 1 source files');
  expect(report.checked).toContain('desktop: 1 source files');
  expect(report.checked).toContain('web: 1 source files');
});

test('thin app closure rejects server, native, model and old engine through external barrels and import forms', () => {
  for (const [entry, forbidden] of [
    ['apps/cli/src/index.ts', 'export type Runtime = import("@kite-ai/agent").Runtime;'],
    ['apps/desktop/src/index.ts', 'const model = import("@kite-ai/ai/sdk");'],
    ['apps/cli/src/index.ts', 'export * from "bun:sqlite";'],
    ['apps/cli/src/index.ts', 'export * from "@kite-ai/kite-service";'],
    ['apps/desktop/src/index.ts', 'const native = require("node:child_process");'],
    ['apps/cli/src/index.ts', 'export * from "@kite-ai/runtime-host";'],
    ['apps/desktop/src/index.ts', 'export * from "../apps/service/src/index";'],
    ['apps/desktop/src/index.ts', 'const name = "@kite-ai/agent"; import(name);'],
    ['apps/web/src/index.ts', 'export type Runtime = import("@kite-ai/agent").Runtime;'],
    ['apps/web/src/index.ts', 'export * from "@kite-ai/service/development-web";'],
    ['apps/web/src/index.ts', 'const native = require("node:fs");'],
  ] as const) {
    const root = fixture({
      [entry]: 'export * from "../../../shared/barrel";',
      'shared/barrel.ts': forbidden,
      'apps/service/src/index.ts': 'export const server = true;',
    });
    const report = checkUnifiedAgentBoundary(root);
    expect(report.violations.length).toBeGreaterThan(0);
    expect(
      report.violations.some(
        (item) => item.rule === 'portable-dependency' || item.rule === 'target-no-legacy-engine',
      ),
    ).toBe(true);
  }
});

test('portable UI cannot import CLI-only process builtin', () => {
  const root = fixture({ 'packages/ui/src/index.ts': 'import process from "node:process";' });
  expect(
    checkUnifiedAgentBoundary(root).violations.some((item) => item.rule === 'portable-dependency'),
  ).toBe(true);
});

test('actual checker CLI rejects a thin-app dynamic model dependency behind a barrel', async () => {
  const root = fixture({
    'apps/desktop/src/index.ts': 'export * from "./bridge";',
    'apps/desktop/src/bridge.ts': 'const model = import("@kite-ai/ai");',
  });
  const child = Bun.spawn(
    [
      Bun.which('bun')!,
      resolve(import.meta.dir, '../../../scripts/check-unified-agent-boundary.ts'),
      root,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [exitCode, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exitCode).toBe(1);
  expect(error).toContain('portable-dependency');
  expect(error).toContain('apps/desktop/src/bridge.ts');
});

test('trusted Service, CLI host, Electron and formal wrappers permit IO but reject complete old carrier set through barrels', () => {
  for (const entry of [
    'apps/service/src/main.ts',
    'apps/cli/host/main.ts',
    'apps/desktop/electron/main.ts',
    'scripts/release/source-terminal.ts',
    'scripts/development/ensure-web.ts',
  ]) {
    const clean = fixture({
      [entry]: 'import fs from "node:fs"; import {Database} from "bun:sqlite";',
    });
    expect(checkUnifiedAgentBoundary(clean).violations).toEqual([]);
    for (const name of [
      'agent-api-contract',
      'agent-api-client',
      'agent-kernel',
      'builtin-runtime',
      'runtime-host',
      'runtime-storage-sqlite',
      'runtime-protocol',
      'runtime-client',
      'runtime-contract',
      'runtime-server',
      'runtime-spi',
      'kite-app-contract',
      'kite-local-runtime',
      'kite-client-ui',
      'kite-cli',
      'kite-service',
      'kite-web',
      'kite-desktop',
    ]) {
      const root = fixture({
        [entry]: `export * from "${'../'.repeat(entry.split('/').length - 1)}shared/barrel";`,
        'shared/barrel.ts': `type Old=import("@kite-ai/${name}").Old;`,
      });
      expect(
        checkUnifiedAgentBoundary(root).violations.some(
          (v) => v.rule === 'target-no-legacy-engine',
        ),
      ).toBe(true);
    }
  }
});
test('actual manifest public exports are followed without subpath guessing and forged or computed imports reject', () => {
  const root = fixture({
    'apps/service/src/index.ts': 'export * from "@kite-ai/service/paired";',
    'apps/service/package.json': JSON.stringify({
      name: '@kite-ai/service',
      exports: { '.': './src/index.ts', './paired': './private/admission.ts' },
    }),
    'apps/service/private/admission.ts':
      'export * from "../../../packages/runtime-host/src/index";',
    'packages/runtime-host/src/index.ts': 'export const old=true;',
  });
  expect(
    checkUnifiedAgentBoundary(root).violations.some(
      (v) => v.file === 'apps/service/private/admission.ts' && v.rule === 'target-no-legacy-engine',
    ),
  ).toBe(true);
  const unresolved = fixture({
    'apps/cli/host/main.ts': 'import "@kite-ai/service/paired";',
    'apps/service/package.json': JSON.stringify({
      name: '@kite-ai/service',
      exports: { '.': './src/index.ts' },
    }),
    'apps/service/src/index.ts': 'export {};',
  });
  expect(
    checkUnifiedAgentBoundary(unresolved).violations.some(
      (v) => v.rule === 'target-unresolved-workspace-export',
    ),
  ).toBe(true);
  const computed = fixture({ 'apps/cli/host/main.ts': 'const x="node:fs";import(x);' });
  expect(
    checkUnifiedAgentBoundary(computed).violations.some((v) => v.rule === 'host-dependency'),
  ).toBe(true);
  const absolute = fixture({
    'apps/desktop/electron/main.ts': 'export * from "./bridge";',
    'apps/kite-service/src/index.ts': 'export const old=true;',
  });
  writeFileSync(
    resolve(absolute, 'apps/desktop/electron/bridge.ts'),
    `const old=require(${JSON.stringify(resolve(absolute, 'apps/kite-service/src/index.ts'))});`,
  );
  expect(
    checkUnifiedAgentBoundary(absolute).violations.some(
      (v) => v.rule === 'target-no-legacy-engine',
    ),
  ).toBe(true);
});

test('conditional public exports inspect actual runtime branch as well as type branch', () => {
  const root = fixture({
    'apps/cli/host/main.ts': 'import "@kite-ai/service/paired";',
    'apps/service/package.json': JSON.stringify({
      name: '@kite-ai/service',
      exports: {
        '.': './src/index.ts',
        './paired': { types: './src/types.ts', default: './private/runtime.ts' },
      },
    }),
    'apps/service/src/index.ts': 'export {};',
    'apps/service/src/types.ts': 'export interface Paired {}',
    'apps/service/private/runtime.ts': 'export * from "@kite-ai/agent-api-client";',
  });
  expect(
    checkUnifiedAgentBoundary(root).violations.some(
      (v) => v.file === 'apps/service/private/runtime.ts' && v.rule === 'target-no-legacy-engine',
    ),
  ).toBe(true);
});

test('standard and Native fixed frontdoors plus caller-supplied build roots cannot hide a legacy barrel', () => {
  for (const entry of [
    'standard-cli',
    'standard-tui',
    'native-cli',
    'native-tui',
    'registered-entry',
  ]) {
    const root = fixture({
      [`scripts/release/entrypoints/${entry}.ts`]: 'export * from "../bridge";',
      'scripts/release/bridge.ts': 'export * from "../../packages/runtime-host/src/index";',
      'packages/runtime-host/src/index.ts': 'export {};',
    });
    expect(
      checkUnifiedAgentBoundary(root).violations.some((v) => v.rule === 'target-no-legacy-engine'),
    ).toBe(true);
  }
  const root = fixture({
    'scripts/build-custom.ts': 'export * from "../packages/runtime-host/src/index";',
    'packages/runtime-host/src/index.ts': 'export {};',
  });
  expect(
    checkUnifiedAgentBoundary(root, ['scripts/build-custom.ts']).violations.some(
      (v) => v.rule === 'target-no-legacy-engine',
    ),
  ).toBe(true);
});
