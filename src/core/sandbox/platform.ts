import { existsSync } from 'node:fs';

/** 沙箱后端类型 / Sandbox backend type */
export type SandboxBackend = 'seatbelt' | 'bubblewrap' | 'none';

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

/** @deprecated 使用 detectSandboxBackend() 代替 / Use detectSandboxBackend() instead */
export function isSandboxAvailable(): boolean {
  return detectSandboxBackend() !== 'none';
}
