import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import CtrlSafeTextInput from '../apps/kite/src/tui/components/CtrlSafeTextInput';

describe('CtrlSafeTextInput user scenario', () => {
  test('fills remaining space on a long digit line with CJK', () => {
    // Simulate a typical wide terminal: 80 cols, prompt "❯ " = 2 cols,
    // input max width 78, effective width 77 with cursor reserve.
    const digits = '2'.repeat(69); // 69 cols of digits
    const cjk = '啊实打实的阿萨德'; // 8 CJK = 16 cols
    const value = digits + cjk;
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 78,
      }),
    );

    const lines = (lastFrame() ?? '').split('\n');

    // First line should contain as many digits as fit plus any CJK that fits,
    // instead of leaving the remaining space empty and putting all CJK below.
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines[0]!).toMatch(/^2+[\u4e00-\u9fff]*$/);
    expect(lines[0]!.length).toBeGreaterThan(digits.length);
  });
});
