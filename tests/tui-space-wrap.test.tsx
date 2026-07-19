import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import CtrlSafeTextInput from '../src/app/tui/components/CtrlSafeTextInput';

describe('CtrlSafeTextInput space wrapping', () => {
  test('fills line when ASCII digits are followed by space and CJK', () => {
    const value = '2222222222 啊实打实的按时按时sad按时打撒撒撒';
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 30,
      }),
    );

    const lines = (lastFrame() ?? '').split('\n');
    expect(lines[0]).toContain('啊');
  });

  test('fills line when ASCII digits are followed by space, digit, and CJK', () => {
    const value =
      '22222222222 2是啊大叔大婶打撒是多少啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊';
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 30,
      }),
    );

    const lines = (lastFrame() ?? '').split('\n');
    console.log('JSON lines:');
    lines.forEach((l, i) => {
      console.log(`${i}: ${JSON.stringify(l)} (length=${l.length})`);
    });
    expect(lines[0]).toContain('是');
  });

  test('breaks at space between ASCII words', () => {
    const value = 'hello world';
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 8,
      }),
    );

    const lines = (lastFrame() ?? '').split('\n');
    expect(lines[0]).toBe('hello');
    expect(lines[1]).toBe('world');
  });

  test('fills line when CJK is followed by space and ASCII', () => {
    const value = '按时打算打 hello world';
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
    expect(lines[0]).toContain('按时打算打');
    expect(lines.length).toBeGreaterThan(1);
  });
});
