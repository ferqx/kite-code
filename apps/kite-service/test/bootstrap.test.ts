import { describe, expect, test } from 'bun:test';
import {
  createKiteAppServerAgentApiReadContext,
  createKiteRuntimeBoundary,
} from '../src/bootstrap';

describe('Kite target composition root', () => {
  test('composes the RA package boundaries on the target Runtime format', () => {
    expect(createKiteRuntimeBoundary()).toEqual({
      contractRevision: 'runtime-contract-current',
      deterministicKernel: true,
      storage: {
        adapterId: 'sqlite',
        stateSchemaVersion: 27,
        storeSchemaVersion: 6,
        formatEpoch: 'kite-runtime-server-v1-2026-08-26',
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

  test('continues Checkpoint keyset pagination after the cursor row is removed', () => {
    const context = createKiteAppServerAgentApiReadContext({
      directory: {} as never,
      runtime: {} as never,
      history: {} as never,
      storage: {} as never,
      artifactStore: {} as never,
      checkpoints: {
        listNamedSnapshots: () =>
          [
            {
              snapshotId: 'checkpoint-a',
              eventPosition: 4,
              createdAt: 10,
              affectedFileCount: 0,
            },
            {
              snapshotId: 'checkpoint-c',
              eventPosition: 4,
              createdAt: 20,
              affectedFileCount: 1,
            },
            {
              snapshotId: 'checkpoint-d',
              eventPosition: 5,
              createdAt: 30,
              affectedFileCount: 2,
            },
          ] as never,
        getNamedSnapshotEntry: () => null,
      },
    });

    expect(
      context.checkpoints.list({
        sessionId: 'session-checkpoints',
        cursor: { revision: 4, checkpointId: 'checkpoint-b' },
        limit: 1,
      }),
    ).toEqual({
      entries: [
        {
          checkpointId: 'checkpoint-c',
          sessionId: 'session-checkpoints',
          revision: 4,
          eventPosition: 4,
          createdAt: 20,
          affectedFileCount: 1,
        },
      ],
      hasMore: true,
      nextCursor: { revision: 4, checkpointId: 'checkpoint-c' },
    });
  });
});
