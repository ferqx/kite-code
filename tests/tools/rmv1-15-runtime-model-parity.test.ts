import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createBuiltinRuntimeModules,
  RMV1_15_CAPABILITY_REVISIONS_V1,
  RMV1_15_OPERATION_IDS_V1,
  RMV1_15_PROVIDER_ID_V1,
} from '#builtin-runtime';
import { createRuntimeModuleRegistryV1 } from '#runtime-spi';
import { KITE_RUNTIME_OPERATION_IDS_V1 } from '../../apps/kite/src/bootstrap/runtime/KiteRuntimeExecutionModule';

const root = resolve(import.meta.dir, '../..');

describe('RMV1-15 Model, Context, Compaction, and Reviewer closure', () => {
  test('registers exactly one Builtin Runtime owner and executor for every Model purpose', () => {
    const registry = createRuntimeModuleRegistryV1(createBuiltinRuntimeModules());
    for (const operationId of RMV1_15_OPERATION_IDS_V1) {
      expect(registry.operationOwner(operationId), operationId).toBe(RMV1_15_PROVIDER_ID_V1);
      expect(registry.capability(operationId), operationId).toMatchObject({
        capabilityId: operationId,
        revision: RMV1_15_CAPABILITY_REVISIONS_V1[operationId],
        providerId: RMV1_15_PROVIDER_ID_V1,
      });
      expect(registry.executor(operationId), operationId).toMatchObject({
        capabilityId: operationId,
        capabilityRevision: RMV1_15_CAPABILITY_REVISIONS_V1[operationId],
        providerId: RMV1_15_PROVIDER_ID_V1,
      });
    }
  });

  test('leaves no Model purpose in the App execution module', () => {
    expect(KITE_RUNTIME_OPERATION_IDS_V1).toEqual([]);
    for (const operationId of RMV1_15_OPERATION_IDS_V1) {
      expect(KITE_RUNTIME_OPERATION_IDS_V1).not.toContain(operationId);
    }
  });

  test('keeps concrete Model and Prompt implementation out of Core compatibility paths', () => {
    const coreModelDirectory = resolve(root, 'src/core/model');
    for (const name of readdirSync(coreModelDirectory).filter((entry) => entry.endsWith('.ts'))) {
      if (name === 'invocation-gateway.ts') continue;
      const source = readFileSync(resolve(coreModelDirectory, name), 'utf8');
      expect(source, name).toContain('RMV1-15 compatibility surface');
      expect(source, name).toContain("from '#builtin-runtime/model'");
      expect(source.trim().split('\n'), name).toHaveLength(2);
    }
    expect(existsSync(resolve(root, 'src/core/model/invocation-composition.ts'))).toBe(false);
    expect(existsSync(resolve(root, 'src/core/runtime/installed-runtime-composition.ts'))).toBe(
      false,
    );
    expect(existsSync(resolve(root, 'src/core/prompts/system-prompt.txt'))).toBe(false);
    expect(existsSync(resolve(root, 'src/core/prompts/system-prompt-v2.txt'))).toBe(false);
    expect(existsSync(resolve(root, 'src/core/prompts/contract.md'))).toBe(false);
    expect(
      existsSync(resolve(root, 'packages/builtin-runtime/src/model/prompts/system-prompt.txt')),
    ).toBe(true);
    expect(
      existsSync(resolve(root, 'packages/builtin-runtime/src/model/prompts/system-prompt-v2.txt')),
    ).toBe(true);
    expect(
      existsSync(resolve(root, 'packages/builtin-runtime/src/model/prompts/contract.md')),
    ).toBe(true);
    expect(existsSync(resolve(root, 'apps/kite/src/bootstrap/model-runtime-composition.ts'))).toBe(
      true,
    );
  });
});
