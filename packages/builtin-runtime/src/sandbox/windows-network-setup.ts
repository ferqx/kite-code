import { resolveWindowsSandboxRunner } from './windows-runner';

export type WindowsManagedNetworkSetupState = 'unsupported' | 'runner_unavailable' | 'ready';

export interface WindowsManagedNetworkSetupStatus {
  version: 1;
  state: WindowsManagedNetworkSetupState;
  reason: string;
}

export interface WindowsManagedNetworkSetupDependencies {
  platform?: NodeJS.Platform;
  resolveRunner?: typeof resolveWindowsSandboxRunner;
}

/**
 * Windows network access follows the same approved-invocation contract as
 * macOS and Linux: the current user's restricted token runs the approved
 * script. No local account, credential store, UAC setup, or persistent state
 * is involved.
 */
export async function resolveWindowsManagedNetworkSetupStatus(
  dependencies: WindowsManagedNetworkSetupDependencies = {},
): Promise<WindowsManagedNetworkSetupStatus> {
  if ((dependencies.platform ?? process.platform) !== 'win32') {
    return { version: 1, state: 'unsupported', reason: 'windows_only' };
  }
  const runner = (dependencies.resolveRunner ?? resolveWindowsSandboxRunner)();
  if (!runner) {
    return {
      version: 1,
      state: 'runner_unavailable',
      reason: 'windows_runner_unavailable',
    };
  }
  return { version: 1, state: 'ready', reason: 'current_user_restricted_token' };
}

/** Legacy CLI compatibility: there is no Windows network identity to install. */
export async function setupWindowsManagedNetwork(
  dependencies: WindowsManagedNetworkSetupDependencies = {},
): Promise<WindowsManagedNetworkSetupStatus> {
  const status = await resolveWindowsManagedNetworkSetupStatus(dependencies);
  if (status.state === 'unsupported') {
    throw new Error('Windows sandbox setup is only available on Windows.');
  }
  if (status.state === 'runner_unavailable') {
    throw new Error('The pinned Windows sandbox runner is unavailable.');
  }
  return status;
}
