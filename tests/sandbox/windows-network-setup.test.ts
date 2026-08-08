import { describe, expect, test } from 'bun:test';
import {
  resolveWindowsManagedNetworkSetupStatusV1,
  setupWindowsManagedNetworkV1,
  windowsManagedNetworkStatusAllowsEntryV1,
} from '@/core/sandbox/windows-network-setup';

const runner = () =>
  ({ path: 'C:\\kite-windows-runner.exe' }) as NonNullable<
    ReturnType<typeof import('@/core/sandbox/windows-runner').resolveWindowsSandboxRunnerV1>
  >;

describe('Windows managed-network onboarding', () => {
  test('status probe is read-only and uses the dedicated native command', async () => {
    const calls: string[][] = [];
    const status = await resolveWindowsManagedNetworkSetupStatusV1({
      platform: 'win32',
      resolveRunner: runner,
      run: async (argv) => {
        calls.push(argv);
        return {
          exitCode: 0,
          stdout: '{"version":1,"state":"missing","reason":"managed_network_setup_required"}',
          stderr: '',
        };
      },
    });
    expect(status.state).toBe('missing');
    expect(calls).toEqual([['C:\\kite-windows-runner.exe', '--managed-network-status']]);
  });

  test('setup is explicit and verifies readiness after the elevated orchestrator exits', async () => {
    const calls: string[][] = [];
    const status = await setupWindowsManagedNetworkV1({
      platform: 'win32',
      resolveRunner: runner,
      run: async (argv) => {
        calls.push(argv);
        return argv[1] === '--setup-managed-network'
          ? { exitCode: 0, stdout: '', stderr: '' }
          : {
              exitCode: 0,
              stdout: '{"version":1,"state":"ready","reason":"managed_network_ready"}',
              stderr: '',
            };
      },
    });
    expect(status.state).toBe('ready');
    expect(calls.map((call) => call[1])).toEqual([
      '--setup-managed-network',
      '--managed-network-status',
    ]);
  });

  test('ordinary status failures never fall through to setup', async () => {
    const calls: string[][] = [];
    const status = await resolveWindowsManagedNetworkSetupStatusV1({
      platform: 'win32',
      resolveRunner: runner,
      run: async (argv) => {
        calls.push(argv);
        return { exitCode: 1, stdout: '', stderr: 'status failed' };
      },
    });
    expect(status).toEqual({ version: 1, state: 'invalid', reason: 'status failed' });
    expect(calls).toHaveLength(1);
  });

  test('non-Windows status is unsupported without resolving a runner', async () => {
    let resolved = false;
    const status = await resolveWindowsManagedNetworkSetupStatusV1({
      platform: 'linux',
      resolveRunner: () => {
        resolved = true;
        return null;
      },
    });
    expect(status.state).toBe('unsupported');
    expect(resolved).toBeFalse();
  });

  test('entry predicate admits ready and unavailable backends but never setup-pending states', () => {
    const status = (
      state: 'unsupported' | 'runner_unavailable' | 'ready' | 'missing' | 'invalid',
    ) => ({
      version: 1 as const,
      state,
      reason: '',
    });
    // A concurrent instance that finished setup must be absorbed silently.
    expect(windowsManagedNetworkStatusAllowsEntryV1(status('ready'))).toBeTrue();
    // Nothing to install when the backend itself is unavailable.
    expect(windowsManagedNetworkStatusAllowsEntryV1(status('runner_unavailable'))).toBeTrue();
    expect(windowsManagedNetworkStatusAllowsEntryV1(status('unsupported'))).toBeTrue();
    // Setup-pending states keep the interactive choice.
    expect(windowsManagedNetworkStatusAllowsEntryV1(status('missing'))).toBeFalse();
    expect(windowsManagedNetworkStatusAllowsEntryV1(status('invalid'))).toBeFalse();
  });
});
