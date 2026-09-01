import { describe, expect, test } from 'bun:test';
import {
  formatServiceBuildDriftWarning,
  formatServiceRuntimeStatus,
  hasServiceBuildDrift,
  serviceRuntimeVersionStatus,
} from '../src/tui/service-runtime-status';

const current = {
  pid: 1234,
  startedAt: '2026-08-31T15:00:00.000Z',
  buildId: 'dev:current',
  clientVersion: '0.1.0',
  serviceVersion: '0.1.0',
  expectedBuildId: 'dev:current',
};
const labels = {
  pid: 'Service PID',
  startedAt: 'Started',
  buildId: 'Build',
  expectedBuildId: 'Expected',
  clientVersion: 'Client version',
  serviceVersion: 'Service version',
  versionStatus: 'Version status',
  aligned: 'Aligned',
  sourceBuildDrift: 'Explicit shared development Service differs from this source build.',
  buildMismatch: 'Build mismatch; restart the installed client.',
};

describe('TUI Local Service status presentation', () => {
  test('shows the exact process and build identity without a false drift warning', () => {
    expect(hasServiceBuildDrift(current)).toBe(false);
    expect(formatServiceBuildDriftWarning(current, 'warning')).toBeNull();
    expect(formatServiceRuntimeStatus(current, labels)).toBe(
      [
        '  ⎿  Service PID: 1234',
        '     Started: 2026-08-31T15:00:00.000Z',
        '     Build: dev:current',
        '     Expected: dev:current',
        '     Client version: 0.1.0',
        '     Service version: 0.1.0',
        '     Version status: Aligned',
      ].join('\n'),
    );
  });

  test('makes a resident source build mismatch explicit and actionable', () => {
    const drifted = { ...current, buildId: 'dev:resident' };
    expect(hasServiceBuildDrift(drifted)).toBe(true);
    expect(serviceRuntimeVersionStatus(drifted)).toBe('source_build_drift');
    expect(formatServiceBuildDriftWarning(drifted, labels.sourceBuildDrift)).toContain(
      'Explicit shared development Service',
    );
    expect(formatServiceRuntimeStatus(drifted, labels)).toContain(
      'Explicit shared development Service differs from this source build.',
    );
  });

  test('does not present an installed or mixed-mode mismatch as source drift', () => {
    const installed = {
      ...current,
      buildId: '1'.repeat(24),
      expectedBuildId: '2'.repeat(24),
    };
    expect(serviceRuntimeVersionStatus(installed)).toBe('build_mismatch');
    expect(hasServiceBuildDrift(installed)).toBe(false);
    expect(formatServiceBuildDriftWarning(installed, 'source warning')).toBeNull();
    expect(formatServiceRuntimeStatus(installed, labels)).toContain(
      'Build mismatch; restart the installed client.',
    );
    const mixed = { ...current, buildId: '1'.repeat(24), expectedBuildId: 'dev:current' };
    expect(serviceRuntimeVersionStatus(mixed)).toBe('build_mismatch');
    expect(hasServiceBuildDrift(mixed)).toBe(false);
  });
});
