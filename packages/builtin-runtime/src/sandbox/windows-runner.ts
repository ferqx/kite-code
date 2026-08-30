import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { z } from 'zod';

/** Matches the native runner's `PROTOCOL_VERSION`. */
export const WINDOWS_SANDBOX_PROTOCOL_VERSION = 6 as const;

const WINDOWS_RUNNER_MANIFEST_SCHEMA = z
  .object({
    version: z.literal(1),
    protocolVersion: z.literal(WINDOWS_SANDBOX_PROTOCOL_VERSION),
    runnerVersion: z
      .string()
      .trim()
      .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/),
    minimumWindowsVersion: z.literal('10.0.19045'),
    runnerDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    runnerPath: z.string().trim().min(1),
    shellRuntime: z.enum(['bash', 'busybox', 'isksh']),
    shellRuntimeDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    shellRuntimePath: z.string().trim().min(1),
    /**
     * Microsoft Coreutils is a single static multi-call executable. The
     * native runner materializes its command-name aliases in the
     * invocation-private runtime after verifying this pin.
     */
    coreutilsDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export interface WindowsSandboxRunnerManifest {
  version: 1;
  protocolVersion: typeof WINDOWS_SANDBOX_PROTOCOL_VERSION;
  runnerVersion: string;
  minimumWindowsVersion: '10.0.19045';
  runnerDigest: string;
  runnerPath: string;
  shellRuntime: 'bash' | 'busybox' | 'isksh';
  shellRuntimeDigest: string;
  shellRuntimePath: string;
  coreutilsDigest: string;
}

/** A verified, usable native runner plus the pinned Shell runtime identity. */
export interface WindowsSandboxRunner {
  path: string;
  version: string;
  digest: string;
  minimumWindowsVersion: '10.0.19045';
  protocolVersion: typeof WINDOWS_SANDBOX_PROTOCOL_VERSION;
  shellRuntimePath: string;
  shellRuntime: WindowsSandboxRunnerManifest['shellRuntime'];
  shellRuntimeDigest: string;
  coreutilsDigest: string;
}

const MANIFEST_RELATIVE_PATH = 'release/platform-capabilities/windows-runner.json';
const DEV_BUILD_RELATIVE_PATH =
  'native/windows-sandbox-runner/target/release/kite-windows-runner.exe';
const MANAGED_INSTALL_MARKER = '.kite-code-managed.json';
const ACTIVE_RELEASE_POINTER = 'active';
const CANDIDATE_ID = /^[a-f0-9]{24}$/u;
const MANAGED_LAUNCHER_NAMES = new Set(['kite.exe', 'kite', 'kite-tui.exe', 'kite-tui']);
const STANDALONE_RELEASE_ROOT_ENV = 'KITE_CODE_RELEASE_ROOT';
const STANDALONE_EXECUTABLE_ENV = 'KITE_STANDALONE_EXECUTABLE';

const managedInstallMarkerSchema = z
  .object({
    schema: z.literal('KiteCodeManagedInstall'),
    version: z.literal(2),
    canonicalRoot: z.string().min(1),
    currentCandidateId: z.string().regex(CANDIDATE_ID),
    previousCandidateId: z.string().regex(CANDIDATE_ID).nullable(),
    target: z.string().regex(/^windows-(?:arm64|x64)$/u),
    activePointer: z.literal(ACTIVE_RELEASE_POINTER),
  })
  .strict();

type ManagedInstallMarker = z.infer<typeof managedInstallMarkerSchema>;

export interface WindowsRunnerFileStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isReparsePoint?(): boolean;
}

export interface WindowsRunnerFileSystem {
  readText(path: string): string;
  readBytes(path: string): Uint8Array;
  lstat(path: string): WindowsRunnerFileStat;
  realpath(path: string): string;
}

export interface WindowsRunnerDiscoveryFileSystemOverrides {
  readonly readFile?: (path: string, encoding: 'utf8') => string;
  readonly readBytes?: (path: string) => Uint8Array;
  readonly lstat?: (path: string) => WindowsRunnerFileStat;
  readonly realpath?: (path: string) => string;
}

function resolveProjectRoot(): string {
  return resolve(import.meta.dirname, '..', '..', '..');
}

export interface RunnerManifestLocation {
  path: string;
  base: string;
}

/**
 * Locate runtime assets next to a managed standalone installation. The v2
 * marker and the unique `active` regular-file pointer live at `<prefix>`; the
 * integrity-checked candidate payload remains in
 * `<prefix>/releases/<candidateId>`. No source, cwd, PATH, or ambient-home
 * fallback is used for a managed launcher.
 */
export function resolveInstalledWindowsRunnerManifestLocation(
  input: {
    readonly executablePath?: string;
    /** Test hook: emulate the release root pinned by the stable launcher. */
    readonly candidateRoot?: string;
    readonly fileSystem?: WindowsRunnerFileSystem;
  } & WindowsRunnerDiscoveryFileSystemOverrides = {},
): RunnerManifestLocation | null {
  const executablePath = input.executablePath ?? process.execPath;
  const executable = win32.basename(executablePath).toLowerCase();
  if (!MANAGED_LAUNCHER_NAMES.has(executable)) return null;
  if (!win32.isAbsolute(executablePath)) return null;
  const fs = input.fileSystem ?? createWindowsRunnerFileSystem(input);
  try {
    const hintedCandidateRoot = input.candidateRoot;
    if (hintedCandidateRoot !== undefined && !win32.isAbsolute(hintedCandidateRoot)) {
      return null;
    }
    const installRoot = hintedCandidateRoot
      ? win32.dirname(win32.dirname(win32.normalize(hintedCandidateRoot)))
      : win32.dirname(win32.dirname(win32.normalize(executablePath)));
    const canonicalInstallRoot = assertSafeWindowsDirectory(
      fs,
      installRoot,
      'managed install root',
    );
    const canonicalExecutable = assertSafeWindowsRegularFile(
      fs,
      executablePath,
      'managed launcher',
    );
    const executableParent = win32.dirname(canonicalExecutable);
    const installLauncherParent = win32.join(canonicalInstallRoot, 'bin');
    const candidateLauncherParent = hintedCandidateRoot
      ? win32.join(win32.normalize(hintedCandidateRoot), 'bin')
      : null;
    if (
      !sameWindowsPath(executableParent, installLauncherParent) &&
      (!candidateLauncherParent || !sameWindowsPath(executableParent, candidateLauncherParent))
    ) {
      return null;
    }
    const marker = parseManagedInstallMarker(
      readWindowsRunnerText(fs, win32.join(canonicalInstallRoot, MANAGED_INSTALL_MARKER)),
    );
    if (!sameWindowsPath(marker.canonicalRoot, canonicalInstallRoot)) return null;

    const pointer = readWindowsRunnerText(
      fs,
      win32.join(canonicalInstallRoot, marker.activePointer),
    );
    if (!CANDIDATE_ID.test(pointer.trim()) || pointer !== `${pointer.trim()}\n`) return null;
    const candidateId = pointer.trim();
    if (candidateId !== marker.currentCandidateId) return null;

    const base = hintedCandidateRoot
      ? win32.normalize(hintedCandidateRoot)
      : win32.join(canonicalInstallRoot, 'releases', candidateId);
    if (
      win32.basename(win32.dirname(base)).toLowerCase() !== 'releases' ||
      !CANDIDATE_ID.test(win32.basename(base))
    ) {
      return null;
    }
    const canonicalBase = assertSafeWindowsDirectory(fs, base, 'active release root');
    if (!sameWindowsPath(win32.dirname(win32.dirname(canonicalBase)), canonicalInstallRoot)) {
      return null;
    }
    if (
      hintedCandidateRoot &&
      !sameWindowsPath(win32.basename(canonicalBase), marker.currentCandidateId)
    ) {
      return null;
    }
    const identity = readWindowsRunnerText(fs, win32.join(canonicalBase, '.candidate-id'));
    if (identity !== `${candidateId}\n`) return null;
    const manifest = readWindowsRunnerBytes(fs, win32.join(canonicalBase, 'manifest.json'));
    if (candidateIdentity(manifest) !== candidateId) return null;

    const path = win32.join(canonicalBase, MANIFEST_RELATIVE_PATH);
    assertSafeWindowsRegularFile(fs, path, 'Windows runner manifest');
    return { path, base: canonicalBase };
  } catch {
    return null;
  }
}

export interface ResolveWindowsSandboxRunnerOptions {
  /** Test hook: override the pinned manifest location. */
  manifestPath?: string;
  /** Test hook: emulate the executable path used by an installed launcher. */
  executablePath?: string;
  /** Test hook: emulate the candidate root pinned by the stable launcher. */
  candidateRoot?: string;
  /** Test hook: provide no-follow filesystem facts without requiring Windows. */
  fileSystem?: WindowsRunnerFileSystem;
}

function sha256File(path: string, fs: WindowsRunnerFileSystem): string | null {
  try {
    assertSafeWindowsRegularFile(fs, path, 'Windows runner asset');
    return `sha256:${createHash('sha256').update(fs.readBytes(path)).digest('hex')}`;
  } catch {
    return null;
  }
}

function loadManifest(
  manifestPath: string | undefined,
  fs: WindowsRunnerFileSystem,
): WindowsSandboxRunnerManifest | null {
  try {
    const path = manifestPath ?? join(resolveProjectRoot(), MANIFEST_RELATIVE_PATH);
    assertSafeWindowsRegularFile(fs, path, 'Windows runner manifest');
    const raw = fs.readText(path);
    return WINDOWS_RUNNER_MANIFEST_SCHEMA.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function candidateRunnerPaths(
  manifest: WindowsSandboxRunnerManifest,
  base: string,
  allowDevelopmentFallback: boolean,
): string[] {
  const candidates: string[] = [];
  if (allowDevelopmentFallback) {
    const override = process.env.KITE_WINDOWS_RUNNER_PATH;
    if (override && isAbsolute(override)) candidates.push(resolve(override));
  }
  const declared = resolveBundlePath(base, manifest.runnerPath);
  if (declared) candidates.push(declared);
  if (allowDevelopmentFallback && !manifest.runnerPath.startsWith('native/')) {
    const development = resolveBundlePath(base, DEV_BUILD_RELATIVE_PATH);
    if (development) candidates.push(development);
  }
  return [...new Set(candidates)];
}

function createWindowsRunnerFileSystem(
  overrides: WindowsRunnerDiscoveryFileSystemOverrides = {},
): WindowsRunnerFileSystem {
  return Object.freeze({
    readText: overrides.readFile
      ? (path: string) => overrides.readFile!(path, 'utf8')
      : (path: string) => readFileSync(path, 'utf8'),
    readBytes: overrides.readBytes
      ? (path: string) => overrides.readBytes!(path)
      : (path: string) => new Uint8Array(readFileSync(path)),
    lstat: overrides.lstat
      ? (path: string) => overrides.lstat!(path)
      : (path: string) => lstatSync(path),
    realpath: overrides.realpath
      ? (path: string) => overrides.realpath!(path)
      : (path: string) => realpathSync.native(path),
  });
}

function readWindowsRunnerText(fs: WindowsRunnerFileSystem, path: string): string {
  assertSafeWindowsRegularFile(fs, path, 'managed release file');
  const value = fs.readText(path);
  if (Buffer.byteLength(value, 'utf8') > 64 * 1024) throw new Error('Managed file is oversized.');
  return value;
}

function readWindowsRunnerBytes(fs: WindowsRunnerFileSystem, path: string): Uint8Array {
  assertSafeWindowsRegularFile(fs, path, 'managed release file');
  const value = fs.readBytes(path);
  if (value.byteLength > 16 * 1024 * 1024) throw new Error('Managed file is oversized.');
  return value;
}

function parseManagedInstallMarker(value: string): ManagedInstallMarker {
  return managedInstallMarkerSchema.parse(JSON.parse(value));
}

function candidateIdentity(manifest: Uint8Array): string {
  return createHash('sha256').update(manifest).digest('hex').slice(0, 24);
}

function assertSafeWindowsRegularFile(
  fs: WindowsRunnerFileSystem,
  path: string,
  label: string,
): string {
  const stat = fs.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.isReparsePoint?.()) {
    throw new Error(`${label} is not a regular file.`);
  }
  const canonical = fs.realpath(path);
  if (!sameWindowsPath(canonical, path)) throw new Error(`${label} is a reparse point.`);
  return canonical;
}

function assertSafeWindowsDirectory(
  fs: WindowsRunnerFileSystem,
  path: string,
  label: string,
): string {
  const stat = fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.isReparsePoint?.()) {
    throw new Error(`${label} is not a regular directory.`);
  }
  const canonical = fs.realpath(path);
  if (!sameWindowsPath(canonical, path)) throw new Error(`${label} is a reparse point.`);
  return canonical;
}

function resolveBundlePath(base: string, value: string): string | null {
  if (!value || value.includes('\\') || win32.isAbsolute(value)) return null;
  const path =
    /^[A-Za-z]:[\\/]/u.test(base) || base.includes('\\')
      ? win32.resolve(base, value)
      : resolve(base, value);
  return isWindowsPathWithin(base, path) ? path : null;
}

function joinBundlePath(base: string, child: string): string {
  return /^[A-Za-z]:[\\/]/u.test(base) || base.includes('\\')
    ? win32.join(base, child)
    : join(base, child);
}

function isWindowsPathWithin(parent: string, candidate: string): boolean {
  const path = win32.relative(win32.normalize(parent), win32.normalize(candidate));
  return path === '' || (!path.startsWith('..') && !win32.isAbsolute(path));
}

function sameWindowsPath(left: string, right: string): boolean {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

function isManagedLauncherPath(path: string): boolean {
  if (!win32.isAbsolute(path)) return false;
  const normalized = win32.normalize(path);
  return (
    win32.basename(win32.dirname(normalized)).toLowerCase() === 'bin' &&
    MANAGED_LAUNCHER_NAMES.has(win32.basename(normalized).toLowerCase())
  );
}

function pinnedCandidateRoot(candidateRoot: string | undefined): string | undefined {
  return candidateRoot ?? process.env[STANDALONE_RELEASE_ROOT_ENV];
}

let cachedRunner: WindowsSandboxRunner | null | undefined;

/**
 * Locate and verify the native runner against the release-pinned manifest.
 * Missing runner, missing/invalid manifest, digest mismatch, or a missing
 * Shell runtime all resolve to `null` — the caller must fail closed.
 */
export function resolveWindowsSandboxRunner(
  options?: ResolveWindowsSandboxRunnerOptions,
): WindowsSandboxRunner | null {
  const cacheable = options?.manifestPath === undefined;
  if (cachedRunner !== undefined && cacheable) return cachedRunner;
  const fileSystem = options?.fileSystem ?? createWindowsRunnerFileSystem();
  const executablePath = options?.executablePath ?? process.execPath;
  const candidateRoot = pinnedCandidateRoot(options?.candidateRoot);
  const installed =
    options?.manifestPath === undefined
      ? resolveInstalledWindowsRunnerManifestLocation({
          executablePath,
          candidateRoot,
          fileSystem,
        })
      : null;
  if (
    options?.manifestPath === undefined &&
    (isManagedLauncherPath(executablePath) ||
      candidateRoot !== undefined ||
      process.env[STANDALONE_EXECUTABLE_ENV] === '1') &&
    !installed
  ) {
    if (cacheable) cachedRunner = null;
    return null;
  }
  const manifestPath = options?.manifestPath ?? installed?.path;
  const manifest = loadManifest(manifestPath, fileSystem);
  if (!manifest) {
    if (cacheable) cachedRunner = null;
    return null;
  }
  // Relative manifest paths are anchored to the manifest's own directory when
  // the caller supplied a custom manifest (tests/evidence producers), and to
  // the repository root for the production pin.
  const base =
    installed?.base ??
    (options?.manifestPath ? resolve(dirname(options.manifestPath)) : resolveProjectRoot());
  const shellRuntimePath = resolveBundlePath(base, manifest.shellRuntimePath);
  if (!shellRuntimePath) {
    if (cacheable) cachedRunner = null;
    return null;
  }
  const shellRuntimeBinary = joinBundlePath(
    shellRuntimePath,
    shellRuntimeExecutable(manifest.shellRuntime),
  );
  const coreutilsBinary = joinBundlePath(shellRuntimePath, 'coreutils.exe');
  if (
    !isSafeWindowsDirectory(fileSystem, shellRuntimePath) ||
    sha256File(shellRuntimeBinary, fileSystem) !== manifest.shellRuntimeDigest ||
    sha256File(coreutilsBinary, fileSystem) !== manifest.coreutilsDigest
  ) {
    if (cacheable) cachedRunner = null;
    return null;
  }
  for (const candidate of candidateRunnerPaths(manifest, base, installed === null)) {
    if (installed && !isWindowsPathWithin(installed.base, candidate)) continue;
    if (sha256File(candidate, fileSystem) !== manifest.runnerDigest) continue;
    const resolved: WindowsSandboxRunner = {
      path: candidate,
      version: manifest.runnerVersion,
      digest: manifest.runnerDigest,
      minimumWindowsVersion: manifest.minimumWindowsVersion,
      protocolVersion: WINDOWS_SANDBOX_PROTOCOL_VERSION,
      shellRuntimePath,
      shellRuntime: manifest.shellRuntime,
      shellRuntimeDigest: manifest.shellRuntimeDigest,
      coreutilsDigest: manifest.coreutilsDigest,
    };
    if (cacheable) cachedRunner = resolved;
    return resolved;
  }
  if (cacheable) cachedRunner = null;
  return null;
}

function isSafeWindowsDirectory(fs: WindowsRunnerFileSystem, path: string): boolean {
  try {
    assertSafeWindowsDirectory(fs, path, 'Windows runner asset directory');
    return true;
  } catch {
    return false;
  }
}

function shellRuntimeExecutable(runtime: WindowsSandboxRunnerManifest['shellRuntime']): string {
  switch (runtime) {
    case 'isksh':
      return 'isksh.exe';
    case 'busybox':
      return 'busybox.exe';
    case 'bash':
      return 'bash.exe';
  }
}

/** Test hook: invalidate the cached runner resolution. */
export function clearWindowsSandboxRunnerCache(): void {
  cachedRunner = undefined;
}

/**
 * Parse a release-pinned runner manifest (used by the evidence producer and
 * tests). Returns null when the manifest is not a valid V1 pin.
 */
export function parseWindowsSandboxRunnerManifest(
  value: unknown,
): WindowsSandboxRunnerManifest | null {
  const parsed = WINDOWS_RUNNER_MANIFEST_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data : null;
}
