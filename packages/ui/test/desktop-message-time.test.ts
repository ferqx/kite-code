import { expect, test } from 'bun:test';
import { formatMessageTime } from '../src/desktop/message-time';

test('message time uses local calendar dates, yesterday across midnight, and explicit older dates', () => {
  const now = new Date(2026, 9, 23, 0, 15).getTime();
  expect(formatMessageTime(new Date(2026, 9, 23, 0, 5).getTime(), now)?.label).toBe('00:05');
  expect(formatMessageTime(new Date(2026, 9, 22, 23, 50).getTime(), now)?.label).toBe('昨天 23:50');
  expect(formatMessageTime(new Date(2026, 9, 21, 9, 7).getTime(), now)?.label).toBe(
    '10月21日 09:07',
  );
  expect(formatMessageTime(new Date(2025, 9, 21, 9, 7).getTime(), now)?.label).toBe(
    '2025年10月21日 09:07',
  );
  expect(
    formatMessageTime(
      new Date(2025, 11, 31, 23, 59).getTime(),
      new Date(2026, 0, 1, 0, 1).getTime(),
    )?.label,
  ).toBe('昨天 23:59');
});

test('yesterday follows the local calendar across daylight saving and leap-day boundaries', () => {
  const now = new Date(2026, 2, 9, 0, 15).getTime();
  expect(formatMessageTime(new Date(2026, 2, 8, 0, 30).getTime(), now)?.label).toBe('昨天 00:30');
  expect(
    formatMessageTime(new Date(2024, 1, 29, 23, 59).getTime(), new Date(2024, 2, 1, 0, 1).getTime())
      ?.label,
  ).toBe('昨天 23:59');
});

test('full message time preserves the instant, seconds and historical local UTC offset; unknown stays unknown', () => {
  const date = new Date(2026, 9, 23, 11, 45, 37);
  const formatted = formatMessageTime(date.getTime(), date.getTime())!;
  expect(formatted.dateTime).toBe(date.toISOString());
  expect(formatted.full).toMatch(/^2026年10月23日 11:45:37（UTC[+-]\d\d:\d\d）$/);
  for (const missing of [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER,
  ])
    expect(formatMessageTime(missing, date.getTime())).toBeUndefined();
});
