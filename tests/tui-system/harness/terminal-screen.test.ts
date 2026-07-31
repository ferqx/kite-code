import { describe, expect, test } from 'bun:test';
import {
  createHeadlessTerminalScreen,
  expectTextAbsentFor,
  screenHasSessionRow,
  waitForAnyText,
  waitForCondition,
  waitForOutputQuiescence,
} from './terminal-screen';

describe('headless terminal screen', () => {
  test('applies cursor movement and erase sequences instead of retaining stale frames', async () => {
    const screen = createHeadlessTerminalScreen(20, 4);
    const mark = screen.mark();
    screen.append(new TextEncoder().encode('old session\r\n❯'));
    screen.append(new TextEncoder().encode('\x1b[2J\x1b[Hnew session\r\n❯'));
    await screen.settled();

    expect(screen.viewport()).toContain('new session');
    expect(screen.viewport()).not.toContain('old session');
    expect(screen.framesSince(mark).some((frame) => frame.includes('old session'))).toBe(true);
    expect(screen.framesSince(mark).at(-1)).toBe(screen.viewport());
    screen.dispose();
  });

  test('reassembles wrapped terminal rows into user-visible logical text', async () => {
    const screen = createHeadlessTerminalScreen(5, 3);
    screen.append(new TextEncoder().encode('abcdefgh'));
    await screen.settled();

    expect(screen.viewport()).toContain('abcdefgh');
    screen.dispose();
  });

  test('retains scrollback separately from the current viewport', async () => {
    const screen = createHeadlessTerminalScreen(20, 2);
    screen.append(new TextEncoder().encode('first\r\nsecond\r\nthird'));
    await screen.settled();

    expect(screen.viewport()).not.toContain('first');
    expect(screen.scrollback()).toContain('first');
    screen.dispose();
  });

  test('excludes queued pre-mark writes from frames captured after the mark', async () => {
    const screen = createHeadlessTerminalScreen(20, 2);
    screen.append(new TextEncoder().encode('before'));
    const mark = screen.mark();
    await screen.settled();

    expect(screen.framesSince(mark)).toEqual([]);

    screen.append(new TextEncoder().encode(' after'));
    await screen.settled();
    expect(screen.framesSince(mark)).toEqual(['before after']);
    screen.dispose();
  });

  test('fails closed when a frame mark predates the bounded history', async () => {
    const screen = createHeadlessTerminalScreen(20, 2, 2);
    const mark = screen.mark();
    screen.append(new TextEncoder().encode('one'));
    screen.append(new TextEncoder().encode('\rtwo'));
    screen.append(new TextEncoder().encode('\rthree'));
    await screen.settled();

    expect(() => screen.framesSince(mark)).toThrow('expired');
    screen.dispose();
  });
});

describe('terminal output quiescence', () => {
  test('waits through output changes and returns the settled frame', async () => {
    let output = 'frame-1';
    setTimeout(() => {
      output = 'frame-2';
    }, 10);
    setTimeout(() => {
      output = 'settled';
    }, 25);

    await expect(waitForOutputQuiescence(() => output, 250, 30)).resolves.toBe('settled');
  });

  test('returns an already settled frame after the quiet window', async () => {
    await expect(waitForOutputQuiescence(() => 'ready', 100, 20)).resolves.toBe('ready');
  });

  test('does not treat an empty post-action stream as successful output', async () => {
    await expect(waitForOutputQuiescence(() => '', 50, 10)).rejects.toThrow(
      'waiting for new terminal output',
    );
  });

  test('can explicitly observe silence when an action is not expected to render', async () => {
    await expect(waitForOutputQuiescence(() => '', 100, 20, false)).resolves.toBe('');
  });
});

describe('terminal condition helpers', () => {
  test('matches SessionSelector rows without accepting background conversation text', () => {
    const selector = [
      '❟ Message in session B',
      '╭───╮',
      '│ 会话列表 │',
      '│ 搜索: _ │',
      '│ > ● Message in session B  8/1/2026 │',
      '│     Message in session A  8/1/2026 │',
      '╰───╯',
    ].join('\n');

    expect(screenHasSessionRow(selector, 'Message in session B')).toBe(true);
    expect(
      screenHasSessionRow(selector, 'Message in session B', { selected: true, active: true }),
    ).toBe(true);
    expect(screenHasSessionRow(selector, 'Message in session A', { active: false })).toBe(true);
    expect(screenHasSessionRow(selector, 'Message in session A', { selected: true })).toBe(false);
    expect(screenHasSessionRow('会话列表\n❟ Message in session B', 'Message in session B')).toBe(
      false,
    );
    expect(screenHasSessionRow('│ Loading... │\n会话列表', 'Message in session B')).toBe(false);
  });

  test('waits for a non-terminal condition', async () => {
    let ready = false;
    setTimeout(() => {
      ready = true;
    }, 10);

    await expect(
      waitForCondition(() => ready, 'fixture readiness', 100, 10),
    ).resolves.toBeUndefined();
  });

  test('observes absence for the entire requested window', async () => {
    let output = 'waiting';
    setTimeout(() => {
      output = 'forbidden';
    }, 10);

    await expect(expectTextAbsentFor(() => output, 'forbidden', 100, 5)).rejects.toThrow(
      'to remain absent',
    );
  });

  test('returns when any expected terminal state appears', async () => {
    let output = 'waiting';
    setTimeout(() => {
      output = 'cancelled';
    }, 10);

    await expect(waitForAnyText(() => output, ['done', 'cancelled'], 100, 5)).resolves.toBe(
      'cancelled',
    );
  });
});
