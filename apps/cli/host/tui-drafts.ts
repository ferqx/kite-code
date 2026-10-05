import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { FileLock, ProfileAccess } from '@kite-ai/agent/profile-access';

export type TuiDraftScope = { storeId: string; workspaceId: string; sessionId: string };
export type TuiStoredDraft = TuiDraftScope & { id: string; revision: string; text: string };
export type TuiDraftDocument = { version: 1; revision: string; drafts: TuiStoredDraft[] };
export class TuiDraftError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const limit = 16 * 1024 * 1024,
  maximum = 9223372036854775807n;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const scopeId = (scope: TuiDraftScope) =>
  digest(Buffer.from(JSON.stringify([scope.storeId, scope.workspaceId, scope.sessionId])));
function revision(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length > 19 ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > maximum
  )
    throw new TuiDraftError('tui_draft_storage_unavailable');
}
function next(value: string) {
  revision(value);
  if (BigInt(value) === maximum) throw new TuiDraftError('tui_draft_capacity_exceeded');
  return String(BigInt(value) + 1n);
}
function closed(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== keys.sort().join(',')
  )
    throw new TuiDraftError('tui_draft_storage_unavailable');
}
function scope(value: TuiDraftScope) {
  for (const id of [value.storeId, value.workspaceId, value.sessionId])
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
      throw new TuiDraftError('tui_draft_scope_invalid');
}
export function parseTuiDraftDocument(value: unknown): TuiDraftDocument {
  closed(value, ['version', 'revision', 'drafts']);
  revision(value.revision);
  if (value.version !== 1 || !Array.isArray(value.drafts) || value.drafts.length > 4096)
    throw new TuiDraftError('tui_draft_storage_unavailable');
  const ids = new Set<string>();
  for (const entry of value.drafts) {
    closed(entry, ['id', 'storeId', 'workspaceId', 'sessionId', 'revision', 'text']);
    revision(entry.revision);
    scope(entry as TuiStoredDraft);
    if (
      typeof entry.text !== 'string' ||
      entry.id !== scopeId(entry as TuiStoredDraft) ||
      ids.has(String(entry.id))
    )
      throw new TuiDraftError('tui_draft_storage_unavailable');
    ids.add(String(entry.id));
  }
  return value as TuiDraftDocument;
}
function present(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function finite<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof TuiDraftError) throw error;
    throw new TuiDraftError(
      (error as { code?: string })?.code === 'owner_busy'
        ? 'tui_draft_busy'
        : 'tui_draft_storage_unavailable',
    );
  }
}
function privateStat(path: string, directory = false) {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw new TuiDraftError('tui_draft_storage_unavailable');
  return stat;
}
/** Host-only file owner. A shared profile lease surrounds every read/write; UI receives no path. */
export function openTuiDraftFile(input: {
  access: ProfileAccess;
  acquireWriteLock: () => FileLock;
}) {
  const parent = join(input.access.profilePath, 'ui'),
    path = join(parent, 'tui.json');
  let disposed = false;
  const active = () => {
    if (disposed) throw new TuiDraftError('tui_draft_storage_unavailable');
  };
  const read = () => {
    active();
    privateStat(input.access.profilePath, true);
    if (present(parent)) privateStat(parent, true);
    if (!present(path))
      return {
        document: { version: 1, revision: '0', drafts: [] } as TuiDraftDocument,
        etag: null,
      };
    const original = privateStat(path),
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (
        opened.dev !== original.dev ||
        opened.ino !== original.ino ||
        opened.size !== original.size ||
        opened.ctimeMs !== original.ctimeMs ||
        opened.nlink !== 1 ||
        (opened.mode & 0o077) !== 0 ||
        opened.size > limit
      )
        throw new TuiDraftError('tui_draft_storage_unavailable');
      const bytes = readFileSync(fd),
        after = fstatSync(fd);
      if (
        bytes.length !== opened.size ||
        after.ctimeMs !== opened.ctimeMs ||
        after.size !== opened.size
      )
        throw new TuiDraftError('tui_draft_storage_unavailable');
      return {
        document: parseTuiDraftDocument(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        ),
        etag: digest(bytes),
      };
    } finally {
      closeSync(fd);
    }
  };
  const load = (selected: TuiDraftScope) => {
    scope(selected);
    return (
      read().document.drafts.find((row) => row.id === scopeId(selected)) ?? {
        ...selected,
        id: scopeId(selected),
        revision: '0',
        text: '',
      }
    );
  };
  const save = (
    selected: TuiDraftScope,
    expectedRevision: string,
    text: string,
  ): TuiStoredDraft => {
    active();
    scope(selected);
    revision(expectedRevision);
    if (typeof text !== 'string') throw new TuiDraftError('tui_draft_storage_unavailable');
    const lock = input.acquireWriteLock();
    let temporary: string | undefined;
    try {
      const original = read(),
        id = scopeId(selected),
        previous = original.document.drafts.find((row) => row.id === id);
      if ((previous?.revision ?? '0') !== expectedRevision)
        throw new TuiDraftError('tui_draft_revision_conflict');
      if (previous?.text === text) return previous;
      const saved = { ...selected, id, revision: next(expectedRevision), text };
      const rows = original.document.drafts.filter((row) => row.id !== id);
      rows.push(saved);
      rows.sort((a, b) => a.id.localeCompare(b.id));
      if (rows.length > 4096) throw new TuiDraftError('tui_draft_capacity_exceeded');
      const bytes = Buffer.from(
        JSON.stringify({ version: 1, revision: next(original.document.revision), drafts: rows }) +
          '\n',
      );
      if (bytes.length > limit) throw new TuiDraftError('tui_draft_capacity_exceeded');
      mkdirSync(parent, { mode: 0o700, recursive: true });
      privateStat(parent, true);
      temporary = join(parent, `.tui-${randomUUID()}.tmp`);
      const fd = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const size = writeSync(fd, bytes, offset, bytes.length - offset);
          if (!size) throw new TuiDraftError('tui_draft_storage_unavailable');
          offset += size;
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (read().etag !== original.etag) throw new TuiDraftError('tui_draft_revision_conflict');
      renameSync(temporary, path);
      temporary = undefined;
      const directory = openSync(
        parent,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      if (read().etag !== digest(bytes)) throw new TuiDraftError('tui_draft_publication_uncertain');
      return saved;
    } finally {
      if (temporary) rmSync(temporary, { force: true });
      lock.release();
    }
  };
  return {
    load: (selected: TuiDraftScope) => finite(() => load(selected)),
    save: (selected: TuiDraftScope, expectedRevision: string, text: string) =>
      finite(() => save(selected, expectedRevision, text)),
    list() {
      return finite(() => read().document.drafts.filter((row) => row.text.length > 0));
    },
    readId(id: string) {
      const row = finite(() => read().document.drafts.find((row) => row.id === id));
      if (!row) throw new TuiDraftError('tui_draft_not_found');
      return row;
    },
    close() {
      disposed = true;
    },
  };
}
