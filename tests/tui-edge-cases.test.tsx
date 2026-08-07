import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import CtrlSafeTextInput from '../src/app/tui/components/CtrlSafeTextInput';

async function wait(ms = 30) {
  await new Promise((r) => setTimeout(r, ms));
}

async function pressKeys(
  stdin: { write: (data: string) => void },
  seq: string,
  count = 1,
  ms = 30,
) {
  for (let i = 0; i < count; i++) {
    stdin.write(seq);
    await wait(ms);
  }
}

describe('CtrlSafeTextInput edge cases', () => {
  test('handles explicit newlines with empty lines', () => {
    const value = 'abc\n\nghi';
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 20,
      }),
    );

    const lines = (lastFrame() ?? '').split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('abc');
    expect(lines[2]).toContain('ghi');
  });

  test('handles single character wider than maxWidth', () => {
    const value = '中';
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 1,
      }),
    );

    const lines = (lastFrame() ?? '').split('\n');
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('中');
  });

  test('handles mask with soft wrap', () => {
    const value = '一二三四五六七八九十';
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        mask: '*',
        maxWidth: 10,
      }),
    );

    const lines = (lastFrame() ?? '').split('\n');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toMatch(/\*+/);
  });

  test('handles emoji width', () => {
    const value = '🎉🎉🎉🎉🎉';
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 4,
      }),
    );

    const lines = (lastFrame() ?? '').split('\n');
    expect(lines.length).toBeGreaterThan(0);
  });

  test('Shift+Enter inserts newline at cursor position, not at end', async () => {
    let currentValue = 'abcdef';
    let lastOnChangeValue = '';
    const onChange = (v: string) => {
      currentValue = v;
      lastOnChangeValue = v;
    };
    const { lastFrame, stdin, rerender } = render(
      React.createElement(CtrlSafeTextInput, {
        value: currentValue,
        onChange,
        focus: true,
        showCursor: true,
        maxWidth: 20,
      }),
    );

    // Move cursor left 3 positions: from end (6) to 3 (after "c").
    await pressKeys(stdin, '\x1b[D', 3);

    // Send Kitty protocol Shift+Enter: \x1b[13;2u
    await pressKeys(stdin, '\x1b[13;2u', 1);
    // Wait for kitty protocol sequence to be flushed (App waits ~20ms)
    await wait(50);

    // onChange should have been called with newline at cursor position 3
    expect(lastOnChangeValue).toBe('abc\ndef');

    // Re-render with updated value so CtrlSafeTextInput picks up the new prop
    rerender(
      React.createElement(CtrlSafeTextInput, {
        value: currentValue,
        onChange,
        focus: true,
        showCursor: true,
        maxWidth: 20,
      }),
    );

    // Verify visual output: 2 lines, "abc" on line 1, "def" on line 2
    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('abc');
    expect(lines[1]).toContain('def');
  });
});
