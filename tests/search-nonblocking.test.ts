/**
 * search 工具非阻塞回归测试
 * Non-blocking regression tests for the search tools.
 *
 * 背景：search_files / search_content 曾以完全同步的方式遍历工作区
 * （readdirSync/statSync/readFileSync）。工具执行期间事件循环被独占，
 * TUI 的动画定时器（StatusBar/ToolCard spinner）无法触发，用户确认工具
 * 授权后 spinner 会冻结到搜索结束。现在遍历全部走 node:fs/promises，
 * 每次 await 让出事件循环。
 *
 * Background: search_files / search_content used to walk the workspace fully
 * synchronously (readdirSync/statSync/readFileSync), holding the event loop
 * for the entire run. TUI animation timers (StatusBar/ToolCard spinners)
 * could not fire, so the spinner froze from the moment the user approved the
 * tool until the search finished. The walk now uses node:fs/promises, and
 * every await yields the event loop.
 *
 * 同步实现下，下面任何测试中的 1ms 定时器在整个搜索期间一次都不会触发
 * （ticks === 0）；异步实现下会触发很多次。
 * Under the sync implementation the 1ms timer below would never fire during a
 * search (ticks === 0); the async implementation yields many times.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTextContent, readTextContentAsync } from '../src/core/tools/file';
import { searchContent, searchFiles } from '../src/core/tools/search';

const DIR_COUNT = 25;
const FILES_PER_DIR = 24;

describe('search tools yield the event loop while walking', () => {
  let workspace: string;

  beforeEach(async () => {
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
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

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

  test('search_files yields the event loop and still returns sorted matches', async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 1);
    const stop = { current: false };
    const { done } = countYields(stop);
    let result: Awaited<ReturnType<typeof searchFiles>>;
    try {
      result = await searchFiles({ workspace, pattern: '*.ts' });
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
    const lines = result.stdout.split('\n').filter(Boolean);
    expect(lines.length).toBe(DIR_COUNT * FILES_PER_DIR);
    const sorted = [...lines].sort();
    expect(lines).toEqual(sorted);
  });

  test('search_content yields the event loop and keeps line-accurate matches', async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 1);
    const stop = { current: false };
    const { done } = countYields(stop);
    let result: Awaited<ReturnType<typeof searchContent>>;
    try {
      result = await searchContent({ workspace, pattern: 'needle_12_7' });
    } finally {
      stop.current = true;
      clearInterval(timer);
    }
    const yields = await done;

    expect(yields).toBeGreaterThan(2);
    expect(ticks).toBeGreaterThan(0);
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain(
      'pkg-12/src/file-07.ts:2:export const needle_12_7 = "needle-12-7";',
    );
  });

  test('search_content glob filter still applies', async () => {
    const result = await searchContent({ workspace, pattern: 'value_0_0', glob: '*.ts' });
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('pkg-00/src/file-00.ts:1:export const value_0_0 = "filler";');
  });

  test('search_files refuses paths outside the workspace', async () => {
    const result = await searchFiles({ workspace, path: '../outside', pattern: '*.ts' });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('Refusing search outside workspace');
  });
});

describe('readTextContentAsync mirrors readTextContent', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'openpx-read-async-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test('identical decode for UTF-8 with CRLF', async () => {
    await writeFile(join(workspace, 'a.txt'), 'alpha\r\nbeta\r\n');
    const sync = readTextContent(workspace, 'a.txt');
    const async = await readTextContentAsync(workspace, 'a.txt');
    expect(async).toEqual(sync);
    // content 保留尾换行（与同步入口一致），totalLines 不计尾空行
    // content keeps its trailing newline (same as the sync entry); totalLines
    // does not count the trailing empty line.
    expect(async).toEqual({ ok: true, content: 'alpha\nbeta\n', totalLines: 2 });
  });

  test('identical binary detection', async () => {
    await writeFile(join(workspace, 'bin.dat'), Buffer.alloc(1024, 0x00));
    const sync = readTextContent(workspace, 'bin.dat');
    const async = await readTextContentAsync(workspace, 'bin.dat');
    expect(async).toEqual(sync);
    expect(async.ok).toBe(false);
  });

  test('identical not-found error', async () => {
    const sync = readTextContent(workspace, 'missing.txt');
    const async = await readTextContentAsync(workspace, 'missing.txt');
    expect(async).toEqual(sync);
    expect(async).toEqual({ ok: false, error: 'File not found: missing.txt', totalLines: 0 });
  });
});
