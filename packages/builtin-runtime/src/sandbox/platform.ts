import { existsSync } from 'node:fs';
import { resolveWindowsSandboxRunnerV1 } from './windows-runner';

/** 沙箱后端类型 / Sandbox backend type */
export type SandboxBackend = 'seatbelt' | 'bubblewrap' | 'windows_restricted_token' | 'none';

export interface SandboxRuntime {
  /** Whether sandboxing is enabled by configuration/runtime flags. */
  enabled: boolean;
  /** The concrete backend selected for this run. */
  backend: SandboxBackend;
  /** True only when sandboxing is enabled and a backend is available. */
  available: boolean;
}

export interface ResolveSandboxRuntimeOptions {
  enabled?: boolean;
  detectBackend?: () => SandboxBackend;
}

/**
 * Full mode is available whenever the selected development backend owns the
 * command process boundary. Windows remains development-only for release
 * qualification; this product mode must not be read as that separate claim.
 */
export function sandboxSupportsFullModeV1(backend: SandboxBackend): boolean {
  return (
    backend === 'seatbelt' || backend === 'bubblewrap' || backend === 'windows_restricted_token'
  );
}

let cachedBubblewrapPath: string | null | undefined;

export const BUBBLEWRAP_USABILITY_PROBE_ARGS = [
  '--ro-bind',
  '/',
  '/',
  '--dev',
  '/dev',
  '--proc',
  '/proc',
  '--unshare-pid',
  '--unshare-net',
  '--die-with-parent',
  '--new-session',
  '/bin/true',
] as const;

export function usableBubblewrapPath(
  path: string | null,
  runProbe: (command: readonly string[]) => number = (command) =>
    Bun.spawnSync([...command], { stdout: 'ignore', stderr: 'ignore' }).exitCode,
): string | null {
  if (!path) return null;
  return runProbe([path, ...BUBBLEWRAP_USABILITY_PROBE_ARGS]) === 0 ? path : null;
}

export function selectSandboxBackend(input: {
  platform: NodeJS.Platform;
  seatbeltAvailable: boolean;
  usableBubblewrapPath: string | null;
  /** Verified direct-workspace runner for the restricted-token backend. */
  windowsRestrictedTokenRunner?: boolean;
}): SandboxBackend {
  if (input.platform === 'darwin' && input.seatbeltAvailable) return 'seatbelt';
  if (input.platform === 'linux' && input.usableBubblewrapPath) return 'bubblewrap';
  if (input.platform === 'win32' && input.windowsRestrictedTokenRunner === true) {
    return 'windows_restricted_token';
  }
  return 'none';
}

/**
 * Resolve bubblewrap only when the host permits the namespace operations used
 * by the real executor. A binary on PATH is discovery evidence, not an
 * executable sandbox boundary.
 */
export function findUsableBubblewrap(): string | null {
  if (cachedBubblewrapPath !== undefined) return cachedBubblewrapPath;
  cachedBubblewrapPath = usableBubblewrapPath(Bun.which('bwrap'));
  return cachedBubblewrapPath;
}

/** 检测当前平台可用的沙箱后端 / Detect available sandbox backend on current platform */
export function detectSandboxBackend(): SandboxBackend {
  const windowsRunnerAvailable =
    process.platform === 'win32' && resolveWindowsSandboxRunnerV1() !== null;
  return selectSandboxBackend({
    platform: process.platform,
    seatbeltAvailable: existsSync('/usr/bin/sandbox-exec'),
    usableBubblewrapPath: process.platform === 'linux' ? findUsableBubblewrap() : null,
    windowsRestrictedTokenRunner: windowsRunnerAvailable,
  });
}

/** Pure binary/manifest discovery. It never launches a usability probe. */
export function discoverSandboxBackendCandidateV1(): SandboxBackend {
  const windowsRunnerAvailable =
    process.platform === 'win32' && resolveWindowsSandboxRunnerV1() !== null;
  return selectSandboxBackend({
    platform: process.platform,
    seatbeltAvailable: existsSync('/usr/bin/sandbox-exec'),
    usableBubblewrapPath: process.platform === 'linux' ? Bun.which('bwrap') : null,
    windowsRestrictedTokenRunner: windowsRunnerAvailable,
  });
}

export function resolveSandboxRuntime(options: ResolveSandboxRuntimeOptions = {}): SandboxRuntime {
  const enabled = options.enabled ?? true;
  if (!enabled) {
    return { enabled: false, backend: 'none', available: false };
  }

  const backend = (options.detectBackend ?? discoverSandboxBackendCandidateV1)();
  return { enabled: true, backend, available: backend !== 'none' };
}

/** @deprecated 使用 detectSandboxBackend() 代替 / Use detectSandboxBackend() instead */
export function isSandboxAvailable(): boolean {
  return detectSandboxBackend() !== 'none';
}
