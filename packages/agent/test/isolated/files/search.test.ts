import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  expect(await files.search({ path: 'src', text: 'needle[.*]', contextLines: 1 })).toEqual(file);
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
  ).toHaveLength(1);
  expect(
    (await files.search({ path: 'src', text: 'needle', respectIgnore: true })).matches,
  ).toHaveLength(2);
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

test('model search v3 bounds results/line previews by default and exposes recoverable path errors', async () => {
  const { files, put } = fixture();
  put('a', Array.from({ length: 120 }, () => `needle${'x'.repeat(2100)}`).join('\n'));
  const tool = createFileTools(files).find((t) => t.id === 'files.search')!;
  expect(tool.version).toBe('3');
  const result = await tool.execute({ text: 'needle' }, context());
  expect(result.outcome).toBe('succeeded');
  const body = JSON.parse(result.content);
  expect(body.matches).toHaveLength(100);
  expect(body.matches[0]).toMatchObject({ truncated: true, originalLength: 2106 });
  expect(body.matches[0].content).toHaveLength(2000);
  expect(body.next).not.toBeNull();
  expect(body.scope).toMatchObject({ kind: 'current_page', complete: false });
  const missing = await tool.execute({ path: 'missing.ts', text: 'needle' }, context());
  expect(missing.outcome).toBe('failed');
  expect(missing.content).toContain('does not exist');
  expect(missing.details).toMatchObject({ code: 'ENOENT', next_action: expect.any(String) });
  const component = await tool.execute({ path: 'a/b', text: 'needle' }, context());
  expect(component.content).toContain('path component is not a directory');
});

test('ignore options cannot grant access to protected files or follow links', async () => {
  const { files, root, put, dir } = fixture({ protectedPaths: ['private'], protectReads: true });
  dir('private');
  put('private/key', 'needle');
  put('a', 'needle');
  symlinkSync(join(root, 'a'), join(root, 'alias'));
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

test('symlink ignore files are never read and skipped diagnostics are bounded', async () => {
  const { files, root, put } = fixture();
  put('rules', 'a\n');
  put('a', 'needle');
  symlinkSync(join(root, 'rules'), join(root, '.gitignore'));
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
