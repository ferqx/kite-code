import { z } from 'zod';
import { resolveWindowsSandboxRunnerV1 } from './windows-runner';

const NATIVE_STATUS_SCHEMA = z
  .object({
    version: z.literal(1),
    state: z.enum(['ready', 'missing', 'invalid']),
    reason: z.enum([
      'managed_network_ready',
      'managed_network_setup_required',
      'managed_network_setup_invalid',
    ]),
  })
  .strict();

export type WindowsManagedNetworkSetupStateV1 =
  | 'unsupported'
  | 'runner_unavailable'
  | 'ready'
  | 'missing'
  | 'invalid';

export interface WindowsManagedNetworkSetupStatusV1 {
  version: 1;
  state: WindowsManagedNetworkSetupStateV1;
  reason: string;
}

/**
 * True when the status admits the main UI without an interactive setup
 * choice: the managed identity is ready, or the backend itself is
 * unavailable/unsupported (setup would have nothing to install). Shared by
 * the gate's initial probe and its confirm-time re-check, so a concurrent
 * TUI instance that finished setup while the user was deciding is absorbed
 * instead of triggering a redundant elevated install.
 */
export function windowsManagedNetworkStatusAllowsEntryV1(
  status: WindowsManagedNetworkSetupStatusV1,
): boolean {
  return (
    status.state === 'ready' ||
    status.state === 'runner_unavailable' ||
    status.state === 'unsupported'
  );
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface WindowsManagedNetworkSetupDependenciesV1 {
  platform?: NodeJS.Platform;
  resolveRunner?: typeof resolveWindowsSandboxRunnerV1;
  run?: (argv: string[]) => Promise<CommandResult>;
}

async function runCommand(argv: string[]): Promise<CommandResult> {
  const child = Bun.spawn(argv, {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** Read-only readiness probe. This path never elevates or mutates Windows. */
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
  const result = await (dependencies.run ?? runCommand)([runner.path, '--managed-network-status']);
  if (result.exitCode !== 0) {
    return {
      version: 1,
      state: 'invalid',
      reason: result.stderr.trim() || `managed_network_status_exit_${result.exitCode}`,
    };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(result.stdout);
  } catch {
    return { version: 1, state: 'invalid', reason: 'managed_network_status_invalid' };
  }
  const parsed = NATIVE_STATUS_SCHEMA.safeParse(decoded);
  if (!parsed.success) {
    return { version: 1, state: 'invalid', reason: 'managed_network_status_invalid' };
  }
  return parsed.data;
}

/**
 * Explicit one-time onboarding action. The native orchestrator may display a
 * single UAC prompt; ordinary Shell execution never calls this function.
 */
export async function setupWindowsManagedNetworkV1(
  dependencies: WindowsManagedNetworkSetupDependenciesV1 = {},
): Promise<WindowsManagedNetworkSetupStatusV1> {
  if ((dependencies.platform ?? process.platform) !== 'win32') {
    throw new Error('Windows managed-network setup is only available on Windows.');
  }
  const runner = (dependencies.resolveRunner ?? resolveWindowsSandboxRunnerV1)();
  if (!runner) throw new Error('The pinned Windows sandbox runner is unavailable.');
  const result = await (dependencies.run ?? runCommand)([runner.path, '--setup-managed-network']);
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || `Windows managed-network setup exited with code ${result.exitCode}.`,
    );
  }
  const status = await resolveWindowsManagedNetworkSetupStatusV1({
    ...dependencies,
    platform: 'win32',
  });
  if (status.state !== 'ready') {
    throw new Error(`Windows managed-network setup did not become ready: ${status.reason}`);
  }
  return status;
}
