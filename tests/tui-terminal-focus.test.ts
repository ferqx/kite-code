import { describe, expect, test } from 'bun:test';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { createElement } from 'react';
import { type TerminalFocusOutput, TerminalFocusStore } from '@/app/tui/hooks/terminal-focus-store';
import { useTerminalFocus } from '@/app/tui/hooks/useTerminalFocus';

describe('TerminalFocusStore', () => {
  test('multiplexes subscribers without attaching a competing stdin data listener', () => {
    const writes: string[] = [];
    const output: TerminalFocusOutput = { write: (value) => writes.push(value) };
    const store = new TerminalFocusStore(output);
    let notifications = 0;
    const unsubscribers = Array.from({ length: 32 }, () =>
      store.subscribe(() => {
        notifications += 1;
      }),
    );

    expect(store.diagnostics()).toEqual({
      subscriberCount: 32,
      reportingEnabled: true,
    });
    store.handleInput('[O');
    expect(store.getSnapshot()).toBe(false);
    expect(notifications).toBe(32);

    for (const unsubscribe of unsubscribers.slice(0, -1)) unsubscribe();
    unsubscribers.at(-1)?.();
    expect(store.diagnostics()).toEqual({
      subscriberCount: 0,
      reportingEnabled: false,
    });
    expect(writes).toEqual(['\x1b[?1004h', '\x1b[?1004l']);
  });

  test('ignores duplicate focus reports without notifying subscribers', () => {
    const store = new TerminalFocusStore({ write: () => {} });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    store.handleInput('\x1b[I');
    store.handleInput('ordinary input');
    expect(notifications).toBe(0);
    store.handleInput('[O');
    store.handleInput('\x1b[O');
    expect(notifications).toBe(1);
    unsubscribe();
  });

  test('receives focus reports through Ink input and can recover after blur', async () => {
    function FocusProbe() {
      return createElement(Text, null, useTerminalFocus() ? 'focused' : 'blurred');
    }

    const view = render(createElement(FocusProbe));
    expect(view.lastFrame()).toContain('focused');

    view.stdin.write('\x1b[O');
    await Bun.sleep(10);
    expect(view.lastFrame()).toContain('blurred');

    view.stdin.write('\x1b[I');
    await Bun.sleep(10);
    expect(view.lastFrame()).toContain('focused');
    view.unmount();
  });
});
