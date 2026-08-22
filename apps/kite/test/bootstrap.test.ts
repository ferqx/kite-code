import { describe, expect, test } from 'bun:test';
import { createKiteRuntimeBoundaryV1 } from '@kite/kite';

describe('Kite target composition root', () => {
  test('composes the RAV1 package boundaries on the target Runtime format', () => {
    expect(createKiteRuntimeBoundaryV1()).toEqual({
      contractRevision: 'rmv1-03',
      deterministicKernel: true,
      storage: {
        adapterId: 'sqlite',
        stateSchemaVersion: 26,
        storeSchemaVersion: 5,
        compatibilityEpoch: 'kite-runtime-modularization-v1-2026-08-19',
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
