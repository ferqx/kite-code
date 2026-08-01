import { existsSync } from 'node:fs';

/** 沙箱后端类型 / Sandbox backend type */
export type SandboxBackend = 'seatbelt' | 'bubblewrap' | 'none';

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
}): SandboxBackend {
  if (input.platform === 'darwin' && input.seatbeltAvailable) return 'seatbelt';
  if (input.platform === 'linux' && input.usableBubblewrapPath) return 'bubblewrap';
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
  return selectSandboxBackend({
    platform: process.platform,
    seatbeltAvailable: existsSync('/usr/bin/sandbox-exec'),
    usableBubblewrapPath: process.platform === 'linux' ? findUsableBubblewrap() : null,
  });
}

export function resolveSandboxRuntime(options: ResolveSandboxRuntimeOptions = {}): SandboxRuntime {
  const enabled = options.enabled ?? true;
  if (!enabled) {
    return { enabled: false, backend: 'none', available: false };
  }

  const backend = (options.detectBackend ?? detectSandboxBackend)();
  return { enabled: true, backend, available: backend !== 'none' };
}

/** @deprecated 使用 detectSandboxBackend() 代替 / Use detectSandboxBackend() instead */
export function isSandboxAvailable(): boolean {
  return detectSandboxBackend() !== 'none';
}
