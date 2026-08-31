import { describe, expect, test } from 'bun:test';
import {
  formatServiceBuildDriftWarning,
  formatServiceRuntimeStatus,
  hasServiceBuildDrift,
} from '../src/tui/service-runtime-status';

const current = {
  pid: 1234,
  startedAt: '2026-08-31T15:00:00.000Z',
  buildId: 'dev:current',
  expectedBuildId: 'dev:current',
};
const labels = {
  pid: 'Service PID',
  startedAt: 'Started',
  buildId: 'Build',
  expectedBuildId: 'Expected',
  driftWarning: 'Warning: resident Service build differs; run `bun run tui:fresh`.',
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
      ].join('\n'),
    );
  });

  test('makes a resident source build mismatch explicit and actionable', () => {
    const drifted = { ...current, buildId: 'dev:resident' };
    expect(hasServiceBuildDrift(drifted)).toBe(true);
    expect(formatServiceBuildDriftWarning(drifted, labels.driftWarning)).toContain(
      'bun run tui:fresh',
    );
    expect(formatServiceRuntimeStatus(drifted, labels)).toContain(
      'Warning: resident Service build differs; run `bun run tui:fresh`.',
    );
  });
});
