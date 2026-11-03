import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { privateDirectory } from '../platform/windows-path-security';
import { launchIdentity, verifyLaunchIdentities } from './launch-identity';

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
/** The staging manifest is the sole inventory for both runtime copies. Pin it
 * once; verify the selected copy against its digests before every dispatch. */
export function captureWindowsGitBashRuntime(
  shell: string,
  fullShell: string,
): (full: boolean) => void {
  const root = join(dirname(shell), '../..');
  const manifestPath = join(root, 'manifest.json');
  const manifestIdentity = launchIdentity(manifestPath, true);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
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
  const roots = [manifestIdentity, launchIdentity(root), launchIdentity(join(root, 'full'))];
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
  if (
    !['bash.exe', 'coreutils.exe', 'msys-2.0.dll', 'ktipc.dll'].every((name) =>
      names.has(`usr/bin/${name}`),
    )
  )
    throw Error('windows_git_bash_asset_invalid');
  return (full) => {
    verifyLaunchIdentities(roots);
    const base = full ? join(root, 'full') : root;
    for (const file of files) {
      const fact = launchIdentity(join(base, file.name), true);
      if (fact.digest !== (full ? file.sourceSha256 : file.sha256))
        throw Error('windows_git_bash_asset_changed');
    }
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
/** Copy the installed Git Bash DLL closure to an immutable, content-addressed runtime.
 * Git Bash is supplied by Git for Windows; the client only redistributes rg and its own helper.
 */
export function stageWindowsGitBash(stateRoot: string, coreutils: string, compatibility: string) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !isAbsolute(stateRoot))
    throw Error('windows_shell_unqualified');
  const git = Bun.which('git');
  if (!git) throw Error('windows_git_bash_unavailable');
  const gitParent = dirname(realpathSync.native(git));
  const installation = [dirname(gitParent), dirname(dirname(gitParent))].find((root) =>
    existsSync(join(root, 'usr/bin/bash.exe')),
  );
  if (!installation) throw Error('windows_git_bash_unavailable');
  const source = join(installation, 'usr/bin');
  if (!existsSync(join(source, 'bash.exe'))) throw Error('windows_git_bash_unavailable');
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
  const paths = [
    ...readdirSync(source)
      .filter(
        (name) =>
          /\.(dll|exe)$/i.test(name) &&
          !['coreutils.exe', 'ktipc.dll'].includes(name.toLowerCase()),
      )
      .sort()
      .map((name) => join(source, name)),
    ...[
      'mingw64/bin',
      'mingw64/libexec/git-core',
      'mingw64/share/git-core',
      'mingw64/etc',
      'usr/lib',
      'etc/ssl',
    ].flatMap((path) => collect(join(installation, path))),
    coreutils,
    compatibility,
  ];
  const files = paths.map((path) => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('windows_git_bash_asset_invalid');
    const original = readFileSync(path);
    return {
      source: realpathSync.native(path),
      name:
        path === coreutils
          ? 'usr/bin/coreutils.exe'
          : path === compatibility
            ? 'usr/bin/ktipc.dll'
            : relative(installation, path).replaceAll('\\', '/'),
      sourceSha256: createHash('sha256').update(original).digest('hex'),
      sha256: createHash('sha256')
        .update(
          path.toLowerCase().endsWith('msys-2.0.dll') ? msysCompatibilityImage(original) : original,
        )
        .digest('hex'),
    };
  });
  const identity = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  privateDirectory(stateRoot);
  const runtime = join(stateRoot, 'runtime', identity);
  privateDirectory(runtime);
  const bin = join(runtime, 'usr/bin');
  const installRuntime = (root: string, compatible: boolean) => {
    mkdirSync(join(root, 'tmp'), { recursive: true });
    for (const file of files) {
      const target = join(root, file.name);
      const expected = compatible ? file.sha256 : file.sourceSha256;
      mkdirSync(dirname(target), { recursive: true });
      if (existsSync(target)) {
        const stat = lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink()) throw Error('windows_git_bash_asset_changed');
      } else if (compatible && file.name.toLowerCase() === 'usr/bin/msys-2.0.dll') {
        writeFileSync(target, msysCompatibilityImage(readFileSync(file.source)), { flag: 'wx' });
      } else copyFileSync(file.source, target);
      if (hash(target) !== expected) throw Error('windows_git_bash_asset_changed');
    }
  };
  installRuntime(runtime, true);
  // Full and Workspace need separate MSYS shared-memory namespaces. Keep
  // Full's image unchanged instead of widening its object ACLs.
  installRuntime(join(runtime, 'full'), false);
  const manifest = join(runtime, 'manifest.json');
  const bytes = JSON.stringify({ identity, files });
  if (existsSync(manifest)) {
    if (readFileSync(manifest, 'utf8') !== bytes) throw Error('windows_git_bash_asset_changed');
  } else writeFileSync(manifest, bytes, { flag: 'wx' });
  return {
    shell: join(bin, 'bash.exe'),
    fullShell: join(runtime, 'full/usr/bin/bash.exe'),
    coreutils: join(bin, 'coreutils.exe'),
    stateRoot,
  };
}
