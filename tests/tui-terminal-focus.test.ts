import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { type TerminalFocusOutput, TerminalFocusStore } from '@/app/tui/hooks/terminal-focus-store';

class FocusInput extends EventEmitter {
  physicalListenerCount(): number {
    return this.listenerCount('data');
  }
}

describe('TerminalFocusStore', () => {
  test('multiplexes any number of subscribers through one stdin listener', () => {
    const input = new FocusInput();
    const writes: string[] = [];
    const output: TerminalFocusOutput = { write: (value) => writes.push(value) };
    const store = new TerminalFocusStore(input, output);
    let notifications = 0;
    const unsubscribers = Array.from({ length: 32 }, () =>
      store.subscribe(() => {
        notifications += 1;
      }),
    );

    expect(input.physicalListenerCount()).toBe(1);
    expect(store.diagnostics()).toEqual({
      subscriberCount: 32,
      inputListenerAttached: true,
    });
    input.emit('data', Buffer.from('\x1b[O'));
    expect(store.getSnapshot()).toBe(false);
    expect(notifications).toBe(32);

    for (const unsubscribe of unsubscribers.slice(0, -1)) unsubscribe();
    expect(input.physicalListenerCount()).toBe(1);
    unsubscribers.at(-1)?.();
    expect(input.physicalListenerCount()).toBe(0);
    expect(store.diagnostics()).toEqual({
      subscriberCount: 0,
      inputListenerAttached: false,
    });
    expect(writes).toEqual(['\x1b[?1004h', '\x1b[?1004l']);
  });

  test('ignores duplicate focus reports without notifying subscribers', () => {
    const input = new FocusInput();
    const store = new TerminalFocusStore(input, { write: () => {} });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    input.emit('data', Buffer.from('\x1b[I'));
    input.emit('data', Buffer.from('ordinary input'));
    expect(notifications).toBe(0);
    input.emit('data', Buffer.from('\x1b[O'));
    input.emit('data', Buffer.from('\x1b[O'));
    expect(notifications).toBe(1);
    unsubscribe();
  });
});
