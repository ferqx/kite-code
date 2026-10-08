import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { assertNoSymlinkPath } from '../platform/profile-identity';
import { AgentError } from '../storage/types';
import { fileChangePreview } from './files-diff';
import { directoryFlags, listAt, openAt, publishAt, unlinkAt } from './files-native';

export interface FileBaseline {
  hash: string;
  size: number;
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
export interface WorkspaceFiles {
  /** Trusted host byte primitives; not additional Model tools or authority. */
  readBytes(path: string, options: { maxBytes: number }): Promise<FileByteSnapshot>;
  restore(input: {
    path: string;
    bytes: Uint8Array;
    base: FileBaseline | null;
    maxBytes: number;
  }): Promise<FileByteSnapshot>;
  remove(input: { path: string; base: FileBaseline; maxBytes: number }): Promise<FileRemoval>;
  read(path: string, options?: { offset?: number; limit?: number }): Promise<FileSnapshot>;
  glob(input: {
    pattern: string;
    path?: string;
    after?: string;
    limit?: number;
  }): Promise<{ paths: string[]; next: string | null }>;
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
  search(input: {
    text: string;
    path?: string;
    after?: string;
    limit?: number;
  }): Promise<{ matches: { path: string; line: number; content: string }[]; next: string | null }>;
  close(): Promise<void>;
}
const missing = (error: unknown) => (error as { code?: string }).code === 'ENOENT';
const fail = (code: string): never => {
  throw new AgentError(code);
};
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
/** Explicit host selection. POSIX directory descriptors bind operations to the selected objects. */
export function createWorkspaceFiles(options: {
  root: string;
  maxFileBytes?: number;
  /** Trusted relative roots denied to byte recovery operations (including descendants). */
  protectedPaths?: readonly string[];
  /** Trusted host may apply the same deny scope to ordinary Tools as well as byte recovery. */
  protectReads?: boolean;
}): WorkspaceFiles {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    fail('file_platform_unsupported');
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
    protectedPaths.some((path) => normalized === path || normalized.startsWith(`${path}/`));
  const root = resolve(options.root);
  assertNoSymlinkPath(root);
  const rootFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const initial = fstatSync(rootFd);
  if (!initial.isDirectory()) {
    closeSync(rootFd);
    fail('file_root_invalid');
  }
  let closed = false;
  function check(): void {
    if (closed) fail('file_closed');
    assertNoSymlinkPath(root);
    const current = lstatSync(root);
    if (current.dev !== initial.dev || current.ino !== initial.ino || realpathSync(root) !== root)
      fail('file_root_changed');
  }
  function withParent<T>(
    path: string,
    work: (parent: number, name: string) => T,
    strict = false,
  ): T {
    check();
    const parts = segments(path);
    if (!parts.length) fail('file_path_invalid');
    if ((strict || protectReads) && isProtected(parts.join('/'))) fail('file_path_protected');
    if (strict && fstatSync(rootFd).uid !== process.getuid?.()) fail('file_owner_invalid');
    const opened: number[] = [];
    let fd = rootFd;
    try {
      for (const part of parts.slice(0, -1)) {
        fd = openAt(fd, part, directoryFlags);
        opened.push(fd);
        if (strict && fstatSync(fd).uid !== process.getuid?.()) fail('file_owner_invalid');
      }
      return work(fd, parts.at(-1)!);
    } finally {
      for (const child of opened.reverse()) closeSync(child);
    }
  }
  function readAt(path: number, name: string, logical: string): FileSnapshot {
    const fd = openAt(path, name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile()) fail('file_not_regular');
      if (max !== undefined && before.size > BigInt(max)) fail('file_too_large');
      const buffer = Buffer.alloc(64 * 1024);
      const digest = createHash('sha256');
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
      const parts: string[] = [];
      let count = 0;
      while (true) {
        const read = readSync(fd, buffer, 0, buffer.length, null);
        if (!read) break;
        count += read;
        if (!Number.isSafeInteger(count) || (max !== undefined && count > max))
          fail('file_too_large');
        const bytes = buffer.subarray(0, read);
        digest.update(bytes);
        try {
          parts.push(decoder.decode(bytes, { stream: true }));
        } catch {
          fail('file_encoding_invalid');
        }
        if (count === read) checkTextSample(bytes);
      }
      const after = fstatSync(fd, { bigint: true });
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
        parts.push(decoder.decode());
        content = parts.join('');
      } catch {
        return fail('file_encoding_invalid');
      }
      return {
        path: logical,
        content,
        baseline: {
          hash: digest.digest('hex'),
          size: count,
          device: String(after.dev),
          inode: String(after.ino),
        },
      };
    } finally {
      closeSync(fd);
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
    return withParent(input.path, (parent, name) => {
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
      const fd = openAt(
        parent,
        temp,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      let published = false;
      try {
        writeFileSync(fd, input.content, 'utf8');
        fsyncSync(fd);
        verify();
        check();
        publishAt(parent, temp, name, input.base === null);
        published = true;
        fsyncSync(parent);
        const after = readAt(parent, name, input.path);
        const publishedFile = fstatSync(fd, { bigint: true });
        if (
          after.content !== input.content ||
          after.baseline.device !== String(publishedFile.dev) ||
          after.baseline.inode !== String(publishedFile.ino)
        )
          fail('file_publication_changed');
        return { ...after, change: fileChangePreview(before, after) };
      } catch (error) {
        if (published)
          throw new AgentError(
            'file_publish_outcome_unknown',
            error instanceof Error ? error.message : String(error),
          );
        throw error;
      } finally {
        closeSync(fd);
        try {
          unlinkAt(parent, temp);
        } catch {
          // Publication is authoritative; a failed temporary cleanup cannot undo it.
        }
      }
    });
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
    const fd = openAt(
      parent,
      name,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile()) fail('file_not_regular');
      if (before.uid !== BigInt(process.getuid!()) || before.nlink !== 1n)
        fail('file_owner_invalid');
      if (before.size > BigInt(limit)) fail('file_too_large');
      const chunks: Buffer[] = [];
      const digest = createHash('sha256');
      let count = 0;
      const block = Buffer.alloc(64 * 1024);
      for (;;) {
        const size = readSync(fd, block, 0, block.length, null);
        if (!size) break;
        count += size;
        if (!Number.isSafeInteger(count) || count > limit) fail('file_too_large');
        const chunk = Buffer.from(block.subarray(0, size));
        digest.update(chunk);
        chunks.push(chunk);
      }
      const after = fstatSync(fd, { bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        before.uid !== after.uid ||
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
      closeSync(fd);
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
        const fd = openAt(
          parent,
          temp,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        let published = false;
        let result: FileByteSnapshot | undefined;
        let failed = false;
        let failure: unknown;
        try {
          writeFileSync(fd, bytes);
          fsyncSync(fd);
          verifyBytes(parent, name, input.path, input.base, limit);
          check();
          publishAt(parent, temp, name, input.base === null);
          published = true;
          // Create-only publication temporarily has two links; remove the private temp first.
          if (input.base === null) unlinkAt(parent, temp);
          fsyncSync(parent);
          result = readBytesAt(parent, name, input.path, limit);
          const publishedFile = fstatSync(fd, { bigint: true });
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
            closeSync(fd);
          } catch (error) {
            failed = true;
            failure = error;
          }
          try {
            unlinkAt(parent, temp);
          } catch {
            /* Published outcome is authoritative. */
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
        unlinkAt(parent, name);
        try {
          fsyncSync(parent);
          try {
            const fd = openAt(
              parent,
              name,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            closeSync(fd);
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
    );
  }
  function entries(path: string): FileEntry[] {
    const parts = segments(path);
    const sentinel = [...parts, '.kite-list-sentinel'].join('/');
    return withParent(sentinel, (parent) => {
      const result = listAt(parent).filter(
        (entry) => !protectReads || !isProtected([...parts, entry.name].join('/')),
      );
      return result.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    });
  }
  return {
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
      const offset = options.offset ?? 1;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 1 ||
        (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1))
      )
        fail('file_read_range_invalid');
      const snapshot = withParent(path, (parent, name) => readAt(parent, name, path));
      const starts: number[] = [];
      if (snapshot.content.length) {
        starts.push(0);
        for (let at = 0; at < snapshot.content.length; at++)
          if (snapshot.content.charCodeAt(at) === 10 && at + 1 < snapshot.content.length)
            starts.push(at + 1);
      }
      const totalLines = starts.length;
      const from = offset - 1;
      const through =
        options.limit === undefined
          ? totalLines
          : Math.min(totalLines, from + Math.min(options.limit, totalLines));
      const content =
        from >= totalLines
          ? ''
          : snapshot.content.slice(
              starts[from],
              through >= totalLines ? snapshot.content.length : starts[through],
            );
      return {
        ...snapshot,
        content,
        selection: {
          fromLine: offset,
          toLine: from >= totalLines ? null : through,
          totalLines,
          nextOffset: through < totalLines && from < totalLines ? through + 1 : null,
        },
      };
    },
    async glob(input) {
      const scope = segments(input.path ?? '').join('/');
      if (
        typeof input.pattern !== 'string' ||
        !input.pattern ||
        Buffer.from(input.pattern).toString('utf8') !== input.pattern ||
        input.pattern.length > 1024 ||
        input.pattern.includes('\\') ||
        input.pattern.includes('\0') ||
        isAbsolute(input.pattern) ||
        input.pattern.split('/').some((part) => part === '..' || part === '.' || !part) ||
        input.pattern.split('/').length > 64
      )
        fail('file_glob_invalid');
      if (input.after !== undefined) {
        const cursor = segments(input.after).join('/');
        if (!cursor || cursor !== input.after || (scope && !cursor.startsWith(`${scope}/`)))
          fail('file_page_invalid');
      }
      const limit = pageLimit(input.limit);
      let matcher: Bun.Glob;
      try {
        matcher = new Bun.Glob(input.pattern);
      } catch {
        return fail('file_glob_invalid');
      }
      const matches: string[] = [];
      function walk(path: string): void {
        for (const entry of entries(path)) {
          const child = path ? `${path}/${entry.name}` : entry.name;
          if (entry.kind === 'directory') walk(child);
          else if (entry.kind === 'file') {
            const local = scope ? child.slice(scope.length + 1) : child;
            if (
              matcher.match(input.pattern.includes('/') ? local : entry.name) &&
              (input.after === undefined || child > input.after)
            ) {
              matches.push(child);
              matches.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
              if (matches.length > limit + 1) matches.pop();
            }
          }
        }
      }
      walk(scope);
      matches.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const selected = matches
        .filter((path) => input.after === undefined || path > input.after)
        .slice(0, limit + 1);
      return {
        paths: selected.slice(0, limit),
        next: selected.length > limit ? selected[limit - 1]! : null,
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
    async search(input) {
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
      const matches: { path: string; line: number; content: string }[] = [];
      function walk(path: string): void {
        for (const entry of entries(path)) {
          const child = path ? `${path}/${entry.name}` : entry.name;
          if (entry.kind === 'directory') walk(child);
          else if (entry.kind === 'file') {
            let snapshot: FileSnapshot;
            try {
              snapshot = withParent(child, (parent, name) => readAt(parent, name, child));
            } catch (error) {
              if (error instanceof AgentError && error.code === 'file_binary') continue;
              throw error;
            }
            for (const [index, line] of snapshot.content.split('\n').entries())
              if (line.includes(input.text)) {
                const match = { path: child, line: index + 1, content: line };
                const cursor = `${match.path}\0${String(match.line).padStart(12, '0')}`;
                if (input.after && cursor <= input.after) continue;
                matches.push(match);
                if (limit !== undefined && matches.length > limit + 1) {
                  matches.sort((a, b) => {
                    const ak = `${a.path}\0${String(a.line).padStart(12, '0')}`,
                      bk = `${b.path}\0${String(b.line).padStart(12, '0')}`;
                    return ak < bk ? -1 : ak > bk ? 1 : 0;
                  });
                  matches.pop();
                }
              }
          }
        }
      }
      walk(input.path ?? '');
      const key = (m: { path: string; line: number }) =>
        `${m.path}\0${String(m.line).padStart(12, '0')}`;
      matches.sort((a, b) => (key(a) < key(b) ? -1 : 1));
      const selected = matches
        .filter((m) => !input.after || key(m) > input.after)
        .slice(0, limit === undefined ? undefined : limit + 1);
      return {
        matches: limit === undefined ? selected : selected.slice(0, limit),
        next: limit !== undefined && selected.length > limit ? key(selected[limit - 1]!) : null,
      };
    },
    async close() {
      if (!closed) {
        closed = true;
        closeSync(rootFd);
      }
    },
  };
}
