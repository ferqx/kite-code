import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { defaultWindowsPathSecurity } from './windows-path-security';

// Failed native closes remain strongly owned even if acquisition could not return a port.
const pendingReleases = new Set<() => void>();
const removalReaders = new WeakMap<
  WindowsInstallationRemoval,
  {
    root: string;
    read(path: string): WindowsRemovalEntry | undefined;
  }
>();

/** Acquisition failed while an original DELETE-purpose HANDLE is still unconfirmed. */
export class WindowsInstallationRemovalAcquireUnknownError extends AggregateError {
  constructor(error: unknown, cleanup: unknown) {
    super([error, cleanup], 'windows_installation_removal_acquire_unknown');
  }
}

/** Windows refused a DELETE-purpose open because another process still holds a file. */
export class WindowsInstallationFilesInUseError extends Error {
  readonly code = 'windows_installation_files_in_use';
}

export interface WindowsInstallationInventoryEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory';
}
export interface WindowsInstallationRemoval {
  verify(): void;
  remove(onProgress?: (completed: number, total: number) => void): void;
  release(): void;
}
interface WindowsRemovalEntry {
  readonly directory: boolean;
  readonly size: bigint;
  readonly identity: string;
  sha256(): string;
}

/** Internal identity proof for read-only whole-asset verification under original DELETE handles. */
export function windowsInstallationRemovalReader(
  owner: WindowsInstallationRemoval,
  candidateRoot: string,
) {
  const reader = removalReaders.get(owner);
  if (
    !reader ||
    (candidateRoot !== reader.root && !candidateRoot.startsWith(reader.root + sep)) ||
    !reader.read(candidateRoot)?.directory
  )
    throw Error('windows_installation_removal_unknown');
  return (path: string) =>
    path === candidateRoot || path.startsWith(candidateRoot + sep) ? reader.read(path) : undefined;
}

export function assertWindowsInstallationRemoval(
  owner: WindowsInstallationRemoval,
  candidateRoot: string,
): void {
  windowsInstallationRemovalReader(owner, candidateRoot);
  owner.verify();
}

/** Installer-private deletion purpose. Caller must retain external selection and use EX locks.
 * Import is inert; no supplied HANDLE, SID, DLL, data-root or recursive path-delete fallback.
 */
export function retainWindowsInstallationRemoval(input: {
  root: string;
  inventory: readonly WindowsInstallationInventoryEntry[];
  onFileHashed?: () => void;
}): WindowsInstallationRemoval {
  const fail = (): never => {
    throw Error('windows_installation_removal_unknown');
  };
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw Error('windows_installation_removal_unsupported');
  const root = input.root;
  if (
    !isAbsolute(root) ||
    resolve(root) !== root ||
    realpathSync(root) !== root ||
    dirname(root) === root
  )
    fail();
  const expected = new Map<string, 'file' | 'directory'>([['', 'directory']]);
  for (const entry of input.inventory) {
    if (
      !entry ||
      !['file', 'directory'].includes(entry.kind) ||
      !entry.path ||
      entry.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      /[\\:*?"<>|]/.test(entry.path) ||
      Array.from(entry.path).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      entry.path.split('/').some((part) => /[. ]$/.test(part)) ||
      expected.has(entry.path)
    )
      fail();
    expected.set(entry.path, entry.kind);
  }
  for (const path of expected.keys()) {
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (expected.get(parent) !== 'directory') fail();
  }
  const security = defaultWindowsPathSecurity()!;
  const { dlopen, ptr } = require('bun:ffi') as typeof import('bun:ffi');
  const kernel = dlopen('kernel32.dll', {
    CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64' },
    GetFileInformationByHandle: { args: ['u64', 'ptr'], returns: 'bool' },
    SetFileInformationByHandle: { args: ['u64', 'u32', 'ptr', 'u32'], returns: 'bool' },
    GetFileAttributesW: { args: ['ptr'], returns: 'u32' },
    ReadFile: { args: ['u64', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'bool' },
    SetFilePointerEx: { args: ['u64', 'i64', 'ptr', 'u32'], returns: 'bool' },
    GetLastError: { args: [], returns: 'u32' },
    CloseHandle: { args: ['u64'], returns: 'bool' },
  });
  type Held = {
    path: string;
    relative: string | null;
    kind: 'file' | 'directory';
    handle: bigint | number;
    identity: string;
    content: string;
    size: bigint;
    marked: boolean;
    closed: boolean;
  };
  const held: Held[] = [];
  const originals = new Map<string, Held>();
  const readBuffer = new Uint8Array(256 * 1024);
  const readCount = new Uint32Array(1);
  let released = false;
  let attempted = false;
  let removed = false;
  const wide = (path: string) => {
    if (path.includes('\0') || path.length > 32760) fail();
    return Buffer.from(`${path}\0`, 'utf16le');
  };
  const metadata = (entry: Held) => {
    const bytes = new Uint8Array(52);
    if (!kernel.symbols.GetFileInformationByHandle(entry.handle, ptr(bytes))) fail();
    const value = new DataView(bytes.buffer);
    if (
      value.getUint32(0, true) & 0x400 ||
      Boolean(value.getUint32(0, true) & 0x10) !== (entry.kind === 'directory') ||
      (entry.kind === 'file' && value.getUint32(40, true) !== 1)
    )
      fail();
    return {
      identity: [28, 44, 48].map((offset) => value.getUint32(offset, true)).join(':'),
      size: (BigInt(value.getUint32(32, true)) << 32n) | BigInt(value.getUint32(36, true)),
      // Directory size/write time legitimately changes as original children are removed.
      content:
        entry.kind === 'file'
          ? [0, 20, 24, 32, 36].map((offset) => value.getUint32(offset, true)).join(':')
          : '',
    };
  };
  const verifyEntry = (entry: Held) => {
    if (entry.closed || entry.marked) fail();
    const current = metadata(entry);
    if (current.identity !== entry.identity || current.content !== entry.content) fail();
    if (entry.relative === null) security.verifyScopeDirectory(entry.path);
    else security.verifyHandle(entry.handle, entry.path, entry.kind === 'directory');
  };
  const open = (path: string, relative: string | null, kind: Held['kind']) => {
    // DELETE-purpose handles deny other WRITE/DELETE opens from the outset. Ancestors
    // outside the removal root retain ordinary no-delete pins and are never deleted.
    const handle = kernel.symbols.CreateFileW(
      ptr(wide(path)),
      relative === null ? 0x200a0 : kind === 'file' ? 0x80030080 : 0x30080,
      relative === null ? 3 : 1,
      null,
      3,
      0x02200000,
      0,
    );
    if (!handle || BigInt(handle) === 18446744073709551615n) {
      if ([32, 33].includes(kernel.symbols.GetLastError()))
        throw new WindowsInstallationFilesInUseError('windows_installation_files_in_use');
      fail();
    }
    const entry: Held = {
      path,
      relative,
      kind,
      handle,
      identity: '',
      content: '',
      size: 0n,
      marked: false,
      closed: false,
    };
    held.push(entry);
    const original = metadata(entry);
    entry.identity = original.identity;
    entry.content = original.content;
    entry.size = original.size;
    verifyEntry(entry);
    if (relative !== null) originals.set(path, entry);
  };
  const inventory = () => {
    const actual = new Map<string, 'file' | 'directory'>([['', 'directory']]);
    const scan = (relative: string) => {
      for (const name of readdirSync(join(root, relative))) {
        const path = relative ? `${relative}/${name}` : name;
        if (!expected.has(path)) fail();
        const stat = lstatSync(join(root, path));
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) fail();
        const kind = stat.isDirectory() ? 'directory' : 'file';
        if (expected.get(path) !== kind) fail();
        actual.set(path, kind);
        if (kind === 'directory') scan(path);
      }
    };
    scan('');
    if (actual.size !== expected.size) fail();
  };
  const close = (entry: Held) => {
    if (entry.closed) return;
    if (!kernel.symbols.CloseHandle(entry.handle)) fail();
    entry.closed = true;
  };
  const release = () => {
    if (released) return;
    pendingReleases.add(release);
    const errors: unknown[] = [];
    for (const entry of [...held].reverse()) {
      try {
        close(entry);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, 'windows_installation_removal_release_unknown');
    kernel.close();
    released = true;
    pendingReleases.delete(release);
  };
  try {
    const parents: string[] = [];
    for (let path = dirname(root); ; path = dirname(path)) {
      parents.unshift(path);
      if (dirname(path) === path) break;
    }
    for (const path of parents) open(path, null, 'directory');
    for (const [relative, kind] of expected) open(join(root, relative), relative, kind);
    inventory();
  } catch (error) {
    try {
      release();
    } catch (cleanup) {
      throw new WindowsInstallationRemovalAcquireUnknownError(error, cleanup);
    }
    throw error;
  }
  const verify = () => {
    if (released || attempted) fail();
    for (const entry of held) verifyEntry(entry);
    inventory();
  };
  const read = (path: string): WindowsRemovalEntry | undefined => {
    if (released || attempted) fail();
    const entry = originals.get(path);
    if (!entry || entry.closed) return undefined;
    return {
      directory: entry.kind === 'directory',
      size: entry.size,
      identity: entry.identity,
      sha256() {
        if (released || attempted || entry.closed || entry.kind !== 'file') fail();
        if (!kernel.symbols.SetFilePointerEx(entry.handle, 0, null, 0)) fail();
        const hash = createHash('sha256');
        let remaining = entry.size;
        while (remaining > 0n) {
          const wanted =
            remaining < BigInt(readBuffer.length) ? Number(remaining) : readBuffer.length;
          if (!kernel.symbols.ReadFile(entry.handle, ptr(readBuffer), wanted, ptr(readCount), null))
            fail();
          const count = readCount[0] ?? 0;
          if (!count || count > wanted) fail();
          hash.update(readBuffer.subarray(0, count));
          remaining -= BigInt(count);
        }
        if (
          !kernel.symbols.ReadFile(entry.handle, ptr(readBuffer), 1, ptr(readCount), null) ||
          readCount[0] !== 0
        )
          fail();
        const digest = hash.digest('hex');
        input.onFileHashed?.();
        return digest;
      },
    };
  };
  const port: WindowsInstallationRemoval = Object.freeze({
    verify,
    remove(onProgress?: (completed: number, total: number) => void) {
      if (removed) return;
      if (released) fail();
      if (!attempted) verify();
      else for (const entry of held) if (entry.relative === null) verifyEntry(entry);
      attempted = true;
      pendingReleases.add(release);
      const entries = [...originals.values()]
        .map((entry) => ({ entry, depth: entry.relative ? entry.relative.split('/').length : 0 }))
        .sort((a, b) => b.depth - a.depth);
      let completed = entries.filter(({ entry }) => entry.closed).length;
      onProgress?.(completed, entries.length);
      for (const { entry } of entries) {
        if (entry.closed) continue;
        if (!entry.marked) {
          verifyEntry(entry);
          if (entry.kind === 'directory' && readdirSync(entry.path).length !== 0) fail();
          const disposition = new Uint8Array([1]);
          if (!kernel.symbols.SetFileInformationByHandle(entry.handle, 4, ptr(disposition), 1))
            fail();
          entry.marked = true;
        }
        // A failed close remains owned and retryable; never reopen or delete by path.
        close(entry);
        onProgress?.(++completed, entries.length);
      }
      if (kernel.symbols.GetFileAttributesW(ptr(wide(root))) !== 0xffffffff) fail();
      if (![2, 3].includes(kernel.symbols.GetLastError())) fail();
      removed = true;
    },
    release,
  });
  removalReaders.set(port, { root, read });
  return port;
}
