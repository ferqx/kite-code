import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelRequest } from '@kite-ai/ai';
import type { ToolContext } from '../../../src/extensions';
import { createFileTools, createWorkspaceFiles, type WorkspaceFiles } from '../../../src/files';
import { createModelToolSurface, modelToolCall } from '../../../src/model-tools';

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

test('model search v5 content mode bounds results/line previews by default and exposes recoverable path errors', async () => {
  const { files, put } = fixture();
  put('a', Array.from({ length: 120 }, () => `needle${'x'.repeat(2100)}`).join('\n'));
  const tool = createFileTools(files).find((t) => t.id === 'files.search')!;
  expect(tool.version).toBe('5');
  const result = await tool.execute({ text: 'needle', mode: 'content' }, context());
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

test('search metadata records normalized parameters, actual lookahead statistics and one returned baseline per file', async () => {
  const { root, files, put, dir } = fixture();
  dir('src');
  put('src/a.ts', 'needle\nneedle\nneedle');
  const tool = createFileTools(files).find((t) => t.id === 'files.search')!;
  const result = await tool.execute(
    { path: join(root, 'src'), text: 'needle', mode: 'content', limit: 1 },
    context(),
  );
  const page = JSON.parse(result.content);
  expect(page.query).toEqual({
    mode: 'content',
    path: 'src',
    text: 'needle',
    glob: null,
    respectIgnore: true,
    after: null,
    limit: 1,
    contextLines: 0,
    maxLineChars: 2000,
  });
  expect(page.stats).toEqual({
    checkedTextFiles: 1,
    matchedFiles: 1,
    matches: 2,
    returnedMatches: 1,
  });
  expect(page.files).toHaveLength(1);
  const snapshot = await files.read('src/a.ts');
  expect(page.files[0]).toEqual({ path: 'src/a.ts', baseline: snapshot.baseline });
  expect(page.observation).toMatchObject({
    kind: 'lookup',
    scope: 'src',
    sources: [{ path: 'src/a.ts', version: snapshot.baseline.hash }],
    matchCount: 1,
    complete: false,
    coverage: 'page',
    next: page.next,
  });
  expect(page.feedback).toContain('Continue with next');
  const tail = JSON.parse(
    (
      await tool.execute(
        { path: 'src', text: 'needle', mode: 'content', after: page.next },
        context(),
      )
    ).content,
  );
  expect(tail.next).toBeNull();
  expect(tail.observation.complete).toBe(false);
  put('src/a.ts', 'needle changed');
  const changed = await files.search({ path: 'src/a.ts', text: 'needle' });
  expect(changed.files![0]!.baseline.hash).not.toBe(snapshot.baseline.hash);
  expect(changed.files![0]!.baseline).toEqual((await files.read('src/a.ts')).baseline);
});

test('zero matches retain partial-scope facts rather than implying absence', async () => {
  const { files, put } = fixture();
  put('text', 'unrelated');
  put('encoded', Buffer.from([0xff]));
  const tool = createFileTools(files).find((t) => t.id === 'files.search')!;
  const page = JSON.parse((await tool.execute({ text: 'needle' }, context())).content);
  expect(page.query.path).toBe('');
  expect(page.stats).toEqual({
    checkedTextFiles: 1,
    matchedFiles: 0,
    returnedFiles: 0,
  });
  expect(page.files).toEqual([]);
  expect(page.observation).toMatchObject({
    sources: [],
    matchCount: 0,
    complete: false,
    coverage: 'page',
  });
  expect(page.scope.skipped.encoding).toBe(1);
  expect(page.feedback).toContain('does not establish which implementation is active');
  expect(page.feedback).toContain('not inspected');
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

test('legacy search adapters without observation metadata keep their original successful result', async () => {
  const { files } = fixture();
  const adapter = new Proxy(files, {
    get(target, key) {
      if (key === 'search') return async () => ({ matches: [], next: null });
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const tool = createFileTools(adapter).find((t) => t.id === 'files.search')!;
  const result = await tool.execute({ text: 'needle', mode: 'content' }, context());
  expect(result.outcome).toBe('succeeded');
  expect(JSON.parse(result.content)).toEqual({ matches: [], next: null });
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

test('default file location pages return each file once with a complete baseline and no archive body', async () => {
  const { files, put, dir } = fixture();
  dir('a');
  dir('archive');
  put('a.ts', `head\n${'needle archive body\n'.repeat(1000)}`);
  put('a/child.ts', 'needle child');
  put('archive/old.ts', 'needle legacy');
  const tool = createFileTools(files).find((t) => t.id === 'files.search')!;
  const paths: string[] = [];
  let after: string | undefined;
  for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
    const result = await tool.execute(
      { text: 'needle', limit: 1, ...(after ? { after } : {}) },
      context(),
    );
    const page = JSON.parse(result.content);
    expect(page.query.mode).toBe('files');
    expect(page.matches).toEqual([]);
    expect(page.stats.returnedFiles).toBe(1);
    expect(page.stats.matches).toBeUndefined();
    expect(page.stats.returnedMatches).toBeUndefined();
    expect(page.observation).toMatchObject({ matchUnit: 'files', matchCount: 1 });
    const file = page.files[0];
    paths.push(file.path);
    expect(file.baseline).toEqual((await files.read(file.path)).baseline);
    expect(file.firstMatchLine).toBe(pageNumber === 0 ? 2 : 1);
    expect(result.content).not.toContain('needle archive body');
    expect(tool.formatModelResult!({ result })).toContain('body not returned');
    if (pageNumber < 2) expect(page.next).toBeString();
    else expect(page.next).toBeNull();
    after = page.next ?? undefined;
  }
  expect(paths).toEqual(['a.ts', 'a/child.ts', 'archive/old.ts']);
  const explicit = await files.search({ text: 'needle', path: 'a.ts', mode: 'files', limit: 1 });
  expect(explicit.next).toBeNull();
  expect(explicit.files).toHaveLength(1);
  expect(explicit.files![0]!.firstMatchLine).toBe(2);
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

test('actual projected declarations and formatted continuation values drive read and search next pages', async () => {
  const { files, put } = fixture();
  put('a', 'needle\nneedle');
  put('b', 'needle');
  const tools = createFileTools(files);
  const request: ModelRequest = {
    modelId: 'fixture',
    requestId: 'request',
    messages: [],
    tools: tools.map((tool) => ({
      id: tool.id,
      definitionVersion: tool.version,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
  const surface = createModelToolSurface(request, new Map(tools.map((tool) => [tool.id, tool])));
  const read = tools.find((tool) => tool.id === 'files.read')!;
  const search = tools.find((tool) => tool.id === 'files.search')!;
  expect(surface.tools.find((tool) => tool.id === 'read_file')!.description).toContain(
    'next_line as start_line',
  );
  const schema = surface.tools.find((tool) => tool.id === 'search_content')!;
  expect(schema.description).toContain('next_cursor as cursor');
  expect(schema.inputSchema.properties).toHaveProperty('cursor');
  expect(schema.inputSchema.properties).not.toHaveProperty('after');
  async function invoke(name: string, input: Record<string, unknown>) {
    const call = surface.decode({ id: 'call', name, arguments: JSON.stringify(input) });
    expect(call.model?.error).toBeUndefined();
    expect(modelToolCall(call)).toEqual({ id: 'call', name, arguments: JSON.stringify(input) });
    const tool = tools.find((tool) => tool.id === call.name)!;
    const result = await tool.execute(JSON.parse(call.arguments), context());
    expect(result.outcome).toBe('succeeded');
    return { raw: JSON.parse(result.content), text: tool.formatModelResult!({ result })! };
  }
  const r1 = await invoke('read_file', { path: 'a', max_lines: 1 });
  const line = /^.*next_line=(\d+);/m.exec(r1.text)![1];
  const r2 = await invoke('read_file', { path: 'a', start_line: Number(line), max_lines: 1 });
  expect(r2.raw.selection).toMatchObject({ fromLine: 2, nextOffset: null });
  const p1 = await invoke('search_content', { text: 'needle', limit: 1 });
  const cursor = JSON.parse(/^next_cursor=(.*)$/m.exec(p1.text)![1]!);
  const p2 = await invoke('search_content', { text: 'needle', limit: 1, cursor });
  expect(p1.raw.files[0].path).toBe('a');
  expect(p2.raw.files[0].path).toBe('b');
  expect(p2.raw.next).toBeNull();
  expect(read.model?.resultVersion).toBe('1');
  expect(search.version).toBe('5');
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
