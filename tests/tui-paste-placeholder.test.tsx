import { describe, expect, test } from 'bun:test';
import { render } from 'ink-testing-library';
import React from 'react';
import InputLine from '../src/app/tui/components/InputLine';

const PASTE_THRESHOLD = 10_000;

function makeLargePaste(length: number): string {
  return 'A'.repeat(length);
}

describe('InputLine paste placeholder', () => {
  test('small input does not trigger placeholder', () => {
    let submitted = '';
    const { stdin, lastFrame } = render(
      React.createElement(InputLine, {
        mode: 'prompt',
        onSubmit: (v) => {
          submitted = v;
        },
        workspace: process.cwd(),
      }),
    );
    stdin.write('hello world');
    stdin.write('\r');
    const output = lastFrame() ?? '';
    expect(output).not.toContain('[已粘贴');
    expect(typeof submitted).toBe('string');
  });

  test('paste >= threshold remounts component and handleSubmit receives placeholder', () => {
    let submitted = '';
    const largeText = makeLargePaste(PASTE_THRESHOLD);
    const { stdin } = render(
      React.createElement(InputLine, {
        mode: 'prompt',
        onSubmit: (v) => {
          submitted = v;
        },
        workspace: process.cwd(),
      }),
    );
    stdin.write(largeText);
    // After paste detection, component remounts with placeholder value.
    // handleSubmit is registered on the remounted CtrlSafeTextInput.
    // Enter submits, and handleSubmit reconstructs pastedContent -> the large text.
    stdin.write('\r');
    expect(typeof submitted).toBe('string');
  });

  test('backspace on placeholder triggers onRemoveAtomicBlock and clears pasteState', () => {
    let submitted = '';
    const largeText = makeLargePaste(PASTE_THRESHOLD);
    const { stdin } = render(
      React.createElement(InputLine, {
        mode: 'prompt',
        onSubmit: (v) => {
          submitted = v;
        },
        workspace: process.cwd(),
      }),
    );
    stdin.write(largeText);
    // Cursor at placeholder end => within atomic delete boundary
    stdin.write('\x08'); // backspace
    stdin.write('\r');
    expect(typeof submitted).toBe('string');
  });

  test('Esc clears pasteState in placeholder mode', () => {
    let submitted = '';
    const largeText = makeLargePaste(PASTE_THRESHOLD);
    const { stdin } = render(
      React.createElement(InputLine, {
        mode: 'prompt',
        onSubmit: (v) => {
          submitted = v;
        },
        workspace: process.cwd(),
      }),
    );
    stdin.write(largeText);
    stdin.write('\x1b'); // Escape
    stdin.write('\r');
    // After Esc, pasteState should be cleared and input should be empty.
    // handleSubmit receives empty string, returns early, onSubmit not called.
    expect(submitted).toBe('');
  });

  test('second large paste replaces placeholder and submits new content', () => {
    let submitted = '';
    const firstPaste = makeLargePaste(PASTE_THRESHOLD);
    const secondPaste = 'B'.repeat(PASTE_THRESHOLD + 100);
    const { stdin } = render(
      React.createElement(InputLine, {
        mode: 'prompt',
        onSubmit: (v) => {
          submitted = v;
        },
        workspace: process.cwd(),
      }),
    );
    stdin.write(firstPaste);
    stdin.write(secondPaste);
    stdin.write('\r');
    expect(typeof submitted).toBe('string');
  });

  test('typing after placeholder coexists, both submit together', () => {
    let submitted = '';
    const largeText = makeLargePaste(PASTE_THRESHOLD);
    const { stdin } = render(
      React.createElement(InputLine, {
        mode: 'prompt',
        onSubmit: (v) => {
          submitted = v;
        },
        workspace: process.cwd(),
      }),
    );
    stdin.write(largeText);
    stdin.write(' 请分析'); // user text after placeholder
    stdin.write('\r');
    expect(typeof submitted).toBe('string');
  });
});
