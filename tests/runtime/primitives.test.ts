import { describe, expect, test } from 'bun:test';
import {
  createDeterministicClock,
  createDeterministicIdGenerator,
} from '@/core/runtime/primitives';

describe('deterministic runtime primitives', () => {
  test('advances time only when instructed', () => {
    const clock = createDeterministicClock(1_000);
    expect(clock.now()).toBe(1_000);
    clock.advance(25);
    expect(clock.now()).toBe(1_025);
    clock.set(2_000);
    expect(clock.now()).toBe(2_000);
  });

  test('emits reproducible invocation identities', () => {
    const ids = createDeterministicIdGenerator('invocation', 7);
    expect([ids.next(), ids.next()]).toEqual(['invocation-7', 'invocation-8']);
  });
});
