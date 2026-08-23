import { describe, expect, test } from 'bun:test';
import { createKiteRuntimeBoundary } from '@kite/kite';

describe('Kite target composition root', () => {
  test('composes the RA package boundaries on the target Runtime format', () => {
    expect(createKiteRuntimeBoundary()).toEqual({
      contractRevision: 'rmv1-03',
      deterministicKernel: true,
      storage: {
        adapterId: 'sqlite',
        stateSchemaVersion: 26,
        storeSchemaVersion: 5,
        formatEpoch: 'kite-runtime-modularization-v1-2026-08-19',
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
