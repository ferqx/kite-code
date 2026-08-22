import { describe, expect, test } from 'bun:test';
import { assertAuthorizationElevation } from '../src/authorization';

describe('Agent Kernel authorization elevation', () => {
  test('keeps default mode and explicitly sandbox-qualified full access admitted', () => {
    expect(() =>
      assertAuthorizationElevation({ mode: 'default', sandboxAvailable: false }),
    ).not.toThrow();
    for (const source of ['user', 'config', 'test'] as const) {
      expect(() =>
        assertAuthorizationElevation({ mode: 'full_access', source, sandboxAvailable: true }),
      ).not.toThrow();
    }
  });

  test('rejects none-to-full elevation without a Full-qualified sandbox', () => {
    expect(() =>
      assertAuthorizationElevation({
        mode: 'full_access',
        source: 'user',
        sandboxAvailable: false,
      }),
    ).toThrow('full_access requires an available workspace sandbox.');
  });

  test('rejects system source mismatch for auto-review and loop mode', () => {
    expect(() =>
      assertAuthorizationElevation({
        mode: 'full_access',
        source: 'system',
        sandboxAvailable: true,
        autoReview: true,
      }),
    ).toThrow('auto-review cannot grant full_access.');
    expect(() =>
      assertAuthorizationElevation({
        mode: 'full_access',
        source: 'system',
        sandboxAvailable: true,
        loopMode: true,
      }),
    ).toThrow('loop-mode cannot auto-elevate authorization.');
    expect(() =>
      assertAuthorizationElevation({
        mode: 'full_access',
        source: 'user',
        sandboxAvailable: true,
        autoReview: true,
        loopMode: true,
      }),
    ).not.toThrow();
  });
});
