import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type WorkingInputRecord, workingInputPath } from '../../../src/input-working-files';
import type { ArtifactReference } from '../../../src/storage/types';
import { createWorkingInputFiles } from '../../../src/tools/input-working-files';

const scope = {
  expectedStoreId: 'store',
  sessionId: 'session',
  subjectId: 'owner',
  commandId: 'command',
  importId: 'import',
};
const bytes = new TextEncoder().encode('immutable original');
const reference: ArtifactReference = {
  id: 'input-file-import',
  storeId: 'store',
  sessionId: 'session',
  subjectId: 'owner',
  scope: { kind: 'session', id: 'session' },
  hash: createHash('sha256').update(bytes).digest('hex'),
  size: String(bytes.length),
  mediaType: 'application/octet-stream',
};
const content = async function* () {
  yield bytes.subarray(0, 4);
  yield bytes.subarray(4);
};
async function rejected(action: () => Promise<unknown>) {
  try {
    await action();
    return undefined;
  } catch (error) {
    return error;
  }
}

test('native preparation copies bytes, bounds Unicode filename and preserves bound edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kite-input-working-'));
  try {
    const rootUri = pathToFileURL(root).href,
      relativePath = workingInputPath(scope, `${'测'.repeat(200)}.docx`),
      port = createWorkingInputFiles();
    expect(Buffer.byteLength(relativePath.split('/').at(-1)!)).toBeLessThan(256);
    expect(relativePath.endsWith('.docx')).toBe(true);
    const first = await port.materialize({
      rootUri,
      relativePath,
      reference,
      existing: null,
      content,
    });
    expect(await readFile(join(root, relativePath))).toEqual(Buffer.from(bytes));
    const record: WorkingInputRecord = {
      commandId: 'command',
      importId: 'import',
      inputRefId: reference.id,
      workingRelativePath: relativePath,
      workspaceRootUri: rootUri,
      state: 'ready',
      ...first,
    };
    await writeFile(join(root, relativePath), 'user changes');
    expect(
      await rejected(() =>
        port.materialize({ rootUri, relativePath, reference, existing: record, content }),
      ),
    ).toMatchObject({ code: 'input_file_content_mismatch' });
    expect(
      await port.materialize({
        rootUri,
        relativePath,
        reference,
        existing: { ...record, state: 'bound' },
        content,
      }),
    ).toEqual(first);
    expect(await readFile(join(root, relativePath), 'utf8')).toBe('user changes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native preparation rejects symlink ancestors and hardlinked destinations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kite-input-working-')),
    outside = await mkdtemp(join(tmpdir(), 'kite-input-outside-'));
  try {
    const rootUri = pathToFileURL(root).href,
      relativePath = workingInputPath(scope, 'safe.txt'),
      port = createWorkingInputFiles();
    await symlink(outside, join(root, '.kite-inputs'), 'dir');
    expect(
      await rejected(() =>
        port.materialize({ rootUri, relativePath, reference, existing: null, content }),
      ),
    ).toBeDefined();
    expect(await readdir(outside)).toEqual([]);
    await rm(join(root, '.kite-inputs'));
    await mkdir(dirname(join(root, relativePath)), { recursive: true });
    await writeFile(join(outside, 'original'), bytes);
    await link(join(outside, 'original'), join(root, relativePath));
    expect(
      await rejected(() =>
        port.materialize({ rootUri, relativePath, reference, existing: null, content }),
      ),
    ).toBeDefined();
    expect(await readFile(join(outside, 'original'))).toEqual(Buffer.from(bytes));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('failed or mismatched source never publishes a partial working file and leaves no temp', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kite-input-working-'));
  try {
    const rootUri = pathToFileURL(root).href,
      relativePath = workingInputPath(scope, 'report.pdf'),
      port = createWorkingInputFiles();
    expect(
      await rejected(() =>
        port.materialize({
          rootUri,
          relativePath,
          reference,
          existing: null,
          content: async function* () {
            yield bytes.subarray(0, 4);
            throw Error('source interrupted');
          },
        }),
      ),
    ).toMatchObject({ message: 'source interrupted' });
    expect(await readdir(dirname(join(root, relativePath)))).toEqual([]);
    expect(
      await rejected(() =>
        port.materialize({
          rootUri,
          relativePath,
          reference,
          existing: null,
          content: async function* () {
            yield new Uint8Array(bytes.length);
          },
        }),
      ),
    ).toMatchObject({ code: 'input_file_content_mismatch' });
    expect(await readdir(dirname(join(root, relativePath)))).toEqual([]);
    await port.materialize({ rootUri, relativePath, reference, existing: null, content });
    expect(await readFile(join(root, relativePath))).toEqual(Buffer.from(bytes));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native revalidation yields to cancellation while preserving the existing working copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kite-input-working-'));
  const large = Buffer.alloc(12 * 1024 * 1024, 19);
  const largeReference = {
    ...reference,
    hash: createHash('sha256').update(large).digest('hex'),
    size: String(large.length),
  };
  const relativePath = workingInputPath(scope, 'large.docx'),
    rootUri = pathToFileURL(root).href;
  try {
    await mkdir(dirname(join(root, relativePath)), { recursive: true });
    await writeFile(join(root, relativePath), large);
    const controller = new AbortController(),
      reason = Error('timer_cancelled');
    const timer = setTimeout(() => controller.abort(reason), 0);
    const error = await rejected(() =>
      createWorkingInputFiles().materialize({
        rootUri,
        relativePath,
        reference: largeReference,
        existing: null,
        content,
        signal: controller.signal,
      }),
    );
    clearTimeout(timer);
    expect(error).toBe(reason);
    expect(await readFile(join(root, relativePath))).toEqual(large);
    expect(await readdir(dirname(join(root, relativePath)))).toEqual([
      relativePath.split('/').at(-1)!,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('production protected roots cannot be used as an input preparation workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kite-input-protected-'));
  try {
    const relativePath = workingInputPath(scope, 'report.docx');
    expect(
      await rejected(() =>
        createWorkingInputFiles({ protectedPaths: [root] }).materialize({
          rootUri: pathToFileURL(root).href,
          relativePath,
          reference,
          existing: null,
          content,
        }),
      ),
    ).toBeDefined();
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
