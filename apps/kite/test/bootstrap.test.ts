import { describe, expect, test } from 'bun:test';
import { createKiteRuntimeBoundary } from '@kite-ai/kite';

describe('Kite target composition root', () => {
  test('composes the RA package boundaries on the target Runtime format', () => {
    expect(createKiteRuntimeBoundary()).toEqual({
      contractRevision: 'runtime-contract-current',
      deterministicKernel: true,
      storage: {
        adapterId: 'sqlite',
        stateSchemaVersion: 27,
        storeSchemaVersion: 5,
        formatEpoch: 'kite-runtime-saq-v1-2026-08-25',
      },
      moduleIds: [
        'kite-runtime-execution',
        'kite-builtin-runtime',
        'kite-builtin-runtime-model',
        'kite-builtin-runtime-git',
        'kite-builtin-runtime-planning',
        'kite-builtin-runtime-subagent',
        'kite-builtin-runtime-verification',
      ],
    });
  });
});
