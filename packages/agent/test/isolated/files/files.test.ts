import { afterEach, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../../../src/extensions';
import { createFileTools, createWorkspaceFiles, type WorkspaceFiles } from '../../../src/files';

const roots: string[] = [];
const handles: WorkspaceFiles[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(maxFileBytes?: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-files-')));
  roots.push(root);
  const files = createWorkspaceFiles({ root, maxFileBytes });
  handles.push(files);
  return { root, files };
}
async function code(work: Promise<unknown>, expected: string) {
  let actual = '';
  try {
    await work;
  } catch (error) {
    actual = (error as { code?: string }).code ?? '';
  }
  expect(actual).toBe(expected);
}
test('complete UTF-8 baseline CAS, exact edits, create-only and atomic replace', async () => {
  const { root, files } = fixture();
  const first = await files.write({ path: 'text', content: '你好\nhello hello\n', base: null });
  expect(first.content).toBe('你好\nhello hello\n');
  expect(first.baseline.size).toBe(Buffer.byteLength(first.content));
  expect(first.baseline.hash).toHaveLength(64);
  await code(files.write({ path: 'text', content: 'bad', base: null }), 'file_baseline_conflict');
  const edited = await files.edit({
    path: 'text',
    base: first.baseline,
    find: 'hello',
    replace: 'world',
    occurrences: 2,
  });
  expect(edited.content).toBe('你好\nworld world\n');
  await code(
    files.edit({
      path: 'text',
      base: edited.baseline,
      find: 'world',
      replace: 'x',
      occurrences: 1,
    }),
    'file_edit_match_conflict',
  );
  writeFileSync(join(root, 'text'), 'same external');
  await code(
    files.write({ path: 'text', content: 'bad', base: edited.baseline }),
    'file_baseline_conflict',
  );
  expect(readFileSync(join(root, 'text'), 'utf8')).toBe('same external');
  const current = await files.read('text');
  unlinkSync(join(root, 'text'));
  writeFileSync(join(root, 'text'), current.content);
  await code(
    files.write({ path: 'text', content: 'bad', base: current.baseline }),
    'file_baseline_conflict',
  );
  expect(readdirSync(root)).toEqual(['text']);
});
test('no-follow path chain, non-regular/encoding/size and traversal reject without writes', async () => {
  const { root, files } = fixture(32);
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'kite-files-external-')));
  roots.push(other);
  writeFileSync(join(other, 'outside'), 'unchanged');
  symlinkSync(other, join(root, 'escape'));
  symlinkSync(join(other, 'outside'), join(root, 'link'));
  for (const path of ['../outside', '/absolute', 'x/../outside', 'escape/outside', 'link']) {
    let failed = false;
    try {
      await files.write({ path, base: null, content: 'bad' });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  }
  expect(readFileSync(join(other, 'outside'), 'utf8')).toBe('unchanged');
  writeFileSync(join(root, 'large'), 'x'.repeat(33));
  await code(files.read('large'), 'file_too_large');
  writeFileSync(join(root, 'invalid'), Buffer.from([0xff]));
  await code(files.read('invalid'), 'file_encoding_invalid');
  writeFileSync(join(root, 'binary'), Buffer.alloc(20));
  await code(files.read('binary'), 'file_binary');
  await code(
    files.write({ path: 'binary-write', content: '\0'.repeat(20), base: null }),
    'file_binary',
  );
  writeFileSync(join(root, 'bom'), Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
  expect((await files.read('bom')).content).toBe('\ufeffa');
  await code(
    files.write({ path: 'surrogate', content: '\ud800', base: null }),
    'file_encoding_invalid',
  );
  await code(
    files.write({ path: 'oversized', content: 'x'.repeat(33), base: null }),
    'file_too_large',
  );
  await files.close();
  await code(files.read('bom'), 'file_closed');
});
test('bounded list/search keysets include root files and never traverse symlinks', async () => {
  const { root, files } = fixture();
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'a'), 'needle\nnone\nneedle');
  writeFileSync(join(root, 'nested', 'b'), 'needle');
  symlinkSync(join(root, 'nested'), join(root, 'alias'));
  const p1 = await files.list({ limit: 2 });
  expect(p1.entries.map((e) => e.name)).toEqual(['a', 'alias']);
  expect(p1.entries[1]?.kind).toBe('symlink');
  expect((await files.list({ limit: 2, afterName: p1.next! })).entries.map((e) => e.name)).toEqual([
    'nested',
  ]);
  const s1 = await files.search({ text: 'needle', limit: 2 });
  expect(s1.matches.map((m) => [m.path, m.line])).toEqual([
    ['a', 1],
    ['a', 3],
  ]);
  const s2 = await files.search({ text: 'needle', limit: 2, after: s1.next! });
  expect(s2.matches.map((m) => m.path)).toEqual(['nested/b']);
  expect(s2.next).toBeNull();
  writeFileSync(join(root, 'huge-line'), `needle${'x'.repeat(32768)}`);
  const complete = await files.search({ text: 'needle' });
  expect(complete.matches).toHaveLength(4);
  expect(
    complete.matches.find((match) => match.path === 'huge-line')?.content.length,
  ).toBeGreaterThan(32768);
  await code(files.list({ limit: 201 }), 'file_page_invalid');
});

test('large Tool body requires Artifact capability while the file leaf retains complete text', async () => {
  const { files } = fixture();
  const tools = createFileTools(files);
  const context = { signal: new AbortController().signal } as ToolContext;
  const write = await tools
    .find((t) => t.id === 'files.write')!
    .execute({ path: 'large', base: null, content: 'x'.repeat(2 * 1024 * 1024) }, context);
  expect(write.outcome).toBe('succeeded');
  expect(JSON.parse(write.content).baseline.size).toBe(2 * 1024 * 1024);
  expect(JSON.parse(write.content).content).toBeUndefined();
  const read = await tools.find((t) => t.id === 'files.read')!.execute({ path: 'large' }, context);
  expect(read.outcome).toBe('failed');
  expect(read.details).toEqual({ code: 'artifact_publication_unavailable' });
  expect((await files.read('large')).content).toHaveLength(2 * 1024 * 1024);
});

test('UTF-8 filenames preserve BOM and unpaired path input is never silently replaced', async () => {
  const { root, files } = fixture();
  writeFileSync(join(root, '\ufeff你好'), 'bytes');
  expect((await files.list()).entries.map((entry) => entry.name)).toEqual(['\ufeff你好']);
  await code(files.read('\ud800'), 'file_path_invalid');
});
