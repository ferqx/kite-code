import { describe, expect, test } from 'bun:test';
import { softWrapLine, wrapDisplayLines } from '../apps/kite/src/tui/components/soft-wrap';

describe('soft wrap', () => {
  test('preserves word-boundary wrapping behavior', () => {
    expect(softWrapLine('alpha beta gamma', 10).map((line) => line.text)).toEqual([
      'alpha',
      'beta gamma',
    ]);
  });

  test('wraps a large single-line paste without losing its visual content', () => {
    const content = 'x'.repeat(31_519);
    const lines = wrapDisplayLines(content, 80);

    expect(lines).toHaveLength(Math.ceil(content.length / 80));
    expect(lines[0]).toBe('x'.repeat(80));
    expect(lines.at(-1)).toBe('x'.repeat(content.length % 80));
    expect(lines.join('')).toBe(content);
  });
});
