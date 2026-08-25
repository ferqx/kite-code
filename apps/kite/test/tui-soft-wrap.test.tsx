import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import CtrlSafeTextInput from '../src/tui/components/CtrlSafeTextInput';

describe('CtrlSafeTextInput soft wrap', () => {
  test('wraps long CJK text to multiple lines when maxWidth is provided', () => {
    const value = '这是一段很长的中文文本用于测试自动换行';
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 20,
      }),
    );

    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    expect(frame).toContain('这是一段很长的中文');
    expect(frame).toContain('文本用于测试自动换');
    expect(frame).toContain('行');
  });

  test('wraps long mixed text at word boundaries when possible', () => {
    const value = 'This is a long English sentence mixed with 中文文本';
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 25,
      }),
    );

    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    // Pure ASCII word boundaries are respected; mixed CJK/ASCII boundaries
    // are allowed to fill the line instead of breaking early.
    expect(frame).toContain('This is a long English');
  });

  test('does not wrap when text fits within maxWidth', () => {
    const value = 'short';
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 80,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame.split('\n').length).toBe(1);
    expect(frame).toContain('short');
  });

  test('preserves explicit newlines while also soft-wrapping long lines', () => {
    const value =
      '第一行这是一段很长的中文文本用于测试自动换行\n第二行这也是一段很长的中文文本用于测试';
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 20,
      }),
    );

    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    expect(lines.length).toBeGreaterThan(2);
    expect(frame).toContain('第一行这是一段很长');
    expect(frame).toContain('第二行这也是一段很');
  });

  test('cursor is rendered on the correct wrapped line', () => {
    const value = 'abcdefghij';
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 5,
      }),
    );

    const frame = lastFrame() ?? '';
    // Cursor at the end means the last line contains the inverse cursor marker.
    // chalk.inverse renders as ANSI escapes, but the last visible char should be "j".
    const lines = frame.split('\n');
    expect(lines[lines.length - 1]).toContain('j');
  });

  test('reserves one column for the end-of-line cursor', () => {
    // 9 CJK chars = 18 display columns, exactly fills a maxWidth of 18.
    // One column is reserved for the cursor block, so the last char moves to
    // the next line and the rendered width never exceeds maxWidth.
    const value = '一二三四五六七八九';
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 18,
      }),
    );

    const frame = lastFrame() ?? '';
    const lines = frame.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('一二三四五六七八');
    expect(lines[1]).toContain('九');
  });
});
