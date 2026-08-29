import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeAgentApiPackages } from '../../../scripts/check-agent-api-packages';

const repositoryRoot = join(import.meta.dir, '..', '..', '..');
const fixtures: string[] = [];

afterEach(() => {
  for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

function repositoryFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'kite-agent-api-package-'));
  fixtures.push(root);
  cpSync(
    join(repositoryRoot, 'packages', 'agent-api-contract'),
    join(root, 'packages', 'agent-api-contract'),
    {
      recursive: true,
    },
  );
  for (const path of [
    'package.json',
    'scripts/run-default-tests.ts',
    'scripts/run-runtime-workspace-script.ts',
  ]) {
    cpSync(join(repositoryRoot, path), join(root, path), { recursive: true });
  }
  mkdirSync(join(root, 'apps/kite-service/src/agent-api'), { recursive: true });
  cpSync(
    join(repositoryRoot, 'apps/kite-service/package.json'),
    join(root, 'apps/kite-service/package.json'),
  );
  writeFileSync(
    join(root, 'apps/kite-service/src/agent-api/context.ts'),
    "import { AGENT_API_VERSION } from '@kite-ai/agent-api-contract';\nexport const version = AGENT_API_VERSION;\n",
  );
  return root;
}

describe('Agent API package boundary gate', () => {
  test('accepts the repository contract workspace', () => {
    expect(analyzeAgentApiPackages(repositoryRoot)).toEqual([]);
  });

  test('rejects a private Runtime dependency and an unregistered runner', () => {
    const root = repositoryFixture();
    const packagePath = join(root, 'packages/agent-api-contract/package.json');
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies['@kite-ai/runtime-contract'] = 'workspace:*';
    writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(root, 'scripts/run-default-tests.ts'), 'export {};\n');
    expect(analyzeAgentApiPackages(root).map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['DEPENDENCY_BOUNDARY_INVALID', 'WORKSPACE_RUNNER_MISSING']),
    );
  });
});
