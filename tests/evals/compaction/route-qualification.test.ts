import { describe, expect, test } from 'bun:test';
import {
  compactionRouteDigest,
  LocalCompactionRouteRegistryV1,
  syntheticRouteIdentity,
} from './route-qualification';

describe('compaction route qualification identity', () => {
  test('keeps the local supported set empty and observations blocked', () => {
    const registry = new LocalCompactionRouteRegistryV1();
    const identity = syntheticRouteIdentity();
    const record = registry.registerExpected(identity);
    expect(record.observation).toBe('not_observed');
    expect(record.qualified).toBeFalse();
    expect(record.reasonCodes).toContain('custom_endpoint_unqualified');
    expect(registry.qualifiedRouteDigests()).toEqual([]);
    expect(registry.routeEnabled(identity)).toBeFalse();
  });

  test('changes qualification identity for every bound behavior change', () => {
    const original = syntheticRouteIdentity();
    const changed = { ...original, suiteDigest: `sha256:${'8'.repeat(64)}` as const };
    expect(compactionRouteDigest(changed)).not.toBe(compactionRouteDigest(original));

    const registry = new LocalCompactionRouteRegistryV1();
    registry.registerExpected(original);
    expect(registry.expectedIdentity(compactionRouteDigest(changed))).toBeNull();
  });

  test('rejects unknown identity fields', () => {
    const registry = new LocalCompactionRouteRegistryV1();
    expect(() =>
      registry.registerExpected({ ...syntheticRouteIdentity(), qualified: true } as never),
    ).toThrow();
  });
});
