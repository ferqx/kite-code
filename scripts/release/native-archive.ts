import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import {
  parseNativeBundleManifest,
  retainWindowsNativeRuntimeFiles,
  verifyNativeRuntimeBundle,
} from '@kite-ai/service/native-runtime-assets';
import {
  parseTerminalBundleManifest,
  retainWindowsTerminalRuntimeFiles,
} from '@kite-ai/service/runtime-assets';
import { windowsInstallationCoordination } from '../../packages/agent/src/platform/windows-installation-coordination';
import {
  retainWindowsInstallationRemoval,
  type WindowsInstallationInventoryEntry,
} from '../../packages/agent/src/platform/windows-installation-removal';
import {
  defaultWindowsPathSecurity,
  privateDirectory,
} from '../../packages/agent/src/platform/windows-path-security';
import { retainWindowsPrivateFileRemoval } from '../../packages/agent/src/platform/windows-private-file-removal';
import { readCandidateArchiveFiles } from './terminal-archive';
import { rejectBundleOutput } from './terminal-paths';

const pendingWindowsArchiveOwners = new Set<object>();
function closedWindowsTree(
  files: readonly string[],
  empty: readonly string[] = [],
): WindowsInstallationInventoryEntry[] {
  const entries = new Map<string, WindowsInstallationInventoryEntry['kind']>();
  for (const file of files) entries.set(file, 'file');
  for (const directory of empty) entries.set(directory, 'directory');
  for (const path of [...entries.keys()]) {
    let parent = posix.dirname(path);
    while (parent !== '.') {
      if (entries.get(parent) === 'file') fail();
      entries.set(parent, 'directory');
      parent = posix.dirname(parent);
    }
  }
  return [...entries]
    .map(([path, kind]) => ({ path, kind }))
    .sort(
      (a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path),
    );
}
function removeWindowsTree(root: string, inventory: readonly WindowsInstallationInventoryEntry[]) {
  const owner = retainWindowsInstallationRemoval({ root, inventory });
  pendingWindowsArchiveOwners.add(owner);
  owner.remove();
  owner.release();
  pendingWindowsArchiveOwners.delete(owner);
}
/** Private release-tool scratch only; no Profile path or active-pointer authority. */
export function createWindowsNativeArchiveScratch(prefix: string) {
  const coordination = windowsInstallationCoordination(resolve(prefix));
  const root = join(coordination.root, `native-unpack-${randomUUID()}`);
  const destination = join(root, 'candidate');
  let inventory: WindowsInstallationInventoryEntry[] | undefined;
  let removal: ReturnType<typeof retainWindowsInstallationRemoval> | undefined;
  let released = false;
  const owner = {
    root,
    destination,
    accept(bundle: ReturnType<typeof verifyNativeRuntimeBundle>) {
      if (released || bundle.root !== destination || inventory)
        throw Error('native_archive_scratch_unknown');
      inventory = closedWindowsTree(
        [
          'candidate/native-manifest.json',
          'candidate/terminal/terminal-manifest.json',
          ...bundle.manifest.files.map((file) => `candidate/${file.path}`),
          ...bundle.terminal.manifest.files.map((file) => `candidate/terminal/${file.path}`),
        ],
        bundle.manifest.directories.map((path) => `candidate/${path}`),
      );
    },
    release() {
      if (released) return;
      if (!inventory && readdirSync(root).length) throw Error('native_archive_scratch_unknown');
      removal ??= retainWindowsInstallationRemoval({ root, inventory: inventory ?? [] });
      removal.remove();
      removal.release();
      coordination.release();
      released = true;
      pendingWindowsArchiveOwners.delete(owner);
    },
  };
  pendingWindowsArchiveOwners.add(owner);
  if (lstatSync(root, { throwIfNoEntry: false })) throw Error('native_archive_scratch_unknown');
  privateDirectory(root);
  return owner;
}

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const text = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
function fail(): never {
  throw Error('native_archive_invalid');
}
/** Regular bytes only: links and exact empty Electron dirs remain closed manifest declarations. */
export async function packNativeBundle(input: { bundleRoot: string; archivePath: string }) {
  const root = resolve(input.bundleRoot),
    leases: { release(): void }[] = [];
  let keep = false;
  let originalFailure: { error: unknown } | undefined;
  if (process.platform === 'win32') pendingWindowsArchiveOwners.add(leases);
  const produce = async () => {
    leases.push(acquireArtifactAccess({ root, mode: 'shared' }));
    leases.push(acquireArtifactAccess({ root: join(root, 'terminal'), mode: 'shared' }));
    if (process.platform === 'win32') {
      leases.push(retainWindowsNativeRuntimeFiles(root));
      leases.push(retainWindowsTerminalRuntimeFiles(join(root, 'terminal')));
    }
    const bundle = verifyNativeRuntimeBundle(root),
      archivePath = resolve(input.archivePath),
      checksumPath = `${archivePath}.sha256`;
    for (const path of [archivePath, checksumPath]) {
      rejectBundleOutput(root, path);
      if (lstatSync(path, { throwIfNoEntry: false })) throw Error('native_destination_exists');
    }
    const files: Record<string, Uint8Array> = Object.create(null);
    for (const [path, digest] of [
      ['native-manifest.json', bundle.digest],
      ['terminal/terminal-manifest.json', bundle.terminal.digest],
    ] as const) {
      const bytes = readFileSync(join(root, path));
      if (hash(bytes) !== digest) fail();
      files[path] = bytes;
    }
    for (const file of [
      ...bundle.manifest.files,
      ...bundle.terminal.manifest.files.map((f) => ({ ...f, path: `terminal/${f.path}` })),
    ]) {
      const bytes = readFileSync(join(root, file.path));
      if (bytes.length !== file.size || hash(bytes) !== file.sha256) fail();
      files[file.path] = bytes;
    }
    if (verifyNativeRuntimeBundle(root).digest !== bundle.digest) fail();
    const bytes = await new Bun.Archive(files, { compress: 'gzip', level: 6 }).bytes(),
      sha256 = hash(bytes);
    // Awaiting compression cannot silently change which source closure was selected.
    if (verifyNativeRuntimeBundle(root).digest !== bundle.digest) fail();
    if (process.platform === 'win32') privateDirectory(dirname(archivePath));
    else mkdirSync(dirname(archivePath), { recursive: true, mode: 0o700 });
    const created: string[] = [];
    try {
      for (const [path, content] of [
        [archivePath, bytes],
        [checksumPath, `${sha256}  ${basename(archivePath)}\n`],
      ] as const) {
        if (process.platform === 'win32') {
          try {
            defaultWindowsPathSecurity()!.writePrivateArtifactFile(
              path,
              typeof content === 'string' ? Buffer.from(content) : content,
            );
            created.push(path);
            defaultWindowsPathSecurity()!.syncPrivateFile(path);
          } catch (error) {
            keep = true;
            throw error;
          }
          continue;
        }
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        created.push(path);
        try {
          writeFileSync(fd, content);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      if (process.platform === 'win32') return { archivePath, sha256, candidateId: bundle.digest };
      const directory = openSync(dirname(archivePath), constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      return { archivePath, sha256, candidateId: bundle.digest };
    } catch (error) {
      if (process.platform === 'win32') {
        if (!keep) {
          try {
            for (const path of created.reverse()) {
              const owner = retainWindowsPrivateFileRemoval(path);
              pendingWindowsArchiveOwners.add(owner);
              owner.remove();
              owner.release();
              pendingWindowsArchiveOwners.delete(owner);
            }
          } catch (cleanup) {
            keep = true;
            throw new AggregateError([error, cleanup], 'native_archive_close_unknown');
          }
        }
      } else for (const path of created.reverse()) rmSync(path, { force: true });
      throw error;
    }
  };
  let result: Awaited<ReturnType<typeof produce>> | undefined;
  try {
    result = await produce();
  } catch (error) {
    originalFailure = { error };
  }
  if (!keep) {
    try {
      while (leases.length) {
        leases.at(-1)!.release();
        leases.pop();
      }
      pendingWindowsArchiveOwners.delete(leases);
    } catch (cleanup) {
      throw new AggregateError(
        originalFailure ? [originalFailure.error, cleanup] : [cleanup],
        'native_archive_close_unknown',
      );
    }
  }
  if (originalFailure) throw originalFailure.error;
  return result!;
}

/** Archive bytes are bounded input, not a task/runtime quota. Never extract archive-controlled links. */
export function unpackNativeBundle(input: {
  archivePath: string;
  sha256: string;
  destination: string;
  maxUnpackedBytes?: number;
}) {
  const destination = resolve(input.destination);
  if (lstatSync(destination, { throwIfNoEntry: false })) throw Error('native_destination_exists');
  const files = readCandidateArchiveFiles(input),
    nativeBytes = files.get('native-manifest.json'),
    terminalBytes = files.get('terminal/terminal-manifest.json');
  if (!nativeBytes || !terminalBytes) fail();
  const manifest = parseNativeBundleManifest(JSON.parse(text(nativeBytes))),
    terminal = parseTerminalBundleManifest(JSON.parse(text(terminalBytes)));
  if (hash(terminalBytes) !== manifest.terminalManifestSha256) fail();
  const expected = [
    ...manifest.files,
    ...terminal.files.map((file) => ({ ...file, path: `terminal/${file.path}` })),
  ];
  if (files.size !== expected.length + 2) fail();
  for (const file of expected) {
    const bytes = files.get(file.path);
    if (!bytes || bytes.length !== file.size || hash(bytes) !== file.sha256) fail();
  }
  const links = [
    ...manifest.links,
    ...terminal.links.map((link) => ({ path: `terminal/${link.path}`, target: link.target })),
  ];
  if (process.platform === 'win32' && links.length) fail();
  const declarations = [
    ...files.keys(),
    ...links.map((link) => link.path),
    ...manifest.directories,
  ];
  const paths = new Set(declarations);
  if (paths.size !== declarations.length) fail();
  for (const path of declarations) {
    let parent = posix.dirname(path);
    while (parent !== '.') {
      if (paths.has(parent)) fail();
      parent = posix.dirname(parent);
    }
  }
  if (process.platform === 'win32') {
    privateDirectory(dirname(destination));
    privateDirectory(destination);
  } else {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    mkdirSync(destination, { mode: 0o700 });
  }
  const windowsCreated: WindowsInstallationInventoryEntry[] = [];
  let windowsUnknown = false;
  if (process.platform === 'win32') pendingWindowsArchiveOwners.add(windowsCreated);
  try {
    const modes = new Map(expected.map((file) => [file.path, file.mode]));
    for (const [path, bytes] of files) {
      const target = join(destination, path);
      if (process.platform === 'win32') {
        const directories: string[] = [];
        let parent = posix.dirname(path);
        while (parent !== '.') {
          directories.unshift(parent);
          parent = posix.dirname(parent);
        }
        for (const directory of directories)
          if (!lstatSync(join(destination, directory), { throwIfNoEntry: false })) {
            privateDirectory(join(destination, directory));
            windowsCreated.push({ path: directory, kind: 'directory' });
          }
        try {
          defaultWindowsPathSecurity()!.writePrivateArtifactFile(target, bytes);
          windowsCreated.push({ path, kind: 'file' });
          defaultWindowsPathSecurity()!.syncPrivateFile(target);
        } catch (error) {
          windowsUnknown = true;
          throw error;
        }
        continue;
      }
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const fd = openSync(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        modes.get(path) ?? 0o644,
      );
      try {
        fchmodSync(fd, modes.get(path) ?? 0o644);
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    for (const directory of manifest.directories) {
      if (process.platform === 'win32') {
        for (const entry of closedWindowsTree([], [directory]))
          if (!lstatSync(join(destination, entry.path), { throwIfNoEntry: false })) {
            privateDirectory(join(destination, entry.path));
            windowsCreated.push(entry);
          }
      } else mkdirSync(join(destination, directory), { recursive: true, mode: 0o700 });
    }
    for (const link of links) {
      const target = join(destination, link.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      symlinkSync(link.target, target);
    }
    const result = verifyNativeRuntimeBundle(destination);
    pendingWindowsArchiveOwners.delete(windowsCreated);
    return result;
  } catch (error) {
    if (process.platform === 'win32') {
      if (!windowsUnknown) {
        try {
          removeWindowsTree(destination, windowsCreated);
          pendingWindowsArchiveOwners.delete(windowsCreated);
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], 'native_archive_close_unknown');
        }
      }
    } else rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}
