import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from '#kite-test';
import type { ToolContext } from '../../../src/extensions';
import { createFileTools, createWorkspaceFiles, type WorkspaceFiles } from '../../../src/files';

const roots: string[] = [];
const owners: WorkspaceFiles[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(options: { protectedPaths?: string[]; protectReads?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-search-')));
  roots.push(root);
  const files = createWorkspaceFiles({ root, ...options });
  owners.push(files);
  const put = (path: string, content: string | Buffer) => writeFileSync(join(root, path), content);
  const dir = (path: string) => mkdirSync(join(root, path), { recursive: true });
  return { root, files, put, dir };
}
const context = () => ({ signal: new AbortController().signal }) as ToolContext;

test('single file and directory share literal matching, context and complete low-level lines', async () => {
  const { files, put, dir } = fixture();
  dir('src');
  put('src/a.ts', 'first\nneedle[.*]\nlast\n');
  const file = await files.search({ path: 'src/a.ts', text: 'needle[.*]', contextLines: 1 });
  expect(file.matches).toEqual([
    {
      path: 'src/a.ts',
      line: 2,
      content: 'needle[.*]',
      before: [{ line: 1, content: 'first' }],
      after: [{ line: 3, content: 'last' }],
    },
  ]);
  expect(
    (await files.search({ path: 'src', text: 'needle[.*]', contextLines: 1 })).matches,
  ).toEqual(file.matches);
  put('long', `needle${'x'.repeat(20000)}`);
  expect((await files.search({ path: 'long', text: 'needle' })).matches[0]!.content).toHaveLength(
    20006,
  );
});

test('UTF-8 binary and non-UTF-8 files do not erase text results; scope names current page', async () => {
  const { files, put } = fixture();
  put('a.txt', 'needle');
  put('b.bin', Buffer.from([0, 0, 0, 0]));
  put('c.bin', Buffer.from([0xff, 0x81, 0]));
  put('d.txt', 'needle');
  const result = await files.search({ text: 'needle' });
  expect(result.matches.map((m) => m.path)).toEqual(['a.txt', 'd.txt']);
  expect(result.scope).toMatchObject({
    kind: 'current_page',
    complete: false,
    skipped: { binary: 1, encoding: 1, ignored: 0, links: 0 },
  });
  expect((await files.search({ path: 'c.bin', text: 'needle' })).scope?.complete).toBe(false);
});

test('pages follow full path order including a.ts before a/child; limit does not scan later files', async () => {
  const { files, put, dir } = fixture();
  dir('a');
  put('a.ts', 'needle\nneedle');
  put('a/child', 'needle');
  put('z.bin', Buffer.from([0xff]));
  const first = await files.search({ text: 'needle', limit: 1 });
  expect(first.matches.map((m) => [m.path, m.line])).toEqual([['a.ts', 1]]);
  expect(first.scope?.skipped.encoding ?? 0).toBe(0);
  const second = await files.search({ text: 'needle', limit: 1, after: first.next! });
  expect(second.matches.map((m) => [m.path, m.line])).toEqual([['a.ts', 2]]);
  const third = await files.search({ text: 'needle', limit: 1, after: second.next! });
  expect(third.matches.map((m) => m.path)).toEqual(['a/child']);
  expect(third.next).toBeNull();
  expect(third.scope?.skipped.encoding).toBe(1);
});

test('root ignore, nested negation and explicit scope priorities are visible and reversible', async () => {
  const { files, put, dir } = fixture();
  dir('dist');
  dir('src');
  put('.gitignore', 'dist/\n*.txt\n');
  put('dist/a.ts', 'needle');
  put('src/.gitignore', '!keep.txt\n');
  put('src/keep.txt', 'needle');
  put('src/drop.txt', 'needle');
  const root = await files.search({ text: 'needle', respectIgnore: true });
  expect(root.matches.map((m) => m.path)).toEqual(['src/keep.txt']);
  expect(root.scope?.skipped.ignored).toBe(2);
  expect(root.scope?.complete).toBe(false);
  expect(
    (await files.search({ path: 'dist/a.ts', text: 'needle', respectIgnore: true })).matches,
  ).toHaveLength(1);
  expect(
    (await files.search({ path: 'dist', text: 'needle', respectIgnore: true })).matches,
  ).toHaveLength(0);
  expect(
    (await files.search({ path: 'src', text: 'needle', respectIgnore: true })).matches,
  ).toHaveLength(1);
  expect(
    (await files.search({ path: 'dist', text: 'needle', respectIgnore: false })).matches,
  ).toHaveLength(1);
  expect((await files.search({ text: 'needle', respectIgnore: false })).matches).toHaveLength(3);
});

test('glob includes root/deep matches, explicit file filtering and context previews remain explicit', async () => {
  const { files, put, dir } = fixture();
  dir('src');
  put('a.ts', 'head\nneedle😀abcdef\ntail');
  put('src/b.ts', 'needle');
  put('src/c.js', 'needle');
  const result = await files.search({
    text: 'needle',
    glob: '**/*.ts',
    maxLineChars: 7,
    contextLines: 1,
  });
  expect(result.matches.map((m) => m.path)).toEqual(['a.ts', 'src/b.ts']);
  expect(result.matches[0]).toMatchObject({
    content: 'needle',
    truncated: true,
    originalLength: 14,
    before: [{ line: 1, content: 'head' }],
    after: [{ line: 3, content: 'tail' }],
  });
  expect((await files.search({ text: 'needle', path: 'a.ts', glob: '*.js' })).matches).toEqual([]);
});

test('scoped discovery inherits ancestor ignores without reopening excluded parents', async () => {
  const { files, put, dir } = fixture();
  dir('packages/app/dist');
  dir('packages/hidden/nested');
  put('.gitignore', 'dist/\npackages/hidden/\n*.txt\n');
  put('packages/.gitignore', '!keep.txt\n');
  put('packages/app/a.ts', 'needle');
  put('packages/app/keep.txt', 'needle');
  put('packages/app/drop.txt', 'needle');
  put('packages/app/dist/b.ts', 'needle');
  put('packages/hidden/nested/.gitignore', '!a.ts\n');
  put('packages/hidden/nested/a.ts', 'needle');
  const result = await files.search({ path: 'packages/app', text: 'needle', respectIgnore: true });
  expect(result.matches.map((match) => match.path)).toEqual([
    'packages/app/a.ts',
    'packages/app/keep.txt',
  ]);
  const first = await files.glob({
    path: 'packages/app',
    pattern: '*',
    respectIgnore: true,
    limit: 1,
  });
  const next = await files.glob({
    path: 'packages/app',
    pattern: '*',
    respectIgnore: true,
    after: first.next!,
    limit: 1,
  });
  expect([...first.paths, ...next.paths]).toEqual(['packages/app/a.ts', 'packages/app/keep.txt']);
  expect(next.next).toBeNull();
  expect(
    (await files.glob({ path: 'packages/hidden/nested', pattern: '*', respectIgnore: true })).paths,
  ).toEqual([]);
  const excluded = await files.search({
    path: 'packages/hidden/nested',
    text: 'needle',
    respectIgnore: true,
  });
  expect(excluded.matches).toEqual([]);
  expect(excluded.scope).toMatchObject({ complete: false, skipped: { ignored: 1 } });
  expect(
    (await files.search({ path: 'packages/app/dist/b.ts', text: 'needle', respectIgnore: true }))
      .matches,
  ).toHaveLength(1);
  expect(
    (await files.glob({ path: 'packages/hidden/nested', pattern: '*.ts', respectIgnore: false }))
      .paths,
  ).toEqual(['packages/hidden/nested/a.ts']);
});

test('ignore options cannot grant access to protected files or follow links', async () => {
  const { files, root, put, dir } = fixture({ protectedPaths: ['private'], protectReads: true });
  dir('private');
  put('private/key', 'needle');
  put('a', 'needle');
  symlinkSync(
    join(root, process.platform === 'win32' ? 'private' : 'a'),
    join(root, 'alias'),
    process.platform === 'win32' ? 'junction' : 'file',
  );
  const result = await files.search({ text: 'needle', respectIgnore: false });
  expect(result.matches.map((m) => m.path)).toEqual(['a']);
  expect(result.scope?.skipped.links).toBe(1);
  await expect(
    files.search({ path: 'private/key', text: 'needle', respectIgnore: false }),
  ).rejects.toMatchObject({ code: 'file_path_protected' });
  await expect(files.search({ path: 'alias', text: 'needle' })).rejects.toMatchObject({
    code: 'file_not_regular',
  });
  await expect(files.search({ path: '../a', text: 'needle' })).rejects.toMatchObject({
    code: 'file_path_invalid',
  });
});

test('linked ignore entries are never read and skipped diagnostics are bounded', async () => {
  const { files, root, put, dir } = fixture();
  put('rules', 'a\n');
  put('a', 'needle');
  if (process.platform === 'win32') dir('rule-directory');
  symlinkSync(
    join(root, process.platform === 'win32' ? 'rule-directory' : 'rules'),
    join(root, '.gitignore'),
    process.platform === 'win32' ? 'junction' : 'file',
  );
  for (let i = 0; i < 30; i++) put(`bad${i}`, Buffer.from([0xff]));
  const result = await files.search({ text: 'needle', respectIgnore: true });
  expect(result.matches.map((m) => m.path)).toEqual(['a']);
  expect(result.scope?.skipped.encoding).toBe(30);
  expect(result.scope?.samples).toHaveLength(20);
});

test('content glob filtering and path discovery share invalid pattern boundaries', async () => {
  const { files, put } = fixture();
  put('a.ts', 'needle');
  for (const pattern of [
    '',
    'a\0.ts',
    '/a.ts',
    'C:/a.ts',
    'C:\\a.ts',
    '//server/a',
    './*.ts',
    '../*.ts',
    'a//*.ts',
    '\ud800',
    Array(65).fill('a').join('/'),
  ]) {
    await expect(files.glob({ pattern })).rejects.toMatchObject({ code: 'file_glob_invalid' });
    await expect(files.search({ text: 'needle', glob: pattern })).rejects.toMatchObject({
      code: 'file_glob_invalid',
    });
  }
  expect((await files.search({ text: 'needle', glob: '**/*.ts' })).matches).toHaveLength(1);
});

test('glob and search preserve negation, extglobs, dotfiles and zero-level globstar', async () => {
  const { files, put, dir } = fixture();
  dir('nested');
  for (const path of ['.hidden.ts', 'a.ts', 'b.tsx', 'nested/a.ts', 'nested/z.md'])
    put(path, 'needle');
  for (const [pattern, paths] of [
    ['**/*.{ts,tsx}', ['.hidden.ts', 'a.ts', 'b.tsx', 'nested/a.ts']],
    ['!(a).ts', ['.hidden.ts']],
    ['!*.ts', ['b.tsx', 'nested/z.md']],
    ['!!a.ts', ['a.ts', 'nested/a.ts']],
  ] as const) {
    expect((await files.glob({ pattern })).paths).toEqual([...paths]);
    expect(
      (await files.search({ text: 'needle', glob: pattern })).matches.map((match) => match.path),
    ).toEqual([...paths]);
  }
});

test('read observations distinguish complete selected windows from complete file content', async () => {
  const { files, put } = fixture();
  put('a', 'one\ntwo\nthree\n');
  const tool = createFileTools(files).find((t) => t.id === 'files.read')!;
  const full = JSON.parse((await tool.execute({ path: 'a' }, context())).content);
  expect(full.observation).toMatchObject({
    kind: 'inspection',
    scope: 'a',
    complete: true,
    coverage: 'file',
    windowComplete: true,
    sources: [{ path: 'a', version: full.baseline.hash, fromLine: 1, toLine: 3 }],
  });
  const middle = JSON.parse(
    (await tool.execute({ path: 'a', offset: 2, limit: 1 }, context())).content,
  );
  expect(middle.content).toBe('two\n');
  expect(middle.observation).toMatchObject({
    complete: false,
    coverage: 'window',
    windowComplete: true,
    sources: [{ path: 'a', version: full.baseline.hash, fromLine: 2, toLine: 2 }],
  });
  const suffix = JSON.parse((await tool.execute({ path: 'a', offset: 2 }, context())).content);
  expect(suffix.observation.complete).toBe(false);
  expect(suffix.observation.coverage).toBe('window');
});

test('read excerpts quote the actual selected window and never split Unicode surrogate pairs', async () => {
  const { files, put } = fixture();
  put('a', `outside\n${'x'.repeat(1999)}😀tail\nlast`);
  const tool = createFileTools(files).find((t) => t.id === 'files.read')!;
  const result = JSON.parse(
    (await tool.execute({ path: 'a', offset: 2, limit: 1 }, context())).content,
  );
  expect(result.observation).toMatchObject({
    coverage: 'window',
    complete: false,
    windowComplete: true,
    excerpt: { text: 'x'.repeat(1999), truncated: true },
  });
  expect(result.content).toBe(`${'x'.repeat(1999)}😀tail\n`);
  const last = JSON.parse((await tool.execute({ path: 'a', offset: 3 }, context())).content);
  expect(last.observation.excerpt).toEqual({ text: 'last', truncated: false });
  expect(last.observation.complete).toBe(false);
});

test('large read keeps its original full Artifact body and a separately bounded observation excerpt', async () => {
  const { files, put } = fixture();
  const text = `${'a'.repeat(1999)}😀${'source '.repeat(170000)}`;
  put('large', text);
  const published: { content: Uint8Array; mediaType: string }[] = [];
  const c = {
    signal: new AbortController().signal,
    artifacts: {
      async publish(input: { content: Uint8Array; mediaType: string }) {
        published.push(input);
        return {
          id: 'actual-body',
          size: String(input.content.byteLength),
          mediaType: input.mediaType,
          scope: { kind: 'execution', id: 'read' },
        };
      },
    },
  } as unknown as ToolContext;
  const result = await createFileTools(files)
    .find((t) => t.id === 'files.read')!
    .execute({ path: 'large' }, c);
  expect(result.outcome).toBe('succeeded');
  const summary = JSON.parse(result.content);
  expect(summary.observation).toMatchObject({
    coverage: 'file',
    complete: true,
    excerpt: { text: 'a'.repeat(1999), truncated: true },
  });
  expect(summary.body.complete).toBe(true);
  expect(result.modelContent).toMatchObject({ kind: 'artifact', reference: { id: 'actual-body' } });
  expect(published).toHaveLength(1);
  expect(Buffer.from(published[0]!.content).toString('utf8')).toBe(text);
});

test('pattern-like query feedback preserves literal matches and accurately scoped absence', async () => {
  const { files, put } = fixture();
  put('a', 'fixtures\ndist/\nfixtures|dist/\nvalue.*literal\n\\bword');
  const matched = await files.search({ text: 'fixtures|dist/' });
  expect(matched.matches.map((m) => m.line)).toEqual([3]);
  expect(matched.feedback).toContain('matched literally, not as OR');
  expect(matched.feedback).toContain('does not prove call reachability');
  const missing = await files.search({ text: 'fixtures|absent' });
  expect(missing.matches).toEqual([]);
  expect(missing.feedback).toContain('Use separate literal queries');
  expect(missing.feedback).toContain('differently worded references');
  expect((await files.search({ text: 'value.*literal' })).matches.map((m) => m.line)).toEqual([4]);
  expect((await files.search({ text: '\\bword' })).matches.map((m) => m.line)).toEqual([5]);
  expect((await files.search({ text: 'ordinary literal' })).feedback).not.toContain('pattern-like');
});

test('search cursors bind matching scope and granularity while permitting a different page size', async () => {
  const { files, put } = fixture();
  put('a.ts', 'needle\nneedle');
  put('b.ts', 'needle');
  const query = { text: 'needle', mode: 'files' as const, limit: 1 };
  const first = await files.search(query);
  for (const changed of [
    { mode: 'content' },
    { text: 'different' },
    { path: 'a.ts' },
    { glob: '*.ts' },
    { respectIgnore: true },
  ]) {
    await expect(
      files.search({ ...query, ...changed, after: first.next! } as Parameters<
        typeof files.search
      >[0]),
    ).rejects.toMatchObject({ code: 'file_page_invalid' });
  }
  const second = await files.search({
    ...query,
    limit: 2,
    after: first.next!,
    contextLines: 1,
    maxLineChars: 1,
  });
  expect(second.files!.map((file) => file.path)).toEqual(['b.ts']);
  expect(second.next).toBeNull();
  await expect(files.search({ ...query, after: 'a.ts\u0000000000000001' })).rejects.toMatchObject({
    code: 'file_page_invalid',
  });
});

test('search continuation uses the normalized scope for trailing and repeated separators', async () => {
  const { files, put, dir } = fixture();
  dir('src/nested');
  put('src/nested/a.ts', 'needle\nneedle');
  put('src/nested/b.ts', 'needle');
  for (const mode of ['files', 'content'] as const) {
    for (const path of ['src/', 'src//nested']) {
      const first = await files.search({ text: 'needle', mode, path, limit: 1 });
      expect(first.next).toBeString();
      const second = await files.search({
        text: 'needle',
        mode,
        path,
        limit: 1,
        after: first.next!,
      });
      expect(second.query!.path).toBe(path === 'src/' ? 'src' : 'src/nested');
      expect(mode === 'files' ? second.files![0]!.path : second.matches[0]!.line).toBe(
        mode === 'files' ? 'src/nested/b.ts' : 2,
      );
    }
  }
});
