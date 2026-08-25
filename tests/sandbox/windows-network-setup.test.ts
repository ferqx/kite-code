import { describe, expect, test } from 'bun:test';
import {
  resolveWindowsManagedNetworkSetupStatus,
  setupWindowsManagedNetwork,
} from '@kite/builtin-runtime/sandbox';

const runner = () =>
  ({ path: 'C:\\kite-windows-runner.exe' }) as NonNullable<
    ReturnType<typeof import('@kite/builtin-runtime/sandbox').resolveWindowsSandboxRunner>
  >;

describe('Windows approved-network execution', () => {
  test('uses the current-user restricted token without a setup command or persistent identity', async () => {
    const status = await resolveWindowsManagedNetworkSetupStatus({
      platform: 'win32',
      resolveRunner: runner,
    });
    expect(status).toEqual({
      version: 1,
      state: 'ready',
      reason: 'current_user_restricted_token',
    });
  });

  test('legacy setup command is a non-elevated compatibility no-op', async () => {
    await expect(
      setupWindowsManagedNetwork({ platform: 'win32', resolveRunner: runner }),
    ).resolves.toMatchObject({ state: 'ready', reason: 'current_user_restricted_token' });
  });

  test('non-Windows status is unsupported without resolving a runner', async () => {
    let resolved = false;
    const status = await resolveWindowsManagedNetworkSetupStatus({
      platform: 'linux',
      resolveRunner: () => {
        resolved = true;
        return null;
      },
    });
    expect(status.state).toBe('unsupported');
    expect(resolved).toBeFalse();
  });
});
