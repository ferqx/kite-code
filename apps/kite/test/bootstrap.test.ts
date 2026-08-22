import { describe, expect, test } from 'bun:test';
import { createKiteRuntimeBoundaryV1 } from '@kite/kite';

describe('Kite target composition root', () => {
  test('composes the RMV1 package boundaries without changing formats', () => {
    expect(createKiteRuntimeBoundaryV1()).toEqual({
      contractRevision: 'rmv1-03',
      deterministicKernel: true,
      storage: {
        adapterId: 'sqlite',
        stateSchemaVersion: 25,
        storeSchemaVersion: 4,
        compatibilityEpoch: 'kite-runtime-2026-08-18',
      },
      moduleIds: [
        'kite-runtime-execution',
        'kite-builtin-runtime',
        'kite-builtin-runtime-rmv1-11',
        'kite-builtin-runtime-rmv1-12',
        'kite-builtin-runtime-rmv1-13',
        'kite-builtin-runtime-rmv1-14',
        'kite-builtin-runtime-rmv1-15',
      ],
    });
  });
});
