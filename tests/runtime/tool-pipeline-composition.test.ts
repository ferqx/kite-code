import { describe, expect, test } from 'bun:test';
import {
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjection,
} from '@kite/builtin-runtime';
import { createRuntimeModuleRegistry } from '@kite/runtime-spi';
import { createAppToolPipelineComposition } from '#app/bootstrap/runtime/tool-pipeline-composition';

function createComposition() {
  const snapshot = createRuntimeModuleRegistry(createBuiltinRuntimeModules()).snapshot();
  return createAppToolPipelineComposition(createBuiltinToolCatalogProjection(snapshot));
}

describe('RM-16 App Tool Pipeline composition', () => {
  test('derives each turn bundle from one frozen base projection', () => {
    const composition = createComposition();
    const first = composition.forTurn({ workspace: '/workspace/a', threadId: 'thread-a' });
    const second = composition.forTurn({ workspace: '/workspace/b', threadId: 'thread-b' });

    expect(Object.isFrozen(composition)).toBe(true);
    expect(Object.isFrozen(composition.baseProjection)).toBe(true);
    expect(composition.baseProjection.entries).toHaveLength(28);
    expect(first.projection.entries).toHaveLength(28);
    expect(second.projection.entries).toHaveLength(28);
    expect(first.projection).not.toBe(second.projection);
    expect(first.projection).not.toBe(composition.baseProjection);
    expect(first.callbacks).not.toBe(second.callbacks);
    expect(first.governance).not.toBe(second.governance);
    expect(Object.isFrozen(first)).toBe(true);
  });

  test('does not create a registry, snapshot, or execution port', () => {
    const composition = createComposition();
    const first = composition.forTurn({ workspace: '/workspace', turnId: 'turn-1' });
    const second = composition.forTurn({ workspace: '/workspace', turnId: 'turn-2' });

    expect(first.projection.revision).toBe(second.projection.revision);
    expect(first.projection.entries.map((entry) => entry.operationId)).toEqual(
      second.projection.entries.map((entry) => entry.operationId),
    );
    expect('invoke' in first.governance).toBe(false);
    expect('dispatch' in first.governance).toBe(false);
  });
});
