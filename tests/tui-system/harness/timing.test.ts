import { describe, expect, test } from 'bun:test';
import { nestedTuiDeadlineBudget, tuiWaitTimeout } from './timing';

describe('TUI timeout budgets', () => {
  test('scales shared CI waits with a bounded multiplier', () => {
    expect(tuiWaitTimeout(100, { CI: 'true' })).toBe(150);
    expect(tuiWaitTimeout(100, { KITE_TUI_TEST_TIMEOUT_SCALE: '9' })).toBe(300);
  });

  test('keeps journey before Bun test before file timeout', () => {
    expect(
      nestedTuiDeadlineBudget({
        fileTimeoutMs: 240_000,
        requestedBunTestTimeoutMs: 170_000,
        requestedJourneyDeadlineMs: 165_000,
        fileTeardownMarginMs: 10_000,
        testTeardownMarginMs: 5_000,
      }),
    ).toEqual({ bunTestTimeoutMs: 170_000, journeyDeadlineMs: 165_000 });
    expect(
      nestedTuiDeadlineBudget({
        fileTimeoutMs: 20_000,
        requestedBunTestTimeoutMs: 170_000,
        requestedJourneyDeadlineMs: 165_000,
        fileTeardownMarginMs: 10_000,
        testTeardownMarginMs: 5_000,
      }),
    ).toEqual({ bunTestTimeoutMs: 10_000, journeyDeadlineMs: 5_000 });
  });

  test('rejects a custom file timeout that cannot preserve cleanup margins', () => {
    expect(() =>
      nestedTuiDeadlineBudget({
        fileTimeoutMs: 15_999,
        requestedBunTestTimeoutMs: 170_000,
        requestedJourneyDeadlineMs: 165_000,
        fileTeardownMarginMs: 10_000,
        testTeardownMarginMs: 5_000,
      }),
    ).toThrow('at least 16000ms');
  });
});
