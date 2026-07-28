import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const repoRoot = join(import.meta.dir, '..');

function collectFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? collectFiles(path) : [path];
  });
}

function isBunDefaultTestFile(path: string): boolean {
  return /\.(test|spec)\.[cm]?[tj]sx?$/.test(path);
}

describe('test discovery boundaries', () => {
  test('keeps real model suites out of Bun default test discovery', () => {
    const defaultTests = collectFiles(join(repoRoot, 'tests'))
      .map((path) => relative(repoRoot, path))
      .map((path) => path.replace(/\\/g, '/'))
      .filter(isBunDefaultTestFile)
      .filter((path) => path !== 'tests/test-discovery.test.ts');
    const realDefaultTests = defaultTests.filter((path) => path.includes('real'));
    const liveModelDefaultTests = defaultTests.filter((path) => {
      const source = readFileSync(join(repoRoot, path), 'utf8');
      return (
        /createDeepSeekModel\([\s\S]*?\)\.invoke\(/.test(source) ||
        /createChatModel\([\s\S]*?\)\.invoke\(/.test(source) ||
        source.includes('ensureRealModelAvailable(')
      );
    });

    expect(realDefaultTests).toEqual([]);
    expect(liveModelDefaultTests).toEqual([]);
  });

  test('classifies E2E suites by local, live MCP, and live model boundaries', () => {
    const e2eFiles = collectFiles(join(repoRoot, 'tests', 'e2e')).map((path) =>
      relative(repoRoot, path).replace(/\\/g, '/'),
    );
    const liveCode = e2eFiles.filter(
      (path) => path.startsWith('tests/e2e/live/') && /\.[cm]?[tj]sx?$/.test(path),
    );

    expect(
      e2eFiles.filter(
        (path) => /\.(test|spec)\.[cm]?[tj]sx?$/.test(path) && !path.startsWith('tests/e2e/local/'),
      ),
    ).toEqual([]);
    expect(liveCode.every((path) => path.endsWith('.live.ts'))).toBe(true);
    expect(e2eFiles).toContain('tests/e2e/live/mcp/langchain-docs.live.ts');
    expect(e2eFiles).toContain('tests/e2e/live/model/README.md');
    expect(e2eFiles).toContain('tests/e2e/live/model/context-compaction.live.ts');
  });

  test('keeps real-agent and PTY suites out of the default test script', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.test).toContain('scripts/run-unit-tests.ts');
    const unitRunner = readFileSync(join(repoRoot, 'scripts', 'run-unit-tests.ts'), 'utf8');
    expect(unitRunner).toContain('--path-ignore-patterns=tests/tui-system/**');
    expect(unitRunner).toContain('--path-ignore-patterns=tests/pty-spike/**');
    expect(unitRunner).toContain('KITE_UNIT_TEST_TIMEOUT_MS');
    expect(pkg.scripts?.['test:all']).toBe('bun run test && bun run test:tui:system');
    expect(pkg.scripts?.['test:e2e']).toContain('tests/e2e/local/');
    expect(pkg.scripts?.['test:e2e']).not.toContain('tests/tui-system/');
    expect(pkg.scripts?.['test:e2e']).not.toContain('tests/e2e/live/');
    expect(pkg.scripts?.['test:mcp:live']).toContain('tests/e2e/live/mcp/');
    expect(pkg.scripts?.['test:mcp:live']).toContain('bun run');
    expect(pkg.scripts?.['test:model:live']).toContain('tests/e2e/live/model/');
    expect(pkg.scripts?.['test:model:live']).toContain('bun run');
    expect(pkg.scripts?.['test:tui:system']).toContain('scripts/run-tui-system-tests.ts');
    expect(pkg.scripts?.['test:real']).toBeUndefined();
    expect(pkg.scripts?.['test:real:direct']).toBeUndefined();
  });
});
