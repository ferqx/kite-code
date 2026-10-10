import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import { createFileTools, createWorkspaceFiles } from '../../../src/files';
import { openSqliteStore } from '../../../src/sqlite';

// These are real Win32 calls. A non-Windows skip does not establish native qualification.
const nativeTest = process.platform === 'win32' ? test : test.skip;
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const budget = { maxBytes: 1024 * 1024 };
function fixture(protectedPaths: string[] = []) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-windows-files-')));
  let files: ReturnType<typeof createWorkspaceFiles>;
  try {
    files = createWorkspaceFiles({ root, protectedPaths, protectReads: true });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    files,
    async close() {
      await files.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

nativeTest(
  'Windows six Files tools preserve complete text, baseline, pages and mutation receipts',
  async () => {
    const f = fixture();
    try {
      expect(createFileTools(f.files).map((tool) => [tool.id, tool.version])).toEqual([
        ['files.read', '3'],
        ['files.write', '2'],
        ['files.edit', '2'],
        ['files.list', '1'],
        ['files.glob', '2'],
        ['files.search', '2'],
      ]);
      const text = '\uFEFF第一行 α\r\nsecond second\r\n末行\n';
      const first = await f.files.write({ path: 'Exact.txt', content: text, base: null });
      expect(first.content).toBe(text);
      expect(first.baseline.hash).toBe(hash(text));
      expect(first.baseline.size).toBe(Buffer.byteLength(text));
      expect(first.change).toMatchObject({ version: 1, before: null, after: first.baseline });
      const page = await f.files.read('Exact.txt', { limit: 1 });
      const rest = await f.files.read('Exact.txt', { offset: page.selection!.nextOffset! });
      expect(page.content + rest.content).toBe(text);
      expect(page.baseline).toEqual(first.baseline);
      expect(rest.baseline).toEqual(first.baseline);
      expect(rest.selection).toEqual({ fromLine: 2, toLine: 3, totalLines: 3, nextOffset: null });
      await expect(
        f.files.write({ path: 'Exact.txt', content: 'wrong', base: null }),
      ).rejects.toMatchObject({ code: 'file_baseline_conflict' });
      const edited = await f.files.edit({
        path: 'Exact.txt',
        base: first.baseline,
        find: 'second',
        replace: 'changed',
        occurrences: 2,
      });
      expect(edited.content).toBe(text.replaceAll('second', 'changed'));
      expect(edited.change).toMatchObject({ before: first.baseline, after: edited.baseline });
      await expect(
        f.files.edit({
          path: 'Exact.txt',
          base: first.baseline,
          find: 'changed',
          replace: 'wrong',
          occurrences: 2,
        }),
      ).rejects.toMatchObject({ code: 'file_baseline_conflict' });
      expect((await f.files.list()).entries).toEqual([{ name: 'Exact.txt', kind: 'file' }]);
      expect(await f.files.glob({ pattern: '**/*.txt' })).toEqual({
        paths: ['Exact.txt'],
        next: null,
      });
      expect(await f.files.search({ text: 'changed' })).toEqual({
        matches: [{ path: 'Exact.txt', line: 2, content: 'changed changed' }],
        next: null,
      });
      await f.files.close();
      await expect(f.files.read('Exact.txt')).rejects.toMatchObject({ code: 'file_closed' });
      await f.files.close();
    } finally {
      await f.close();
    }
  },
);

nativeTest(
  'Windows ordinary Core read publishes the complete Artifact and supplies the next Model',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-windows-files-core-')));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    let files: ReturnType<typeof createWorkspaceFiles> | undefined;
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    let artifacts: ReturnType<typeof createArtifactStore> | undefined;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let failure: unknown;
    let failed = false;
    try {
      files = createWorkspaceFiles({ root: workspace });
      const profile = { dataRoot: join(root, 'data'), profile: 'new' };
      store = await openSqliteStore(profile);
      artifacts = createArtifactStore({ profile, store });
      const content = `\uFEFFstart\r\n${'完整 α\r\n'.repeat(20000)}end\r\n`;
      writeFileSync(join(workspace, 'large.txt'), content);
      const finish: Extract<ModelEvent, { type: 'finish' }> = {
        type: 'finish',
        reason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
      const model = createFixedModel([
        [
          { type: 'tool_call', id: 'read', name: 'files.read', arguments: '{"path":"large.txt"}' },
          { ...finish, reason: 'tool_calls' },
        ],
        [finish],
      ]);
      runtime = createRuntime({
        store,
        artifacts,
        model,
        modelId: 'fixed',
        permissions: {
          async authorize() {
            return { allowed: true, revision: 'approved' };
          },
        },
        extensions: [{ id: 'files', version: '2', apiMajor: 1, tools: createFileTools(files) }],
      });
      const expectedStoreId = (await store.getMetadata()).storeId;
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'w',
        rootUri: pathToFileURL(workspace).href,
      });
      await runtime.createSession({
        expectedStoreId,
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        subjectId: 'owner',
        title: 'files',
      });
      await runtime.submitCommand({
        expectedStoreId,
        commandId: 'read',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'read the complete file' },
      });
      await runtime.waitForCommand('read');
      const execution = (await store.listExecutions('s')).find(
        (row) => row.definitionId === 'files.read',
      )!;
      expect(execution.status).toBe('succeeded');
      expect(execution.definitionVersion).toBe('3');
      const result = execution.result as {
        content: string;
        artifactRefs: { id: string; scope: { kind: 'execution'; id: string } }[];
      };
      const summary = JSON.parse(result.content);
      expect(summary.inlineBody).toBe(false);
      expect(summary.body.complete).toBe(true);
      expect(summary.baseline.hash).toBe(hash(content));
      expect(result.artifactRefs).toHaveLength(1);
      const ref = result.artifactRefs[0]!;
      expect(
        Buffer.from(
          await artifacts.read({
            expectedStoreId,
            refId: ref.id,
            sessionId: 's',
            subjectId: 'owner',
            scope: ref.scope,
          }),
        ).toString('utf8'),
      ).toBe(content);
      expect(model.requests).toHaveLength(2);
      expect(
        model.requests[1]!.messages.some(
          (message) => message.role === 'tool' && message.content.endsWith(content),
        ),
      ).toBe(true);
      expect((await files.read('large.txt')).content).toBe(content);
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      const failures: unknown[] = [];
      for (const close of [
        () => runtime?.close(),
        () => artifacts?.close(),
        () => store?.close(),
        () => files?.close(),
      ]) {
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (!failures.length) rmSync(root, { recursive: true, force: true });
      if (failures.length) {
        failure = new AggregateError(
          failed ? [failure, ...failures] : failures,
          `Windows Files cleanup unconfirmed; retained ${root}`,
        );
        failed = true;
      }
    }
    if (failed) throw failure;
  },
);

nativeTest(
  'Windows byte recovery preserves original bytes and rejects multiply linked originals',
  async () => {
    const f = fixture();
    try {
      const original = Buffer.concat([
        Buffer.from('\uFEFFα\r\n'),
        Buffer.from([0, 255, 128]),
        Buffer.alloc(70000, 231),
      ]);
      const created = await f.files.restore({
        path: 'data.bin',
        bytes: original,
        base: null,
        ...budget,
      });
      const before = await f.files.readBytes('data.bin', budget);
      expect(Buffer.from(before.bytes)).toEqual(original);
      expect(before.baseline).toEqual(created.baseline);
      expect(before.baseline.hash).toBe(hash(original));
      const next = await f.files.restore({
        path: 'data.bin',
        bytes: Buffer.from('new'),
        base: before.baseline,
        ...budget,
      });
      expect(next.baseline.inode).not.toBe(before.baseline.inode);
      await expect(
        f.files.restore({ path: 'data.bin', bytes: original, base: before.baseline, ...budget }),
      ).rejects.toMatchObject({ code: 'file_baseline_conflict' });
      const restored = await f.files.restore({
        path: 'data.bin',
        bytes: before.bytes,
        base: next.baseline,
        ...budget,
      });
      expect(readFileSync(join(f.root, 'data.bin'))).toEqual(original);
      linkSync(join(f.root, 'data.bin'), join(f.root, 'hard.bin'));
      await expect(f.files.readBytes('hard.bin', budget)).rejects.toMatchObject({
        code: 'file_owner_invalid',
      });
      rmSync(join(f.root, 'hard.bin'));
      expect(
        await f.files.remove({ path: 'data.bin', base: restored.baseline, ...budget }),
      ).toEqual({ path: 'data.bin', removedBaseline: restored.baseline });
      expect(existsSync(join(f.root, 'data.bin'))).toBe(false);
      await expect(
        f.files.remove({ path: 'data.bin', base: restored.baseline, ...budget }),
      ).rejects.toBeDefined();
    } finally {
      await f.close();
    }
  },
);

nativeTest(
  'Windows aliases, reparse points and protected roots never widen the selected Workspace',
  async () => {
    const f = fixture(['protected', '.git']);
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'kite-windows-files-outside-')));
    try {
      mkdirSync(join(f.root, 'protected'));
      mkdirSync(join(f.root, '.git'));
      writeFileSync(join(f.root, '.git', 'config'), 'private');
      writeFileSync(join(f.root, 'protected', 'secret'), 'secret');
      writeFileSync(join(f.root, 'Exact.txt'), 'local');
      writeFileSync(join(outside, 'outside.txt'), 'outside');
      for (const path of [
        'Exact.txt:stream',
        'Exact.txt.',
        'Exact.txt ',
        'NUL',
        'CON.txt',
        'COM1',
        'LPT1.txt',
        '../outside.txt',
      ])
        await expect(f.files.read(path)).rejects.toBeDefined();
      await expect(
        f.files.write({ path: 'Exact.txt:stream', content: 'bad', base: null }),
      ).rejects.toBeDefined();
      expect((await f.files.read('exact.txt')).baseline).toEqual(
        (await f.files.read('Exact.txt')).baseline,
      );
      await expect(f.files.read('.GiT/config')).rejects.toMatchObject({
        code: 'file_path_protected',
      });
      await expect(f.files.read('PROTECTED/secret')).rejects.toMatchObject({
        code: 'file_path_protected',
      });
      await expect(f.files.read('protected/secret')).rejects.toMatchObject({
        code: 'file_path_protected',
      });
      expect((await f.files.list()).entries.map((entry) => entry.name)).toEqual(['Exact.txt']);
      symlinkSync(outside, join(f.root, 'escape'), 'junction');
      await expect(f.files.read('escape/outside.txt')).rejects.toBeDefined();
      expect((await f.files.glob({ pattern: '**/*.txt' })).paths).toEqual(['Exact.txt']);
      // If Win32 permits the rename, the selected original cannot become the replacement.
      // A sharing denial instead proves the pinned original remains selected.
      const moved = `${f.root}-moved`;
      let renamed = false;
      try {
        renameSync(f.root, moved);
        renamed = true;
      } catch (error) {
        expect(['EPERM', 'EACCES', 'EBUSY']).toContain((error as NodeJS.ErrnoException).code!);
      }
      if (renamed) {
        try {
          mkdirSync(f.root);
          writeFileSync(join(f.root, 'Exact.txt'), 'replacement');
          await expect(f.files.read('Exact.txt')).rejects.toMatchObject({
            code: 'file_root_changed',
          });
        } finally {
          await f.files.close();
          rmSync(f.root, { recursive: true, force: true });
          renameSync(moved, f.root);
        }
      } else expect((await f.files.read('Exact.txt')).content).toBe('local');
      expect(readFileSync(join(outside, 'outside.txt'), 'utf8')).toBe('outside');
    } finally {
      await f.close();
      rmSync(outside, { recursive: true, force: true });
    }
  },
);
