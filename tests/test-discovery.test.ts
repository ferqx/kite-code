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

  test('keeps real-agent and PTY scenarios out while admitting deterministic TUI harness tests', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const defaultRunner = readFileSync(join(repoRoot, 'scripts', 'run-default-tests.ts'), 'utf8');
    const writerTests = readFileSync(
      join(repoRoot, 'tests', 'session-logger', 'writer.test.ts'),
      'utf8',
    );

    expect(pkg.scripts?.test).toContain('scripts/run-default-tests.ts');
    expect(defaultRunner).not.toContain("'tests/tui-system/**'");
    expect(defaultRunner).toContain("'tests/tui-system/scenarios/**'");
    expect(defaultRunner).toContain("'tests/tui-system/smoke/**'");
    expect(defaultRunner).toContain("'tests/pty-spike/**'");
    expect(defaultRunner).toContain("'tests/sandbox-executor.test.ts'");
    expect(defaultRunner).toContain("'tests/sandbox-bwrap-executor.test.ts'");
    expect(defaultRunner).toContain("'tests/mcp-config-catalog.test.ts'");
    expect(defaultRunner).toContain("'tests/runtime/plan-artifacts.test.ts'");
    expect(defaultRunner).toContain('KITE_CODE_HOME: testHome');
    expect(defaultRunner).toContain('HOME: testHome');
    expect(writerTests).toContain('process.env.KITE_CODE_HOME = isolatedHome');
    expect(writerTests).toContain("mkdtempSync(join(tmpdir(), 'kite-code-writer-test-'))");
    expect(pkg.scripts?.['test:all']).toBe('bun run test && bun run test:tui:system');
    expect(pkg.scripts?.['test:e2e']).toContain('tests/e2e/local/');
    expect(pkg.scripts?.['test:e2e']).not.toContain('tests/tui-system/');
    expect(pkg.scripts?.['test:e2e']).not.toContain('tests/e2e/live/');
    expect(pkg.scripts?.['test:mcp:live']).toContain('tests/e2e/live/mcp/');
    expect(pkg.scripts?.['test:mcp:live']).toContain('bun run');
    expect(pkg.scripts?.['test:model:live']).toContain('tests/e2e/live/model/');
    expect(pkg.scripts?.['test:model:live']).toContain('bun run');
    expect(pkg.scripts?.['test:first-decision:live']).toBe(
      'bun run scripts/evals/first-decision-eval.ts',
    );
    expect(pkg.scripts?.['test:prompt:live']).toBe('bun run scripts/evals/first-decision-eval.ts');
    expect(pkg.scripts?.['test:prompt-cache:live']).toBe(
      'bun run scripts/evals/prompt-cache-transition.ts',
    );
    expect(pkg.scripts?.['test:task-journey:live']).toBe(
      'bun run scripts/evals/live-task-journey.ts',
    );
    expect(pkg.scripts?.['test:tui:system']).toContain('scripts/run-tui-system-tests.ts');
    expect(pkg.scripts?.['test:tui:harness']).toContain('tests/tui-system/harness/');
    expect(pkg.scripts?.['test:sandbox:smoke:native']).toContain('tests/sandbox-executor.test.ts');
    expect(pkg.scripts?.['test:sandbox:smoke:native']).toContain(
      'tests/sandbox-bwrap-executor.test.ts',
    );
    expect(pkg.scripts?.['test:real']).toBeUndefined();
    expect(pkg.scripts?.['test:real:direct']).toBeUndefined();
  });
});
