/** App-local projection of the selected concrete sandbox backend. */
export type AppSandboxBackendV1 = 'seatbelt' | 'bubblewrap' | 'windows_restricted_token' | 'none';

export type SandboxBackend = AppSandboxBackendV1;

export function appSandboxSupportsFullModeV1(backend: AppSandboxBackendV1): boolean {
  return (
    backend === 'seatbelt' || backend === 'bubblewrap' || backend === 'windows_restricted_token'
  );
}

export const sandboxSupportsFullModeV1 = appSandboxSupportsFullModeV1;
