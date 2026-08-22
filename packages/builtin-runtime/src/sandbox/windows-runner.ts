import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';
import { z } from 'zod';

/** Matches the native runner's `PROTOCOL_VERSION`. */
export const WINDOWS_SANDBOX_PROTOCOL_VERSION = 6 as const;

const WINDOWS_RUNNER_MANIFEST_V1_SCHEMA = z
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

export interface WindowsSandboxRunnerManifestV1 {
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
export interface WindowsSandboxRunnerV1 {
  path: string;
  version: string;
  digest: string;
  minimumWindowsVersion: '10.0.19045';
  protocolVersion: typeof WINDOWS_SANDBOX_PROTOCOL_VERSION;
  shellRuntimePath: string;
  shellRuntime: WindowsSandboxRunnerManifestV1['shellRuntime'];
  shellRuntimeDigest: string;
  coreutilsDigest: string;
}

const MANIFEST_RELATIVE_PATH = 'release/platform-capabilities/windows-runner-v1.json';
const DEV_BUILD_RELATIVE_PATH =
  'native/windows-sandbox-runner/target/release/kite-windows-runner.exe';

function resolveProjectRoot(): string {
  return resolve(import.meta.dirname, '..', '..', '..');
}

const INSTALLED_CANDIDATE_MARKER = '.kite-code-managed.json';

export interface RunnerManifestLocationV1 {
  path: string;
  base: string;
}

/**
 * Locate runtime assets next to a managed standalone installation. The active
 * launcher lives in `<prefix>/bin`; the integrity-checked candidate payload
 * remains in `<prefix>/releases/<candidateId>`, where the manifest's existing
 * repository-relative paths stay valid.
 */
export function resolveInstalledWindowsRunnerManifestLocationV1(
  input: { executablePath?: string; readFile?: (path: string, encoding: 'utf8') => string } = {},
): RunnerManifestLocationV1 | null {
  const executablePath = input.executablePath ?? process.execPath;
  const executable = win32.basename(executablePath).toLowerCase();
  if (!['kite.exe', 'kite', 'kite-tui.exe', 'kite-tui'].includes(executable)) {
    return null;
  }
  const installRoot = win32.dirname(win32.dirname(executablePath));
  try {
    const marker = JSON.parse(
      (input.readFile ?? readFileSync)(win32.join(installRoot, INSTALLED_CANDIDATE_MARKER), 'utf8'),
    ) as { currentCandidateId?: unknown };
    if (
      typeof marker.currentCandidateId !== 'string' ||
      !/^[a-f0-9]{24}$/.test(marker.currentCandidateId)
    ) {
      return null;
    }
    const base = win32.join(installRoot, 'releases', marker.currentCandidateId);
    return { path: win32.join(base, MANIFEST_RELATIVE_PATH), base };
  } catch {
    return null;
  }
}

export interface ResolveWindowsSandboxRunnerOptionsV1 {
  /** Test hook: override the pinned manifest location. */
  manifestPath?: string;
}

function sha256File(path: string): string | null {
  try {
    return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  } catch {
    return null;
  }
}

function loadManifest(manifestPath?: string): WindowsSandboxRunnerManifestV1 | null {
  try {
    const raw = readFileSync(
      manifestPath ?? join(resolveProjectRoot(), MANIFEST_RELATIVE_PATH),
      'utf8',
    );
    return WINDOWS_RUNNER_MANIFEST_V1_SCHEMA.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function candidateRunnerPaths(manifest: WindowsSandboxRunnerManifestV1, base: string): string[] {
  const candidates: string[] = [];
  const override = process.env.KITE_WINDOWS_RUNNER_PATH;
  if (override) candidates.push(resolve(override));
  candidates.push(resolve(base, manifest.runnerPath));
  if (!manifest.runnerPath.startsWith('native/')) {
    candidates.push(resolve(base, DEV_BUILD_RELATIVE_PATH));
  }
  return candidates;
}

let cachedRunner: WindowsSandboxRunnerV1 | null | undefined;

/**
 * Locate and verify the native runner against the release-pinned manifest.
 * Missing runner, missing/invalid manifest, digest mismatch, or a missing
 * Shell runtime all resolve to `null` — the caller must fail closed.
 */
export function resolveWindowsSandboxRunnerV1(
  options?: ResolveWindowsSandboxRunnerOptionsV1,
): WindowsSandboxRunnerV1 | null {
  const cacheable = options?.manifestPath === undefined;
  if (cachedRunner !== undefined && cacheable) return cachedRunner;
  const installed =
    options?.manifestPath === undefined ? resolveInstalledWindowsRunnerManifestLocationV1() : null;
  const manifestPath = options?.manifestPath ?? installed?.path;
  const manifest = loadManifest(manifestPath);
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
  const shellRuntimePath = resolve(base, manifest.shellRuntimePath);
  const shellRuntimeBinary = join(shellRuntimePath, shellRuntimeExecutable(manifest.shellRuntime));
  const coreutilsBinary = join(shellRuntimePath, 'coreutils.exe');
  if (
    !existsSync(shellRuntimeBinary) ||
    sha256File(shellRuntimeBinary) !== manifest.shellRuntimeDigest ||
    !existsSync(coreutilsBinary) ||
    sha256File(coreutilsBinary) !== manifest.coreutilsDigest
  ) {
    if (cacheable) cachedRunner = null;
    return null;
  }
  for (const candidate of candidateRunnerPaths(manifest, base)) {
    if (!existsSync(candidate)) continue;
    if (sha256File(candidate) !== manifest.runnerDigest) continue;
    const resolved: WindowsSandboxRunnerV1 = {
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

function shellRuntimeExecutable(runtime: WindowsSandboxRunnerManifestV1['shellRuntime']): string {
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
export function clearWindowsSandboxRunnerCacheV1(): void {
  cachedRunner = undefined;
}

/**
 * Parse a release-pinned runner manifest (used by the evidence producer and
 * tests). Returns null when the manifest is not a valid V1 pin.
 */
export function parseWindowsSandboxRunnerManifestV1(
  value: unknown,
): WindowsSandboxRunnerManifestV1 | null {
  const parsed = WINDOWS_RUNNER_MANIFEST_V1_SCHEMA.safeParse(value);
  return parsed.success ? parsed.data : null;
}
