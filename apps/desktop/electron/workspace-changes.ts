import { randomUUID } from 'node:crypto';
import { constants, watch } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Workspace } from '@kite-ai/client';
import type {
  NativeWorkspaceChange,
  NativeWorkspaceChangeDetail,
  NativeWorkspaceChangeEvent,
  NativeWorkspaceChangePage,
  NativeWorkspaceChangeScope,
} from '../src/workspace-changes-bridge';
import { NativeProcessOwner } from './native-processes';
import { canonicalProtectedPath } from './protected-path';

const STATUS_BYTES = 512 * 1024;
const FILE_BYTES = 1024 * 1024;
const PATCH_BYTES = 64 * 1024;
const inside = (root: string, path: string) => {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
};
type GitSnapshot = { path: string; objects: string; active: number; retired: boolean };
function retireSnapshot(snapshot: GitSnapshot) {
  snapshot.retired = true;
  if (snapshot.active === 0)
    void rm(snapshot.path, { recursive: true, force: true }).catch(() => {});
}
type Lease = {
  stopWatching?: () => void;
  observationReady?: () => void;
  snapshot?: GitSnapshot;
  scope: NativeWorkspaceChangeScope;
  abort: AbortController;
  root?: string;
  index?: string;
  head?: string;
  rootUri?: string;
  identity?: string;
  entries: Map<string, NativeWorkspaceChange>;
};

type WatchOptions = {
  watch?: typeof watch;
  recursive?: boolean;
  debounceMs?: number;
  maxWaitMs?: number;
  fallbackMs?: number;
};

/** Read-only, main-owned repository observations. No renderer supplied paths. */
export class NativeWorkspaceChanges {
  private lease?: { readId: string; value: Lease };
  private readonly protectedRoots: string[];
  private readonly details = new Map<string, Lease>();
  private readonly current: () => NativeWorkspaceChangeScope | undefined;
  private readonly workspace: (id: string) => Workspace | undefined;
  private readonly processes: NativeProcessOwner;
  private readonly changed?: (event: NativeWorkspaceChangeEvent) => void;
  private readonly watchOptions: WatchOptions;
  constructor(
    current: () => NativeWorkspaceChangeScope | undefined,
    workspace: (id: string) => Workspace | undefined,
    protectedRoots: readonly string[],
    processes = new NativeProcessOwner(),
    changed?: (event: NativeWorkspaceChangeEvent) => void,
    watchOptions: WatchOptions = {},
  ) {
    this.changed = changed;
    this.watchOptions = watchOptions;
    this.current = current;
    this.workspace = workspace;
    this.processes = processes;
    this.protectedRoots = protectedRoots.map(canonicalProtectedPath);
  }
  release() {
    this.lease?.value.stopWatching?.();
    this.lease?.value.abort.abort();
    if (this.lease?.value.snapshot) retireSnapshot(this.lease.value.snapshot);
    this.lease = undefined;
    for (const detail of this.details.values()) detail.abort.abort();
    this.details.clear();
  }
  close(readId: string) {
    if (this.lease?.readId === readId) this.release();
    else {
      this.details.get(readId)?.abort.abort();
      this.details.delete(readId);
    }
  }
  /** Notifications contain no paths or bytes and never run Git themselves. */
  private observe(lease: Lease, readId: string, root: string, gitDir: string, common: string) {
    if (!this.changed) return;
    const watchers: ReturnType<typeof watch>[] = [];
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let maximum: ReturnType<typeof setTimeout> | undefined;
    let fallback: ReturnType<typeof setInterval> | undefined;
    let stopped = false,
      ready = false,
      dirty = false;
    const clearPending = () => {
      clearTimeout(quiet);
      clearTimeout(maximum);
      quiet = maximum = undefined;
    };
    const stop = () => {
      stopped = true;
      clearPending();
      clearInterval(fallback);
      for (const watcher of watchers) watcher.close();
    };
    lease.stopWatching = stop;
    const emit = () => {
      clearPending();
      if (stopped || !ready || !dirty) return;
      try {
        this.check(lease);
      } catch {
        stop();
        return;
      }
      dirty = false;
      this.changed?.({
        kind: 'workspaceChanges.changed',
        generation: lease.scope.generation,
        readId,
        scope: { ...lease.scope },
      });
    };
    const invalidate = () => {
      if (stopped) return;
      dirty = true;
      if (!ready) return;
      clearTimeout(quiet);
      quiet = setTimeout(emit, this.watchOptions.debounceMs ?? 500);
      maximum ??= setTimeout(emit, this.watchOptions.maxWaitMs ?? 1000);
    };
    const degraded = () => {
      if (stopped || fallback) return;
      fallback = setInterval(invalidate, this.watchOptions.fallbackMs ?? 10000);
      fallback.unref?.();
    };
    const add = (path: string, recursive: boolean, worktree = false) => {
      try {
        const watcher = (this.watchOptions.watch ?? watch)(
          path,
          { recursive, persistent: false },
          (_event, filename) => {
            const name = filename?.toString().replaceAll('\\', '/');
            // Git metadata has dedicated watches; object/log writes are not workspace edits.
            if (worktree && name?.startsWith('.git/')) return;
            if (!worktree && name && /^(objects|logs)(\/|$)/.test(name)) return;
            invalidate();
          },
        );
        watcher.on('error', () => {
          watcher.close();
          degraded();
          invalidate();
        });
        watchers.push(watcher);
      } catch {
        degraded();
      }
    };
    // Linux recursive fs.watch walks every directory, including huge ignored dependency trees.
    // Keep its resource cost bounded; a visible lease alone owns the fallback refresh timer.
    const recursive = this.watchOptions.recursive ?? process.platform !== 'linux';
    add(root, recursive, true);
    if (!recursive) degraded();
    for (const metadata of new Set([gitDir, common])) add(metadata, false);
    add(join(common, 'refs'), true);
    lease.observationReady = () => {
      ready = true;
      if (dirty) invalidate();
    };
  }
  private check(lease: Lease) {
    const now = this.current();
    if (
      lease.abort.signal.aborted ||
      !now ||
      (lease.rootUri !== undefined &&
        this.workspace(lease.scope.workspaceId)?.rootUri !== lease.rootUri) ||
      Object.keys(lease.scope).some(
        (key) =>
          now[key as keyof NativeWorkspaceChangeScope] !==
          lease.scope[key as keyof NativeWorkspaceChangeScope],
      )
    )
      throw Error('workspace_changes_stale');
  }
  private async git(
    lease: Lease,
    cwd: string,
    args: string[],
    limit = STATUS_BYTES,
    original = false,
  ) {
    this.check(lease);
    const snapshot = original ? undefined : lease.snapshot;
    const sourceConfig = original && args[0] === 'config';
    const running = this.processes.start(
      'git',
      [
        '--no-pager',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        ...(sourceConfig ? [] : ['-c', 'core.attributesFile=/dev/null']),
        ...args,
      ],
      {
        cwd,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          SystemRoot: process.env.SystemRoot,
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          GIT_NO_LAZY_FETCH: '1',
          HOME: sourceConfig ? process.env.HOME : undefined,
          USERPROFILE: sourceConfig ? process.env.USERPROFILE : undefined,
          XDG_CONFIG_HOME: sourceConfig ? process.env.XDG_CONFIG_HOME : undefined,
          GIT_CONFIG_NOSYSTEM: sourceConfig ? undefined : '1',
          GIT_CONFIG_GLOBAL: sourceConfig ? undefined : '/dev/null',
          GIT_LITERAL_PATHSPECS: '1',
          GIT_ATTR_NOSYSTEM: '1',
          ...(snapshot
            ? {
                GIT_DIR: snapshot.path,
                GIT_COMMON_DIR: snapshot.path,
                GIT_WORK_TREE: cwd,
                GIT_INDEX_FILE: lease.index ?? join(snapshot.path, 'index'),
                GIT_OBJECT_DIRECTORY: snapshot.objects,
              }
            : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
      {
        timeoutMs: 10000,
        timeoutError: 'workspace_changes_timeout',
        launchError: 'workspace_changes_git_unavailable',
      },
    );
    if (snapshot) snapshot.active++;
    const chunks: Buffer[] = [];
    let bytes = 0,
      errors = 0,
      truncated = false;
    const cancel = () => running.stop(Error('workspace_changes_stale'));
    lease.abort.signal.addEventListener('abort', cancel, { once: true });
    running.child.stdout!.on('data', (chunk: Buffer) => {
      const remaining = limit - bytes;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > limit) {
        truncated = true;
        running.stop(Error('workspace_changes_limit'));
      }
    });
    running.child.stderr!.on('data', (chunk: Buffer) => {
      errors += chunk.length;
      if (errors > PATCH_BYTES) running.stop(Error('workspace_changes_error_limit'));
    });
    let code: number | null;
    try {
      code = await running.result;
    } catch (error) {
      if (!truncated) throw error;
      code = null;
    } finally {
      lease.abort.signal.removeEventListener('abort', cancel);
      if (snapshot) {
        snapshot.active--;
        if (snapshot.retired) retireSnapshot(snapshot);
      }
    }
    this.check(lease);
    return {
      code,
      // Streaming decode retains an incomplete trailing code point instead of replacing it.
      text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks), {
        stream: truncated,
      }),
      truncated,
    };
  }
  private async checkFilters(lease: Lease, root: string) {
    const filters = await this.git(
      lease,
      root,
      ['config', '--null', '--get-regexp', '^filter\\..*\\.(clean|process)$'],
      65536,
      true,
    );
    if (filters.truncated || filters.code === 0)
      throw Error('workspace_changes_filters_unsupported');
    if (filters.code !== 1) throw Error('workspace_changes_metadata_unavailable');
  }
  private async checkAttributes(lease: Lease, root: string) {
    const info = await this.git(
      lease,
      root,
      ['rev-parse', '--path-format=absolute', '--git-path', 'info/attributes'],
      4096,
      true,
    );
    const configured = await this.git(
      lease,
      root,
      ['config', '--path', '--get', 'core.attributesfile'],
      4096,
      true,
    );
    if (
      info.code !== 0 ||
      info.truncated ||
      ![0, 1].includes(configured.code ?? -1) ||
      configured.truncated
    )
      throw Error('workspace_changes_metadata_unavailable');
    const globalPath =
      configured.code === 0
        ? resolve(root, configured.text.replace(/\r?\n$/, ''))
        : join(
            process.env.XDG_CONFIG_HOME ||
              join(process.env.HOME || process.env.USERPROFILE || homedir(), '.config'),
            'git',
            'attributes',
          );
    for (const path of [info.text.replace(/\r?\n$/, ''), globalPath]) {
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.size) throw Error('workspace_changes_attributes_unsupported');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  private async readExclude(path: string) {
    let canonical: string;
    try {
      canonical = await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (this.protectedRoots.some((p) => inside(p, canonical)))
      throw Error('workspace_changes_protected_root');
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024)
        throw Error('workspace_changes_excludes_unsupported');
      const buffer = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > stat.size) throw Error('workspace_changes_excludes_unsupported');
      return buffer.subarray(0, offset);
    } finally {
      await handle.close();
    }
  }
  /** Never load source config or info/attributes in a command that inspects worktree bytes. */
  private async snapshotGit(lease: Lease, root: string) {
    const discover = async (args: string[]) => {
      const value = await this.git(lease, root, ['rev-parse', ...args], 4096);
      if (value.code !== 0 || value.truncated)
        throw Error('workspace_changes_metadata_unavailable');
      return value.text.replace(/\r?\n$/, '');
    };
    await this.checkFilters(lease, root);
    await this.checkAttributes(lease, root);
    let scalarConfig = '';
    const scalarKeys: Record<string, readonly string[]> = {
      filemode: ['true', 'false'],
      ignorecase: ['true', 'false'],
      symlinks: ['true', 'false'],
      autocrlf: ['true', 'false', 'input'],
      eol: ['lf', 'crlf', 'native'],
    };
    for (const [key, allowed] of Object.entries(scalarKeys)) {
      const value = await this.git(lease, root, ['config', '--get', `core.${key}`], 128, true);
      if (value.code === 1) continue;
      const scalar = value.text.trim().toLowerCase();
      if (value.code !== 0 || value.truncated || !allowed.includes(scalar))
        throw Error('workspace_changes_config_unsupported');
      scalarConfig += `${key} = ${scalar}\n`;
    }
    const format = await discover(['--show-object-format']);
    if (!['sha1', 'sha256'].includes(format))
      throw Error('workspace_changes_unsupported_repository');
    const shared = await discover(['--shared-index-path']);
    if (shared) throw Error('workspace_changes_split_index_unsupported');
    const infoExclude = await this.readExclude(
      await discover(['--path-format=absolute', '--git-path', 'info/exclude']),
    );
    const excludes = await this.git(
      lease,
      root,
      ['config', '--path', '--get', 'core.excludesfile'],
      4096,
      true,
    );
    if (![0, 1].includes(excludes.code ?? -1) || excludes.truncated)
      throw Error('workspace_changes_excludes_unsupported');
    const globalExcludePath =
      excludes.code === 0
        ? resolve(root, excludes.text.replace(/\r?\n$/, ''))
        : join(
            process.env.XDG_CONFIG_HOME ||
              join(process.env.HOME || process.env.USERPROFILE || homedir(), '.config'),
            'git',
            'ignore',
          );
    const globalExclude = await this.readExclude(globalExcludePath);
    const index = await discover(['--path-format=absolute', '--git-path', 'index']);
    const objects = await realpath(
      await discover(['--path-format=absolute', '--git-path', 'objects']),
    );
    if (this.protectedRoots.some((p) => inside(p, objects) || inside(p, index)))
      throw Error('workspace_changes_protected_root');
    let indexBytes: Buffer | undefined;
    try {
      const handle = await open(index, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        const limit = 16 * 1024 * 1024;
        if (!stat.isFile() || stat.size > limit) throw Error('workspace_changes_index_too_large');
        const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset > stat.size || offset > limit) throw Error('workspace_changes_index_too_large');
        indexBytes = buffer.subarray(0, offset);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.check(lease);
    const path = await mkdtemp(join(tmpdir(), 'kite-git-observation-'));
    const snapshot: GitSnapshot = { path, objects, active: 1, retired: false };
    lease.snapshot = snapshot;
    try {
      this.check(lease);
      await mkdir(join(path, 'refs'));
      await mkdir(join(path, 'objects'));
      await mkdir(join(path, 'info'));
      if (infoExclude) await writeFile(join(path, 'info', 'exclude'), infoExclude, { mode: 0o600 });
      await writeFile(join(path, 'global-exclude'), globalExclude ?? Buffer.alloc(0), {
        mode: 0o600,
      });
      await writeFile(
        join(path, 'config'),
        `[core]\nrepositoryformatversion = ${format === 'sha256' ? 1 : 0}\nbare = false\nfilemode = ${process.platform !== 'win32'}\n${scalarConfig}excludesfile = ${JSON.stringify(join(path, 'global-exclude'))}\n${format === 'sha256' ? '[extensions]\nobjectformat = sha256\n' : ''}`,
        { mode: 0o600 },
      );
      await writeFile(
        join(path, 'HEAD'),
        lease.head ? `${lease.head}\n` : 'ref: refs/heads/unborn\n',
        { mode: 0o600 },
      );
      if (indexBytes) await writeFile(join(path, 'index'), indexBytes, { mode: 0o600 });
      this.check(lease);
    } catch (error) {
      snapshot.retired = true;
      throw error;
    } finally {
      snapshot.active--;
      if (snapshot.retired) retireSnapshot(snapshot);
    }
  }
  async list(input: {
    generation: number;
    viewSelection: number;
    readId: string;
  }): Promise<NativeWorkspaceChangePage> {
    const scope = this.current();
    if (
      !scope ||
      scope.generation !== input.generation ||
      scope.viewSelection !== input.viewSelection
    )
      throw Error('workspace_changes_stale');
    this.release();
    const lease: Lease = {
      scope: {
        generation: scope.generation,
        viewSelection: scope.viewSelection,
        storeId: scope.storeId,
        sessionId: scope.sessionId,
        workspaceId: scope.workspaceId,
      },
      abort: new AbortController(),
      entries: new Map(),
    };
    this.lease = { readId: input.readId, value: lease };
    try {
      const workspace = this.workspace(scope.workspaceId);
      if (!workspace) throw Error('workspace_changes_unavailable');
      lease.rootUri = workspace.rootUri;
      const uri = new URL(workspace.rootUri);
      if (uri.protocol !== 'file:' || (uri.hostname && uri.hostname !== 'localhost'))
        throw Error('workspace_changes_unavailable');
      const path = fileURLToPath(uri);
      if ((await realpath(path)) !== path) throw Error('workspace_changes_path_changed');
      let marker: string | undefined;
      for (let dir = path; ; dir = dirname(dir)) {
        try {
          await lstat(join(dir, '.git'));
          marker = dir;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (dirname(dir) === dir) break;
      }
      const page: NativeWorkspaceChangePage = {
        kind: 'workspaceChanges.page',
        readId: input.readId,
        scope: lease.scope,
        repository: false,
        entries: [],
        truncated: false,
      };
      this.check(lease);
      if (!marker) return page;
      // Refuse broad roots containing private data, even when a selected project is a subdirectory.
      if (this.protectedRoots.some((p) => inside(marker!, p) || inside(p, marker!)))
        throw Error('workspace_changes_protected_root');
      const markerPath = await realpath(join(marker, '.git'));
      if (this.protectedRoots.some((p) => inside(p, markerPath)))
        throw Error('workspace_changes_protected_root');
      let worktreeMetadata = markerPath;
      const markerStat = await lstat(markerPath);
      if (markerStat.isFile()) {
        if (markerStat.size > 4096) throw Error('workspace_changes_unsafe_root');
        const handle = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        let pointer: string;
        try {
          const data = Buffer.alloc(4097);
          const { bytesRead } = await handle.read(data, 0, data.length, 0);
          if (bytesRead > 4096) throw Error('workspace_changes_unsafe_root');
          pointer = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, bytesRead));
        } finally {
          await handle.close();
        }
        if (!pointer.startsWith('gitdir: ')) throw Error('workspace_changes_unsafe_root');
        const metadata = await realpath(resolve(marker, pointer.slice(8).replace(/\r?\n$/, '')));
        worktreeMetadata = metadata;
        if (this.protectedRoots.some((p) => inside(p, metadata)))
          throw Error('workspace_changes_protected_root');
      } else if (!markerStat.isDirectory()) throw Error('workspace_changes_unsafe_root');
      const rootResult = await this.git(lease, path, ['rev-parse', '--show-toplevel']);
      if (rootResult.code !== 0 || rootResult.truncated)
        throw Error('workspace_changes_unavailable');
      const root = rootResult.text.replace(/\r?\n$/, '');
      if (root !== marker || (await realpath(root)) !== root || !inside(root, path))
        throw Error('workspace_changes_unsafe_root');
      const gitDir = await this.git(lease, root, [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]);
      if (gitDir.code !== 0 || gitDir.truncated) throw Error('workspace_changes_unavailable');
      const metadataRoot = await realpath(gitDir.text.replace(/\r?\n$/, ''));
      if (this.protectedRoots.some((p) => inside(p, metadataRoot)))
        throw Error('workspace_changes_protected_root');
      lease.root = root;
      this.observe(lease, input.readId, root, worktreeMetadata, metadataRoot);
      const identity = await lstat(root, { bigint: true });
      lease.identity = `${identity.dev}:${identity.ino}`;
      const head = await this.git(lease, root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
      if (head.code === 0 && /^[a-f0-9]{40,64}\n?$/.test(head.text)) lease.head = head.text.trim();
      else if (head.code !== 1) throw Error('workspace_changes_head_unavailable');
      await this.snapshotGit(lease, root);
      const status = await this.git(lease, root, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--ignore-submodules=all',
      ]);
      if (status.code !== 0 && !status.truncated) throw Error('workspace_changes_unavailable');
      const records = status.text.split('\0');
      records.pop();
      for (let i = 0; i < records.length && page.entries.length < 1000; i++) {
        const record = records[i]!;
        if (record.length < 4 || record[2] !== ' ') throw Error('workspace_changes_invalid_status');
        const entry: NativeWorkspaceChange = {
          changeId: randomUUID(),
          path: record.slice(3),
          indexStatus: record[0]!,
          worktreeStatus: record[1]!,
          untracked: record.startsWith('??'),
        };
        if (/[RC]/.test(record.slice(0, 2))) {
          entry.oldPath = records[++i];
          if (!entry.oldPath) {
            page.truncated = true;
            break;
          }
        }
        if (
          ![entry.path, ...(entry.oldPath ? [entry.oldPath] : [])].every(
            (p) =>
              p && !isAbsolute(p) && inside(root, join(root, p)) && !p.split('/').includes('.git'),
          )
        )
          throw Error('workspace_changes_invalid_path');
        const removed = entry.untracked
          ? page.entries.find(
              (previous) => previous.path === entry.path && previous.indexStatus === 'D',
            )
          : undefined;
        if (removed) {
          removed.untracked = true;
          removed.worktreeStatus = '?';
          continue;
        }
        lease.entries.set(entry.changeId, entry);
        page.entries.push(entry);
      }
      await this.checkFilters(lease, root);
      await this.checkAttributes(lease, root);
      page.repository = true;
      page.truncated ||= status.truncated || records.length > 1000;
      this.check(lease);
      lease.observationReady?.();
      return page;
    } catch (error) {
      if (this.lease?.value === lease) this.release();
      throw error;
    }
  }
  async detail(readId: string, changeId: string): Promise<NativeWorkspaceChangeDetail> {
    const source = this.lease?.value;
    if (!source?.entries.has(changeId)) throw Error('workspace_changes_stale');
    this.check(source);
    // The panel displays one file at a time; switching aborts the former read, not the list.
    for (const previous of this.details.values()) previous.abort.abort();
    this.details.clear();
    const lease: Lease = { ...source, abort: new AbortController() };
    this.details.set(readId, lease);
    try {
      const result = await this.readDetail(lease, readId, changeId);
      this.check(lease);
      return result;
    } finally {
      if (this.details.get(readId) === lease) this.details.delete(readId);
      if (lease.index) await rm(lease.index, { force: true });
    }
  }
  private async readDetail(
    lease: Lease,
    readId: string,
    changeId: string,
  ): Promise<NativeWorkspaceChangeDetail> {
    const entry = lease?.entries.get(changeId);
    if (!lease?.root || !entry) throw Error('workspace_changes_stale');
    this.check(lease);
    const result: NativeWorkspaceChangeDetail = {
      kind: 'workspaceChanges.detail',
      readId,
      changeId,
      truncated: false,
    };
    const omit = (reason: NativeWorkspaceChangeDetail['reason']) => ({
      ...result,
      reason,
      truncated: reason === 'too_large',
    });
    if (
      entry.indexStatus === 'U' ||
      entry.worktreeStatus === 'U' ||
      ['AA', 'DD'].includes(entry.indexStatus + entry.worktreeStatus)
    )
      return omit('unsupported');
    if ((await realpath(lease.root)) !== lease.root) throw Error('workspace_changes_path_changed');
    const identity = await lstat(lease.root, { bigint: true });
    if (`${identity.dev}:${identity.ino}` !== lease.identity)
      throw Error('workspace_changes_path_changed');
    await this.checkFilters(lease, lease.root);
    await this.checkAttributes(lease, lease.root);
    const head = await this.git(
      lease,
      lease.root,
      ['rev-parse', '--verify', '--quiet', 'HEAD'],
      128,
      true,
    );
    if (
      (lease.head && (head.code !== 0 || head.text.trim() !== lease.head)) ||
      (!lease.head && head.code !== 1)
    )
      throw Error('workspace_changes_stale');
    const path = join(lease.root, entry.path);
    let exists = true;
    // Check both rename paths and every existing parent before Git reads worktree content.
    for (const name of [entry.path, ...(entry.oldPath ? [entry.oldPath] : [])]) {
      const target = join(lease.root, name);
      for (let parent = dirname(target); inside(lease.root, parent); parent = dirname(parent)) {
        try {
          if ((await realpath(parent)) !== parent) return omit('unsupported');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (parent === lease.root) break;
      }
      try {
        const stat = await lstat(target);
        if (!stat.isFile()) return omit('unsupported');
        if (stat.size > FILE_BYTES) return omit('too_large');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (name === entry.path) exists = false;
      }
      if (lease.head) {
        const size = await this.git(
          lease,
          lease.root,
          ['cat-file', '-s', `${lease.head}:${name}`],
          128,
        );
        if (size.truncated) return omit('too_large');
        if (size.code === 0 && (!/^\d+\n$/.test(size.text) || Number(size.text) > FILE_BYTES))
          return omit('too_large');
        // A missing HEAD path is expected for additions. Other failures are not clean results.
        if (
          size.code !== 0 &&
          !['A', '?', 'R', 'C'].includes(entry.indexStatus) &&
          entry.worktreeStatus !== 'A'
        )
          throw Error('workspace_changes_baseline_unavailable');
      }
    }
    if (!lease.head || (entry.untracked && entry.indexStatus !== 'D')) {
      if (!exists) {
        this.check(lease);
        return { ...result, text: '' };
      }
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return omit('unsupported');
        const buffer = Buffer.alloc(FILE_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > FILE_BYTES) return omit('too_large');
        if (buffer.subarray(0, bytesRead).includes(0)) return omit('binary');
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
        } catch {
          return omit('binary');
        }
        const lines = content.length ? content.split('\n') : [];
        if (content.endsWith('\n')) lines.pop();
        const header = `--- /dev/null\n+++ ${JSON.stringify(`b/${entry.path}`)}\n`;
        const patch =
          header +
          (lines.length
            ? `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n${content.endsWith('\n') ? '' : '\\ No newline at end of file\n'}`
            : '');
        const encoded = Buffer.from(patch);
        result.truncated = encoded.length > PATCH_BYTES;
        result.text = new TextDecoder('utf-8', { fatal: true }).decode(
          encoded.subarray(0, PATCH_BYTES),
          { stream: result.truncated },
        );
      } finally {
        await handle.close();
      }
    } else {
      if (entry.untracked && entry.indexStatus === 'D') {
        // `git rm --cached` leaves an index deletion and an untracked copy. A private
        // detail index restores HEAD membership so diff compares the actual remaining
        // bytes rather than reporting the file as deleted. Never modify the source index.
        const baseline = await this.git(
          lease,
          lease.root,
          ['ls-tree', '-z', lease.head, '--', entry.path],
          8192,
        );
        const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t/.exec(baseline.text);
        if (baseline.code !== 0 || baseline.truncated || !match || !lease.snapshot)
          return omit('unsupported');
        lease.index = join(lease.snapshot.path, `detail-index-${randomUUID()}`);
        await copyFile(join(lease.snapshot.path, 'index'), lease.index);
        const restored = await this.git(
          lease,
          lease.root,
          ['update-index', '--add', '--cacheinfo', `${match[1]},${match[2]},${entry.path}`],
          128,
        );
        if (restored.code !== 0) throw Error('workspace_changes_baseline_unavailable');
      }
      const diff = await this.git(
        lease,
        lease.root,
        [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          '--no-color',
          '--ignore-submodules=all',
          '--unified=3',
          lease.head,
          '--',
          entry.path,
          ...(entry.oldPath ? [entry.oldPath] : []),
        ],
        PATCH_BYTES,
      );
      if (diff.code !== 0 && !diff.truncated) throw Error('workspace_changes_diff_unavailable');
      if (/^Binary files /m.test(diff.text)) return omit('binary');
      result.text = diff.text;
      result.truncated = diff.truncated;
    }
    this.check(lease);
    return result;
  }
}
