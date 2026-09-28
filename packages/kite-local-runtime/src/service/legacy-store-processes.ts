import { dlopen, ptr } from 'bun:ffi';
import { realpathSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

/** Observation only: this does not establish that an old distribution cannot launch later. */
export type LegacyKiteProcessKind = 'service' | 'launcher' | 'desktop' | 'source_client';
export interface LegacyKiteProcessIdentity {
  readonly pid: number;
  readonly startIdentity: string;
}
export interface LegacyKiteProcessMatch extends LegacyKiteProcessIdentity {
  readonly kind: LegacyKiteProcessKind;
}
export type LegacyKiteProcessObservation =
  | { readonly status: 'busy'; readonly matches: readonly LegacyKiteProcessMatch[] }
  | { readonly status: 'complete'; readonly matches: readonly [] }
  | {
      readonly status: 'incomplete';
      readonly reason: 'process_identity' | 'process_arguments' | 'snapshot_capacity';
    }
  | { readonly status: 'unsupported' };

const PROC_PIDTBSDINFO = 3;
const PROC_BSDINFO_SIZE = 136; // macOS SDK struct proc_bsdinfo
const KINFO_PROC_SIZE = 648; // macOS 64-bit SDK struct kinfo_proc
const SZOMB = 5; // macOS SDK sys/proc.h
const MAX_PIDS = 65_536;
const MAX_ARG_BYTES = 1_048_576;
const MAX_PATH_BYTES = 4_096;
const decoder = new TextDecoder('utf-8', { fatal: true });

type DarwinApi = ReturnType<typeof openDarwinApi>;
function openDarwinApi() {
  return dlopen('/usr/lib/libSystem.B.dylib', {
    proc_listpids: { args: ['u32', 'u32', 'ptr', 'i32'], returns: 'i32' },
    proc_pidinfo: { args: ['i32', 'i32', 'u64', 'ptr', 'i32'], returns: 'i32' },
    proc_pidpath: { args: ['i32', 'ptr', 'u32'], returns: 'i32' },
    csops: { args: ['i32', 'u32', 'ptr', 'u64'], returns: 'i32' },
    sysctl: { args: ['ptr', 'u32', 'ptr', 'ptr', 'ptr', 'u64'], returns: 'i32' },
  });
}

/** Return the exact macOS PID/start identity expected by the observer exclusion. */
export function readLegacyKiteProcessIdentity(pid: number): LegacyKiteProcessIdentity | undefined {
  if (process.platform !== 'darwin' || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  let api: DarwinApi;
  try {
    api = openDarwinApi();
  } catch {
    return undefined;
  }
  try {
    const identity = readDarwinIdentity(api, pid);
    return identity ? { pid, startIdentity: identity.startIdentity } : undefined;
  } finally {
    api.close();
  }
}

/** Verify an exact source CLI/TUI parent from the named checkout before excluding it. */
export function readKiteSourceClientParentIdentity(
  pid: number,
  repositoryRoot: string,
): LegacyKiteProcessIdentity | undefined {
  if (process.platform !== 'darwin' || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  let expectedRoot: string;
  try {
    expectedRoot = realpathSync.native(repositoryRoot);
  } catch {
    return undefined;
  }
  let api: DarwinApi;
  try {
    api = openDarwinApi();
  } catch {
    return undefined;
  }
  try {
    const before = readDarwinIdentity(api, pid);
    if (!before || before.uid !== process.getuid?.()) return undefined;
    const argv = readDarwinArgv(api, pid);
    const cwd = readDarwinCwd(api, pid);
    if (!argv || !cwd) return undefined;
    const expected = [
      join(expectedRoot, 'scripts/release/entrypoints/cli.ts'),
      join(expectedRoot, 'scripts/release/entrypoints/tui.ts'),
    ];
    const sourceClient = argv.some((argument) => {
      if (!/(?:^|[/\\])scripts[/\\]release[/\\]entrypoints[/\\](?:cli|tui)\.ts$/u.test(argument))
        return false;
      try {
        return expected.includes(realpathSync.native(resolve(cwd, argument)));
      } catch {
        return false;
      }
    });
    const after = readDarwinIdentity(api, pid);
    return sourceClient && after?.startIdentity === before.startIdentity
      ? { pid, startIdentity: before.startIdentity }
      : undefined;
  } finally {
    api.close();
  }
}

function readDarwinCwd(api: DarwinApi, pid: number): string | undefined {
  const bytes = new Uint8Array(2_352); // macOS SDK proc_vnodepathinfo
  if (api.symbols.proc_pidinfo(pid, 9, 0, ptr(bytes), bytes.length) !== bytes.length)
    return undefined;
  const path = bytes.subarray(152, 152 + 1_024); // pvi_cdir.vip_path
  const end = path.indexOf(0);
  if (end < 1) return undefined;
  try {
    return decoder.decode(path.subarray(0, end));
  } catch {
    return undefined;
  }
}

/** Verify the direct Electron parent of a paired Desktop Service executable. */
export function readKitePairedDesktopParentIdentity(input: {
  readonly pid: number;
  readonly serviceExecutablePath: string;
  /** Present only for `bun run desktop`; an archive candidate may still be paired. */
  readonly sourceRepositoryRoot?: string;
}): LegacyKiteProcessIdentity | undefined {
  if (process.platform !== 'darwin' || !Number.isSafeInteger(input.pid) || input.pid <= 0)
    return undefined;
  let servicePath: string;
  try {
    servicePath = realpathSync.native(input.serviceExecutablePath);
  } catch {
    return undefined;
  }
  let api: DarwinApi;
  try {
    api = openDarwinApi();
  } catch {
    return undefined;
  }
  try {
    const before = readDarwinIdentity(api, input.pid);
    if (!before || before.uid !== process.getuid?.()) return undefined;
    const executable = readDarwinExecutable(api, input.pid);
    const argv = readDarwinArgv(api, input.pid);
    const cwd = readDarwinCwd(api, input.pid);
    if (!executable || !argv || !cwd) return undefined;
    let paired = false;
    if (input.sourceRepositoryRoot !== undefined) {
      let root: string;
      try {
        root = realpathSync.native(input.sourceRepositoryRoot);
      } catch {
        return undefined;
      }
      const appPath = join(root, 'apps/kite-desktop');
      paired =
        servicePath === join(appPath, 'service/kite-service') &&
        cwd === appPath &&
        argv.some((argument) => {
          try {
            return realpathSync.native(resolve(cwd, argument)) === appPath;
          } catch {
            return false;
          }
        }) &&
        executable.startsWith(`${root}/node_modules/`) &&
        /[/\\]electron[/\\]dist[/\\]Electron\.app[/\\]Contents[/\\]MacOS[/\\]Electron$/u.test(
          executable,
        );
    } else {
      const appRoot =
        /^(.*[/\\]kite\.app)[/\\]Contents[/\\]Resources[/\\]service[/\\]kite-service$/iu.exec(
          servicePath,
        )?.[1];
      paired = appRoot !== undefined && executable === `${appRoot}/Contents/MacOS/kite`;
    }
    const after = readDarwinIdentity(api, input.pid);
    return paired && after?.startIdentity === before.startIdentity
      ? { pid: input.pid, startIdentity: before.startIdentity }
      : undefined;
  } finally {
    api.close();
  }
}

/** The installed stdio Service is owned by its pinned candidate client and stable launcher. */
export function readKiteInstalledStdioLineage(input: {
  readonly parentPid: number;
  readonly candidateRoot: string;
  readonly installRoot: string;
}): readonly LegacyKiteProcessIdentity[] | undefined {
  if (process.platform !== 'darwin') return undefined;
  let api: DarwinApi;
  try {
    api = openDarwinApi();
  } catch {
    return undefined;
  }
  try {
    const parent = readDarwinIdentity(api, input.parentPid);
    if (!parent || parent.uid !== process.getuid?.() || parent.ppid <= 0) return undefined;
    const parentExe = readDarwinExecutable(api, parent.pid);
    if (
      parentExe !== join(input.candidateRoot, 'bin/kite') &&
      parentExe !== join(input.candidateRoot, 'bin/kite-tui')
    )
      return undefined;
    const launcher = readDarwinIdentity(api, parent.ppid);
    if (!launcher || launcher.uid !== process.getuid?.()) return undefined;
    const launcherExe = readDarwinExecutable(api, launcher.pid);
    if (launcherExe !== join(input.installRoot, 'bin', basename(parentExe))) return undefined;
    const finalParent = readDarwinIdentity(api, parent.pid);
    const finalLauncher = readDarwinIdentity(api, launcher.pid);
    if (
      finalParent?.startIdentity !== parent.startIdentity ||
      finalParent.ppid !== launcher.pid ||
      finalLauncher?.startIdentity !== launcher.startIdentity
    )
      return undefined;
    return Object.freeze([
      { pid: parent.pid, startIdentity: parent.startIdentity },
      { pid: launcher.pid, startIdentity: launcher.startIdentity },
    ]);
  } finally {
    api.close();
  }
}

/**
 * Observe the supported Kite entrypoints among this OS user's processes. Exclusions require
 * both PID and precise OS start time; a PID alone cannot waive a potentially reused process.
 * The caller must separately prove new-entry gating, distribution selection, and source stability.
 */
export function observeLegacyKiteStoreProcesses(
  input: {
    readonly exclude?: readonly LegacyKiteProcessIdentity[];
    readonly platform?: NodeJS.Platform;
    /** Only report processes that may use this canonical Store home. */
    readonly canonicalKiteHome?: string;
    /** Verified managed installation prefixes; required for non-default --prefix installs. */
    readonly managedInstallPrefixes?: readonly string[];
  } = {},
): LegacyKiteProcessObservation {
  if ((input.platform ?? process.platform) !== 'darwin' || process.platform !== 'darwin') {
    return { status: 'unsupported' };
  }
  const uid = process.getuid?.();
  if (uid === undefined) return { status: 'unsupported' };
  const scopedHome = input.canonicalKiteHome
    ? canonicalStoreHome(input.canonicalKiteHome)
    : undefined;
  if (input.canonicalKiteHome && !scopedHome)
    return { status: 'incomplete', reason: 'process_identity' };
  let api: DarwinApi;
  try {
    api = openDarwinApi();
  } catch {
    return { status: 'unsupported' };
  }
  try {
    const pids = new Int32Array(MAX_PIDS);
    const countBytes = api.symbols.proc_listpids(4, uid, ptr(pids), pids.byteLength);
    const count = countBytes / Int32Array.BYTES_PER_ELEMENT;
    if (!Number.isInteger(count) || count <= 0 || count >= pids.length) {
      return { status: 'incomplete', reason: 'snapshot_capacity' };
    }
    const prefixes = [...(input.managedInstallPrefixes ?? [])];
    if (prefixes.some((value) => !isAbsolute(value))) {
      return { status: 'incomplete', reason: 'process_identity' };
    }
    const matches: LegacyKiteProcessMatch[] = [];
    for (const pid of pids.subarray(0, count)) {
      if (pid <= 0 || pid === process.pid) continue;
      const identity = readDarwinIdentity(api, pid);
      if (!identity) {
        if (processIsGone(pid) || isStableDarwinZombie(api, pid)) continue;
        return { status: 'incomplete', reason: 'process_identity' };
      }
      if (identity.uid !== uid && identity.ruid !== uid) continue;
      const startIdentity = identity.startIdentity;
      if (
        input.exclude?.some((entry) => entry.pid === pid && entry.startIdentity === startIdentity)
      ) {
        continue;
      }
      const executable = readDarwinExecutable(api, pid);
      const invocation = readDarwinProcessInvocation(api, pid);
      if (!executable || !invocation) {
        if (
          executable
            ? !invocation &&
              isDefinitelyUnrelatedExecutable(executable, identity.commandName, prefixes)
            : isVerifiedUnrelatedHelper(api, pid, identity.commandName)
        ) {
          const after = readDarwinIdentity(api, pid);
          if (after?.startIdentity === startIdentity && after.commandName === identity.commandName)
            continue;
        }
        if (processIsGone(pid) || isStableDarwinZombie(api, pid, startIdentity)) continue;
        return { status: 'incomplete', reason: 'process_arguments' };
      }
      const after = readDarwinIdentity(api, pid);
      if (!after || after.startIdentity !== startIdentity) {
        if (processIsGone(pid) || isStableDarwinZombie(api, pid, startIdentity)) continue;
        return { status: 'incomplete', reason: 'process_identity' };
      }
      const kind = classifyKiteProcess(executable, invocation.argv, prefixes);
      if (!kind) continue;
      if (scopedHome) {
        const processHomes = kiteProcessStoreHomes(kind, invocation);
        if (!processHomes) return { status: 'incomplete', reason: 'process_identity' };
        if (!processHomes.includes(scopedHome)) continue;
      }
      matches.push(Object.freeze({ pid, startIdentity, kind }));
    }
    return matches.length > 0
      ? { status: 'busy', matches: Object.freeze(matches) }
      : { status: 'complete', matches: [] };
  } catch {
    return { status: 'incomplete', reason: 'process_identity' };
  } finally {
    api.close();
  }
}

/** A zombie has no writer left; require two matching kernel snapshots before skipping it. */
function isStableDarwinZombie(
  api: DarwinApi,
  pid: number,
  expectedStartIdentity?: string,
): boolean {
  const first = readDarwinZombieIdentity(api, pid);
  if (!first || (expectedStartIdentity && first !== expectedStartIdentity)) return false;
  return readDarwinZombieIdentity(api, pid) === first;
}

function readDarwinZombieIdentity(api: DarwinApi, pid: number): string | undefined {
  const mib = new Int32Array([1, 14, 1, pid]); // CTL_KERN, KERN_PROC, KERN_PROC_PID
  const bytes = new Uint8Array(KINFO_PROC_SIZE);
  const length = new BigUint64Array([BigInt(bytes.length)]);
  if (api.symbols.sysctl(ptr(mib), mib.length, ptr(bytes), ptr(length), null, 0) !== 0)
    return undefined;
  if (Number(length[0]) !== KINFO_PROC_SIZE) return undefined;
  const value = new DataView(bytes.buffer);
  if (value.getInt32(40, true) !== pid || value.getUint8(36) !== SZOMB) return undefined;
  const seconds = value.getBigInt64(0, true);
  const microseconds = value.getBigInt64(8, true);
  if (seconds <= 0n || microseconds < 0n || microseconds >= 1_000_000n) return undefined;
  return `darwin:${seconds}:${microseconds}`;
}

/** Readable paths can rule out Kite only for OS-owned binaries or another app's main executable. */
function isDefinitelyUnrelatedExecutable(
  executable: string,
  commandName: string,
  managedInstallPrefixes: readonly string[],
): boolean {
  if (!isAbsolute(executable) || !commandName) return false;
  const name = basename(executable);
  if (commandName !== name.slice(0, 16)) return false;
  if (classifyKiteProcess(executable, [], managedInstallPrefixes)) return false;
  // Source entrypoints can run under a generic script runtime; a renamed or
  // unrecognized binary outside these known locations is similarly unknown.
  if (/^(?:bun|node|nodejs|deno|electron|kite(?:-tui|-service)?)(?:\.exe)?$/iu.test(name))
    return false;
  const systemBinary = /^(?:\/bin|\/sbin|\/usr\/bin|\/usr\/sbin)\/[^/]+$/u.test(executable);
  const otherAppMain =
    /(?:^|\/)[^/]+\.app\/Contents\/MacOS\/[^/]+$/iu.test(executable) &&
    !/(?:^|\/)kite\.app\//iu.test(executable);
  return systemBinary || otherAppMain;
}

function readDarwinIdentity(
  api: DarwinApi,
  pid: number,
):
  | (LegacyKiteProcessIdentity & {
      uid: number;
      ruid: number;
      ppid: number;
      commandName: string;
    })
  | undefined {
  const bytes = new Uint8Array(PROC_BSDINFO_SIZE);
  if (api.symbols.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, ptr(bytes), bytes.length) !== bytes.length)
    return undefined;
  const value = new DataView(bytes.buffer);
  if (value.getUint32(12, true) !== pid) return undefined;
  const seconds = value.getBigUint64(120, true);
  const microseconds = value.getBigUint64(128, true);
  if (seconds === 0n || microseconds >= 1_000_000n) return undefined;
  const commandBytes = bytes.subarray(48, 64); // pbi_comm: kernel name set at exec
  const commandEnd = commandBytes.indexOf(0);
  let commandName = '';
  try {
    commandName = decoder.decode(commandBytes.subarray(0, commandEnd < 0 ? 16 : commandEnd));
  } catch {
    // An undecodable name cannot identify an exempt helper.
  }
  return {
    pid,
    ppid: value.getUint32(16, true),
    uid: value.getUint32(20, true),
    ruid: value.getUint32(28, true),
    commandName,
    startIdentity: `darwin:${seconds}:${microseconds}`,
  };
}

/** Only these signed, hardened non-Kite executables may outlive a removed app bundle. */
function isVerifiedUnrelatedHelper(api: DarwinApi, pid: number, commandName: string): boolean {
  const expectedIdentity =
    commandName === 'browser_crashpa'
      ? 'browser_crashpad_handler'
      : commandName === 'bare-modifier-m'
        ? 'bare-modifier-monitor'
        : undefined;
  if (!expectedIdentity) return false;
  const flags = new Uint32Array(1);
  if (api.symbols.csops(pid, 0, ptr(flags), flags.byteLength) !== 0) return false;
  const enforcedSignature = 0x1 | 0x100 | 0x200 | 0x10000; // CS_VALID, HARD, KILL, RUNTIME
  if (((flags[0] ?? 0) & enforcedSignature) !== enforcedSignature) return false;
  return (
    readDarwinSigningString(api, pid, 14) === '2DC432GLL2' && // OpenAI Team ID
    readDarwinSigningString(api, pid, 11) === expectedIdentity
  );
}

function readDarwinSigningString(
  api: DarwinApi,
  pid: number,
  operation: number,
): string | undefined {
  const bytes = new Uint8Array(128);
  if (api.symbols.csops(pid, operation, ptr(bytes), bytes.length) !== 0) return undefined;
  const length = Number(new DataView(bytes.buffer).getBigUint64(0, false));
  if (!Number.isSafeInteger(length) || length < 10 || length > bytes.length) return undefined;
  if (bytes[length - 1] !== 0 || bytes.subarray(8, length - 1).includes(0)) return undefined;
  try {
    return decoder.decode(bytes.subarray(8, length - 1));
  } catch {
    return undefined;
  }
}

function readDarwinExecutable(api: DarwinApi, pid: number): string | undefined {
  const bytes = new Uint8Array(MAX_PATH_BYTES);
  const count = api.symbols.proc_pidpath(pid, ptr(bytes), bytes.length);
  if (count <= 0 || count > bytes.length) return undefined;
  try {
    return decoder.decode(bytes.subarray(0, count)).replace(/\0+$/u, '');
  } catch {
    return undefined;
  }
}

interface DarwinProcessInvocation {
  readonly argv: readonly string[];
  readonly homeDirectory?: string;
  readonly configHome?: string;
  readonly runtimeHome?: string;
  readonly environmentComplete: boolean;
}

function readDarwinArgv(api: DarwinApi, pid: number): readonly string[] | undefined {
  return readDarwinProcessInvocation(api, pid)?.argv;
}

function readDarwinProcessInvocation(
  api: DarwinApi,
  pid: number,
): DarwinProcessInvocation | undefined {
  const mib = new Int32Array([1, 49, pid]); // CTL_KERN, KERN_PROCARGS2, pid
  const length = new BigUint64Array([0n]);
  if (api.symbols.sysctl(ptr(mib), mib.length, null, ptr(length), null, 0) !== 0) return undefined;
  const announced = Number(length[0]);
  if (!Number.isSafeInteger(announced) || announced < 5 || announced > MAX_ARG_BYTES)
    return undefined;
  const bytes = new Uint8Array(Math.min(announced + 4_096, MAX_ARG_BYTES));
  length[0] = BigInt(bytes.length);
  if (api.symbols.sysctl(ptr(mib), mib.length, ptr(bytes), ptr(length), null, 0) !== 0)
    return undefined;
  const size = Number(length[0]);
  if (size < 5 || size > bytes.length) return undefined;
  const argc = new DataView(bytes.buffer).getInt32(0, true);
  if (argc < 1 || argc > 4_096) return undefined;
  let offset = 4;
  const executableEnd = bytes.indexOf(0, offset);
  if (executableEnd < 0 || executableEnd >= size) return undefined;
  offset = executableEnd + 1;
  while (offset < size && bytes[offset] === 0) offset++;
  const argv: string[] = [];
  try {
    for (let index = 0; index < argc; index++) {
      const end = bytes.indexOf(0, offset);
      if (end < offset || end >= size) return undefined;
      argv.push(decoder.decode(bytes.subarray(offset, end)));
      offset = end + 1;
    }
    let homeDirectory: string | undefined;
    let configHome: string | undefined;
    let runtimeHome: string | undefined;
    let environmentComplete = false;
    while (offset < size) {
      const end = bytes.indexOf(0, offset);
      if (end < offset || end >= size) break;
      if (end === offset) {
        environmentComplete = true;
        break;
      }
      const entry = decoder.decode(bytes.subarray(offset, end));
      if (entry.startsWith('HOME=')) {
        if (homeDirectory !== undefined) break;
        homeDirectory = entry.slice('HOME='.length);
      }
      if (entry.startsWith('KITE_CODE_CONFIG_HOME=')) {
        if (configHome !== undefined) break;
        configHome = entry.slice('KITE_CODE_CONFIG_HOME='.length);
      }
      if (entry.startsWith('KITE_CODE_HOME=')) {
        if (runtimeHome !== undefined) break;
        runtimeHome = entry.slice('KITE_CODE_HOME='.length);
      }
      offset = end + 1;
    }
    return { argv, homeDirectory, configHome, runtimeHome, environmentComplete };
  } catch {
    return undefined;
  }
}

function canonicalStoreHome(path: string): string | undefined {
  if (!isAbsolute(path)) return undefined;
  try {
    return realpathSync.native(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return resolve(path);
    return undefined;
  }
}

function kiteProcessStoreHomes(
  kind: LegacyKiteProcessKind,
  invocation: DarwinProcessInvocation,
): readonly string[] | undefined {
  const positions = invocation.argv.flatMap((value, index) =>
    value === '--kite-home' ? [index] : [],
  );
  if (positions.length > 1) return undefined;
  const explicit = positions.length === 1 ? invocation.argv[positions[0]! + 1] : undefined;
  if (positions.length === 1 && !explicit) return undefined;
  if (!invocation.environmentComplete) return undefined;
  // The observer's HOME may be an isolated test or Service home. A different
  // process's default Store must be derived from that process's own environment.
  const defaultHome = invocation.homeDirectory
    ? join(invocation.homeDirectory, '.kite-code')
    : undefined;
  if (kind === 'service') {
    // Older Services may keep their Store under the runtime root even when
    // their config root differs. Either root can therefore conflict.
    const paths = [invocation.configHome, invocation.runtimeHome].filter(
      (path): path is string => path !== undefined,
    );
    const candidates = paths.length > 0 ? paths : defaultHome ? [defaultHome] : [];
    if (candidates.length === 0) return undefined;
    const homes = candidates.map(canonicalStoreHome);
    return homes.every((home): home is string => home !== undefined) ? homes : undefined;
  }
  // Current clients use --kite-home or their own HOME. Include inherited Kite
  // roots as candidates as well, since an older client may route through them.
  const paths = [explicit ?? defaultHome, invocation.configHome, invocation.runtimeHome].filter(
    (path): path is string => path !== undefined,
  );
  if (paths.length === 0) return undefined;
  const homes = paths.map(canonicalStoreHome);
  return homes.every((home): home is string => home !== undefined) ? homes : undefined;
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isErrno(error, 'ESRCH');
  }
}
function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export function classifyKiteProcess(
  executable: string,
  argv: readonly string[],
  managedInstallPrefixes: readonly string[],
): LegacyKiteProcessKind | undefined {
  const executableName = basename(executable).toLowerCase();
  const managedSlot = managedInstallPrefixes.some((prefix) => {
    const canonicalPrefix = resolve(prefix);
    const suffix = executable.slice(canonicalPrefix.length);
    return (
      executable.startsWith(`${canonicalPrefix}/`) &&
      (/^\/bin\/kite(?:-tui|-service)?(?:\.exe)?$/u.test(suffix) ||
        /^\/releases\/[a-f0-9]{24}\/bin\/kite(?:-tui|-service)?(?:\.exe)?$/u.test(suffix))
    );
  });
  // A custom managed prefix cannot be enumerated from a different Desktop
  // distribution. Its exact executable layout is still enough to *block*
  // migration while that process lives. This match never authorizes a parent
  // exclusion or proves that a launcher cannot be started later.
  const unlistedManagedSlot =
    /(?:^|[/\\])releases[/\\][a-f0-9]{24}[/\\]bin[/\\]kite(?:-tui|-service)?(?:\.exe)?$/u.test(
      executable,
    ) || /(?:^|[/\\])bin[/\\]kite(?:-tui|-service)?(?:\.exe)?$/u.test(executable);
  const possibleManagedSlot = managedSlot || unlistedManagedSlot;
  const managedService =
    possibleManagedSlot &&
    (executableName === 'kite-service' || executableName === 'kite-service.exe');
  const desktopService =
    /[/\\]kite\.app[/\\]Contents[/\\]Resources[/\\]service[/\\]kite-service$/iu.test(executable);
  const supportedService =
    managedService ||
    desktopService ||
    argv.some((value) =>
      /(?:^|[/\\])scripts[/\\]release[/\\]entrypoints[/\\]service\.ts$/u.test(value),
    );
  if (
    supportedService &&
    argv.some(
      (value, index) =>
        value === 'app-server' &&
        (argv[index + 1] === 'run-stdio' || argv[index + 1] === 'run-daemon'),
    )
  )
    return 'service';
  if (
    possibleManagedSlot &&
    ['kite', 'kite-tui', 'kite-service', 'kite.exe', 'kite-tui.exe', 'kite-service.exe'].includes(
      executableName,
    )
  )
    return 'launcher';
  const sourceDesktopMain =
    /[/\\]Electron\.app[/\\]Contents[/\\]MacOS[/\\]Electron$/u.test(executable) &&
    !argv.some((value) => value.startsWith('--type=')) &&
    argv.some((value) => /(?:^|[/\\])apps[/\\]kite-desktop[/\\]?$/u.test(value));
  if (/[/\\]kite\.app[/\\]Contents[/\\]MacOS[/\\]kite$/iu.test(executable) || sourceDesktopMain)
    return 'desktop';
  if (
    argv.some((value) =>
      /(?:^|[/\\])scripts[/\\]release[/\\]entrypoints[/\\](?:cli|tui)\.ts$/u.test(value),
    )
  )
    return 'source_client';
  return undefined;
}
