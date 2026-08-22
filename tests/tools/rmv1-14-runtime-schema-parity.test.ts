import { describe, expect, test } from 'bun:test';
import {
  createBuiltinRuntimeModules,
  RMV1_14_CAPABILITY_REVISIONS_V1,
  RMV1_14_OPERATION_IDS_V1,
} from '#builtin-runtime';
import { createRuntimeModuleRegistryV1 } from '#runtime-spi';

describe('RMV1-14 Builtin Runtime closure', () => {
  test('registers exactly one RMV1-14 owner and executor per operation', () => {
    const registry = createRuntimeModuleRegistryV1(createBuiltinRuntimeModules());
    for (const operationId of RMV1_14_OPERATION_IDS_V1) {
      expect(registry.operationOwner(operationId), operationId).toBe(
        'kite-builtin-runtime-rmv1-14',
      );
      expect(registry.capability(operationId), operationId).toMatchObject({
        capabilityId: operationId,
        revision: RMV1_14_CAPABILITY_REVISIONS_V1[operationId],
        providerId: 'kite-builtin-runtime-rmv1-14',
      });
      expect(registry.executor(operationId), operationId).toMatchObject({
        capabilityId: operationId,
        capabilityRevision: RMV1_14_CAPABILITY_REVISIONS_V1[operationId],
        providerId: 'kite-builtin-runtime-rmv1-14',
      });
    }
  });
});
