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

/** 检测当前平台可用的沙箱后端 / Detect available sandbox backend on current platform */
export function detectSandboxBackend(): SandboxBackend {
  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    return 'seatbelt';
  }
  if (process.platform === 'linux' && Bun.which('bwrap') !== null) {
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
