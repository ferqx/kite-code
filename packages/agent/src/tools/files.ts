import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import ignore, { type Ignore } from 'ignore';
import { AgentError } from '../storage/types';
import { fileChangePreview } from './files-diff';
import { createWorkspaceFileIo } from './files-io';

export interface FileBaseline {
  hash: string;
  size: number;
  device: string;
  inode: string;
}
export interface FileIdentity {
  device: string;
  inode: string;
}
export interface FileSnapshot {
  path: string;
  content: string;
  baseline: FileBaseline;
  /** Saved from the verified preimage and the confirmed publication, only for text mutations. */
  change?: FileChangePreview;
  selection?: {
    fromLine: number;
    toLine: number | null;
    totalLines: number;
    nextOffset: number | null;
  };
}
export interface FileChangePreview {
  version: 1;
  format: 'line_diff' | 'file_content';
  path: string;
  before: FileBaseline | null;
  after: FileBaseline;
  text: string;
  truncated: boolean;
}
export interface FileByteSnapshot {
  path: string;
  bytes: Uint8Array;
  baseline: FileBaseline;
}
export interface FileRemoval {
  path: string;
  removedBaseline: FileBaseline;
}
export interface FileEntry {
  name: string;
  kind: 'file' | 'directory' | 'symlink' | 'other';
}
export interface FileSearchInput {
  text: string;
  path?: string;
  after?: string;
  limit?: number;
  glob?: string;
  contextLines?: number;
  maxLineChars?: number;
  respectIgnore?: boolean;
}
export interface FileSearchMatch {
  path: string;
  line: number;
  content: string;
  truncated?: true;
  originalLength?: number;
  before?: { line: number; content: string; truncated?: true; originalLength?: number }[];
  after?: { line: number; content: string; truncated?: true; originalLength?: number }[];
}
export interface FileSearchResult {
  query?: {
    path: string;
    text: string;
    glob: string | null;
    respectIgnore: boolean;
    after: string | null;
    limit: number | null;
    contextLines: number;
    maxLineChars: number | null;
  };
  stats?: {
    checkedTextFiles: number;
    matchedFiles: number;
    matches: number;
    returnedMatches: number;
  };
  files?: { path: string; baseline: FileBaseline }[];
  feedback?: string;
  matches: FileSearchMatch[];
  next: string | null;
  scope?: {
    kind: 'current_page';
    complete: boolean;
    skipped: { binary: number; encoding: number; ignored: number; links: number };
    samples: { path: string; reason: string }[];
    filters: { glob: string | null; respectIgnore: boolean };
  };
}
export interface WorkspaceFiles {
  /** Model Tool boundary: resolve against the fixed Workspace, never process cwd. */
  relativePath(path: string): string;
  /** Trusted host metadata only: strict parent/file identity from the actual native IO. */
  inspectIdentity(path: string): Promise<{ parent: FileIdentity; file: FileIdentity | null }>;
  /** Trusted host byte primitives; not additional Model tools or authority. */
  readBytes(path: string, options: { maxBytes: number }): Promise<FileByteSnapshot>;
  restore(input: {
    path: string;
    bytes: Uint8Array;
    base: FileBaseline | null;
    maxBytes: number;
  }): Promise<FileByteSnapshot>;
  remove(input: { path: string; base: FileBaseline; maxBytes: number }): Promise<FileRemoval>;
  read(
    path: string,
    options?: { offset?: number; limit?: number; signal?: AbortSignal },
  ): Promise<FileSnapshot>;
  glob(
    input: { pattern: string; path?: string; after?: string; limit?: number },
    options?: { signal?: AbortSignal },
  ): Promise<{ paths: string[]; next: string | null }>;
  write(input: { path: string; content: string; base: FileBaseline | null }): Promise<FileSnapshot>;
  edit(input: {
    path: string;
    base: FileBaseline;
    find: string;
    replace: string;
    occurrences: number;
  }): Promise<FileSnapshot>;
  list(input?: {
    path?: string;
    afterName?: string;
    limit?: number;
  }): Promise<{ entries: FileEntry[]; next: string | null }>;
  search(input: FileSearchInput, options?: { signal?: AbortSignal }): Promise<FileSearchResult>;
  close(): Promise<void>;
}
const missing = (error: unknown) => (error as { code?: string }).code === 'ENOENT';
const fail = (code: string): never => {
  throw new AgentError(code);
};
/** Shared lexical contract for path discovery and content filtering. */
function compileFileGlob(pattern: unknown): Bun.Glob {
  if (
    typeof pattern !== 'string' ||
    !pattern ||
    Buffer.from(pattern).toString('utf8') !== pattern ||
    pattern.length > 1024 ||
    pattern.includes('\\') ||
    pattern.includes('\0') ||
    isAbsolute(pattern) ||
    /^[a-z]:\//i.test(pattern) ||
    pattern.split('/').some((part) => part === '..' || part === '.' || !part) ||
    pattern.split('/').length > 64
  )
    return fail('file_glob_invalid');
  try {
    return new Bun.Glob(pattern);
  } catch {
    return fail('file_glob_invalid');
  }
}
function checkTextSample(bytes: Uint8Array): void {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return;
  const size = Math.min(bytes.byteLength, 8192);
  let nonText = 0;
  for (let index = 0; index < size; index++) {
    const byte = bytes[index]!;
    if (
      !(
        byte === 9 ||
        byte === 10 ||
        byte === 13 ||
        (byte >= 32 && byte <= 126) ||
        (byte >= 128 && byte <= 253)
      )
    )
      nonText++;
  }
  if (nonText > size * 0.3) fail('file_binary');
}
function segments(path: string): string[] {
  if (
    typeof path !== 'string' ||
    Buffer.from(path).toString('utf8') !== path ||
    path.length > 4096 ||
    path.includes('\0') ||
    path.includes('\\') ||
    isAbsolute(path)
  )
    fail('file_path_invalid');
  const parts = path.split('/').filter(Boolean);
  if (parts.length > 64 || parts.some((p) => p === '.' || p === '..' || Buffer.byteLength(p) > 255))
    fail('file_path_invalid');
  return parts;
}
function pageLimit(value = 100): number {
  if (!Number.isInteger(value) || value < 1 || value > 200) fail('file_page_invalid');
  return value;
}
/** Explicit host selection. Operations retain the selected physical directory objects. */
export function createWorkspaceFiles(options: {
  root: string;
  maxFileBytes?: number;
  /** Trusted absolute user-file assembly: reject foreign-owner and hardlink read aliases. */
  strictReads?: boolean;
  /** Trusted relative roots denied to byte recovery operations (including descendants). */
  protectedPaths?: readonly string[];
  /** Trusted host may apply the same deny scope to ordinary Tools as well as byte recovery. */
  protectReads?: boolean;
}): WorkspaceFiles {
  const max = options.maxFileBytes;
  if (max !== undefined && (!Number.isSafeInteger(max) || max < 1)) fail('file_limit_invalid');
  if (options.protectedPaths !== undefined && !Array.isArray(options.protectedPaths))
    fail('file_path_invalid');
  const protectedPaths = (options.protectedPaths ?? []).map((path) => {
    const parts = segments(path);
    if (!parts.length) fail('file_path_invalid');
    return parts.join('/');
  });
  if (options.protectReads !== undefined && typeof options.protectReads !== 'boolean')
    fail('file_path_invalid');
  const protectReads = options.protectReads === true;
  const isProtected = (normalized: string) =>
    protectedPaths.some((path) => {
      const name = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
      const denied = process.platform === 'win32' ? path.toLowerCase() : path;
      return name === denied || name.startsWith(`${denied}/`);
    });
  const root = resolve(options.root);
  const io = createWorkspaceFileIo(root, protectedPaths, protectReads);
  const rootFd = io.root;
  let closed = false;
  const activeReads = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  function check(): void {
    if (closed) fail('file_closed');
    io.verifyRoot();
  }
  function withParent<T>(
    path: string,
    work: (parent: number, name: string) => T,
    strict = false,
    mutation = false,
  ): T {
    check();
    const parts = segments(path);
    if (!parts.length) fail('file_path_invalid');
    if ((strict || protectReads) && isProtected(parts.join('/'))) fail('file_path_protected');
    if (strict) io.verifyOwner(rootFd);
    const opened: number[] = [];
    let fd = rootFd;
    let completed = false;
    let result: T | undefined;
    let failed = false;
    let failure: unknown;
    try {
      for (const part of parts.slice(0, -1)) {
        fd = io.openAt(fd, part, 'directory', strict);
        opened.push(fd);
        if (strict) io.verifyOwner(fd);
      }
      result = work(fd, parts.at(-1)!);
      completed = true;
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      for (const child of opened.reverse()) {
        try {
          io.closeHandle(child);
        } catch (error) {
          if (!failed) {
            failure =
              completed && mutation
                ? new AgentError('file_publish_outcome_unknown', 'parent_close_unknown')
                : error;
            failed = true;
          }
        }
      }
    }
    if (failed) throw failure;
    return result!;
  }
  function trackRead<T>(work: () => Promise<T>): Promise<T> {
    const pending = work().finally(() => activeReads.delete(pending));
    activeReads.add(pending);
    return pending;
  }
  async function withReadParent<T>(
    path: string,
    work: (parent: number, name: string) => Promise<T>,
  ): Promise<T> {
    check();
    const parts = segments(path);
    if (!parts.length) fail('file_path_invalid');
    if (protectReads && isProtected(parts.join('/'))) fail('file_path_protected');
    const opened: number[] = [];
    let fd = rootFd;
    let failed = false;
    let failure: unknown;
    let result: T | undefined;
    try {
      for (const part of parts.slice(0, -1)) {
        fd = io.openAt(fd, part, 'directory');
        opened.push(fd);
      }
      result = await work(fd, parts.at(-1)!);
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      for (const child of opened.reverse()) {
        try {
          io.closeHandle(child);
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
    }
    if (failed) throw failure;
    return result!;
  }

  function readAt(path: number, name: string, logical: string, expectedLinks = 1n): FileSnapshot {
    const steps = readSteps(path, name, logical, expectedLinks);
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
    }
  }
  async function readAtAsync(
    parent: number,
    name: string,
    logical: string,
    signal?: AbortSignal,
    selection?: { offset: number; limit?: number },
  ): Promise<FileSnapshot> {
    signal?.throwIfAborted();
    const checkpoint = queryCheckpoint(signal);
    const steps = readSteps(parent, name, logical, 1n, selection);
    try {
      for (;;) {
        const step = steps.next();
        if (step.done) {
          signal?.throwIfAborted();
          check();
          return step.value;
        }
        const pause = checkpoint();
        if (pause) await pause;
      }
    } finally {
      steps.return(undefined as never);
    }
  }
  function* readSteps(
    path: number,
    name: string,
    logical: string,
    expectedLinks = 1n,
    selection?: { offset: number; limit?: number },
  ): Generator<void, FileSnapshot, void> {
    const fd = io.openAt(path, name, 'read');
    try {
      const before = io.stat(fd);
      if (!before.isFile()) fail('file_not_regular');
      if (options.strictReads) {
        io.verifyOwner(fd);
        if (before.nlink !== expectedLinks) fail('file_owner_invalid');
      }
      if (max !== undefined && before.size > BigInt(max)) fail('file_too_large');
      const buffer = Buffer.alloc(64 * 1024);
      const digest = createHash('sha256');
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      const parts: string[] = [];
      let count = 0;
      let line = 1;
      let characters = 0;
      let finalNewline = false;
      const lastLine =
        selection?.limit === undefined ? Infinity : selection.offset + selection.limit - 1;
      function accept(text: string) {
        if (!selection) {
          parts.push(text);
          return;
        }
        characters += text.length;
        if (text.length) finalNewline = text.endsWith('\n');
        let from = 0;
        for (;;) {
          const newline = text.indexOf('\n', from);
          const end = newline === -1 ? text.length : newline + 1;
          if (line >= selection.offset && line <= lastLine && end > from)
            parts.push(text.slice(from, end));
          if (newline === -1) break;
          line++;
          from = end;
        }
      }
      while (true) {
        const read = io.read(fd, buffer);
        if (!read) break;
        count += read;
        if (!Number.isSafeInteger(count) || (max !== undefined && count > max))
          fail('file_too_large');
        const bytes = buffer.subarray(0, read);
        digest.update(bytes);
        try {
          accept(decoder.decode(bytes, { stream: true }));
        } catch {
          fail('file_encoding_invalid');
        }
        if (count === read) checkTextSample(bytes);
        yield;
      }
      const after = io.stat(fd);
      if (options.strictReads) {
        io.verifyOwner(fd);
        if (after.nlink !== expectedLinks) fail('file_owner_invalid');
      }
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        BigInt(count) !== after.size
      )
        fail('file_changed');
      let content: string;
      try {
        accept(decoder.decode());
        content = parts.join('');
      } catch {
        return fail('file_encoding_invalid');
      }
      return {
        path: logical,
        content,
        ...(selection
          ? {
              selection: {
                fromLine: selection.offset,
                toLine:
                  characters === 0 || selection.offset > line - Number(finalNewline)
                    ? null
                    : Math.min(lastLine, line - Number(finalNewline)),
                totalLines: characters === 0 ? 0 : line - Number(finalNewline),
                nextOffset:
                  characters !== 0 && lastLine < line - Number(finalNewline) ? lastLine + 1 : null,
              },
            }
          : {}),
        baseline: {
          hash: digest.digest('hex'),
          size: count,
          device: String(after.dev),
          inode: String(after.ino),
        },
      };
    } finally {
      io.closeHandle(fd);
    }
  }
  function baselineEqual(a: FileBaseline, b: FileBaseline): boolean {
    return a.hash === b.hash && a.size === b.size && a.device === b.device && a.inode === b.inode;
  }
  function write(input: {
    path: string;
    content: string;
    base: FileBaseline | null;
  }): FileSnapshot {
    if (
      typeof input.content !== 'string' ||
      (max !== undefined && Buffer.byteLength(input.content) > max)
    )
      fail('file_too_large');
    if (Buffer.from(input.content).toString('utf8') !== input.content)
      fail('file_encoding_invalid');
    checkTextSample(Buffer.from(input.content.slice(0, 8192)));
    return withParent(
      input.path,
      (parent, name) => {
        let before: FileSnapshot | null = null;
        const verify = () => {
          try {
            const current = readAt(parent, name, input.path);
            if (!input.base || !baselineEqual(current.baseline, input.base))
              fail('file_baseline_conflict');
            before = current;
          } catch (error) {
            if (!(missing(error) && input.base === null)) throw error;
          }
        };
        verify();
        const temp = `.kite-write-${randomUUID()}`;
        const fd = io.openAt(parent, temp, 'temporary');
        let published = false;
        let result: FileSnapshot | undefined;
        let failed = false;
        let failure: unknown;
        try {
          io.write(fd, Buffer.from(input.content));
          io.sync(fd);
          verify();
          check();
          io.publishAt(parent, temp, name, input.base === null);
          published = true;
          io.sync(parent);
          // POSIX create-only publication temporarily retains exactly our known temp hardlink.
          const after = readAt(
            parent,
            name,
            input.path,
            input.base === null && io.createOnlyLeavesTemporary ? 2n : 1n,
          );
          const publishedFile = io.stat(fd);
          if (
            after.content !== input.content ||
            after.baseline.device !== String(publishedFile.dev) ||
            after.baseline.inode !== String(publishedFile.ino)
          )
            fail('file_publication_changed');
          result = { ...after, change: fileChangePreview(before, after) };
        } catch (error) {
          failed = true;
          failure = error;
        } finally {
          try {
            io.closeHandle(fd);
          } catch (error) {
            failed = true;
            failure = error;
          }
          try {
            io.unlinkAt(parent, temp);
          } catch (error) {
            // Publication is authoritative; a failed temporary cleanup cannot undo it.
            if (error instanceof AgentError && error.code === 'file_close_unknown') {
              failed = true;
              failure = error;
            }
          }
        }
        if (failed) {
          if (published)
            throw new AgentError(
              'file_publish_outcome_unknown',
              failure instanceof Error ? failure.message : String(failure),
            );
          throw failure;
        }
        return result!;
      },
      false,
      true,
    );
  }
  function byteLimit(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1) fail('file_limit_invalid');
    return max === undefined ? value : Math.min(value, max);
  }
  function assertBaseline(base: FileBaseline): void {
    if (
      !base ||
      !/^[a-f0-9]{64}$/.test(base.hash) ||
      !Number.isSafeInteger(base.size) ||
      base.size < 0 ||
      !/^(0|[1-9][0-9]*)$/.test(base.device) ||
      !/^(0|[1-9][0-9]*)$/.test(base.inode)
    )
      fail('file_baseline_invalid');
  }
  function readBytesAt(
    parent: number,
    name: string,
    path: string,
    limit: number,
  ): FileByteSnapshot {
    const fd = io.openAt(parent, name, 'read', true);
    try {
      const before = io.stat(fd);
      if (!before.isFile()) fail('file_not_regular');
      io.verifyOwner(fd);
      if (before.nlink !== 1n) fail('file_owner_invalid');
      if (before.size > BigInt(limit)) fail('file_too_large');
      const chunks: Buffer[] = [];
      const digest = createHash('sha256');
      let count = 0;
      const block = Buffer.alloc(64 * 1024);
      for (;;) {
        const size = io.read(fd, block);
        if (!size) break;
        count += size;
        if (!Number.isSafeInteger(count) || count > limit) fail('file_too_large');
        const chunk = Buffer.from(block.subarray(0, size));
        digest.update(chunk);
        chunks.push(chunk);
      }
      const after = io.stat(fd);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        before.owner !== after.owner ||
        after.nlink !== 1n ||
        BigInt(count) !== after.size
      )
        fail('file_changed');
      return {
        path,
        bytes: Buffer.concat(chunks, count),
        baseline: {
          hash: digest.digest('hex'),
          size: count,
          device: String(after.dev),
          inode: String(after.ino),
        },
      };
    } finally {
      io.closeHandle(fd);
    }
  }
  function verifyBytes(
    parent: number,
    name: string,
    path: string,
    base: FileBaseline | null,
    limit: number,
  ): void {
    try {
      const current = readBytesAt(parent, name, path, limit);
      if (base === null || !baselineEqual(current.baseline, base)) fail('file_baseline_conflict');
    } catch (error) {
      if (!(missing(error) && base === null)) throw error;
    }
  }
  function restore(input: {
    path: string;
    bytes: Uint8Array;
    base: FileBaseline | null;
    maxBytes: number;
  }): FileByteSnapshot {
    const limit = byteLimit(input.maxBytes);
    if (!(input.bytes instanceof Uint8Array)) fail('file_bytes_invalid');
    if (input.bytes.byteLength > limit) fail('file_too_large');
    if (input.base !== null) assertBaseline(input.base);
    // Freeze caller-owned mutable bytes before any publication.
    const bytes = Buffer.from(input.bytes);
    return withParent(
      input.path,
      (parent, name) => {
        verifyBytes(parent, name, input.path, input.base, limit);
        const temp = `.kite-write-${randomUUID()}`;
        const fd = io.openAt(parent, temp, 'temporary');
        let published = false;
        let result: FileByteSnapshot | undefined;
        let failed = false;
        let failure: unknown;
        try {
          io.write(fd, bytes);
          io.sync(fd);
          verifyBytes(parent, name, input.path, input.base, limit);
          check();
          io.publishAt(parent, temp, name, input.base === null);
          published = true;
          // POSIX create-only links retain a second name; Windows moves the original temporary.
          if (input.base === null && io.createOnlyLeavesTemporary) io.unlinkAt(parent, temp);
          io.sync(parent);
          result = readBytesAt(parent, name, input.path, limit);
          const publishedFile = io.stat(fd);
          if (
            result.baseline.device !== String(publishedFile.dev) ||
            result.baseline.inode !== String(publishedFile.ino) ||
            result.baseline.hash !== createHash('sha256').update(bytes).digest('hex') ||
            result.baseline.size !== bytes.length
          )
            fail('file_changed');
          check();
        } catch (error) {
          failed = true;
          failure = error;
        } finally {
          try {
            io.closeHandle(fd);
          } catch (error) {
            failed = true;
            failure = error;
          }
          try {
            io.unlinkAt(parent, temp);
          } catch (error) {
            /* Published outcome is authoritative. */
            if (error instanceof AgentError && error.code === 'file_close_unknown') {
              failed = true;
              failure = error;
            }
          }
        }
        if (failed) {
          if (published)
            throw new AgentError(
              'file_publish_outcome_unknown',
              failure instanceof Error ? failure.message : String(failure),
            );
          throw failure;
        }
        return result!;
      },
      true,
      true,
    );
  }
  function remove(input: { path: string; base: FileBaseline; maxBytes: number }): FileRemoval {
    const limit = byteLimit(input.maxBytes);
    assertBaseline(input.base);
    return withParent(
      input.path,
      (parent, name) => {
        verifyBytes(parent, name, input.path, input.base, limit);
        check();
        io.unlinkAt(parent, name, true);
        try {
          io.sync(parent);
          try {
            const fd = io.openAt(parent, name, 'read');
            io.closeHandle(fd);
            fail('file_changed');
          } catch (error) {
            if (!missing(error)) throw error;
          }
          check();
          return { path: input.path, removedBaseline: { ...input.base } };
        } catch (error) {
          throw new AgentError(
            'file_publish_outcome_unknown',
            error instanceof Error ? error.message : String(error),
          );
        }
      },
      true,
      true,
    );
  }
  function entries(path: string): FileEntry[] {
    const parts = segments(path);
    const sentinel = [...parts, '.kite-list-sentinel'].join('/');
    return withParent(sentinel, (parent) => {
      const result = io
        .listAt(parent)
        .filter((entry) => !protectReads || !isProtected([...parts, entry.name].join('/')));
      return result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    });
  }
  /** Cooperative budget; each caller retains ownership of its live handles until finally. */
  function queryCheckpoint(signal?: AbortSignal) {
    let remaining = 64;
    let until = performance.now() + 8;
    return () => {
      signal?.throwIfAborted();
      if (--remaining > 0 && performance.now() < until) return;
      return setImmediate(undefined, { signal }).then(() => {
        signal?.throwIfAborted();
        check();
        remaining = 64;
        until = performance.now() + 8;
      });
    };
  }
  return {
    relativePath(path) {
      if (
        typeof path !== 'string' ||
        Buffer.from(path).toString('utf8') !== path ||
        path.length > 4096 ||
        path.includes('\0')
      )
        fail('file_path_invalid');
      if (path === '.' || path === '') return '';
      const windows = process.platform === 'win32';
      const logical = windows ? path.replaceAll('\\', '/') : path;
      // Check before path.relative can erase traversal components.
      if (logical.split('/').some((part) => part === '.' || part === '..'))
        fail('file_path_invalid');
      if (isAbsolute(path)) {
        // The Windows engine supports local drive paths, never UNC/device or drive-relative paths.
        if (windows && !/^[a-z]:[\\/]/i.test(path)) fail('file_path_invalid');
        const selected = relative(root, path);
        return segments(windows ? selected.replaceAll('\\', '/') : selected).join('/');
      }
      if (windows && /^[a-z]:/i.test(path)) fail('file_path_invalid');
      return segments(logical).join('/');
    },
    async inspectIdentity(path) {
      return withParent(
        path,
        (parent, name) => {
          let fd: number | undefined;
          try {
            fd = io.openAt(parent, name, 'read', true);
          } catch (error) {
            if (!missing(error)) throw error;
          }
          let file: FileIdentity | null = null;
          if (fd !== undefined) {
            try {
              const stat = io.stat(fd);
              if (!stat.isFile()) fail('file_not_regular');
              io.verifyOwner(fd);
              if (stat.nlink !== 1n) fail('file_owner_invalid');
              file = { device: String(stat.dev), inode: String(stat.ino) };
            } finally {
              io.closeHandle(fd);
            }
          }
          check();
          const stat = io.stat(parent);
          return { parent: { device: String(stat.dev), inode: String(stat.ino) }, file };
        },
        true,
      );
    },
    async readBytes(path, options) {
      const limit = byteLimit(options.maxBytes);
      return withParent(
        path,
        (parent, name) => {
          const snapshot = readBytesAt(parent, name, path, limit);
          check();
          return snapshot;
        },
        true,
      );
    },
    async restore(input) {
      return restore(input);
    },
    async remove(input) {
      return remove(input);
    },
    async read(path, options = {}) {
      options.signal?.throwIfAborted();
      const offset = options.offset ?? 1;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 1 ||
        (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1))
      )
        fail('file_read_range_invalid');
      return trackRead(() =>
        withReadParent(path, (parent, name) =>
          readAtAsync(parent, name, path, options.signal, { offset, limit: options.limit }),
        ),
      );
    },
    async glob(input, options) {
      options?.signal?.throwIfAborted();
      const scope = segments(input.path ?? '').join('/');
      const matcher = compileFileGlob(input.pattern);
      if (input.after !== undefined) {
        const cursor = segments(input.after).join('/');
        if (!cursor || cursor !== input.after || (scope && !cursor.startsWith(`${scope}/`)))
          fail('file_page_invalid');
      }
      const limit = pageLimit(input.limit);
      // Only complete literal directory components can exclude a subtree. Basename
      // patterns still match at every depth, and all wildcard semantics stay with Bun.
      const prefix: string[] = [];
      if (input.pattern.includes('/')) {
        for (const part of input.pattern.split('/').slice(0, -1)) {
          if (/[*?[\]{}()!+@]/.test(part)) break;
          prefix.push(part);
        }
      }
      const checkpoint = queryCheckpoint(options?.signal);
      const matches: string[] = [];
      async function walk(path: string): Promise<boolean> {
        // A directory's descendants begin with "name/", not "name". This order
        // makes DFS equal complete-path order (including a.ts before a/child.ts).
        const ordered = entries(path).sort((a, b) => {
          const ak = a.name + (a.kind === 'directory' ? '/' : ''),
            bk = b.name + (b.kind === 'directory' ? '/' : '');
          return ak < bk ? -1 : ak > bk ? 1 : 0;
        });
        for (const entry of ordered) {
          await checkpoint();
          const child = path ? `${path}/${entry.name}` : entry.name;
          const local = scope ? child.slice(scope.length + 1) : child;
          if (entry.kind === 'directory') {
            const parts = local.split('/');
            if (prefix.some((part, index) => index < parts.length && parts[index] !== part))
              continue;
            if (await walk(child)) return true;
          } else if (entry.kind === 'file') {
            if (
              matcher.match(input.pattern.includes('/') ? local : entry.name) &&
              (input.after === undefined || child > input.after)
            ) {
              matches.push(child);
              if (matches.length > limit) return true;
            }
          }
        }
        return false;
      }
      await walk(scope);
      options?.signal?.throwIfAborted();
      check();
      return {
        paths: matches.slice(0, limit),
        next: matches.length > limit ? matches[limit - 1]! : null,
      };
    },
    async write(input) {
      return write(input);
    },
    async edit(input) {
      if (
        !input.base ||
        typeof input.find !== 'string' ||
        !input.find ||
        typeof input.replace !== 'string' ||
        !Number.isSafeInteger(input.occurrences) ||
        input.occurrences < 1
      )
        fail('file_edit_invalid');
      const original = withParent(input.path, (parent, name) => readAt(parent, name, input.path));
      if (!baselineEqual(original.baseline, input.base)) fail('file_baseline_conflict');
      if (
        max !== undefined &&
        (Buffer.byteLength(input.find) > max || Buffer.byteLength(input.replace) > max)
      )
        fail('file_too_large');
      const pieces: string[] = [];
      let cursor = 0;
      let count = 0;
      let bytes = 0;
      for (
        let at = original.content.indexOf(input.find, cursor);
        at !== -1;
        at = original.content.indexOf(input.find, cursor)
      ) {
        if (++count > input.occurrences) fail('file_edit_match_conflict');
        const part = original.content.slice(cursor, at);
        bytes += Buffer.byteLength(part) + Buffer.byteLength(input.replace);
        if (max !== undefined && bytes > max) fail('file_too_large');
        pieces.push(part, input.replace);
        cursor = at + input.find.length;
      }
      if (count !== input.occurrences) fail('file_edit_match_conflict');
      const tail = original.content.slice(cursor);
      if (max !== undefined && bytes + Buffer.byteLength(tail) > max) fail('file_too_large');
      pieces.push(tail);
      return write({ path: input.path, base: input.base, content: pieces.join('') });
    },
    async list(input = {}) {
      if (
        input.afterName !== undefined &&
        (typeof input.afterName !== 'string' ||
          Buffer.byteLength(input.afterName) > 255 ||
          input.afterName.includes('/') ||
          input.afterName.includes('\0'))
      )
        fail('file_page_invalid');
      const limit = pageLimit(input.limit);
      const all = entries(input.path ?? '').filter(
        (entry) => !input.afterName || entry.name > input.afterName,
      );
      const selected = all.slice(0, limit);
      return { entries: selected, next: all.length > limit ? selected.at(-1)!.name : null };
    },
    async search(input, options) {
      options?.signal?.throwIfAborted();
      if (typeof input.text !== 'string' || !input.text || Buffer.byteLength(input.text) > 1024)
        fail('file_search_invalid');
      if (input.after !== undefined) {
        if (typeof input.after !== 'string' || input.after.length > 4110) fail('file_page_invalid');
        const parts = input.after.split('\0');
        if (parts.length !== 2 || !/^\d{12}$/.test(parts[1]!) || BigInt(parts[1]!) === 0n)
          fail('file_page_invalid');
        segments(parts[0]!);
      }
      const limit = input.limit === undefined ? undefined : pageLimit(input.limit);
      const contextLines = input.contextLines ?? 0;
      if (!Number.isSafeInteger(contextLines) || contextLines < 0 || contextLines > 10)
        fail('file_search_context_invalid');
      if (
        input.maxLineChars !== undefined &&
        (!Number.isSafeInteger(input.maxLineChars) || input.maxLineChars < 1)
      )
        fail('file_search_preview_invalid');
      if (input.respectIgnore !== undefined && typeof input.respectIgnore !== 'boolean')
        fail('file_search_filter_invalid');
      const matcher = input.glob === undefined ? undefined : compileFileGlob(input.glob);
      const scope = segments(input.path ?? '').join('/');
      const matches: FileSearchMatch[] = [];
      let checkedTextFiles = 0;
      const matchedBaselines = new Map<string, FileBaseline>();
      const skipped = { binary: 0, encoding: 0, ignored: 0, links: 0 };
      const samples: { path: string; reason: string }[] = [];
      const skip = (path: string, reason: keyof typeof skipped) => {
        skipped[reason]++;
        if (samples.length < 20) samples.push({ path, reason });
      };
      const checkpoint = queryCheckpoint(options?.signal);
      const key = (m: { path: string; line: number }) =>
        `${m.path}\0${String(m.line).padStart(12, '0')}`;
      const preview = (content: string) => {
        if (input.maxLineChars === undefined || content.length <= input.maxLineChars)
          return { content };
        // Do not split a UTF-16 surrogate pair in the preview.
        let end = input.maxLineChars;
        if (end > 0 && /[\uD800-\uDBFF]/.test(content[end - 1]!)) end--;
        return {
          content: content.slice(0, end),
          truncated: true as const,
          originalLength: content.length,
        };
      };
      const read = (path: string) =>
        trackRead(() =>
          withReadParent(path, (parent, name) => readAtAsync(parent, name, path, options?.signal)),
        );
      async function searchFile(path: string): Promise<boolean> {
        let snapshot: FileSnapshot;
        try {
          snapshot = await read(path);
        } catch (error) {
          if (
            error instanceof AgentError &&
            ['file_binary', 'file_encoding_invalid'].includes(error.code)
          ) {
            skip(path, error.code === 'file_binary' ? 'binary' : 'encoding');
            return false;
          }
          throw error;
        }
        checkedTextFiles++;
        // Keep at most the requested preceding lines, rather than a full-file line array.
        const preceding: {
          line: number;
          content: string;
          truncated?: true;
          originalLength?: number;
        }[] = [];
        let offset = 0;
        let index = 0;
        for (;;) {
          const pause = checkpoint();
          if (pause) await pause;
          const newline = snapshot.content.indexOf('\n', offset);
          const line = snapshot.content.slice(offset, newline === -1 ? undefined : newline);
          const match: FileSearchMatch = { path, line: index + 1, ...preview(line) };
          if (line.includes(input.text) && (!input.after || key(match) > input.after)) {
            if (contextLines) {
              match.before = [...preceding];
              match.after = [];
              let following = newline === -1 ? snapshot.content.length : newline + 1;
              for (let at = 0; at < contextLines && following < snapshot.content.length; at++) {
                const end = snapshot.content.indexOf('\n', following);
                match.after.push({
                  line: index + at + 2,
                  ...preview(snapshot.content.slice(following, end === -1 ? undefined : end)),
                });
                following = end === -1 ? snapshot.content.length : end + 1;
              }
            }
            matchedBaselines.set(path, snapshot.baseline);
            matches.push(match);
            if (limit !== undefined && matches.length > limit) return true;
          }
          if (contextLines) {
            preceding.push({ line: index + 1, ...preview(line) });
            if (preceding.length > contextLines) preceding.shift();
          }
          if (newline === -1) break;
          offset = newline + 1;
          index++;
        }
        return false;
      }
      type IgnoreScope = { base: string; matcher: Ignore };
      async function walk(path: string, parents: IgnoreScope[]): Promise<boolean> {
        const all = entries(path);
        let rules = parents;
        let unreadableIgnore = false;
        if (
          input.respectIgnore &&
          all.some((entry) => entry.name === '.gitignore' && entry.kind === 'file')
        ) {
          const file = path ? `${path}/.gitignore` : '.gitignore';
          try {
            rules = [...parents, { base: path, matcher: ignore().add((await read(file)).content) }];
          } catch (error) {
            if (
              !(error instanceof AgentError) ||
              !['file_binary', 'file_encoding_invalid'].includes(error.code)
            )
              throw error;
            skip(file, error.code === 'file_binary' ? 'binary' : 'encoding');
            unreadableIgnore = true;
          }
        }
        const ordered = all.sort((a, b) => {
          const ak = a.name + (a.kind === 'directory' ? '/' : '');
          const bk = b.name + (b.kind === 'directory' ? '/' : '');
          return ak < bk ? -1 : ak > bk ? 1 : 0;
        });
        for (const entry of ordered) {
          await checkpoint();
          const child = path ? `${path}/${entry.name}` : entry.name;
          if (unreadableIgnore && entry.name === '.gitignore') continue;
          if (entry.kind === 'symlink' || entry.kind === 'other') {
            skip(child, 'links');
            continue;
          }
          let excluded = false;
          for (const rule of rules) {
            const local =
              (rule.base ? child.slice(rule.base.length + 1) : child) +
              (entry.kind === 'directory' ? '/' : '');
            const verdict = rule.matcher.test(local);
            if (verdict.ignored) excluded = true;
            else if (verdict.unignored) excluded = false;
          }
          if (excluded) {
            skip(child, 'ignored');
            continue;
          }
          if (entry.kind === 'directory') {
            if (await walk(child, rules)) return true;
          } else {
            const local = scope ? child.slice(scope.length + 1) : child;
            if (matcher && !matcher.match(input.glob!.includes('/') ? local : entry.name)) continue;
            // Entire files before the continuation cannot contain a later result.
            if (input.after && child < input.after.split('\0')[0]!) continue;
            if (await searchFile(child)) return true;
          }
        }
        return false;
      }
      if (!scope) await walk('', []);
      else {
        const kind = withParent(
          scope,
          (parent, name) =>
            io
              .listAt(parent)
              .find((entry) =>
                process.platform === 'win32'
                  ? entry.name.toLowerCase() === name.toLowerCase()
                  : entry.name === name,
              )?.kind,
        );
        if (!kind) fail('ENOENT');
        if (kind === 'directory') await walk(scope, []);
        else if (kind === 'file') {
          const name = scope.split('/').at(-1)!;
          if (!matcher || matcher.match(name)) await searchFile(scope);
        } else fail('file_not_regular');
      }
      options?.signal?.throwIfAborted();
      check();
      const more = limit !== undefined && matches.length > limit;
      const selected = more ? matches.slice(0, limit) : matches;
      const incomplete = more || Object.values(skipped).some(Boolean);
      const feedback = [
        'This is literal text matching in the selected scope and filters. Even a complete scan does not prove call reachability, absence of other implementations, or absence of differently worded references.',
        ...(['|', '.*', '\\b'].some((marker) => input.text.includes(marker))
          ? [
              'The query contains pattern-like text (|, .* or \\b), but these characters are matched literally, not as OR, wildcards or word boundaries. Use separate literal queries when testing alternatives.',
            ]
          : []),
        ...(selected.length === 0
          ? [
              'No literal match was found in the checked scope; this does not establish which implementation is active. Check the entry point/configuration or change the query or scope.',
            ]
          : []),
        ...(more
          ? [
              'More matches remain. Continue with next using the same query and filters; this page is not the complete search.',
            ]
          : []),
        ...(Object.values(skipped).some(Boolean)
          ? [
              'Some scope was not inspected; consult scope.skipped and samples before claiming absence.',
            ]
          : []),
      ].join(' ');
      return {
        query: {
          path: scope,
          text: input.text,
          glob: input.glob ?? null,
          respectIgnore: input.respectIgnore === true,
          after: input.after ?? null,
          limit: limit ?? null,
          contextLines,
          maxLineChars: input.maxLineChars ?? null,
        },
        stats: {
          checkedTextFiles,
          matchedFiles: matchedBaselines.size,
          matches: matches.length,
          returnedMatches: selected.length,
        },
        files: [...new Set(selected.map((match) => match.path))].map((path) => ({
          path,
          baseline: matchedBaselines.get(path)!,
        })),
        ...(feedback ? { feedback } : {}),
        matches: selected,
        next: more ? key(matches[limit! - 1]!) : null,
        ...(more ||
        input.respectIgnore ||
        input.glob !== undefined ||
        Object.values(skipped).some(Boolean)
          ? {
              scope: {
                kind: 'current_page' as const,
                complete: !incomplete,
                skipped,
                samples,
                filters: { glob: input.glob ?? null, respectIgnore: input.respectIgnore === true },
              },
            }
          : {}),
      };
    },
    close() {
      if (!closing) {
        closed = true;
        closing = (async () => {
          await Promise.allSettled([...activeReads]);
          io.close();
        })();
      }
      return closing;
    },
  };
}
