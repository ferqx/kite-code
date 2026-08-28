import type { SandboxExecutionBackend } from '@kite-ai/runtime-contract';

/** Client-safe execution projection; concrete sandbox implementations remain Service-owned. */
export type SandboxBackend = SandboxExecutionBackend;

export function appSandboxBackendAvailable(backend: SandboxBackend): boolean {
  return (
    backend === 'seatbelt' || backend === 'bubblewrap' || backend === 'windows_restricted_token'
  );
}
