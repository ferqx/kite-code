import type { RuntimeState } from './state-runtime';

/** Resolve only process-local cleanup owners; historical State is never required. */
export function resolveLocalDeletionCleanupContext(input: {
  readonly getCoordinatorState: () => Readonly<RuntimeState> | undefined;
  readonly shellWorkspace: () => string | null;
  readonly localWorkspace?: string;
  readonly backgroundRecoveryIdentity: (workspace: string) => string | null;
  readonly readRecoveryIdentity: () => string | null;
}): { readonly workspace: string; readonly recoveryIdentityKey: string } | null {
  let state: Readonly<RuntimeState> | undefined;
  try {
    state = input.getCoordinatorState();
  } catch {
    // A coordinator may already be closing while its Shell is still live.
  }
  const shellWorkspace = input.shellWorkspace();
  const backgroundIdentity = input.localWorkspace
    ? input.backgroundRecoveryIdentity(input.localWorkspace)
    : null;
  if (!state && !shellWorkspace && !backgroundIdentity) return null;
  const workspace = state?.session.workspace ?? shellWorkspace ?? input.localWorkspace;
  const recoveryIdentityKey =
    state?.toolRecovery.identityKey ?? backgroundIdentity ?? input.readRecoveryIdentity();
  return workspace && recoveryIdentityKey ? { workspace, recoveryIdentityKey } : null;
}
