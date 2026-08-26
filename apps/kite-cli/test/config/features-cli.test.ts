import { describe, expect, test } from 'bun:test';
import { parseArgs } from '#kite-cli/cli/index';

describe('CLI feature override parsing', () => {
  test('rejects legacy feature overrides after Service cutover', () => {
    expect(() =>
      parseArgs(['run', '--feature', 'autoReview=false', '--feature', 'loopMode']),
    ).toThrow("Unsupported CLI option '--feature'");
  });

  test('keeps the explicit telemetry status query while rejecting feature mutation', () => {
    expect(() => parseArgs(['run', '--feature', 'executionBoundary'])).toThrow(
      "Unsupported CLI option '--feature'",
    );
    expect(parseArgs(['run', '--telemetry-status']).telemetryStatus).toBe(true);
  });
});
