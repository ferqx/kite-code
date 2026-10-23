import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../../../src/extensions';
import { createFileTools, createWorkspaceFiles } from '../../../src/files';
import type { Json } from '../../../src/storage/types';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-tool-paths-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const files = createWorkspaceFiles({
    root: workspace,
    protectedPaths: ['private'],
    protectReads: true,
  });
  const captured: string[] = [];
  const tools = createFileTools(files, {
    capture: {
      async before(input) {
        captured.push(input.path);
      },
      async after(_token, result) {
        captured.push(result.path);
      },
      async failed() {},
    },
  });
  return {
    root,
    workspace,
    files,
    captured,
    call: (name: string, input: Json) =>
      tools
        .find((tool) => tool.id === `files.${name}`)!
        .execute(input, {
          signal: new AbortController().signal,
          executionId: 'tool',
          runId: 'run',
        } as ToolContext),
    async close() {
      await files.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('all six Model file tools accept workspace absolute paths and keep relative results and checkpoint capture', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.workspace, 'nested'));
    const path = join(f.workspace, 'nested', 'Exact.txt');
    const write = await f.call('write', { path, content: 'original\n', base: null });
    expect(write.outcome).toBe('succeeded');
    const written = JSON.parse(write.content);
    expect(written.path).toBe('nested/Exact.txt');
    expect(f.captured).toEqual(['nested/Exact.txt', 'nested/Exact.txt']);
    const read = await f.call('read', { path });
    expect(read.outcome).toBe('succeeded');
    expect(JSON.parse(read.content).content).toBe('original\n');
    const edit = await f.call('edit', {
      path,
      base: written.baseline,
      find: 'original',
      replace: 'changed',
      occurrences: 1,
    });
    expect(edit.outcome).toBe('succeeded');
    expect(JSON.parse(edit.content).fileChange.path).toBe('nested/Exact.txt');
    expect(f.captured).toEqual(Array(4).fill('nested/Exact.txt'));
    expect(readFileSync(path, 'utf8')).toBe('changed\n');
    const listed = await f.call('list', { path: join(f.workspace, 'nested') });
    expect(listed.outcome).toBe('succeeded');
    expect(JSON.parse(listed.content).entries).toEqual([{ name: 'Exact.txt', kind: 'file' }]);
    const glob = await f.call('glob', { path: f.workspace, pattern: '**/*.txt' });
    expect(glob.outcome).toBe('succeeded');
    expect(JSON.parse(glob.content).paths).toEqual(['nested/Exact.txt']);
    const search = await f.call('search', { path: f.workspace, text: 'changed', mode: 'content' });
    expect(search.outcome).toBe('succeeded');
    expect(JSON.parse(search.content).matches).toEqual([
      { path: 'nested/Exact.txt', line: 1, content: 'changed' },
    ]);
    // Native and recovery primitives retain their original relative-only contract.
    await expect(f.files.read(path)).rejects.toMatchObject({ code: 'file_path_invalid' });
    await expect(f.files.readBytes(path, { maxBytes: 1024 })).rejects.toMatchObject({
      code: 'file_path_invalid',
    });
  } finally {
    await f.close();
  }
});

test('directory defaults, absolute roots and native Windows separators select the fixed workspace', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.workspace, 'local.txt'), 'local');
    const inputs: Json[] = [{ limit: 50 }, { path: '' }, { path: '.' }, { path: f.workspace }];
    for (const input of inputs) {
      const result = await f.call('list', input);
      expect(result.outcome).toBe('succeeded');
      expect(JSON.parse(result.content)).toEqual({
        entries: [{ name: 'local.txt', kind: 'file' }],
        next: null,
      });
    }
    if (process.platform === 'win32') {
      mkdirSync(join(f.workspace, 'nested'));
      writeFileSync(join(f.workspace, 'nested', 'file.txt'), 'native');
      for (const path of [
        'nested\\file.txt',
        join(f.workspace.toUpperCase(), 'nested', 'file.txt'),
        join(f.workspace, 'nested', 'file.txt').replaceAll('\\', '/'),
        join(f.workspace, 'nested', 'file.txt').replaceAll('\\', '\\\\'),
      ]) {
        const result = await f.call('read', { path });
        expect(result.outcome).toBe('succeeded');
        expect(JSON.parse(result.content).content).toBe('native');
      }
    }
  } finally {
    await f.close();
  }
});

test('Tool path conversion rejects escapes before capture and preserves native path protections', async () => {
  const f = fixture();
  try {
    const sibling = `${f.workspace}-other`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'outside.txt'), 'outside');
    mkdirSync(join(f.workspace, 'private'));
    writeFileSync(join(f.workspace, 'private', 'secret.txt'), 'private');
    const paths = [
      join(sibling, 'outside.txt'),
      '../workspace-other/outside.txt',
      `${f.workspace}/../workspace/local.txt`,
      `${f.workspace}/nested/./file.txt`,
      `${f.workspace}/\0bad`,
      '\ud800',
      ...(process.platform === 'win32'
        ? [
            'C:relative.txt',
            '\\rooted.txt',
            '\\\\server\\share\\file.txt',
            `\\\\?\\${f.workspace}\\local.txt`,
            join(f.workspace, 'local.txt:stream'),
            join(f.workspace, 'local.txt.'),
            join(f.workspace, 'NUL'),
          ]
        : []),
    ];
    for (const path of paths) {
      const result = await f.call('write', { path, content: 'must not publish', base: null });
      expect(result.outcome).toBe('failed');
      expect(result.details).toEqual({ code: 'file_path_invalid' });
    }
    // Invalid Windows components are refused by the original native engine, after capture.
    expect(f.captured.filter((path) => path.includes('..') || path.includes(sibling))).toEqual([]);
    const protectedRead = await f.call('read', {
      path: join(f.workspace, 'private', 'secret.txt'),
    });
    expect(protectedRead.outcome).toBe('failed');
    expect(protectedRead.details).toEqual({ code: 'file_path_protected' });
    expect(readFileSync(join(sibling, 'outside.txt'), 'utf8')).toBe('outside');
    expect(readFileSync(join(f.workspace, 'private', 'secret.txt'), 'utf8')).toBe('private');
  } finally {
    await f.close();
  }
});
