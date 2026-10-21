import { afterEach, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../../../src/extensions';
import type { WorkspaceFiles } from '../../../src/files';
import * as nativeBinding from '../../../src/files-native-binding';

// Keep the real native path/FD/deny behavior. This isolated seam observes actual
// enumerations only; it invents neither directory entries nor elapsed IO time.
const actualBinding = { ...nativeBinding };
let enumerations = 0;
let nativeCalls = 0;
let firstEnumeration: (() => void) | undefined;
mock.module('../../../src/files-native-binding', () => ({
  ...actualBinding,
  createNativeWorkspaceFileIo(
    ...args: Parameters<typeof nativeBinding.createNativeWorkspaceFileIo>
  ) {
    const io = new Proxy(
      { ...actualBinding.createNativeWorkspaceFileIo(...args) },
      {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function'
            ? (...parameters: unknown[]) => {
                nativeCalls++;
                return Reflect.apply(value, target, parameters);
              }
            : value;
        },
      },
    );
    return {
      ...io,
      listAt(parent: number) {
        enumerations++;
        const first = firstEnumeration;
        firstEnumeration = undefined;
        first?.();
        return io.listAt(parent);
      },
    };
  },
}));
const { createWorkspaceFiles, createFileTools } = await import('../../../src/files');
const roots: string[] = [];
const handles: WorkspaceFiles[] = [];
afterEach(async () => {
  firstEnumeration = undefined;
  for (const handle of handles.splice(0)) await handle.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  enumerations = 0;
  nativeCalls = 0;
});
function tree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-query-responsive-')));
  roots.push(root);
  writeFileSync(join(root, 'sibling.txt'), 'independent sibling read\n');
  for (let index = 0; index < 128; index++) {
    const directory = join(root, `dir-${String(index).padStart(3, '0')}`);
    mkdirSync(directory);
    writeFileSync(join(directory, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(directory, 'b.ts'), 'export const b = 2;\n');
  }
  const files = createWorkspaceFiles({ root });
  handles.push(files);
  return { root, files };
}

test('glob traversal yields to a real macrotask and an independent file read before settling', async () => {
  const { files } = tree();
  let settled = false;
  let siblingBeforeSettlement = false;
  let release!: () => void;
  let reject!: (cause: unknown) => void;
  const macro = new Promise<void>((resolve, fail) => {
    release = resolve;
    reject = fail;
  });
  firstEnumeration = () => {
    setTimeout(() => {
      void files
        .read('sibling.txt')
        .then((snapshot) => {
          expect(snapshot.content).toBe('independent sibling read\n');
          siblingBeforeSettlement = !settled;
          release();
        })
        .catch(reject);
    }, 0);
  };
  const query = files.glob({ pattern: '**/*.ts', limit: 200 }).finally(() => {
    settled = true;
  });
  const [result] = await Promise.all([query, macro]);
  expect(result.paths).toHaveLength(200);
  expect(result.next).not.toBeNull();
  expect(siblingBeforeSettlement).toBe(true);
});

test('glob Tool cancellation from a macrotask stops actual traversal before the whole tree is enumerated', async () => {
  const { files } = tree();
  const controller = new AbortController();
  let atAbort = 0;
  let release!: () => void;
  const macro = new Promise<void>((resolve) => {
    release = resolve;
  });
  firstEnumeration = () => {
    setTimeout(() => {
      atAbort = enumerations;
      controller.abort();
      release();
    }, 0);
  };
  const tool = createFileTools(files).find((definition) => definition.id === 'files.glob')!;
  const [result] = await Promise.all([
    tool.execute({ pattern: '**/*.ts', limit: 200 }, { signal: controller.signal } as ToolContext),
    macro,
  ]);
  expect(controller.signal.aborted).toBe(true);
  expect(atAbort).toBeGreaterThan(0);
  expect(result.outcome).toBe('cancelled');
  // 128 real child directories plus the root; no timing threshold or fake delay.
  expect(enumerations).toBeLessThan(129);
});

test('search yields to a real macrotask and an independent file read before settling', async () => {
  const { files } = tree();
  let settled = false;
  let siblingBeforeSettlement = false;
  let release!: () => void;
  let reject!: (cause: unknown) => void;
  const macro = new Promise<void>((resolve, fail) => {
    release = resolve;
    reject = fail;
  });
  firstEnumeration = () => {
    setTimeout(() => {
      void files
        .read('sibling.txt')
        .then((snapshot) => {
          expect(snapshot.content).toBe('independent sibling read\n');
          siblingBeforeSettlement = !settled;
          release();
        })
        .catch(reject);
    }, 0);
  };
  const query = files.search({ text: 'export const', limit: 200 }).finally(() => {
    settled = true;
  });
  const [result] = await Promise.all([query, macro]);
  expect(result.matches).toHaveLength(200);
  expect(result.next).not.toBeNull();
  expect(siblingBeforeSettlement).toBe(true);
});

test('search Tool cancellation from a macrotask interrupts the original traversal', async () => {
  const { files } = tree();
  const controller = new AbortController();
  let settled = false;
  let abortedBeforeSettlement = false;
  let release!: () => void;
  const macro = new Promise<void>((resolve) => {
    release = resolve;
  });
  firstEnumeration = () => {
    setTimeout(() => {
      abortedBeforeSettlement = !settled;
      controller.abort();
      release();
    }, 0);
  };
  const tool = createFileTools(files).find((definition) => definition.id === 'files.search')!;
  const query = tool
    .execute({ text: 'export const', limit: 200 }, { signal: controller.signal } as ToolContext)
    .finally(() => {
      settled = true;
    });
  const [result] = await Promise.all([query, macro]);
  expect(abortedBeforeSettlement).toBe(true);
  expect(result.outcome).toBe('cancelled');
  expect(enumerations).toBeLessThan(129);
});

test('responsive glob retains sorted keyset pages, root ** matches, protected roots and no symlink traversal', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-query-contract-')));
  roots.push(root);
  mkdirSync(join(root, 'nested'));
  mkdirSync(join(root, 'private'));
  writeFileSync(join(root, 'a.ts'), 'a');
  writeFileSync(join(root, 'nested', 'b.ts'), 'b');
  writeFileSync(join(root, 'z.ts'), 'z');
  writeFileSync(join(root, 'private', 'secret.ts'), 'protected');
  symlinkSync(join(root, 'private'), join(root, 'alias'));
  const files = createWorkspaceFiles({ root, protectedPaths: ['private'], protectReads: true });
  handles.push(files);
  const first = await files.glob({ pattern: '**/*.ts', limit: 2 });
  expect(first).toEqual({ paths: ['a.ts', 'nested/b.ts'], next: 'nested/b.ts' });
  expect(await files.glob({ pattern: '**/*.ts', after: first.next!, limit: 2 })).toEqual({
    paths: ['z.ts'],
    next: null,
  });
  expect(await files.glob({ pattern: '*.ts' })).toEqual({
    paths: ['a.ts', 'nested/b.ts', 'z.ts'],
    next: null,
  });
  expect(await files.glob({ pattern: '**/*.ts', path: 'nested' })).toEqual({
    paths: ['nested/b.ts'],
    next: null,
  });
  await expect(files.glob({ pattern: '**/*.ts', path: 'private' })).rejects.toMatchObject({
    code: 'file_path_protected',
  });
  await expect(files.glob({ pattern: '**/*.ts', path: 'alias' })).rejects.toBeDefined();
});

test('glob pages preserve complete path ordering across file and directory name boundaries', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-query-order-')));
  roots.push(root);
  mkdirSync(join(root, 'a', 'b'), { recursive: true });
  mkdirSync(join(root, 'a', 'private'));
  const visible = ['a.ts', 'a-1.ts', 'a/child.ts', 'a/b.ts', 'a/b/child.ts'];
  for (const path of visible) writeFileSync(join(root, path), path);
  writeFileSync(join(root, 'a', 'private', 'secret.ts'), 'protected');
  symlinkSync(join(root, 'a'), join(root, 'alias'));
  const files = createWorkspaceFiles({
    root,
    protectedPaths: ['a/private'],
    protectReads: true,
  });
  handles.push(files);

  async function pages(path: string | undefined, limit: number) {
    const collected: string[] = [];
    let after: string | undefined;
    // The strict bound catches a repeating cursor instead of hanging the suite.
    for (let page = 0; page <= visible.length; page++) {
      const result = await files.glob({ pattern: '**/*.ts', path, limit, after });
      expect(result.paths.length).toBeLessThanOrEqual(limit);
      expect(result.paths.every((entry) => after === undefined || entry > after)).toBe(true);
      collected.push(...result.paths);
      if (result.next === null) return collected;
      expect(result.paths.length).toBeGreaterThan(0);
      expect(result.next).toBe(result.paths.at(-1)!);
      after = result.next;
    }
    throw new Error('glob keyset cursor did not terminate');
  }

  const expected = [...visible].sort();
  for (const limit of [1, 2]) {
    expect(await pages(undefined, limit)).toEqual(expected);
    expect(await pages('a', limit)).toEqual(expected.filter((path) => path.startsWith('a/')));
  }
  expect(await files.glob({ pattern: '**/*.ts', after: expected.at(-1)!, limit: 1 })).toEqual({
    paths: [],
    next: null,
  });
  expect(await files.glob({ pattern: 'missing/**/*.ts', limit: 1 })).toEqual({
    paths: [],
    next: null,
  });
});

test('literal glob directory prefixes skip unrelated native enumeration', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-query-prefix-')));
  roots.push(root);
  mkdirSync(join(root, 'wanted', 'deep'), { recursive: true });
  writeFileSync(join(root, 'wanted', 'deep', 'a.ts'), 'wanted');
  for (let index = 0; index < 96; index++) {
    const directory = join(root, 'unrelated', `branch-${index}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'b.ts'), 'unrelated');
  }
  const files = createWorkspaceFiles({ root });
  handles.push(files);
  enumerations = 0;
  const prefixed = await files.glob({ pattern: 'wanted/**/*.ts' });
  const prefixEnumerations = enumerations;
  enumerations = 0;
  const scoped = await files.glob({ pattern: '**/*.ts', path: 'wanted' });
  const scopedEnumerations = enumerations;
  expect(prefixed).toEqual({ paths: ['wanted/deep/a.ts'], next: null });
  expect(prefixed).toEqual(scoped);
  // Root, wanted and deep only: no listAt for unrelated or any of its 96 branches.
  expect(prefixEnumerations).toBe(3);
  expect(scopedEnumerations).toBe(2);
  enumerations = 0;
  expect(await files.glob({ pattern: 'missing/**/*.ts', limit: 1 })).toEqual({
    paths: [],
    next: null,
  });
  expect(enumerations).toBe(1);
});

test('glob syntax and paged results agree with Bun matching over known visible files', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-query-patterns-')));
  roots.push(root);
  const visible = [
    'root.ts',
    'root.md',
    'wanted/a.ts',
    'wanted/a.md',
    'wanted/deep/b.ts',
    'wanted/deep/more/c.ts',
    'other/b.ts',
    'other/deep/a.ts',
  ];
  for (const path of visible) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), path);
  }
  const files = createWorkspaceFiles({ root });
  handles.push(files);
  const patterns = [
    'wanted/**/*.ts',
    '{wanted,other}/**/*.ts',
    '**/*.ts',
    'wanted/**/a.ts',
    '**/[ab].ts',
    '*.ts',
    '!*.md',
  ];
  for (const pattern of patterns) {
    const matcher = new Bun.Glob(pattern);
    // The public basename-only contract matches each file's basename at any depth.
    const expected = visible
      .filter((path) => matcher.match(pattern.includes('/') ? path : path.split('/').at(-1)!))
      .sort();
    for (const limit of [1, 2]) {
      const collected: string[] = [];
      let after: string | undefined;
      for (let page = 0; page <= visible.length; page++) {
        const result = await files.glob({ pattern, after, limit });
        expect(result.paths.length).toBeLessThanOrEqual(limit);
        expect(result.paths.every((path) => after === undefined || path > after)).toBe(true);
        collected.push(...result.paths);
        if (result.next === null) break;
        expect(result.paths.length).toBeGreaterThan(0);
        expect(result.next).toBe(result.paths.at(-1)!);
        after = result.next;
        if (page === visible.length) throw new Error(`nonterminating glob page: ${pattern}`);
      }
      expect(collected).toEqual(expected);
    }
  }
});

test('glob and search reject a close after the final enumeration without further native IO', async () => {
  for (const operation of ['glob', 'search'] as const) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-query-close-')));
    roots.push(root);
    const files = createWorkspaceFiles({ root });
    handles.push(files);
    let close!: Promise<void>;
    let callsAtClose = 0;
    let enumerationsAtClose = 0;
    firstEnumeration = () => {
      // The empty real directory has no per-entry checkpoint. Close after its
      // actual listAt returns, before the completed walk publishes its result.
      queueMicrotask(() => {
        close = files.close().then(() => {
          callsAtClose = nativeCalls;
          enumerationsAtClose = enumerations;
        });
        handles.splice(handles.indexOf(files), 1);
      });
    };
    const query =
      operation === 'glob' ? files.glob({ pattern: '**/*.ts' }) : files.search({ text: 'needle' });
    await expect(query).rejects.toMatchObject({ code: 'file_closed' });
    await close;
    expect(enumerationsAtClose).toBeGreaterThan(0);
    await expect(files.glob({ pattern: '**/*.ts' })).rejects.toMatchObject({ code: 'file_closed' });
    await expect(files.search({ text: 'needle' })).rejects.toMatchObject({ code: 'file_closed' });
    await expect(files.read('missing.txt')).rejects.toMatchObject({ code: 'file_closed' });
    expect(enumerations).toBe(enumerationsAtClose);
    expect(nativeCalls).toBe(callsAtClose);
  }
});
