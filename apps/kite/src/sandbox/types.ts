/** App-local projection of the selected concrete sandbox backend. */
export type AppSandboxBackend = 'seatbelt' | 'bubblewrap' | 'windows_restricted_token' | 'none';

export type SandboxBackend = AppSandboxBackend;

export function appSandboxSupportsFullMode(backend: AppSandboxBackend): boolean {
  return (
    backend === 'seatbelt' || backend === 'bubblewrap' || backend === 'windows_restricted_token'
  );
}

export const sandboxSupportsFullMode = appSandboxSupportsFullMode;
