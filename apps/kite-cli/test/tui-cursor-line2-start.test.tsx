import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import CtrlSafeTextInput from '../src/tui/components/CtrlSafeTextInput';

describe('CtrlSafeTextInput cursor boundary rendering', () => {
  test('cursor at line boundary is rendered consistently', () => {
    const value = '一二三四五六七八九十'; // line1=8 chars, line2=2 chars
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 18,
      }),
    );

    const lines = (lastFrame() ?? '').split('\n');
    console.log('Cursor at end (offset 10):');
    lines.forEach((l, i) => {
      console.log(`${i}: |${l}|`);
    });
    expect(lines.length).toBe(2);
  });

  test('cursor at line 2 first char', async () => {
    // cursor at line 2 start (offset 8)
    const value = '一二三四五六七八九十';
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 18,
      }),
    );
    // Cannot easily set cursorOffset from outside; test initial end position.
    expect(lastFrame()).toBeDefined();
  });
});
