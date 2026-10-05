import { dlopen, ptr, toArrayBuffer } from 'bun:ffi';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentClient } from '@kite-ai/client';
import type { TuiFileCandidatesPort, TuiFileScope } from '@kite-ai/ui/tui';
import ignore, { type Ignore } from 'ignore';

const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const excluded = new Set([
  'node_modules',
  '.git',
  '.kite-code',
  'dist',
  'build',
  '__pycache__',
  '.DS_Store',
  'coverage',
]);
let native: ReturnType<typeof load> | undefined;
function load() {
  return dlopen(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    ...(process.platform === 'darwin'
      ? { __openat: { args: ['i32', 'ptr', 'i32', 'u32'], returns: 'i32' } as const }
      : { openat: { args: ['i32', 'ptr', 'i32', 'u32'], returns: 'i32' } as const }),
    fdopendir: { args: ['i32'], returns: 'ptr' },
    readdir: { args: ['ptr'], returns: 'ptr' },
    closedir: { args: ['ptr'], returns: 'i32' },
    ...(process.platform === 'darwin'
      ? { __error: { args: [], returns: 'ptr' } as const }
      : { __errno_location: { args: [], returns: 'ptr' } as const }),
  });
}
function api() {
  native ??= load();
  return native.symbols;
}
function openAt(fd: number, name: string, mode: number) {
  const bytes = Buffer.from(`${name}\0`),
    a = api();
  const next = ('__openat' in a ? a.__openat : a.openat)(
    fd,
    ptr(bytes),
    mode | (process.platform === 'darwin' ? 0x1000000 : 0x80000),
    0,
  );
  if (next < 0) throw new Error('file_candidate_open_unavailable');
  return next;
}
function canonicalDirectory(path: string) {
  let fd = openSync('/', flags);
  try {
    for (const segment of path.split('/').filter(Boolean)) {
      const next = openAt(fd, segment, flags);
      closeSync(fd);
      fd = next;
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
function sameDirectory(fd: number, path: string) {
  const proof = canonicalDirectory(path);
  try {
    const a = fstatSync(fd, { bigint: true }),
      b = fstatSync(proof, { bigint: true });
    if (a.dev !== b.dev || a.ino !== b.ino) throw new Error('file_candidate_directory_changed');
  } finally {
    closeSync(proof);
  }
}
function names(fd: number) {
  const a = api(),
    dup = openAt(fd, '.', flags),
    dir = a.fdopendir(dup);
  if (!dir) {
    closeSync(dup);
    throw new Error('file_candidate_directory_unavailable');
  }
  const error = new DataView(
    toArrayBuffer(('__error' in a ? a.__error : a.__errno_location)()!, 0, 4),
  );
  const result: { name: string; type: number }[] = [];
  try {
    for (;;) {
      error.setInt32(0, 0, true);
      const entry = a.readdir(dir);
      if (!entry) {
        if (error.getInt32(0, true)) throw new Error('file_candidate_directory_unavailable');
        break;
      }
      const offset = process.platform === 'darwin' ? 20 : 18;
      const length = new DataView(toArrayBuffer(entry, 16, 2)).getUint16(0, true) - offset - 1;
      if (length < 1 || length > 2048) throw new Error('file_candidate_name_invalid');
      const raw = new Uint8Array(toArrayBuffer(entry, offset + 1, length)),
        end = raw.indexOf(0);
      if (end < 0) throw new Error('file_candidate_name_invalid');
      const name = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, end));
      if (name === '.' || name === '..') continue;
      if (!name || name.includes('/') || name.includes('\0'))
        throw new Error('file_candidate_name_invalid');
      result.push({ name, type: new Uint8Array(toArrayBuffer(entry, offset, 1))[0]! });
    }
  } finally {
    a.closedir(dir);
  }
  return result;
}
function stamp(fd: number) {
  const s = fstatSync(fd, { bigint: true });
  return `${s.dev}:${s.ino}:${s.mtimeNs}:${s.ctimeNs}:${s.size}`;
}
async function config(fd: number, signal: AbortSignal): Promise<Ignore> {
  const before = stamp(fd),
    stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('file_candidate_ignore_invalid');
  const decoder = new TextDecoder('utf-8', { fatal: true }),
    buffer = Buffer.alloc(65536);
  let text = '',
    chunks = 0;
  for (;;) {
    const size = readSync(fd, buffer, 0, buffer.length, null);
    if (!size) break;
    signal.throwIfAborted();
    text += decoder.decode(buffer.subarray(0, size), { stream: true });
    if (++chunks % 16 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  text += decoder.decode();
  if (text.includes('\0')) throw new Error('file_candidate_ignore_invalid');
  if (stamp(fd) !== before) throw new Error('file_candidate_ignore_changed');
  return ignore().add(text);
}
function rank(path: string, query: string) {
  let index = 0,
    score = 0,
    streak = 0;
  const p = path.toLowerCase(),
    q = query.toLowerCase();
  for (let i = 0; i < p.length && index < q.length; i++) {
    if (p[i] === q[index]) {
      index++;
      score += 1 + ++streak * 2 + (i === 0 || /[/_-]/.test(p[i - 1]!) ? 5 : 0);
    } else streak = 0;
  }
  return index === q.length ? score : -1;
}
export function createTuiFileCandidates(
  client: Pick<AgentClient, 'getView' | 'listWorkspaces'>,
  admittedStoreId: string,
): TuiFileCandidatesPort {
  let saved:
    | {
        id: string;
        scope: TuiFileScope;
        root: string;
        query: string;
        paths: string[];
        unavailable: { path: string; reason: string }[];
      }
    | undefined;
  async function root(scope: TuiFileScope, signal: AbortSignal) {
    signal.throwIfAborted();
    const view = await client.getView(scope.sessionId, { signal });
    if (
      scope.storeId !== admittedStoreId ||
      view.storeId !== scope.storeId ||
      view.session.id !== scope.sessionId ||
      view.session.workspaceId !== scope.workspaceId ||
      view.session.deletedAt !== null
    )
      throw new Error('file_candidate_scope_mismatch');
    const workspace = (await client.listWorkspaces({ signal })).find(
      (w) => w.id === scope.workspaceId,
    );
    if (!workspace?.rootUri.startsWith('file:'))
      throw new Error('file_candidate_workspace_unavailable');
    return realpathSync(fileURLToPath(workspace.rootUri));
  }
  return {
    async read(scope, input, signal) {
      const canonical = await root(scope, signal);
      const scopeKey = JSON.stringify([scope.storeId, scope.sessionId, scope.workspaceId]);
      let offset = 0;
      if (input.cursor) {
        const cursor = JSON.parse(input.cursor);
        if (
          !saved ||
          !Array.isArray(cursor) ||
          cursor.length !== 2 ||
          cursor[0] !== saved.id ||
          !Number.isSafeInteger(cursor[1]) ||
          cursor[1] < 0 ||
          cursor[1] > saved.paths.length ||
          JSON.stringify([saved.scope.storeId, saved.scope.sessionId, saved.scope.workspaceId]) !==
            scopeKey ||
          saved.query !== input.query ||
          saved.root !== canonical
        )
          throw new Error('file_candidate_cursor_mismatch');
        offset = cursor[1];
      } else {
        const paths: string[] = [],
          unavailable: { path: string; reason: string }[] = [];
        const rootFd = openSync('/', flags);
        let fd = rootFd;
        try {
          for (const segment of canonical.split('/').filter(Boolean)) {
            const next = openAt(fd, segment, flags);
            if (fd !== rootFd) closeSync(fd);
            fd = next;
          }
          const rootStamp = stamp(fd);
          async function walk(
            dir: number,
            prefix: string,
            rules: { base: string; matcher: Ignore }[],
          ) {
            signal.throwIfAborted();
            sameDirectory(dir, prefix ? `${canonical}/${prefix.slice(0, -1)}` : canonical);
            const before = stamp(dir),
              entries = names(dir),
              configuration = entries.find((e) => e.name === '.gitignore');
            if (configuration) {
              if (configuration.type !== 8) throw new Error('file_candidate_ignore_invalid');
              const cf = openAt(
                dir,
                '.gitignore',
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
              );
              try {
                rules = [...rules, { base: prefix, matcher: await config(cf, signal) }];
              } finally {
                closeSync(cf);
              }
            }
            const start = paths.length;
            for (let index = 0; index < entries.length; index++) {
              if (index % 32 === 0) {
                await new Promise<void>((resolve) => setImmediate(resolve));
                signal.throwIfAborted();
              }
              const e = entries[index]!,
                path = prefix + e.name;
              if (excluded.has(e.name) || (e.name.startsWith('.') && e.name !== '.gitignore'))
                continue;
              if (e.type === 10 || (e.type !== 4 && e.type !== 8)) {
                unavailable.push({ path, reason: 'file_candidate_type_unavailable' });
                continue;
              }
              let ignored = false;
              for (const r of rules) {
                const result = r.matcher.test(
                  path.slice(r.base.length) + (e.type === 4 ? '/' : ''),
                );
                if (result.ignored) ignored = true;
                else if (result.unignored) ignored = false;
              }
              if (ignored) continue;
              if (e.type === 8) {
                paths.push(path);
                continue;
              }
              let child: number | undefined;
              try {
                child = openAt(dir, e.name, flags);
                await walk(child, `${path}/`, rules);
              } catch (error) {
                signal.throwIfAborted();
                unavailable.push({
                  path,
                  reason:
                    error instanceof Error ? error.message : 'file_candidate_directory_unavailable',
                });
              } finally {
                if (child !== undefined) closeSync(child);
              }
            }
            try {
              sameDirectory(dir, prefix ? `${canonical}/${prefix.slice(0, -1)}` : canonical);
            } catch (error) {
              paths.splice(start);
              throw error;
            }
            if (stamp(dir) !== before) {
              paths.splice(start);
              throw new Error('file_candidate_directory_changed');
            }
          }
          await walk(fd, '', []);
          const afterRoot = await root(scope, signal);
          sameDirectory(fd, canonical);
          if (stamp(fd) !== rootStamp || afterRoot !== canonical)
            throw new Error('file_candidate_workspace_changed');
        } finally {
          if (fd !== rootFd) closeSync(fd);
          closeSync(rootFd);
        }
        signal.throwIfAborted();
        saved = {
          id: crypto.randomUUID(),
          scope: { ...scope },
          root: canonical,
          query: input.query,
          paths: paths
            .map((path) => ({ path, score: rank(path, input.query) }))
            .filter((p) => p.score >= 0)
            .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
            .map((p) => p.path),
          unavailable,
        };
      }
      const catalog = saved!;
      const paths = catalog.paths.slice(offset, offset + 200),
        next = offset + paths.length;
      return {
        scope: { ...scope },
        query: input.query,
        snapshotId: catalog.id,
        paths,
        nextCursor: next < catalog.paths.length ? JSON.stringify([catalog.id, next]) : null,
        unavailable: catalog.unavailable,
      };
    },
  };
}
