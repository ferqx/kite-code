import { describe, expect, test } from 'bun:test';
import {
  expectTextAbsentFor,
  waitForAnyText,
  waitForCondition,
  waitForOutputQuiescence,
} from './terminal-screen';

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
