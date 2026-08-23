import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createBuiltinRuntimeModules,
  VERIFICATION_CAPABILITY_REVISIONS_,
  VERIFICATION_OPERATION_IDS_,
  VERIFICATION_PROVIDER_ID_,
} from '#builtin-runtime';
import { createRuntimeModuleRegistry } from '#runtime-spi';
import { KITE_RUNTIME_OPERATION_IDS_ } from '../../apps/kite/src/bootstrap/runtime/KiteRuntimeExecutionModule';

const root = resolve(import.meta.dir, '../..');

describe('RM-15 Model, Context, Compaction, and Reviewer closure', () => {
  test('registers exactly one Builtin Runtime owner and executor for every Model purpose', () => {
    const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
    for (const operationId of VERIFICATION_OPERATION_IDS_) {
      expect(registry.operationOwner(operationId), operationId).toBe(VERIFICATION_PROVIDER_ID_);
      expect(registry.capability(operationId), operationId).toMatchObject({
        capabilityId: operationId,
        revision: VERIFICATION_CAPABILITY_REVISIONS_[operationId],
        providerId: VERIFICATION_PROVIDER_ID_,
      });
      expect(registry.executor(operationId), operationId).toMatchObject({
        capabilityId: operationId,
        capabilityRevision: VERIFICATION_CAPABILITY_REVISIONS_[operationId],
        providerId: VERIFICATION_PROVIDER_ID_,
      });
    }
  });

  test('leaves no Model purpose in the App execution module', () => {
    expect(KITE_RUNTIME_OPERATION_IDS_).toEqual([]);
    for (const operationId of VERIFICATION_OPERATION_IDS_) {
      expect(KITE_RUNTIME_OPERATION_IDS_).not.toContain(operationId);
    }
  });

  test('keeps concrete Model and Prompt implementation out of Core compatibility paths', () => {
    const coreModelDirectory = resolve(root, 'src/core/model');
    const modelCompatibilityFiles = existsSync(coreModelDirectory)
      ? readdirSync(coreModelDirectory).filter((entry) => entry.endsWith('.ts'))
      : [];
    for (const name of modelCompatibilityFiles) {
      if (name === 'invocation-gateway.ts') continue;
      const source = readFileSync(resolve(coreModelDirectory, name), 'utf8');
      expect(source, name).toContain('RM-15 compatibility surface');
      expect(source, name).toContain("from '#builtin-runtime/model'");
      expect(source.trim().split('\n'), name).toHaveLength(2);
    }
    expect(existsSync(resolve(root, 'src/core/model/invocation-composition.ts'))).toBe(false);
    expect(existsSync(resolve(root, 'src/core/runtime/installed-runtime-composition.ts'))).toBe(
      false,
    );
    expect(existsSync(resolve(root, 'src/core/prompts/system-prompt.txt'))).toBe(false);
    expect(existsSync(resolve(root, 'src/core/prompts/system-prompt.txt'))).toBe(false);
    expect(existsSync(resolve(root, 'src/core/prompts/contract.md'))).toBe(false);
    expect(
      existsSync(resolve(root, 'packages/builtin-runtime/src/model/prompts/system-prompt.txt')),
    ).toBe(true);
    expect(
      existsSync(resolve(root, 'packages/builtin-runtime/src/model/prompts/system-prompt.txt')),
    ).toBe(true);
    expect(
      existsSync(resolve(root, 'packages/builtin-runtime/src/model/prompts/contract.md')),
    ).toBe(true);
    expect(existsSync(resolve(root, 'apps/kite/src/bootstrap/model-runtime-composition.ts'))).toBe(
      true,
    );
  });
});
