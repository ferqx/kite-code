import { describe, expect, test } from 'bun:test';
import {
  createBuiltinRuntimeModules,
  SUBAGENT_CAPABILITY_REVISIONS_,
  SUBAGENT_OPERATION_IDS_,
} from '#builtin-runtime';
import { createRuntimeModuleRegistry } from '#runtime-spi';

describe('RM-14 Builtin Runtime closure', () => {
  test('registers exactly one RM-14 owner and executor per operation', () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    for (const operationId of SUBAGENT_OPERATION_IDS_) {
      expect(registry.operationOwner(operationId), operationId).toBe(
        'kite-builtin-runtime-rmv1-14',
      );
      expect(registry.capability(operationId), operationId).toMatchObject({
        capabilityId: operationId,
        revision: SUBAGENT_CAPABILITY_REVISIONS_[operationId],
        providerId: 'kite-builtin-runtime-rmv1-14',
      });
      expect(registry.executor(operationId), operationId).toMatchObject({
        capabilityId: operationId,
        capabilityRevision: SUBAGENT_CAPABILITY_REVISIONS_[operationId],
        providerId: 'kite-builtin-runtime-rmv1-14',
      });
    }
  });
});
