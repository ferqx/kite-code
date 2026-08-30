import { describe, expect, test } from 'bun:test';
import { resolveReadinessForwarding } from '../../scripts/release/stable-launcher-contract';

const managedCompanions = [
  ['kite-service', 'service', 'KITE_SERVICE_READINESS_FD'],
  ['kite-coordinator', 'coordinator', 'KITE_COORDINATOR_READY_FD'],
  ['kite-worker', 'worker', 'KITE_WORKER_READY_FD'],
  ['kite-web-gateway', 'web-gateway', 'KITE_WEB_GATEWAY_READY_FD'],
] as const;

describe('stable release launcher readiness forwarding', () => {
  for (const [executable, command, environmentVariable] of managedCompanions) {
    test(`forwards fd 3 for exact ${command} run`, () => {
      expect(
        resolveReadinessForwarding(executable, [command, 'run'], {
          [environmentVariable]: '3',
        }),
      ).toEqual({ environmentVariable, fd: 3 });
      expect(
        resolveReadinessForwarding(`${executable}.exe`, [command, 'run'], {
          [environmentVariable]: '3',
        }),
      ).toEqual({ environmentVariable, fd: 3 });
    });

    test(`rejects unknown or duplicate ${command} launcher arguments`, () => {
      const environment = { [environmentVariable]: '3' };
      expect(() => resolveReadinessForwarding(executable, [], environment)).toThrow('exact');
      expect(() =>
        resolveReadinessForwarding(executable, [command, 'run', 'run'], environment),
      ).toThrow('exact');
      expect(() => resolveReadinessForwarding(executable, ['wrong', 'run'], environment)).toThrow(
        'exact',
      );
    });

    test(`rejects ${command} launch without manager-owned fd 3`, () => {
      expect(() => resolveReadinessForwarding(executable, [command, 'run'], {})).toThrow('fd 3');
      expect(() =>
        resolveReadinessForwarding(executable, [command, 'run'], {
          [environmentVariable]: '4',
        }),
      ).toThrow('fd 3');
    });
  }

  test('leaves CLI and TUI argument handling outside the managed process gate', () => {
    expect(resolveReadinessForwarding('kite', ['--help'], {})).toBeUndefined();
    expect(resolveReadinessForwarding('kite-tui', ['--version'], {})).toBeUndefined();
  });
});
