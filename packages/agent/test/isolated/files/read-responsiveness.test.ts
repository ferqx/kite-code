import { afterEach, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthorizationRequest, ToolContext } from '../../../src/extensions';
import type { WorkspaceFiles } from '../../../src/files';
import * as binding from '../../../src/files-native-binding';

const actual = { ...binding };
let firstRead: (() => void) | undefined;
let atEof: (() => void) | undefined;
let reads = 0;
let leakedHandlesAtOwnerClose = 0;
mock.module('../../../src/files-native-binding', () => ({
  ...actual,
  createNativeWorkspaceFileIo(...args: Parameters<typeof binding.createNativeWorkspaceFileIo>) {
    const io = actual.createNativeWorkspaceFileIo(...args);
    const handles = new Set<number>();
    return {
      ...io,
      openAt(...parameters: Parameters<typeof io.openAt>) {
        const fd = io.openAt(...parameters);
        handles.add(fd);
        return fd;
      },
      closeHandle(fd: number) {
        expect(handles.delete(fd)).toBe(true);
        io.closeHandle(fd);
      },
      close() {
        leakedHandlesAtOwnerClose += handles.size;
        io.close();
      },
      read(fd: number, bytes: Uint8Array) {
        reads++;
        const hook = firstRead;
        firstRead = undefined;
        hook?.();
        const size = io.read(fd, bytes);
        if (size === 0) {
          const eof = atEof;
          atEof = undefined;
          eof?.();
        }
        return size;
      },
    };
  },
}));
const { createWorkspaceFiles, createFileTools } = await import('../../../src/files');
const { createPathFileTools } = await import('../../../src/tools/path-files');
const roots: string[] = [];
const owners: WorkspaceFiles[] = [];
afterEach(async () => {
  firstRead = undefined;
  atEof = undefined;
  for (const files of owners.splice(0)) await files.close();
  expect(leakedHandlesAtOwnerClose).toBe(0);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  reads = 0;
  leakedHandlesAtOwnerClose = 0;
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-read-responsive-')));
  roots.push(root);
  const content = `\uFEFF${(`${'a'.repeat(61)}\r\n`).repeat(262144)}`;
  writeFileSync(join(root, 'large.txt'), content);
  writeFileSync(join(root, 'sibling.txt'), 'sibling');
  const files = createWorkspaceFiles({ root });
  owners.push(files);
  return { files, root, content };
}
test('one-line read yields while hashing the complete file and preserves BOM/CRLF baseline', async () => {
  const { files, content } = fixture();
  let settled = false;
  let during = false;
  let release!: () => void;
  const macro = new Promise<void>((resolve) => {
    release = resolve;
  });
  firstRead = () => {
    setImmediate(() => {
      during = !settled;
      release();
    });
  };
  const query = files.read('large.txt', { limit: 1 }).finally(() => {
    settled = true;
  });
  const [result] = await Promise.all([query, macro]);
  expect(during).toBe(true);
  expect(result.content).toBe(`\uFEFF${'a'.repeat(61)}\r\n`);
  expect(result.selection).toEqual({ fromLine: 1, toLine: 1, totalLines: 262144, nextOffset: 2 });
  expect(result.baseline.hash).toBe(createHash('sha256').update(content).digest('hex'));
  expect(result.baseline.size).toBe(Buffer.byteLength(content));
});
test('read Tool abort from a real macrotask interrupts its original complete-file read', async () => {
  const { files } = fixture();
  const controller = new AbortController();
  let atAbort = 0;
  let release!: () => void;
  const macro = new Promise<void>((resolve) => {
    release = resolve;
  });
  firstRead = () => {
    setImmediate(() => {
      atAbort = reads;
      controller.abort();
      release();
    });
  };
  const tool = createFileTools(files).find((tool) => tool.id === 'files.read')!;
  const [result] = await Promise.all([
    tool.execute({ path: 'large.txt', limit: 1 }, { signal: controller.signal } as ToolContext),
    macro,
  ]);
  expect(result.outcome).toBe('cancelled');
  expect(atAbort).toBeGreaterThan(0);
  expect(reads).toBeLessThan(253);
  expect((await files.read('sibling.txt')).content).toBe('sibling');
  const afterSibling = reads;
  await expect(files.read('missing-parent/unused', { signal: controller.signal })).rejects.toBe(
    controller.signal.reason,
  );
  expect(reads).toBe(afterSibling);
});

test('close drains an in-flight read before owner teardown and blocks further IO', async () => {
  const { files, root } = fixture();
  mkdirSync(join(root, 'nested'));
  renameSync(join(root, 'large.txt'), join(root, 'nested', 'large.txt'));
  let close!: Promise<void>;
  let release!: () => void;
  const macro = new Promise<void>((resolve) => {
    release = resolve;
  });
  firstRead = () => {
    setImmediate(() => {
      close = files.close();
      expect(files.close()).toBe(close);
      release();
    });
  };
  const query = files.read('nested/large.txt', { limit: 1 });
  await expect(query).rejects.toMatchObject({ code: 'file_closed' });
  await macro;
  await close;
  const atClose = reads;
  expect(atClose).toBeLessThan(253);
  await expect(files.read('sibling.txt')).rejects.toMatchObject({ code: 'file_closed' });
  expect(reads).toBe(atClose);
  expect(leakedHandlesAtOwnerClose).toBe(0);
});

test('a same-file external change during yielded read rejects the complete baseline', async () => {
  const { files, root, content } = fixture();
  firstRead = () => {
    setImmediate(() => {
      writeFileSync(join(root, 'large.txt'), content.replace('aaa', 'bbb'));
    });
  };
  await expect(files.read('large.txt', { limit: 1 })).rejects.toMatchObject({
    code: 'file_changed',
  });
});

test('search cancellation interrupts one large file rather than waiting for its complete body', async () => {
  const { files } = fixture();
  const controller = new AbortController();
  firstRead = () => {
    setImmediate(() => {
      controller.abort();
    });
  };
  const tool = createFileTools(files).find((tool) => tool.id === 'files.search')!;
  const result = await tool.execute({ text: 'not present', limit: 1 }, {
    signal: controller.signal,
  } as ToolContext);
  expect(result.outcome).toBe('cancelled');
  expect(reads).toBeGreaterThan(0);
  expect(reads).toBeLessThan(253);
});

test('search yields and observes cancellation during line matching after native EOF', async () => {
  const { files } = fixture();
  const controller = new AbortController();
  let completed = false;
  let abortedDuringMatching = false;
  atEof = () => {
    setImmediate(() => {
      abortedDuringMatching = !completed;
      controller.abort();
    });
  };
  const tool = createFileTools(files).find((tool) => tool.id === 'files.search')!;
  const result = await tool.execute({ text: 'post-eof-unmatched-probe', limit: 1 }, {
    signal: controller.signal,
  } as ToolContext);
  completed = true;
  expect(abortedDuringMatching).toBe(true);
  expect(result.outcome).toBe('cancelled');
  expect(reads).toBeGreaterThanOrEqual(253);
});

test('read_user_file passes the actual trusted signal to its anchored complete read', async () => {
  const { root } = fixture();
  const api = createPathFileTools({ qualifiedPlatforms: [process.platform], protectedRoots: [] });
  const controller = new AbortController();
  const input = { path: join(root, 'large.txt'), limit: 1 };
  const capability = await api.describeRequest({
    kind: 'tool',
    definitionId: 'files.read_path',
    definitionVersion: '2',
    input,
    signal: controller.signal,
  } as unknown as AuthorizationRequest);
  firstRead = () => {
    setImmediate(() => {
      controller.abort();
    });
  };
  const result = await api.tools
    .find((tool) => tool.id === 'files.read_path')!
    .execute(input, {
      signal: controller.signal,
      dispatchAuthorization: {
        revision: 'owned-read-dispatch',
        snapshot: {
          namespace: 'builtin.permissions',
          version: '1',
          data: {
            mode: 'accept_edits',
            workspaceTrust: true,
            capability,
          },
        },
      },
    } as unknown as ToolContext);
  expect(result.outcome).toBe('cancelled');
  expect(reads).toBeGreaterThan(0);
  expect(reads).toBeLessThan(253);
});
