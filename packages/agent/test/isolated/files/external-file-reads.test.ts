import {
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '#kite-test';
import { temporaryDirectory } from '../../../../../tests/fixtures/test-filesystem';
import type { AuthorizationRequest, ToolContext } from '../../../src/extensions';
import { createFileTools, createWorkspaceFiles, withExternalFileReads } from '../../../src/files';

function fixture() {
  const root = temporaryDirectory('kite-external-read-');
  const workspace = join(root, 'workspace'),
    external = join(root, 'user'),
    protectedRoot = join(root, 'private');
  for (const path of [workspace, external, protectedRoot]) mkdirSync(path);
  const files = createWorkspaceFiles({ root: workspace });
  const original = createFileTools(files);
  const api = withExternalFileReads({
    tools: original,
    workspaceRoot: async () => workspace,
    protectedRoots: () => [protectedRoot],
  });
  const read = api.tools.find((tool) => tool.id === 'files.read')!;
  const request = (path: string): AuthorizationRequest => ({
    kind: 'tool',
    definitionId: read.id,
    definitionVersion: read.version,
    executionId: 'read',
    runId: 'run',
    sessionId: 'session',
    input: { path },
    signal: new AbortController().signal,
  });
  // Dispatch authorization belongs to Core; the ordinary reader needs no second proof envelope.
  const execute = (
    input: { path: string; offset?: number; limit?: number },
    extra: Partial<ToolContext> = {},
  ) => read.execute(input, { signal: new AbortController().signal, ...extra } as ToolContext);
  return {
    root,
    workspace,
    external,
    protectedRoot,
    api,
    read,
    original,
    request,
    execute,
    async close() {
      await files.close();
      if (realpathSync.native(root) !== root) throw Error('external_read_cleanup_scope_changed');
      const check = (path: string) => {
        if (lstatSync(path).isSymbolicLink()) throw Error('external_read_cleanup_link');
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw Error('external_read_cleanup_link');
          if (entry.isDirectory()) check(join(path, entry.name));
        }
      };
      check(root);
      rmSync(root, { recursive: true });
    },
  };
}

test('one read_file paginates external BOM/CRLF without a baseline while workspace reads retain theirs', async () => {
  const f = fixture();
  try {
    expect(f.api.tools.map((tool) => [tool.id, tool.version])).toEqual(
      f.original.map((tool) => [tool.id, tool.version]),
    );
    const path = join(f.external, 'ordinary.txt');
    writeFileSync(path, '\uFEFFone\r\ntwo\r\nthree\r\n');
    const result = await f.execute({ path, offset: 2, limit: 1 });
    expect(result.outcome).toBe('succeeded');
    expect(JSON.parse(result.content)).toMatchObject({
      path,
      content: 'two\r\n',
      selection: { fromLine: 2, toLine: 2, totalLines: 3, nextOffset: 3 },
    });
    expect(JSON.parse(result.content).baseline).toBeUndefined();
    expect(result.details).toEqual({ fileScope: 'external_path', workspaceCheckpoint: false });
    expect(f.read.formatModelResult!({ result })).toContain(
      'External read-only file; no edit baseline.',
    );
    expect(JSON.parse((await f.execute({ path, offset: 4 })).content).selection).toMatchObject({
      toLine: null,
      nextOffset: null,
    });
    writeFileSync(path, '');
    expect(JSON.parse((await f.execute({ path })).content)).toMatchObject({
      content: '',
      selection: { totalLines: 0, toLine: null },
    });
    const inside = join(f.workspace, 'inside.txt');
    writeFileSync(inside, 'inside');
    expect(await f.api.describeRequest(f.request(inside))).toBeNull();
    expect(JSON.parse((await f.execute({ path: 'inside.txt' })).content).baseline.hash).toMatch(
      /^[a-f0-9]{64}$/,
    );
  } finally {
    await f.close();
  }
});

test('external hardlinks are readable and private path rules cover actual symlink targets', async () => {
  const f = fixture();
  const alias = join(f.external, 'private-link');
  try {
    const path = join(f.external, 'shared.txt');
    writeFileSync(path, 'shared');
    const hardlink = join(f.external, 'hardlink.txt');
    linkSync(path, hardlink);
    expect((await f.execute({ path: hardlink })).outcome).toBe('succeeded');
    const privateFile = join(f.protectedRoot, 'secret.txt');
    writeFileSync(privateFile, 'private');
    expect(await f.api.describeRequest(f.request(privateFile))).toMatchObject({
      hardAllowed: false,
      denialReason: 'file_path_protected',
    });
    if (process.platform === 'win32')
      expect(await f.api.describeRequest(f.request(privateFile.toUpperCase()))).toMatchObject({
        hardAllowed: false,
        denialReason: 'file_path_protected',
      });
    symlinkSync(f.protectedRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await f.api.describeRequest(f.request(join(alias, 'secret.txt')))).toMatchObject({
      hardAllowed: false,
      denialReason: 'file_path_protected',
    });
    expect((await f.execute({ path: join(alias, 'secret.txt') })).content).toBe(
      'file_path_protected',
    );
  } finally {
    if (lstatSync(alias, { throwIfNoEntry: false })) rmSync(alias);
    await f.close();
  }
});

test('external reads return current content and preserve complete large results and cancellation', async () => {
  const f = fixture();
  try {
    const path = join(f.external, 'ordinary.txt');
    writeFileSync(path, 'before');
    await f.api.describeRequest(f.request(path));
    writeFileSync(path, 'after');
    expect(JSON.parse((await f.execute({ path })).content).content).toBe('after');
    const content = 'complete text '.repeat(100000);
    writeFileSync(path, content);
    let published = '';
    const result = await f.execute(
      { path },
      {
        artifacts: {
          publish: async (input) => {
            published = Buffer.from(input.content).toString();
            return {
              id: 'body',
              mediaType: 'text/plain',
              size: String(Buffer.byteLength(published)),
              scope: { kind: 'execution', id: 'read' },
            };
          },
        } as ToolContext['artifacts'],
      },
    );
    expect(published).toBe(content);
    expect(result.modelContent?.kind).toBe('artifact');
    expect(JSON.parse(result.content).baseline).toBeUndefined();
    expect(f.read.formatModelResult!({ result, body: published })).toContain(content);
    expect((await f.execute({ path })).content).toBe('artifact_publication_unavailable');
    expect((await f.execute({ path }, { signal: AbortSignal.abort() })).outcome).toBe('cancelled');
    writeFileSync(path, Buffer.from([0xff]));
    expect((await f.execute({ path })).content).toBe('file_encoding_invalid');
  } finally {
    await f.close();
  }
});
