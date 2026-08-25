import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import CtrlSafeTextInput from '../src/tui/components/CtrlSafeTextInput';

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

describe('CtrlSafeTextInput cursor across soft wrap', () => {
  test('layout is stable when moving cursor left across line boundary', async () => {
    const value = '一二三四五六七八九'; // 18 display columns
    const { lastFrame, stdin } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 18,
      }),
    );

    // Cursor at end: line 1 = 8 chars, line 2 = "九" + trailing cursor.
    let frame = lastFrame() ?? '';
    let lines = frame.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe('一二三四五六七八');
    expect(lines[1]).toContain('九');

    // Cursor on "九".
    await pressKeys(stdin, '\x1b[D', 1);
    frame = lastFrame() ?? '';
    lines = frame.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe('一二三四五六七八');
    expect(lines[1]).toContain('九');

    // Cursor on "八": layout stays two lines, no blank cursor line.
    await pressKeys(stdin, '\x1b[D', 1);
    frame = lastFrame() ?? '';
    lines = frame.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('八');
    expect(lines[1]).toBe('九');
  });

  test('layout is stable when moving cursor right across line boundary', async () => {
    const value = '一二三四五六七八九十'; // 20 display columns
    const { lastFrame, stdin } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 18,
      }),
    );

    // Move cursor to start of second visual line (index 8).
    await pressKeys(stdin, '\x1b[D', 20);
    await pressKeys(stdin, '\x1b[C', 8);

    let frame = lastFrame() ?? '';
    let lines = frame.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe('一二三四五六七八');
    expect(lines[1]).toContain('九十');

    // Move right: cursor over "九".
    await pressKeys(stdin, '\x1b[C', 1);
    frame = lastFrame() ?? '';
    lines = frame.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe('一二三四五六七八');
    expect(lines[1]).toContain('九十');

    // Move right: cursor at end.
    await pressKeys(stdin, '\x1b[C', 1);
    frame = lastFrame() ?? '';
    lines = frame.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe('一二三四五六七八');
    expect(lines[1]).toContain('九十');
  });

  test('up/down arrows move by visual wrapped lines', async () => {
    const value = '一二三四五六七八九十'; // 20 cols
    const { lastFrame, stdin } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 18,
        disableArrowNav: false,
      }),
    );

    // Cursor at end of second line (col 2 of line 2).
    await pressKeys(stdin, '\x1b[4~', 1, 50); // End key
    let frame = lastFrame() ?? '';
    let lines = frame.split('\n');
    expect(lines.length).toBe(2);

    // Up: should move to same column on first line (col 2).
    await pressKeys(stdin, '\x1b[A', 1);
    frame = lastFrame() ?? '';
    lines = frame.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('三'); // col 2 of line1 is "三"

    // Down: back to second line end.
    await pressKeys(stdin, '\x1b[B', 1);
    frame = lastFrame() ?? '';
    lines = frame.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain('十');
  });

  test('home/end move within current visual line', async () => {
    const value = '一二三四五六七八九十'; // line1=8 chars, line2=2 chars
    const { lastFrame, stdin } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 18,
        disableArrowNav: false,
      }),
    );

    // End -> then Up -> cursor at col 2 of line1.
    await pressKeys(stdin, '\x1b[4~', 1, 50);
    await pressKeys(stdin, '\x1b[A', 1);
    let frame = lastFrame() ?? '';
    let lines = frame.split('\n');
    expect(lines[0]).toContain('三');

    // Home -> start of line1.
    await pressKeys(stdin, '\x1b[1~', 1, 50);
    frame = lastFrame() ?? '';
    lines = frame.split('\n');
    expect(lines[0]).toContain('一');

    // End -> end of line1 (after "八").
    await pressKeys(stdin, '\x1b[4~', 1, 50);
    frame = lastFrame() ?? '';
    lines = frame.split('\n');
    expect(lines[0]).toContain('八');
  });

  test('cursor respects explicit newlines when moving up/down', async () => {
    const value = 'abc\ndefghi'; // explicit newline; second line wraps at maxWidth=6
    const { lastFrame, stdin } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 6,
        disableArrowNav: false,
      }),
    );

    // Visual lines: "abc", "def", "ghi"
    let frame = lastFrame() ?? '';
    let lines = frame.split('\n');
    expect(lines.length).toBe(3);

    // End then Up twice -> should land on line1.
    await pressKeys(stdin, '\x1b[4~', 1, 50);
    await pressKeys(stdin, '\x1b[A', 2);
    frame = lastFrame() ?? '';
    lines = frame.split('\n');
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('c');
  });

  test('backspace across soft wrap boundary merges lines without blank line', async () => {
    let currentValue = '一二三四五六七八九十'; // 20 cols
    const onChange = (v: string) => {
      currentValue = v;
    };
    const { lastFrame, stdin, rerender } = render(
      React.createElement(CtrlSafeTextInput, {
        value: currentValue,
        onChange,
        focus: true,
        showCursor: true,
        maxWidth: 18,
      }),
    );

    // Move cursor to start of second line (index 8).
    await pressKeys(stdin, '\x1b[D', 20);
    await pressKeys(stdin, '\x1b[C', 8);
    rerender(
      React.createElement(CtrlSafeTextInput, {
        value: currentValue,
        onChange,
        focus: true,
        showCursor: true,
        maxWidth: 18,
      }),
    );

    let frame = lastFrame() ?? '';
    let lines = frame.split('\n');
    expect(lines.length).toBe(2);

    // Backspace: removes "八", "九" moves to line1 end, "十" stays line2.
    await pressKeys(stdin, '\x7f', 1);
    rerender(
      React.createElement(CtrlSafeTextInput, {
        value: currentValue,
        onChange,
        focus: true,
        showCursor: true,
        maxWidth: 18,
      }),
    );

    frame = lastFrame() ?? '';
    lines = frame.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('七');
    expect(lines[1]).toContain('十');
  });
});
