import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createFileTools, createWorkspaceFiles } from '../../../src/files';
import { openSqliteStore } from '../../../src/sqlite';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-files-product-')));
  const files = createWorkspaceFiles({ root });
  return {
    root,
    files,
    async close() {
      await files.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('read line pages retain full-byte baseline, BOM/CRLF and continuation; same-mtime unselected edit conflicts', async () => {
  const f = fixture();
  try {
    const text = '\uFEFFfirst\r\nsecond\r\nthird\n';
    writeFileSync(join(f.root, 'text'), text);
    const full = await f.files.read('text');
    expect(full.content).toBe(text);
    expect(full.selection).toEqual({ fromLine: 1, toLine: 3, totalLines: 3, nextOffset: null });
    const first = await f.files.read('text', { limit: 1 });
    const second = await f.files.read('text', { offset: first.selection!.nextOffset!, limit: 1 });
    const third = await f.files.read('text', { offset: second.selection!.nextOffset! });
    expect(first.content + second.content + third.content).toBe(text);
    expect(first.baseline).toEqual(full.baseline);
    expect(second.baseline).toEqual(full.baseline);
    expect(first.baseline.hash).toBe(createHash('sha256').update(Buffer.from(text)).digest('hex'));
    expect(third.selection!.nextOffset).toBeNull();
    expect((await f.files.read('text', { offset: 2 })).content).toBe('second\r\nthird\n');
    expect((await f.files.read('text', { offset: 100 })).selection!.toLine).toBeNull();
    for (const range of [{ offset: 0 }, { limit: 0 }, { limit: 1.5 }, { offset: NaN }])
      await expect(f.files.read('text', range)).rejects.toMatchObject({
        code: 'file_read_range_invalid',
      });
    const before = statSync(join(f.root, 'text'));
    writeFileSync(join(f.root, 'text'), text.replace('third', 'other'));
    utimesSync(join(f.root, 'text'), before.atime, before.mtime);
    await expect(
      f.files.write({ path: 'text', content: 'must not publish', base: first.baseline }),
    ).rejects.toMatchObject({ code: 'file_baseline_conflict' });
    expect((await f.files.read('text', { limit: 1 })).content).toBe(first.content);
    expect((await f.files.read('text', { limit: 1 })).baseline.hash).not.toBe(first.baseline.hash);
    writeFileSync(join(f.root, 'empty'), '');
    expect((await f.files.read('empty')).selection).toEqual({
      fromLine: 1,
      toLine: null,
      totalLines: 0,
      nextOffset: null,
    });
  } finally {
    await f.close();
  }
});

test('glob ** matches zero/deep directories with stable complete pagination and no symlink traversal', async () => {
  const f = fixture();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'kite-glob-outside-')));
  try {
    mkdirSync(join(f.root, 'nested/deep'), { recursive: true });
    for (const path of [
      'root.ts',
      'nested/a.ts',
      'nested/deep/b.ts',
      'nested/deep/c.tsx',
      'other.txt',
    ])
      writeFileSync(join(f.root, path), 'local');
    writeFileSync(join(outside, 'secret.ts'), 'secret');
    symlinkSync(outside, join(f.root, 'escape'));
    symlinkSync(join(outside, 'secret.ts'), join(f.root, 'secret.ts'));
    const full = await f.files.glob({ pattern: '**/*.ts' });
    expect(full.paths).toEqual(['nested/a.ts', 'nested/deep/b.ts', 'root.ts']);
    expect(full.next).toBeNull();
    const pages: string[] = [];
    let after: string | undefined;
    do {
      const page = await f.files.glob({
        pattern: '**/*.ts',
        limit: 1,
        ...(after ? { after } : {}),
      });
      pages.push(...page.paths);
      after = page.next ?? undefined;
    } while (after);
    expect(pages).toEqual(full.paths);
    expect((await f.files.glob({ pattern: '*.ts' })).paths).toEqual(full.paths);
    expect((await f.files.glob({ pattern: '**/*.{ts,tsx}', path: 'nested' })).paths).toEqual([
      'nested/a.ts',
      'nested/deep/b.ts',
      'nested/deep/c.tsx',
    ]);
    expect((await f.files.glob({ pattern: '**/*.ts', path: 'nested/deep' })).paths).toEqual([
      'nested/deep/b.ts',
    ]);
    for (const pattern of ['../*.ts', '/tmp/*.ts', 'a/../../b', 'a\\*.ts', '\ud800'])
      await expect(f.files.glob({ pattern })).rejects.toMatchObject({ code: 'file_glob_invalid' });
    await expect(f.files.glob({ pattern: '**/*.ts', path: 'escape' })).rejects.toBeDefined();
    await expect(f.files.glob({ pattern: '**/*.ts', path: '../outside' })).rejects.toMatchObject({
      code: 'file_path_invalid',
    });
    await expect(
      f.files.glob({ pattern: '**/*.ts', path: 'nested', after: 'root.ts' }),
    ).rejects.toMatchObject({ code: 'file_page_invalid' });
  } finally {
    await f.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test('real UnifiedExecution dispatches paged read/glob; denied requests have zero adapter I/O', async () => {
  const f = fixture();
  const store = await openSqliteStore({ dataRoot: join(f.root, 'data'), profile: 'local' });
  const finish: ModelEvent = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const call = (name: string, input: unknown): ModelEvent[] => [
    { type: 'tool_call', id: 'call', name, arguments: JSON.stringify(input) },
    { ...finish, reason: 'tool_calls' },
  ];
  writeFileSync(join(f.root, 'root.ts'), 'one\ntwo\nthree\n');
  let io = 0;
  const counted = {
    ...f.files,
    async read(...args: Parameters<typeof f.files.read>) {
      io++;
      return f.files.read(...args);
    },
    async glob(...args: Parameters<typeof f.files.glob>) {
      io++;
      return f.files.glob(...args);
    },
  };
  const model = createFixedModel([
    call('files.read', { path: 'root.ts', offset: 2, limit: 1 }),
    [finish],
    call('files.glob', { pattern: '**/*.ts' }),
    [finish],
    call('files.read', { path: 'root.ts' }),
    [finish],
    call('files.glob', { pattern: '**/*.ts' }),
    [finish],
  ]);
  let deny = false;
  const runtime = createRuntime({
    store,
    model,
    extensions: [{ id: 'files', version: '1', apiMajor: 1, tools: createFileTools(counted) }],
    permissions: {
      async authorize(request) {
        return { allowed: !(deny && request.definitionId.startsWith('files.')), revision: '1' };
      },
    },
  });
  try {
    const id = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId: id,
      id: 'w',
      rootUri: `file://${f.root}`,
      name: 'local',
    });
    await runtime.createSession({
      expectedStoreId: id,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      subjectId: 'owner',
      title: 'files',
    });
    const submit = async (commandId: string) => {
      await runtime.submitCommand({
        expectedStoreId: id,
        commandId,
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: commandId },
      });
      await runtime.waitForCommand(commandId);
    };
    await submit('read');
    await submit('glob');
    const records = await store.listExecutions('s');
    const read = records.find((value) => value.definitionId === 'files.read')!;
    const glob = records.find((value) => value.definitionId === 'files.glob')!;
    expect(read).toMatchObject({ status: 'succeeded', definitionVersion: '3' });
    expect(JSON.parse((read.result as { content: string }).content).content).toBe('two\n');
    expect(JSON.parse((read.result as { content: string }).content).baseline).toEqual(
      (await f.files.read('root.ts')).baseline,
    );
    expect(JSON.parse((glob.result as { content: string }).content).paths).toEqual(['root.ts']);
    expect(io).toBe(2);
    deny = true;
    await submit('denied-read');
    await submit('denied-glob');
    expect(io).toBe(2);
    expect(
      (await store.listExecutions('s')).filter(
        (value) => value.kind === 'tool' && value.status === 'failed',
      ),
    ).toHaveLength(2);
    expect(existsSync(join(f.root, 'root.ts'))).toBe(true);
  } finally {
    await runtime.close();
    await f.close();
  }
});

test('glob traverses formerly capped directory count; paged large read keeps full baseline', async () => {
  const f = fixture();
  try {
    const content = 'short line\n'.repeat(200000);
    writeFileSync(join(f.root, 'large'), content);
    const tool = createFileTools(f.files).find((value) => value.id === 'files.read')!;
    const context = { signal: new AbortController().signal } as Parameters<typeof tool.execute>[1];
    const full = await tool.execute({ path: 'large' }, context);
    expect(full).toMatchObject({
      outcome: 'failed',
      details: { code: 'artifact_publication_unavailable' },
    });
    const page = await tool.execute({ path: 'large', offset: 2, limit: 2 }, context);
    expect(page.outcome).toBe('succeeded');
    const result = JSON.parse(page.content);
    expect(result.content).toBe('short line\nshort line\n');
    expect(result.baseline.hash).toBe(createHash('sha256').update(content).digest('hex'));
    expect(result.baseline.size).toBe(Buffer.byteLength(content));
    expect(result.selection.nextOffset).toBe(4);
    for (let index = 0; index < 256; index++) mkdirSync(join(f.root, `d${index}`));
    writeFileSync(join(f.root, 'root.ts'), 'root');
    expect((await f.files.glob({ pattern: '**/*.ts' })).paths).toEqual(['root.ts']);
  } finally {
    await f.close();
  }
});
