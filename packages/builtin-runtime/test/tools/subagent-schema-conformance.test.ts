import { describe, expect, test } from 'bun:test';
import { createBuiltinRuntimeModules } from '@kite-ai/builtin-runtime';
import {
  SUBAGENT_CAPABILITY_REVISIONS_,
  SUBAGENT_OPERATION_IDS_,
} from '@kite-ai/builtin-runtime/subagent';
import { createRuntimeModuleRegistry } from '@kite-ai/runtime-spi';

describe('RM-14 Builtin Runtime closure', () => {
  test('registers exactly one RM-14 owner and executor per operation', () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    for (const operationId of SUBAGENT_OPERATION_IDS_) {
      expect(registry.operationOwner(operationId), operationId).toBe(
        'kite-builtin-runtime-subagent',
      );
      expect(registry.capability(operationId), operationId).toMatchObject({
        capabilityId: operationId,
        revision: SUBAGENT_CAPABILITY_REVISIONS_[operationId],
        providerId: 'kite-builtin-runtime-subagent',
      });
      expect(registry.executor(operationId), operationId).toMatchObject({
        capabilityId: operationId,
        capabilityRevision: SUBAGENT_CAPABILITY_REVISIONS_[operationId],
        providerId: 'kite-builtin-runtime-subagent',
      });
    }
  });
});
