import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { constants, copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { acquireFileLock, type FileLock, LockBusyError } from '../platform/locks';
import { privateDirectory } from '../platform/windows-path-security';
import {
  launchIdentityAsync,
  mapAssetVerification,
  verifyLaunchIdentitiesAsync,
} from './launch-identity';

const gitBashFiles = ['bash.exe', 'ls.exe', 'msys-2.0.dll'];

/** Keep file I/O bounded, and settle every in-flight write before reporting failure. */
async function prepareFiles<T>(items: readonly T[], prepare: (item: T) => Promise<void>) {
  let next = 0;
  let failed = false;
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(8, items.length) }, async () => {
      while (!failed && next < items.length) {
        const item = items[next++]!;
        try {
          await prepare(item);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  const failure = workers.find((worker) => worker.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}
/** The staging manifest is the sole inventory for both runtime copies. Pin it
 * once; verify the selected copy against its digests before every dispatch. */
export async function captureWindowsGitBashRuntime(
  shell: string,
  fullShell: string,
  signal?: AbortSignal,
) {
  const root = join(dirname(shell), '../..');
  const manifestPath = join(root, 'manifest.json');
  const manifestIdentity = await launchIdentityAsync(manifestPath, true, signal);
  const bytes = await readFile(manifestPath, { encoding: 'utf8', signal });
  signal?.throwIfAborted();
  if (createHash('sha256').update(bytes).digest('hex') !== manifestIdentity.digest)
    throw Error('windows_git_bash_asset_changed');
  const manifest = JSON.parse(bytes);
  if (
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.identity !==
      createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex') ||
    shell !== join(root, 'usr/bin/bash.exe') ||
    fullShell !== join(root, 'full/usr/bin/bash.exe')
  )
    throw Error('windows_git_bash_asset_invalid');
  const names = new Set<string>();
  const roots = [
    manifestIdentity,
    ...(await mapAssetVerification(
      [root, join(root, 'full')],
      (path, signal) => launchIdentityAsync(path, false, signal),
      signal,
    )),
  ];
  const files: { name: string; sha256: string; sourceSha256: string }[] = [];
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file.name !== 'string' ||
      file.name
        .split('/')
        .some((part: string) => !part || part === '.' || part === '..' || /[\\:\0]/.test(part)) ||
      names.has(file.name.toLowerCase()) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !/^[a-f0-9]{64}$/.test(file.sourceSha256)
    )
      throw Error('windows_git_bash_asset_invalid');
    names.add(file.name.toLowerCase());
    files.push({ name: file.name, sha256: file.sha256, sourceSha256: file.sourceSha256 });
  }
  const programs = files.filter(({ name }) => {
    const layout = /^([^/]+)\/bin\/git\.exe$/iu.exec(name)?.[1];
    return layout && files.some((file) => file.name.startsWith(`${layout}/libexec/git-core/`));
  });
  if (
    programs.length !== 1 ||
    ![...gitBashFiles, 'ktipc.dll'].every((name) => names.has(`usr/bin/${name}`))
  )
    throw Error('windows_git_bash_asset_invalid');
  const program = programs[0]!.name;
  return {
    git: join(root, program),
    fullGit: join(root, 'full', program),
    async verify(full: boolean, signal?: AbortSignal) {
      await verifyLaunchIdentitiesAsync(roots, signal);
      const base = full ? join(root, 'full') : root;
      await mapAssetVerification(
        files,
        async (file, signal) => {
          const fact = await launchIdentityAsync(join(base, file.name), true, signal);
          if (fact.digest !== (full ? file.sourceSha256 : file.sha256))
            throw Error('windows_git_bash_asset_changed');
        },
        signal,
      );
      await verifyLaunchIdentitiesAsync(roots, signal);
    },
  };
}
/** Redirect only the private MSYS image's import descriptor, without changing
 * machine code, exports, the installed DLL, or its filesystem authority.
 */
export function msysCompatibilityImage(input: Uint8Array): Buffer {
  const bytes = Buffer.from(input);
  try {
    const pe = bytes.readUInt32LE(0x3c),
      optional = pe + 24;
    if (
      bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0' ||
      bytes.readUInt16LE(pe + 4) !== 0x8664 ||
      bytes.readUInt16LE(optional) !== 0x20b
    )
      throw Error();
    const sections = optional + bytes.readUInt16LE(pe + 20);
    const rva = (address: number) => {
      for (let n = 0; n < bytes.readUInt16LE(pe + 6); n++) {
        const section = sections + n * 40,
          start = bytes.readUInt32LE(section + 12),
          size = bytes.readUInt32LE(section + 16);
        if (address >= start && address < start + size) {
          const offset = bytes.readUInt32LE(section + 20) + address - start;
          if (offset >= bytes.length) throw Error();
          return offset;
        }
      }
      throw Error();
    };
    const table = rva(bytes.readUInt32LE(optional + 120));
    const length = bytes.readUInt32LE(optional + 124);
    let changed = 0,
      ended = false;
    for (
      let descriptor = table;
      descriptor + 20 <= Math.min(bytes.length, table + length);
      descriptor += 20
    ) {
      const name = bytes.readUInt32LE(descriptor + 12);
      if (!name) {
        ended = true;
        break;
      }
      const offset = rva(name),
        end = bytes.indexOf(0, offset);
      if (end < offset) throw Error();
      if (bytes.toString('ascii', offset, end).toLowerCase() === 'ntdll.dll') {
        bytes.write('ktipc.dll\0', offset, 'ascii');
        changed++;
      }
    }
    if (changed !== 1 || !ended) throw Error();
    return bytes;
  } catch {
    throw Error('windows_msys_compatibility_image_invalid');
  }
}
export class WindowsGitBashUnavailable extends Error {
  readonly gitExecutable?: string;
  constructor(gitExecutable?: string) {
    super('windows_git_bash_unavailable');
    this.gitExecutable = gitExecutable;
  }
}

/** Search only the installation containing the PATH result. Git for Windows
 * launchers are separate from the Git executable and its helper directory. */
function discoverGitInstallation(executable: string) {
  const parent = dirname(executable);
  const installation = [parent, dirname(parent), dirname(dirname(parent))].find((root) => {
    const stat = lstatSync(join(root, 'usr/bin/bash.exe'), { throwIfNoEntry: false });
    if (!stat) return false;
    if (!stat.isFile()) throw Error('windows_git_bash_asset_invalid');
    return true;
  });
  if (!installation) return undefined;

  const isDirectory = (path: string) => lstatSync(path, { throwIfNoEntry: false })?.isDirectory();
  const hasProgram = (root: string) => {
    const helpers = join(root, 'libexec/git-core');
    return (
      isDirectory(join(root, 'bin')) &&
      lstatSync(join(root, 'bin/git.exe'), { throwIfNoEntry: false })?.isFile() &&
      isDirectory(join(root, 'libexec')) &&
      isDirectory(helpers) &&
      readdirSync(helpers, { withFileTypes: true }).some((entry) => entry.isFile())
    );
  };
  const direct = dirname(parent);
  if (
    basename(parent).toLowerCase() === 'bin' &&
    dirname(direct) === installation &&
    hasProgram(direct)
  )
    return { installation, programRoot: direct };

  const candidates = readdirSync(installation, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(installation, entry.name))
    .filter(hasProgram);
  if (candidates.length === 1) return { installation, programRoot: candidates[0]! };
  return undefined;
}

export function windowsGitProgram(executable: string): string {
  const selected = realpathSync.native(executable);
  const discovered = discoverGitInstallation(selected);
  return discovered ? join(discovered.programRoot, 'bin/git.exe') : selected;
}

/** Copy Git for Windows to an immutable, content-addressed runtime. */
export async function stageWindowsGitBash(stateRoot: string, compatibility: string) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !isAbsolute(stateRoot))
    throw Error('windows_shell_unqualified');
  const git = Bun.which('git');
  if (!git) throw new WindowsGitBashUnavailable();
  const gitExecutable = realpathSync.native(git);
  const discovered = discoverGitInstallation(gitExecutable);
  if (!discovered) throw new WindowsGitBashUnavailable(gitExecutable);
  const { installation, programRoot } = discovered;
  const source = join(installation, 'usr/bin');
  for (const name of gitBashFiles) {
    const stat = lstatSync(join(source, name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('windows_git_bash_asset_invalid');
  }
  const collect = (directory: string): string[] => {
    if (!existsSync(directory)) return [];
    const result: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error('windows_git_bash_asset_invalid');
      if (entry.isDirectory()) result.push(...collect(path));
      else if (entry.isFile()) result.push(path);
      else throw Error('windows_git_bash_asset_invalid');
    }
    return result;
  };
  const paths = new Set([
    ...readdirSync(source)
      .filter((name) => /\.(dll|exe)$/i.test(name) && name.toLowerCase() !== 'ktipc.dll')
      .sort()
      .map((name) => join(source, name)),
    ...['bin', 'libexec/git-core', 'share/git-core', 'etc'].flatMap((path) =>
      collect(join(programRoot, path)),
    ),
    ...['usr/lib', 'etc/ssl'].flatMap((path) => collect(join(installation, path))),
    compatibility,
  ]);
  const files = Array.from(paths, (path) => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('windows_git_bash_asset_invalid');
    const original = readFileSync(path);
    const sourceSha256 = createHash('sha256').update(original).digest('hex');
    return {
      source: realpathSync.native(path),
      name:
        path === compatibility
          ? 'usr/bin/ktipc.dll'
          : relative(installation, path).replaceAll('\\', '/'),
      sourceSha256,
      sha256: path.toLowerCase().endsWith('msys-2.0.dll')
        ? createHash('sha256').update(msysCompatibilityImage(original)).digest('hex')
        : sourceSha256,
    };
  });
  const identity = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  privateDirectory(stateRoot);
  const runtime = join(stateRoot, 'runtime', identity);
  privateDirectory(runtime);
  const bin = join(runtime, 'usr/bin');
  const installRuntime = async (root: string, compatible: boolean) => {
    // Create each parent once, rather than issuing recursive mkdir for every file.
    const directories = [...new Set(['tmp', ...files.map((file) => dirname(file.name))])];
    await prepareFiles(directories, async (directory) => {
      await mkdir(join(root, directory), { recursive: true });
    });
    await prepareFiles(files, async (file) => {
      const target = join(root, file.name);
      const expected = compatible ? file.sha256 : file.sourceSha256;
      const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      if (stat && (!stat.isFile() || stat.isSymbolicLink()))
        throw Error('windows_git_bash_asset_changed');
      if (!stat) {
        // A racing preparation may create this same file; never overwrite its bytes.
        try {
          if (compatible && file.name.toLowerCase() === 'usr/bin/msys-2.0.dll')
            await writeFile(target, msysCompatibilityImage(await readFile(file.source)), {
              flag: 'wx',
            });
          else await copyFile(file.source, target, constants.COPYFILE_EXCL);
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        }
      }
      const current = await lstat(target);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        createHash('sha256')
          .update(await readFile(target))
          .digest('hex') !== expected
      )
        throw Error('windows_git_bash_asset_changed');
    });
  };
  // Both runtime copies and the manifest share one cross-process publication owner.
  // A waiter must never hash a file while another preparation is still writing it.
  const deadline = performance.now() + 30000;
  let preparation: FileLock;
  for (;;) {
    try {
      preparation = acquireFileLock(join(runtime, 'preparation.lock'), 'exclusive');
      break;
    } catch (error) {
      if (!(error instanceof LockBusyError) || performance.now() >= deadline) throw error;
      await Bun.sleep(10);
    }
  }
  try {
    await installRuntime(runtime, true);
    // Full and Workspace need separate MSYS shared-memory namespaces. Keep
    // Full's image unchanged instead of widening its object ACLs.
    await installRuntime(join(runtime, 'full'), false);
    const manifest = join(runtime, 'manifest.json');
    const bytes = JSON.stringify({ identity, files });
    if (existsSync(manifest)) {
      if (readFileSync(manifest, 'utf8') !== bytes) throw Error('windows_git_bash_asset_changed');
    } else writeFileSync(manifest, bytes, { flag: 'wx' });
    return {
      shell: join(bin, 'bash.exe'),
      fullShell: join(runtime, 'full/usr/bin/bash.exe'),
      stateRoot,
    };
  } finally {
    // prepareFiles settles every started operation before this owner is released.
    preparation.release();
  }
}
