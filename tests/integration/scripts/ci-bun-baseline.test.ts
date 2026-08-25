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
});
