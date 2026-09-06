import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FORMAL_QUALIFICATION_BUN_VERSION } from '../../../scripts/runtime/verify-fault-soak-qualification';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const workflowRoot = join(repositoryRoot, '.github', 'workflows');

describe('CI Bun baseline', () => {
  test('pins every third-party workflow action to an immutable current-runtime commit', () => {
    const workflows = readdirSync(workflowRoot)
      .filter((name) => name.endsWith('.yml'))
      .map((name) => ({ name, source: readFileSync(join(workflowRoot, name), 'utf8') }));
    const allowed = new Set([
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
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

  test('pins every setup-bun workflow to the formal qualification version', () => {
    expect(FORMAL_QUALIFICATION_BUN_VERSION).toBe('1.4.0');

    const setupWorkflows = readdirSync(workflowRoot)
      .filter((name) => name.endsWith('.yml'))
      .map((name) => ({ name, source: readFileSync(join(workflowRoot, name), 'utf8') }))
      .filter(({ source }) => source.includes('oven-sh/setup-bun'));

    expect(setupWorkflows.length).toBeGreaterThan(0);
    for (const { name, source } of setupWorkflows) {
      const versions = [...source.matchAll(/bun-version:\s*([^\s#]+)/gu)].map((match) => match[1]);
      expect(versions, name).not.toEqual([]);
      expect(new Set(versions), name).toEqual(new Set([FORMAL_QUALIFICATION_BUN_VERSION]));
    }
  });

  test('cancels stale Required runs without cancelling formal evidence workflows', () => {
    const required = readFileSync(join(workflowRoot, 'required.yml'), 'utf8');
    expect(required).toMatch(
      /group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/u,
    );
    expect(required).toContain('cancel-in-progress: true');

    for (const name of ['runtime-resilience-qualification.yml', 'release-candidate.yml']) {
      const source = readFileSync(join(workflowRoot, name), 'utf8');
      expect(source, name).not.toContain('cancel-in-progress: true');
    }
  });

  test('keeps the native keyring workflow on the qualification-owned test path', () => {
    const workflow = readFileSync(join(workflowRoot, 'mcp-native-keyring-smoke.yml'), 'utf8');
    expect(workflow).toContain('tests/qualification/mcp-keyring-platform-smoke.test.ts');
    expect(workflow).not.toContain('tests/mcp-keyring-platform-smoke.test.ts');
  });

  test('keeps execution-boundary triggers and commands on current test owners', () => {
    const workflow = readFileSync(join(workflowRoot, 'execution-boundary-conformance.yml'), 'utf8');
    const currentPaths = [
      'apps/kite-service/test/policies/protected-path.test.ts',
      'apps/kite-service/test/sandbox/network-boundary.test.ts',
      'apps/kite-service/test/sandbox/network-boundary-concurrency.test.ts',
      'tests/qualification/sandbox/process-tree-limit.test.ts',
      'tests/isolated/workspace/worktree-controller.test.ts',
      'tests/integration/builtin-runtime/mcp-transport-boundary.test.ts',
      'packages/builtin-runtime/test/mcp-transport-boundary-concurrency.test.ts',
    ];
    const retiredPaths = [
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

    for (const path of currentPaths) expect(workflow, path).toContain(path);
    for (const path of retiredPaths) expect(workflow, path).not.toContain(path);
  });
});
