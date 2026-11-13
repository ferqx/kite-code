import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, test } from '#kite-test';

const repositoryRoot = join(import.meta.dirname, '..', '..', '..');
const workflowRoot = join(repositoryRoot, '.github', 'workflows');

describe('CI Bun install and Node runtime baseline', () => {
  test('pins every third-party workflow action to an immutable current-runtime commit', () => {
    const workflows = readdirSync(workflowRoot)
      .filter((name) => name.endsWith('.yml'))
      .map((name) => ({ name, source: readFileSync(join(workflowRoot, name), 'utf8') }));
    const allowed = new Set([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      'actions/setup-node@2028fbc5c25fe9cf00d9f06a71cc4710d4507903',
      'actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830',
      'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
    ]);

    for (const { name, source } of workflows) {
      const actions = [...source.matchAll(/^\s*-?\s*uses:\s+([^\s]+)\s*$/gmu)].map(
        (match) => match[1]!,
      );
      for (const action of actions) {
        expect(action, name).toMatch(/^[^@\s]+@[a-f0-9]{40}$/u);
        expect(allowed.has(action), `${name}: ${action}`).toBe(true);
      }
    }
  });

  test('pins Node and Bun before every frozen CI install', () => {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
    expect(manifest.engines.node).toBe('26.13.1');
    expect(manifest.packageManager).toBe('bun@1.4.4');
    let installs = 0;
    for (const name of readdirSync(workflowRoot).filter((name) => name.endsWith('.yml'))) {
      const workflow = parse(readFileSync(join(workflowRoot, name), 'utf8'));
      for (const [job, value] of Object.entries(workflow.jobs) as [
        string,
        {
          steps?: {
            uses?: string;
            run?: string;
            with?: Record<string, string>;
          }[];
        },
      ][]) {
        const label = `${name}:${job}`;
        const steps = value.steps ?? [];
        const install = steps.findIndex((step) => step.run?.startsWith('bun install'));
        const bun = steps.findIndex((step) => step.uses?.startsWith('oven-sh/setup-bun@'));
        if (install < 0 && bun < 0) continue;
        const node = steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@'));
        expect(node, label).toBeGreaterThanOrEqual(0);
        expect(bun, label).toBeGreaterThan(node);
        expect(install, label).toBeGreaterThan(bun);
        expect(steps[node]?.with?.['node-version'], label).toBe(manifest.engines.node);
        expect(steps[bun]?.with?.['bun-version'], label).toBe(manifest.packageManager.slice(4));
        expect(steps[install]?.run, label).toMatch(
          /^bun install --frozen-lockfile(?: --ignore-scripts)?$/u,
        );
        installs++;
      }
    }
    expect(installs).toBeGreaterThan(10);
  });

  test('build jobs install dependencies before bundling and keep formal tests on Node', () => {
    const { scripts } = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const buildCommand =
      /\bbun (?:--cwd=\S+ )?run (?:build|release:(?:build|macos-dmg|windows-setup))(?=\s|$)/u;
    // The keyring qualification also builds its candidate inside the test.
    const keyringQualification = 'tests/isolated/unified-agent/native-credential-platform.test.ts';
    let builds = 0;
    for (const name of readdirSync(workflowRoot).filter((name) => name.endsWith('.yml'))) {
      const workflow = parse(readFileSync(join(workflowRoot, name), 'utf8'));
      for (const [job, value] of Object.entries(workflow.jobs) as [
        string,
        { steps: { uses?: string; run?: string; with?: Record<string, string> }[] },
      ][]) {
        const label = `${name}:${job}`;
        const steps = value.steps;
        const build = steps.findIndex(
          ({ run = '' }) => buildCommand.test(run) || run.includes(keyringQualification),
        );
        if (build >= 0) {
          builds++;
          const install = steps.findIndex((step) => step.run?.startsWith('bun install'));
          expect(install, label).toBeGreaterThanOrEqual(0);
          expect(install, label).toBeLessThan(build);
        }
        for (const step of steps) {
          const run = step.run ?? '';
          expect(run, label).not.toMatch(/\bbun\s+(?:test|--bun)\b|\bbun\s+run\s+--bun\b/u);
          for (const [, alias] of run.matchAll(/\bbun run (test(?:[:\w-]*))(?=\s|$)/gu)) {
            expect(alias, label).not.toBe('test:fast');
            expect(scripts[alias!], `${label}:${alias}`).toMatch(/^node --import\s/u);
          }
        }
      }
    }
    expect(builds).toBeGreaterThan(0);
  });

  test('cancels stale ordinary checks without cancelling formal evidence workflows', () => {
    for (const name of [
      'required.yml',
      'mcp-native-keyring-smoke.yml',
      'runtime-stdio-smoke.yml',
      'runtime-transport-qualification.yml',
      'session-log-acl-smoke.yml',
    ]) {
      const source = readFileSync(join(workflowRoot, name), 'utf8');
      expect(source, name).toMatch(
        /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/u,
      );
      expect(source, name).toContain('cancel-in-progress: true');
    }

    for (const name of [
      'runtime-resilience-qualification.yml',
      'release-candidate.yml',
      'platform-capability-probe.yml',
      'execution-boundary-conformance.yml',
    ]) {
      const source = readFileSync(join(workflowRoot, name), 'utf8');
      expect(source, name).not.toContain('cancel-in-progress: true');
    }
  });

  test('keeps the native keyring workflow on the qualification-owned test path', () => {
    const workflow = readFileSync(join(workflowRoot, 'mcp-native-keyring-smoke.yml'), 'utf8');
    const steps = parse(workflow).jobs['native-keyring'].steps as { run?: string; if?: string }[];
    const install = steps.findIndex(({ run }) => run === 'bun install --frozen-lockfile');
    const prepare = steps.findIndex(({ run }) => run === 'bun run prepare:node-inputs');
    expect(prepare).toBeGreaterThan(install);
    expect(steps[prepare]?.if).toBeUndefined();
    for (const [index, { run }] of steps.entries())
      if (run?.includes('tests/isolated/unified-agent/native-credential-platform.test.ts'))
        expect(index).toBeGreaterThan(prepare);
    expect(workflow).toMatch(/push:\n\s+branches: \[main\]/u);
    expect(workflow).toContain('tests/isolated/unified-agent/native-credential-platform.test.ts');
    expect(workflow).not.toContain('tests/qualification/mcp-keyring-platform-smoke.test.ts');
    expect(workflow).not.toContain('tests/mcp-keyring-platform-smoke.test.ts');
  });

  test('bounds platform jobs and keeps stdio owned by one workflow', () => {
    const expectedTimeouts = new Map([
      ['execution-boundary-conformance.yml', 30],
      ['platform-capability-probe.yml', 30],
      ['runtime-stdio-smoke.yml', 15],
      ['runtime-transport-qualification.yml', 15],
      ['session-log-acl-smoke.yml', 15],
    ]);
    for (const [name, timeout] of expectedTimeouts) {
      const source = readFileSync(join(workflowRoot, name), 'utf8');
      expect(source, name).toContain(`timeout-minutes: ${timeout}`);
    }

    const stdio = readFileSync(join(workflowRoot, 'runtime-stdio-smoke.yml'), 'utf8');
    const transport = readFileSync(
      join(workflowRoot, 'runtime-transport-qualification.yml'),
      'utf8',
    );
    expect(stdio).toContain('bun run test:runtime:stdio');
    expect(transport).not.toContain('bun run test:runtime:stdio');
    expect(transport).not.toContain('.github/workflows/runtime-stdio-smoke.yml');
  });

  test('keeps execution-boundary triggers and commands on current test owners', () => {
    const workflow = readFileSync(join(workflowRoot, 'execution-boundary-conformance.yml'), 'utf8');
    const currentPaths = [
      'packages/agent/test/isolated/jobs/confined-shell.test.ts',
      'packages/agent/test/isolated/files/runtime.test.ts',
      'packages/agent/test/isolated/execution/authorization-check.test.ts',
      'apps/service/test/isolated/runtime-assets.test.ts',
      'tests/isolated/unified-agent/formal-optional-capabilities.test.ts',
      'tests/isolated/unified-agent/native-runtime-protection.test.ts',
    ];
    const retiredPaths = [
      'apps/kite-service/',
      'packages/builtin-runtime/',
      'tests/qualification/sandbox/',
      'tests/isolated/workspace/worktree-controller.test.ts',
      'tests/integration/builtin-runtime/',
      'apps/kite-cli/test/policies/protected-path.test.ts',
      'apps/kite-cli/test/sandbox/network-boundary.test.ts',
      'apps/kite-cli/test/sandbox/network-boundary-concurrency.test.ts',
      'tests/policies/protected-path.test.ts',
      'tests/sandbox/network-boundary.test.ts',
      'tests/sandbox/network-boundary-concurrency.test.ts',
      'tests/workspace/worktree-controller.test.ts',
      'tests/mcp-transport-boundary.test.ts',
      'tests/mcp-transport-boundary-concurrency.test.ts',
    ];

    for (const path of currentPaths) {
      expect(existsSync(join(repositoryRoot, path)), path).toBe(true);
      expect(workflow, path).toContain(path);
    }
    for (const path of retiredPaths) expect(workflow, path).not.toContain(path);
  });
});
