import { randomUUID } from 'node:crypto';

export interface RuntimeCommandIdAllocator {
  next(): string;
}

/** App-owned entropy source for one logical Runtime mutation. */
export function createRuntimeCommandIdAllocator(
  allocate: () => string = randomUUID,
): RuntimeCommandIdAllocator {
  return Object.freeze({
    next(): string {
      const identity = allocate();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(identity)) {
        throw new Error('Runtime command identity source returned an invalid identifier.');
      }
      return `command_${identity}`;
    },
  });
}
