import { randomUUID } from 'node:crypto';

export interface RuntimeClock {
  now(): number;
}

export interface RuntimeIdGenerator {
  next(): string;
}

export const systemRuntimeClock: RuntimeClock = Object.freeze({
  now: Date.now,
});

export const systemRuntimeIdGenerator: RuntimeIdGenerator = Object.freeze({
  next: randomUUID,
});

export function createDeterministicClock(initialNow = 0): RuntimeClock & {
  advance(ms: number): void;
  set(now: number): void;
} {
  let current = initialNow;
  return {
    now: () => current,
    advance(ms: number) {
      if (!Number.isFinite(ms) || ms < 0) throw new Error('Clock advance must be non-negative.');
      current += ms;
    },
    set(now: number) {
      if (!Number.isFinite(now)) throw new Error('Clock value must be finite.');
      current = now;
    },
  };
}

export function createDeterministicIdGenerator(
  prefix = 'test',
  initialSequence = 0,
): RuntimeIdGenerator {
  let sequence = initialSequence;
  return {
    next: () => `${prefix}-${sequence++}`,
  };
}
