/**
 * search 工具非阻塞回归测试
 * Non-blocking regression tests for the search tools.
 *
 * 背景：search_files / search_content 曾以完全同步的方式遍历工作区
 * （readdirSync/statSync/readFileSync）。工具执行期间事件循环被独占，
 * TUI 的动画定时器（StatusBar/ToolCard spinner）无法触发，用户确认工具
 * 授权后 spinner 会冻结到搜索结束。现在 production Local Provider 会在目录、
 * entry 与 content read 之间协作式让出 event loop，同时保留有界、identity-checked I/O。
 *
 * Background: search_files / search_content used to walk the workspace fully
 * synchronously (readdirSync/statSync/readFileSync), holding the event loop
 * for the entire run. TUI animation timers (StatusBar/ToolCard spinners)
 * could not fire, so the spinner froze from the moment the user approved the
 * tool until the search finished. The production Local Provider now yields
 * between directories, entries, and content reads while retaining its bounded,
 * identity-checked filesystem operations.
 *
 * 同步实现下，下面任何测试中的 1ms 定时器在整个搜索期间一次都不会触发
 * （ticks === 0）；协作式遍历下会触发很多次。
 * Under the sync implementation the 1ms timer below would never fire during a
 * search (ticks === 0); the cooperative implementation yields many times.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalWorkspaceFilesystemProviderV1,
  WorkspaceFilesystemGrantAuthorityV1,
  workspaceFilesystemProtectedBoundaryDigestV1,
} from '@kite/builtin-runtime/filesystem';
import { createProtectedPathEvaluatorV1 } from '@kite/builtin-runtime/sandbox';
import type {
  WorkspaceFilesystemObserveOperationV1,
  WorkspaceReadFileOperationV1,
  WorkspaceSearchContentOperationV1,
  WorkspaceSearchFilesOperationV1,
} from '@kite/runtime-spi';

const DIR_COUNT = 25;
const FILES_PER_DIR = 24;
type LocalSearchOperation =
  | Omit<WorkspaceReadFileOperationV1, 'pathScope'>
  | Omit<WorkspaceSearchFilesOperationV1, 'pathScope'>
  | Omit<WorkspaceSearchContentOperationV1, 'pathScope'>;

function localSearch(workspace: string) {
  const authority = new WorkspaceFilesystemGrantAuthorityV1();
  const projection = createProtectedPathEvaluatorV1({
    workspaceRoot: workspace,
    mode: 'deny',
  }).projectFilesystemBoundary();
  const unsignedBoundary = {
    schema: 'kite.workspace-filesystem-protected-boundary.v1' as const,
    ...structuredClone(projection),
  };
  const protectedBoundary = {
    ...unsignedBoundary,
    boundaryDigest: workspaceFilesystemProtectedBoundaryDigestV1(unsignedBoundary),
  };
  const binding = {
    threadId: 'search-nonblocking-thread',
    turnId: 'search-nonblocking-turn',
    toolCallId: 'search-nonblocking-tool',
    invocationId: 'search-nonblocking-invocation',
    attempt: 1,
    intentDigest: `sha256:${'1'.repeat(64)}`,
    searchBoundaryDigest: protectedBoundary.boundaryDigest,
    capabilityRevision: 'search-nonblocking-revision',
    effectDigest: 'search-nonblocking-effect',
    canonicalWorkspace: realpathSync(workspace),
    protectedPathRevision: 'search-nonblocking-protected-path',
    approvalSummary: 'search nonblocking fixture',
  };
  const provider = new LocalWorkspaceFilesystemProviderV1(authority.verifier());
  return (operation: LocalSearchOperation) =>
    provider.observe({
      grant: authority.issueObserveGrant({
        binding,
        operation: {
          ...operation,
          pathScope: 'workspace_only',
        } as WorkspaceFilesystemObserveOperationV1,
        protectedBoundary,
        ttlMs: 30_000,
      }),
    });
}

describe('search tools yield the event loop while walking', () => {
  let workspace: string;

  beforeEach(
    async () => {
      workspace = await mkdtemp(join(tmpdir(), 'openpx-search-nonblock-'));
      for (let d = 0; d < DIR_COUNT; d++) {
        const dir = join(workspace, `pkg-${String(d).padStart(2, '0')}`, 'src');
        await mkdir(dir, { recursive: true });
        for (let f = 0; f < FILES_PER_DIR; f++) {
          const content = [
            `export const value_${d}_${f} = "filler";`,
            `export const needle_${d}_${f} = "needle-${d}-${f}";`,
            '',
          ].join('\r\n');
          await writeFile(join(dir, `file-${String(f).padStart(2, '0')}.ts`), content);
        }
      }
    },
    { timeout: 30_000 },
  );

  afterEach(
    async () => {
      await rm(workspace, { recursive: true, force: true });
    },
    { timeout: 30_000 },
  );

  // setImmediate 轮转计数——比时钟定时器更确定：同步实现下搜索期间计数
  // 不会增长（整个搜索压在一个宏任务里），异步实现下每次 await 都让出。
  // A setImmediate turn counter is more deterministic than wall-clock timers:
  // a sync implementation cannot advance it during the search (the whole run
  // is one macrotask), while every await in the async walk yields a turn.
  function countYields(stop: { current: boolean }): { done: Promise<number> } {
    let yields = 0;
    const done = (async () => {
      while (!stop.current) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        yields++;
      }
      return yields;
    })();
    return { done };
  }

  test(
    'search_files yields the event loop and still returns sorted matches',
    async () => {
      let ticks = 0;
      const timer = setInterval(() => {
        ticks++;
      }, 1);
      const stop = { current: false };
      const { done } = countYields(stop);
      const search = localSearch(workspace);
      let result: Awaited<ReturnType<typeof search>>;
      try {
        result = await search({ kind: 'search_files', path: '.', pattern: '*.ts' });
      } finally {
        stop.current = true;
        clearInterval(timer);
      }
      const yields = await done;

      // 同步遍历下 yields 至多为 1（搜索结束后才轮到计数协程）。
      // Under a sync walk yields is at most 1 (the counter only resumes after).
      expect(yields).toBeGreaterThan(2);
      expect(ticks).toBeGreaterThan(0);
      expect(result.ok).toBe(true);
      if (!result.ok || result.observation.kind !== 'search_files') {
        throw new Error('Local search_files failed');
      }
      expect(result.observation.matches).toHaveLength(DIR_COUNT * FILES_PER_DIR);
      expect(result.observation.matches).toEqual([...result.observation.matches].sort());
    },
    { timeout: 30_000 },
  );

  test(
    'search_content yields the event loop and keeps line-accurate matches',
    async () => {
      let ticks = 0;
      const timer = setInterval(() => {
        ticks++;
      }, 1);
      const stop = { current: false };
      const { done } = countYields(stop);
      const search = localSearch(workspace);
      let result: Awaited<ReturnType<typeof search>>;
      try {
        result = await search({ kind: 'search_content', path: '.', pattern: 'needle_12_7' });
      } finally {
        stop.current = true;
        clearInterval(timer);
      }
      const yields = await done;

      expect(yields).toBeGreaterThan(2);
      expect(ticks).toBeGreaterThan(0);
      expect(result.ok).toBe(true);
      if (!result.ok || result.observation.kind !== 'search_content') {
        throw new Error('Local search_content failed');
      }
      expect(result.observation.matches).toContainEqual({
        path: 'pkg-12/src/file-07.ts',
        line: 2,
        text: 'export const needle_12_7 = "needle-12-7";',
      });
    },
    { timeout: 30_000 },
  );

  test(
    'search_content glob filter still applies',
    async () => {
      const result = await localSearch(workspace)({
        kind: 'search_content',
        path: '.',
        pattern: 'value_0_0',
        glob: '*.ts',
      });
      if (!result.ok || result.observation.kind !== 'search_content') {
        throw new Error('Local glob search failed');
      }
      expect(result.observation.matches).toContainEqual({
        path: 'pkg-00/src/file-00.ts',
        line: 1,
        text: 'export const value_0_0 = "filler";',
      });
    },
    { timeout: 30_000 },
  );

  test(
    'search_files refuses paths outside the workspace',
    async () => {
      const result = await localSearch(workspace)({
        kind: 'search_files',
        path: '../outside',
        pattern: '*.ts',
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('outside search unexpectedly succeeded');
      expect(result.failure.code).toBe('path_outside_workspace');
    },
    { timeout: 30_000 },
  );
});

describe('Builtin filesystem Provider read decoding', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'openpx-read-async-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test('read_file normalizes UTF-8 CRLF and remains deterministic', async () => {
    await writeFile(join(workspace, 'a.txt'), 'alpha\r\nbeta\r\n');
    const observe = localSearch(workspace);
    const first = await observe({ kind: 'read_file', path: 'a.txt' });
    const second = await observe({ kind: 'read_file', path: 'a.txt' });
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok || first.observation.kind !== 'read_file') {
      throw new Error('CRLF read unexpectedly failed');
    }
    expect(first.observation.rawContent).toBe('alpha\nbeta\n');
    expect(first.observation.totalLines).toBe(2);
  });

  test('read_file rejects binary content', async () => {
    await writeFile(join(workspace, 'bin.dat'), Buffer.alloc(1024, 0x00));
    const result = await localSearch(workspace)({ kind: 'read_file', path: 'bin.dat' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('binary read unexpectedly succeeded');
    expect(result.failure.code).toBe('binary_file');
  });

  test('read_file reports a missing target through Provider failure taxonomy', async () => {
    const result = await localSearch(workspace)({ kind: 'read_file', path: 'missing.txt' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('missing read unexpectedly succeeded');
    expect(result.failure.code).toBe('not_found');
  });
});
