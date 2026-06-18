import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import CtrlSafeTextInput from '../src/app/tui/components/CtrlSafeTextInput';

describe('CtrlSafeTextInput IME auto-space cleanup', () => {
  test('strips IME-leading space when switching from ASCII digits to CJK', async () => {
    let currentValue = '2222222222222';
    const onChange = (v: string) => {
      currentValue = v;
    };
    const { stdin, rerender } = render(
      React.createElement(CtrlSafeTextInput, {
        value: currentValue,
        onChange,
        focus: true,
        showCursor: true,
        maxWidth: 78,
      }),
    );

    stdin.write(' 是啊打撒的');
    await new Promise((r) => setTimeout(r, 30));

    rerender(
      React.createElement(CtrlSafeTextInput, {
        value: currentValue,
        onChange,
        focus: true,
        showCursor: true,
        maxWidth: 78,
      }),
    );

    expect(currentValue).toBe('2222222222222是啊打撒的');
  });

  test('strips IME-leading space when switching from CJK to ASCII digit', async () => {
    let currentValue = '啊实打实的';
    const onChange = (v: string) => {
      currentValue = v;
    };
    const { stdin, rerender } = render(
      React.createElement(CtrlSafeTextInput, {
        value: currentValue,
        onChange,
        focus: true,
        showCursor: true,
        maxWidth: 78,
      }),
    );

    stdin.write(' 2');
    await new Promise((r) => setTimeout(r, 30));

    rerender(
      React.createElement(CtrlSafeTextInput, {
        value: currentValue,
        onChange,
        focus: true,
        showCursor: true,
        maxWidth: 78,
      }),
    );

    expect(currentValue).toBe('啊实打实的2');
  });

  test('preserves an intentional single space between scripts', async () => {
    let currentValue = '啊实打实的';
    const onChange = (v: string) => {
      currentValue = v;
    };
    const { stdin, rerender } = render(
      React.createElement(CtrlSafeTextInput, {
        value: currentValue,
        onChange,
        focus: true,
        showCursor: true,
        maxWidth: 78,
      }),
    );

    stdin.write(' ');
    await new Promise((r) => setTimeout(r, 30));
    rerender(
      React.createElement(CtrlSafeTextInput, {
        value: currentValue,
        onChange,
        focus: true,
        showCursor: true,
        maxWidth: 78,
      }),
    );

    stdin.write('2');
    await new Promise((r) => setTimeout(r, 30));
    rerender(
      React.createElement(CtrlSafeTextInput, {
        value: currentValue,
        onChange,
        focus: true,
        showCursor: true,
        maxWidth: 78,
      }),
    );

    expect(currentValue).toBe('啊实打实的 2');
  });
});
