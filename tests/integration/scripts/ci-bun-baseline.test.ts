import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FORMAL_QUALIFICATION_BUN_VERSION } from '../../../scripts/runtime/verify-fault-soak-qualification';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const workflowRoot = join(repositoryRoot, '.github', 'workflows');

describe('CI Bun baseline', () => {
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
      'apps/kite-cli/test/policies/protected-path.test.ts',
      'apps/kite-cli/test/sandbox/network-boundary.test.ts',
      'apps/kite-cli/test/sandbox/network-boundary-concurrency.test.ts',
      'tests/qualification/sandbox/process-tree-limit.test.ts',
      'tests/isolated/workspace/worktree-controller.test.ts',
      'tests/integration/builtin-runtime/mcp-transport-boundary.test.ts',
      'packages/builtin-runtime/test/mcp-transport-boundary-concurrency.test.ts',
    ];
    const retiredPaths = [
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
