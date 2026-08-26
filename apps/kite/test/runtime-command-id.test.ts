import { describe, expect, test } from 'bun:test';
import { createRuntimeCommandIdAllocator } from '../src/runtime-client/command-id';

describe('Runtime command identity allocator', () => {
  test('allocates content-free identities from the injected entropy source', () => {
    const values = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const allocator = createRuntimeCommandIdAllocator(() => values.shift()!);

    expect(allocator.next()).toBe('command_11111111-1111-4111-8111-111111111111');
    expect(allocator.next()).toBe('command_22222222-2222-4222-8222-222222222222');
  });

  test('rejects malformed deterministic test sources', () => {
    const allocator = createRuntimeCommandIdAllocator(() => 'workspace:/private/secret');
    expect(() => allocator.next()).toThrow('invalid identifier');
  });
});
