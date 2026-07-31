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

/**
 * Resolve bubblewrap only when the host permits the namespace operations used
 * by the real executor. A binary on PATH is discovery evidence, not an
 * executable sandbox boundary.
 */
export function findUsableBubblewrap(): string | null {
  if (cachedBubblewrapPath !== undefined) return cachedBubblewrapPath;
  const path = Bun.which('bwrap');
  if (!path) {
    cachedBubblewrapPath = null;
    return null;
  }
  const probe = Bun.spawnSync(
    [
      path,
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
    ],
    { stdout: 'ignore', stderr: 'ignore' },
  );
  cachedBubblewrapPath = probe.exitCode === 0 ? path : null;
  return cachedBubblewrapPath;
}

/** 检测当前平台可用的沙箱后端 / Detect available sandbox backend on current platform */
export function detectSandboxBackend(): SandboxBackend {
  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    return 'seatbelt';
  }
  if (process.platform === 'linux' && findUsableBubblewrap() !== null) {
    return 'bubblewrap';
  }
  return 'none';
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
