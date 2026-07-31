import { describe, expect, test } from 'bun:test';
import { formatLocalDateTime } from '../src/core/persistence/sessions';

describe('formatLocalDateTime', () => {
  test('uses a stable local YYYY-MM-DD HH:mm:ss format', () => {
    const localTimestamp = new Date(2026, 6, 30, 9, 10, 49).getTime() / 1000;

    expect(formatLocalDateTime(localTimestamp)).toBe('2026-07-30 09:10:49');
  });

  test('uses the unknown fallback for an invalid timestamp', () => {
    expect(formatLocalDateTime(Number.NaN)).toBe('(unknown)');
  });
});
