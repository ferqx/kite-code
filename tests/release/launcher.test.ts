import { describe, expect, test } from 'bun:test';
import { resolveReadinessForwarding } from '../../scripts/release/stable-launcher-contract';

describe('stable release launcher readiness forwarding', () => {
  test('forwards fd 3 only for the exact single-Service child entry', () => {
    const environment = { KITE_SERVICE_READINESS_FD: '3' };
    expect(
      resolveReadinessForwarding('kite-service', ['service', 'run-single'], environment),
    ).toEqual({ environmentVariable: 'KITE_SERVICE_READINESS_FD', fd: 3 });
    expect(
      resolveReadinessForwarding('kite-service.exe', ['service', 'run-single'], environment),
    ).toEqual({ environmentVariable: 'KITE_SERVICE_READINESS_FD', fd: 3 });
  });

  test('rejects unknown or duplicate Service launcher arguments', () => {
    const environment = { KITE_SERVICE_READINESS_FD: '3' };
    expect(() => resolveReadinessForwarding('kite-service', [], environment)).toThrow('exact');
    expect(() =>
      resolveReadinessForwarding(
        'kite-service',
        ['service', 'run-single', 'run-single'],
        environment,
      ),
    ).toThrow('exact');
    expect(() =>
      resolveReadinessForwarding('kite-service', ['service', 'run'], environment),
    ).toThrow('exact');
  });

  test('rejects Service launch without manager-owned fd 3', () => {
    expect(() => resolveReadinessForwarding('kite-service', ['service', 'run-single'], {})).toThrow(
      'fd 3',
    );
    expect(() =>
      resolveReadinessForwarding('kite-service', ['service', 'run-single'], {
        KITE_SERVICE_READINESS_FD: '4',
      }),
    ).toThrow('fd 3');
  });

  test('leaves CLI, TUI and retired companion names outside the managed process gate', () => {
    expect(resolveReadinessForwarding('kite', ['--help'], {})).toBeUndefined();
    expect(resolveReadinessForwarding('kite-tui', ['--version'], {})).toBeUndefined();
    expect(
      resolveReadinessForwarding('kite-coordinator', ['coordinator', 'run'], {}),
    ).toBeUndefined();
    expect(resolveReadinessForwarding('kite-worker', ['worker', 'run'], {})).toBeUndefined();
    expect(
      resolveReadinessForwarding('kite-web-gateway', ['web-gateway', 'run'], {}),
    ).toBeUndefined();
  });
});
