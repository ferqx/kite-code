import { resolveWindowsSandboxRunnerV1 } from './windows-runner';

export type WindowsManagedNetworkSetupStateV1 = 'unsupported' | 'runner_unavailable' | 'ready';

export interface WindowsManagedNetworkSetupStatusV1 {
  version: 1;
  state: WindowsManagedNetworkSetupStateV1;
  reason: string;
}

export interface WindowsManagedNetworkSetupDependenciesV1 {
  platform?: NodeJS.Platform;
  resolveRunner?: typeof resolveWindowsSandboxRunnerV1;
}

/**
 * Windows network access follows the same approved-invocation contract as
 * macOS and Linux: the current user's restricted token runs the approved
 * script. No local account, credential store, UAC setup, or persistent state
 * is involved.
 */
export async function resolveWindowsManagedNetworkSetupStatusV1(
  dependencies: WindowsManagedNetworkSetupDependenciesV1 = {},
): Promise<WindowsManagedNetworkSetupStatusV1> {
  if ((dependencies.platform ?? process.platform) !== 'win32') {
    return { version: 1, state: 'unsupported', reason: 'windows_only' };
  }
  const runner = (dependencies.resolveRunner ?? resolveWindowsSandboxRunnerV1)();
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
export async function setupWindowsManagedNetworkV1(
  dependencies: WindowsManagedNetworkSetupDependenciesV1 = {},
): Promise<WindowsManagedNetworkSetupStatusV1> {
  const status = await resolveWindowsManagedNetworkSetupStatusV1(dependencies);
  if (status.state === 'unsupported') {
    throw new Error('Windows sandbox setup is only available on Windows.');
  }
  if (status.state === 'runner_unavailable') {
    throw new Error('The pinned Windows sandbox runner is unavailable.');
  }
  return status;
}
