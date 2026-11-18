import { win32 } from 'node:path';
import { windowsSystemDirectory } from './windows-powershell';

const executableExtensions = ['.exe', '.com', '.cmd', '.bat', '.ps1'];
const appPaths = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths';
const maximumCandidates = 8;
const maximumDirectories = 64;

type CandidateSource = 'path' | 'user_app_paths' | 'machine_app_paths' | 'configured_directory';
type Candidate = { path: string; source: CandidateSource };

function missingCommand(stderr: string, powerShell: boolean): string | undefined {
  const pattern = powerShell
    ? /^Kite could not resolve command: ([^\r\n]+)\r?$/gmu
    : /^(?:[^\r\n]*[\\/])?bash(?:\.exe)?: line \d+: (?:([^\r\n]+): command not found|type: ([^\r\n]+): not found)\r?$/gimu;
  const match = [...stderr.matchAll(pattern)].at(-1);
  return match?.[1] ?? match?.[2];
}

function silentBashProbeMiss(command: string, exitCode: number): string | undefined {
  // Without a diagnostic, only a standalone, literal lookup has an unambiguous
  // result. A hit writes the command's name even when `|| true` handles a miss.
  const probe =
    /^command[ \t]+-v[ \t]+(?:--[ \t]+)?(?<quote>['"]?)(?<name>[\p{L}\p{N}_.+-]{1,128})\k<quote>(?<handled>[ \t]*\|\|[ \t]*true)?$/u.exec(
      command.trim(),
    )?.groups;
  if (probe && exitCode === (probe.handled ? 0 : 1)) return probe.name;
  return undefined;
}

/** Observe an exact failed lookup. Discovery only reads names and local file metadata. */
export function windowsCommandLookup(
  observation: {
    stderr: string;
    powerShell: boolean;
    command: string;
    exitCode: number;
    emptyStdout: boolean;
  },
  env: Readonly<Record<string, string>>,
): { name: string; candidates: Candidate[] } | undefined {
  const { stderr, powerShell, command, exitCode, emptyStdout } = observation;
  const name =
    missingCommand(stderr, powerShell) ??
    (!powerShell && emptyStdout && !stderr ? silentBashProbeMiss(command, exitCode) : undefined);
  if (
    !name ||
    name.length > 128 ||
    name.trim() !== name ||
    name.endsWith('.') ||
    /[<>:"/\\|?*\p{Cc}\p{Cf}]/u.test(name)
  )
    return;
  const candidates: Candidate[] = [];
  const found = new Set<string>();
  const environment = new Map(
    Object.entries(env).map(([key, value]) => [key.toUpperCase(), value]),
  );

  function localPath(value: string): string | undefined {
    const path = value
      .trim()
      .replace(/^"(.*)"$/u, '$1')
      .replace(/%([^%]+)%/gu, (whole, key: string) => environment.get(key.toUpperCase()) ?? whole);
    if (
      path.length <= 1024 &&
      /^[a-z]:[\\/]/iu.test(path) &&
      !/[:*?"<>|\p{Cc}\p{Cf}]/u.test(path.slice(2))
    )
      return win32.normalize(path);
    return undefined;
  }

  try {
    const { dlopen, ptr } = require('bun:ffi') as typeof import('bun:ffi');
    const wide = (text: string) => Buffer.from(`${text}\0`, 'utf16le');
    const kernel = dlopen('kernel32.dll', {
      GetDriveTypeW: { args: ['ptr'], returns: 'u32' },
      GetFileAttributesW: { args: ['ptr'], returns: 'u32' },
    });
    try {
      const fixedDrives = new Map<string, boolean>();
      const attributes = new Map<string, number>();
      function isLocalFile(path: string): boolean {
        const root = path.slice(0, 3);
        const drive = root.toLowerCase();
        if (!fixedDrives.has(drive))
          fixedDrives.set(drive, kernel.symbols.GetDriveTypeW(ptr(wide(root))) === 3); // DRIVE_FIXED
        if (!fixedDrives.get(drive)) return false;
        let current = root;
        let flags = 0x10; // FILE_ATTRIBUTE_DIRECTORY
        for (const part of path.slice(3).split('\\')) {
          if (!(flags & 0x10)) return false;
          current = win32.join(current, part);
          const key = current.toLowerCase();
          if (!attributes.has(key))
            attributes.set(key, kernel.symbols.GetFileAttributesW(ptr(wide(current))));
          flags = attributes.get(key)!;
          // Stop before traversing a reparse point or examining a remote path.
          if (flags === 0xffffffff || flags & 0x400) return false;
        }
        return !(flags & 0x10);
      }

      function record(path: string, source: CandidateSource) {
        if (path.length > 1024 || candidates.length >= maximumCandidates) return;
        const key = path.toLowerCase();
        if (found.has(key) || !isLocalFile(path)) return;
        found.add(key);
        candidates.push({ path, source });
      }

      const hasExecutableExtension = executableExtensions.includes(
        win32.extname(name).toLowerCase(),
      );
      const fileNames = hasExecutableExtension
        ? [name]
        : [...executableExtensions.map((ext) => name + ext), name];
      function searchDirectories(value: string | undefined, source: CandidateSource) {
        const directories = (value ?? '')
          .split(';')
          .map(localPath)
          .filter((path) => path !== undefined);
        for (const directory of directories.slice(0, maximumDirectories)) {
          if (candidates.length >= maximumCandidates) break;
          for (const file of fileNames) record(win32.join(directory, file), source);
        }
      }
      searchDirectories(environment.get('PATH'), 'path');
      if (candidates.length < maximumCandidates) {
        const registry = dlopen(win32.join(windowsSystemDirectory(), 'advapi32.dll'), {
          RegGetValueW: { args: ['u64', 'ptr', 'ptr', 'u32', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
        });
        try {
          const key = wide(`${appPaths}\\${hasExecutableExtension ? name : `${name}.exe`}`);
          for (const [hive, source] of [
            [0xffffffff80000001n, 'user_app_paths'],
            [0xffffffff80000002n, 'machine_app_paths'],
          ] as const) {
            for (const view of [0x10000, 0x20000]) {
              const bytes = Buffer.alloc(4096);
              const length = new Uint32Array([bytes.length]);
              const status = registry.symbols.RegGetValueW(
                hive,
                ptr(key),
                null,
                view | 0x10000006, // REG_SZ or REG_EXPAND_SZ, expanded using the Job's environment.
                null,
                ptr(bytes),
                ptr(length),
              );
              if (status !== 0 || length[0]! < 2 || length[0]! > bytes.length) continue;
              const path = localPath(bytes.toString('utf16le', 0, length[0]! - 2));
              if (!path) continue;
              if (!executableExtensions.includes(win32.extname(path).toLowerCase()))
                record(`${path}.exe`, source);
              record(path, source);
            }
          }
        } finally {
          registry.close();
        }
      }
      searchDirectories(environment.get('KITE_SHELL_TOOL_DIRS'), 'configured_directory');
    } finally {
      kernel.close();
    }
  } catch {
    // A candidate lookup cannot change the result of the original command.
  }
  return { name, candidates };
}
