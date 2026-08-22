import { describe, expect, test } from 'bun:test';
import { SessionMailbox } from '../src/session-mailbox';
import { SessionRegistry } from '../src/session-registry';
import { deferred } from './helpers';

describe('SessionMailbox', () => {
  test('preserves FIFO and continues after a failed operation', async () => {
    const mailbox = new SessionMailbox();
    const gate = deferred();
    const order: string[] = [];
    const first = mailbox.run(async () => {
      order.push('first:start');
      await gate.promise;
      order.push('first:fail');
      throw new Error('expected failure');
    });
    const second = mailbox.run(async () => {
      order.push('second');
      return 2;
    });
    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    gate.resolve();
    await expect(first).rejects.toThrow('expected failure');
    expect(await second).toBe(2);
    expect(order).toEqual(['first:start', 'first:fail', 'second']);
  });

  test('returns one stable mailbox per session and isolates sessions', () => {
    const registry = new SessionRegistry();
    expect(registry.mailbox('a')).toBe(registry.mailbox('a'));
    expect(registry.mailbox('a')).not.toBe(registry.mailbox('b'));
  });
});
