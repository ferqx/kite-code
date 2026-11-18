import { readdirSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, win32 } from 'node:path';
import {
  startWindowsOwnedChild,
  WindowsOwnedChildStartError,
} from '../platform/process/windows-owned-child';
import { compareInstalledShellVersions } from './installed-shell-version';
import {
  type LaunchIdentity,
  launchIdentityAsync,
  mapAssetVerification,
  verifyLaunchIdentitiesAsync,
} from './launch-identity';

export interface WindowsPowerShell {
  readonly systemDirectory: string;
  readonly version: string;
  readonly edition?: 'Desktop' | 'Core';
  readonly executable: LaunchIdentity;
  readonly engine: LaunchIdentity;
  /** A locally installed, self-contained PowerShell runtime. */
  readonly installation?: { root: string; dependencies: readonly LaunchIdentity[] };
}

type InspectionShell = Pick<WindowsPowerShell, 'systemDirectory' | 'executable' | 'installation'> &
  Partial<Pick<WindowsPowerShell, 'engine'>>;

class PowerShellInspectionCleanupError extends Error {}

async function confirmInspectionCleanup(cleanup: Promise<void>) {
  try {
    await cleanup;
  } catch (cause) {
    throw new PowerShellInspectionCleanupError('windows_powershell_inspection_close_unknown', {
      cause,
    });
  }
}

export function powerShellLaunchIdentities(shell: InspectionShell): readonly LaunchIdentity[] {
  return [
    shell.executable,
    ...(shell.engine ? [shell.engine] : []),
    ...(shell.installation?.dependencies ?? []),
  ];
}

export function windowsSystemDirectory() {
  const { dlopen, ptr } = require('bun:ffi') as typeof import('bun:ffi');
  const kernel = dlopen('kernel32.dll', {
    GetSystemDirectoryW: { args: ['ptr', 'u32'], returns: 'u32' },
  });
  try {
    const buffer = new Uint16Array(32768);
    const length = kernel.symbols.GetSystemDirectoryW(ptr(buffer), buffer.length);
    if (!length || length >= buffer.length) throw Error('windows_system_directory_unavailable');
    return Buffer.from(buffer.buffer, 0, length * 2).toString('utf16le');
  } finally {
    kernel.close();
  }
}

function sameWindowsPath(first: string, second: string) {
  return win32.normalize(first).toLowerCase() === win32.normalize(second).toLowerCase();
}

async function identifyPowerShellFile(path: string, signal?: AbortSignal): Promise<LaunchIdentity> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw Error('windows_powershell_unavailable');
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('windows_powershell_asset_invalid');
  const identity = await launchIdentityAsync(path, true, signal);
  if (!sameWindowsPath(path, identity.canonical)) throw Error('windows_powershell_asset_invalid');
  return identity;
}

const inspectVersion =
  '[Console]::WriteLine($PSVersionTable.PSVersion.ToString()); [Console]::WriteLine([System.Management.Automation.Language.Parser].Assembly.Location); [Console]::WriteLine($PSVersionTable.PSEdition)';

export async function discoverWindowsPowerShell(): Promise<WindowsPowerShell> {
  const directory = windowsSystemDirectory();
  const executable = await identifyPowerShellFile(
    join(directory, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  );
  const result = await runWindowsPowerShellInspection(
    { systemDirectory: directory, executable },
    inspectVersion,
    '',
  );
  const [version, assembly] = result.trim().split(/\r?\n/u);
  if (!version || version.length > 64 || !/^\d+\.\d+(?:\.\d+){0,2}$/u.test(version))
    throw Error('windows_powershell_unavailable');
  if (
    !assembly ||
    !isAbsolute(assembly) ||
    !assembly.toLowerCase().startsWith(`${dirname(directory).toLowerCase()}\\`)
  )
    throw Error('windows_powershell_asset_invalid');
  return {
    systemDirectory: directory,
    version,
    edition: 'Desktop',
    executable,
    engine: await launchIdentityAsync(assembly, true),
  };
}

function powerShellDirectories(directory: string): string[] {
  const { dlopen, ptr } = require('bun:ffi') as typeof import('bun:ffi');
  const advapi = dlopen(join(directory, 'advapi32.dll'), {
    RegGetValueW: { args: ['u64', 'ptr', 'ptr', 'u32', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
    RegOpenKeyExW: { args: ['u64', 'ptr', 'u32', 'u32', 'ptr'], returns: 'i32' },
    RegEnumKeyExW: {
      args: ['u64', 'u32', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'],
      returns: 'i32',
    },
    RegCloseKey: { args: ['u64'], returns: 'i32' },
  });
  const localDirectory = (value: string) => {
    const path = value
      .trim()
      .replace(/^"(.*)"$/u, '$1')
      .replaceAll('/', '\\');
    return /^[a-z]:\\[^\\]/iu.test(path) && !/\p{Cc}/u.test(path) ? win32.resolve(path) : undefined;
  };
  try {
    const wide = (value: string) => Buffer.from(`${value}\0`, 'utf16le');
    const read = (key: string, name: string, view: 32 | 64 = 64) => {
      const bytes = Buffer.alloc(32768 * 2);
      const capacity = new Uint32Array([bytes.length]);
      const status = advapi.symbols.RegGetValueW(
        0xffffffff80000002n, // HKEY_LOCAL_MACHINE
        ptr(wide(key)),
        ptr(wide(name)),
        (view === 64 ? 0x10000 : 0x20000) | 0x2, // REG_SZ only
        null,
        ptr(bytes),
        ptr(capacity),
      );
      if (status !== 0 || capacity[0]! < 2 || capacity[0]! > bytes.length) return undefined;
      return localDirectory(bytes.toString('utf16le', 0, capacity[0]! - 2));
    };
    const installed = (view: 32 | 64) => {
      const key = 'SOFTWARE\\Microsoft\\PowerShellCore\\InstalledVersions';
      const handle = new BigUint64Array(1);
      if (
        advapi.symbols.RegOpenKeyExW(
          0xffffffff80000002n,
          ptr(wide(key)),
          0,
          0x8 | (view === 64 ? 0x100 : 0x200),
          ptr(handle),
        ) !== 0
      )
        return [];
      const directories: string[] = [];
      try {
        for (let index = 0; index < 256; index++) {
          const name = new Uint16Array(256);
          const length = new Uint32Array([name.length]);
          const status = advapi.symbols.RegEnumKeyExW(
            handle[0]!,
            index,
            ptr(name),
            ptr(length),
            null,
            null,
            null,
            null,
          );
          if (status === 259) return directories; // ERROR_NO_MORE_ITEMS
          if (status !== 0) break;
          const release = Buffer.from(name.buffer, 0, length[0]! * 2).toString('utf16le');
          const path = read(`${key}\\${release}`, 'InstallLocation', view);
          if (path) directories.push(path);
        }
        return directories;
      } finally {
        advapi.symbols.RegCloseKey(handle[0]!);
      }
    };
    const windows = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion';
    const programFiles = read(windows, 'ProgramFilesDir');
    const programFilesX86 = read(windows, 'ProgramFilesDir (x86)');
    const systemProgramDirs = [programFiles, programFilesX86].filter(
      (path): path is string => path !== undefined,
    );
    // The interpreter also parses commands on the host. Only machine-registered
    // installs and real directories under the system Program Files roots qualify.
    const inheritedPath =
      process.env.PATH ??
      Object.entries(process.env).find(([name]) => name.toUpperCase() === 'PATH')?.[1];
    const pathDirs = (inheritedPath ?? '')
      .split(';')
      .map(localDirectory)
      .filter(
        (path): path is string =>
          !!path &&
          systemProgramDirs.some((root) =>
            path.toLowerCase().startsWith(`${root.toLowerCase()}\\`),
          ),
      );
    const programDirectories = systemProgramDirs.flatMap((root) => {
      const parent = join(root, 'PowerShell');
      try {
        return readdirSync(parent, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(parent, entry.name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    });
    const candidates = [...installed(64), ...installed(32), ...programDirectories, ...pathDirs];
    const seen = new Set<string>();
    return candidates.filter((path): path is string => {
      if (!path || seen.has(path.toLowerCase())) return false;
      seen.add(path.toLowerCase());
      return true;
    });
  } finally {
    advapi.close();
  }
}

/** Legacy export name: verifies self-contained Core installs without a fixed major version. */
export async function discoverWindowsPowerShell7(): Promise<WindowsPowerShell> {
  const system = windowsSystemDirectory();
  const available: WindowsPowerShell[] = [];
  for (const candidate of powerShellDirectories(system)) {
    try {
      const root = await realpath(candidate);
      if (!sameWindowsPath(candidate, root)) continue;
      const [executable, engine, ...dependencies] = await mapAssetVerification(
        [
          'pwsh.exe',
          'System.Management.Automation.dll',
          'pwsh.dll',
          'pwsh.deps.json',
          'pwsh.runtimeconfig.json',
          'hostfxr.dll',
          'hostpolicy.dll',
          'coreclr.dll',
        ],
        (file, signal) => identifyPowerShellFile(join(root, file), signal),
      );
      const installation = { root, dependencies };
      const shell = {
        systemDirectory: system,
        executable: executable!,
        engine: engine!,
        installation,
      };
      const result = await runWindowsPowerShellInspection(shell, inspectVersion, '');
      const [version, assembly, edition] = result.trim().split(/\r?\n/u);
      if (
        version &&
        version.length <= 64 &&
        /^\d+\.\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?$/u.test(version) &&
        edition === 'Core' &&
        assembly &&
        sameWindowsPath(assembly, shell.engine.canonical)
      )
        available.push({ ...shell, version, edition });
    } catch (error) {
      if (error instanceof PowerShellInspectionCleanupError) throw error;
      // Incomplete, stale or non-runnable installations don't hide later candidates.
    }
  }
  available.sort((first, second) => compareInstalledShellVersions(second.version, first.version));
  if (available[0]) return available[0];
  throw Error('windows_powershell7_unavailable');
}

/** Both installed runtime layouts share one selection policy and one Job backend. */
export async function discoverPreferredWindowsPowerShell(): Promise<WindowsPowerShell> {
  const results = await Promise.allSettled([
    discoverWindowsPowerShell(),
    discoverWindowsPowerShell7(),
  ]);
  const available: WindowsPowerShell[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') available.push(result.value);
    else if (result.reason instanceof PowerShellInspectionCleanupError) throw result.reason;
  }
  available.sort((first, second) => compareInstalledShellVersions(second.version, first.version));
  if (!available[0]) throw Error('windows_powershell_unavailable');
  return available[0];
}

/** Fixed host inspection code. Model text is UTF-8 input data, never part of its arguments. */
export async function runWindowsPowerShellInspection(
  shell: InspectionShell,
  inspection: string,
  source: string,
  signal?: AbortSignal,
): Promise<string> {
  await verifyLaunchIdentitiesAsync(powerShellLaunchIdentities(shell), signal);
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = [System.Text.UTF8Encoding]::new($false, $true)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$env:PSModulePath = $PSHOME + '\\Modules'
${inspection}`;
  const directory = shell.systemDirectory;
  let owner: ReturnType<typeof startWindowsOwnedChild>;
  try {
    owner = startWindowsOwnedChild({
      executable: shell.executable.canonical,
      argv: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-OutputFormat',
        'Text',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      cwd: dirname(shell.executable.canonical),
      env: {
        SystemRoot: dirname(directory),
        PATH: directory,
        PSModulePath: join(dirname(shell.executable.canonical), 'Modules'),
        POWERSHELL_TELEMETRY_OPTOUT: '1',
        POWERSHELL_UPDATECHECK: 'Off',
      },
      stdin: 'pipe',
    });
  } catch (error) {
    if (error instanceof WindowsOwnedChildStartError) await confirmInspectionCleanup(error.cleanup);
    throw error;
  }
  const deadline = AbortSignal.timeout(5000);
  const inspectionSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const stop = () => {
    void owner.stop({ graceMs: 0 }).catch(() => {});
  };
  inspectionSignal.addEventListener('abort', stop, { once: true });
  if (inspectionSignal.aborted) stop();
  const read = async (stream: AsyncIterable<Uint8Array>, maximum: number) => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      if (bytes > maximum) throw Error('windows_powershell_inspection_output_limit');
      chunks.push(chunk);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  };
  const output = read(owner.stdout, 1024 * 1024);
  const errors = read(owner.stderr, 64 * 1024);
  const input = (async () => {
    if (source) await owner.writeStdin(Buffer.from(source, 'utf8'));
    await owner.endStdin();
  })();
  const tasks = [output, errors, input, owner.exited] as const;
  try {
    const [stdout, stderr, , code] = await Promise.all(tasks);
    inspectionSignal.throwIfAborted();
    if (code !== 0 || stderr.trim()) throw Error('windows_powershell_inspection_failed');
    return stdout;
  } finally {
    inspectionSignal.removeEventListener('abort', stop);
    await confirmInspectionCleanup(owner.close());
    await Promise.allSettled(tasks);
  }
}

export async function verifyWindowsPowerShell(shell: WindowsPowerShell): Promise<void> {
  await verifyLaunchIdentitiesAsync(powerShellLaunchIdentities(shell));
}
