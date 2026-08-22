import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GENERATED_MANIFEST_FILES,
  generatedManifestPath,
  generateRuntimeModularizationManifests,
  RUNTIME_MODULARIZATION_BUILTIN_FACTS_V1,
  serializeGeneratedManifest,
  validateRuntimeModularizationManualManifests,
} from '../../scripts/runtime-modularization/manifest-generator';

const root = resolve(import.meta.dir, '../..');

describe('Runtime modularization manifests', () => {
  test('freeze the RMV1 State, Event, Store, package, and public-export baseline', () => {
    const generated = generateRuntimeModularizationManifests(root);

    expect(generated['runtime-state-shape.generated.json'].facts).toMatchObject({
      schemaVersion: 26,
      formatEpoch: 'kite-runtime-modularization-v1-2026-08-19',
      rootType: 'RuntimeState',
      fieldCount: 30,
    });
    expect(generated['runtime-event-shape.generated.json'].facts).toMatchObject({
      rootType: 'RuntimeEvent',
      eventCount: 136,
      codecDiscriminantCount: 136,
    });
    expect(generated['store-schema.generated.json'].facts).toMatchObject({
      adapterId: 'sqlite',
      storeSchemaVersion: 5,
      runtimeStateSchemaVersion: 26,
      formatEpoch: 'kite-runtime-modularization-v1-2026-08-19',
      tableCount: 10,
      indexCount: 4,
    });
    const storeSources = generated['store-schema.generated.json'].sources.map(
      (source) => source.path,
    );
    expect(storeSources).toContain('packages/runtime-storage-sqlite/src/sqlite-store.ts');
    expect(storeSources).not.toContain('src/core/runtime/store.ts');
    expect(generated['package-graph.generated.json'].facts.packages).toHaveLength(8);
  });

  test('freezes the one Builtin SPI snapshot at the RMV1 6/29/20/9 boundary', () => {
    expect(RUNTIME_MODULARIZATION_BUILTIN_FACTS_V1).toMatchObject({
      moduleCount: 6,
      operationCount: 29,
      catalogEntryCount: 29,
      modelVisibleCount: 20,
      internalCount: 9,
    });
    expect(RUNTIME_MODULARIZATION_BUILTIN_FACTS_V1.operationIds).toHaveLength(29);
    expect(new Set(RUNTIME_MODULARIZATION_BUILTIN_FACTS_V1.operationIds).size).toBe(29);
    expect(RUNTIME_MODULARIZATION_BUILTIN_FACTS_V1.modelToolNames).toHaveLength(20);
  });

  test('reproduces checked-in facts and closes owner/delete/source manifests', () => {
    const generated = generateRuntimeModularizationManifests(root);
    for (const file of GENERATED_MANIFEST_FILES) {
      expect(readFileSync(generatedManifestPath(root, file), 'utf8')).toBe(
        serializeGeneratedManifest(generated[file]),
      );
    }

    expect(validateRuntimeModularizationManualManifests(root, generated)).toMatchObject({
      operationCount: 29,
      responsibilityCount: 19,
      legacyRuleCount: 107,
      sourceFileCount: 0,
      architectureExceptionCount: 0,
    });
  });

  test('has no operation left under a Legacy Runtime owner', () => {
    const manifest = JSON.parse(
      readFileSync(
        resolve(
          root,
          'tests/reliability-harness/runtime-modularization/manifests/operation-owner.json',
        ),
        'utf8',
      ),
    ) as {
      readonly operationGroups: readonly {
        readonly operations: readonly string[];
        readonly currentOwnerProfile: string;
      }[];
    };
    const manifestOperations = manifest.operationGroups
      .filter((group) => group.currentOwnerProfile.startsWith('legacy-'))
      .flatMap((group) => group.operations)
      .sort();
    expect(manifestOperations).toEqual([]);
  });

  test('keeps the Kernel scheduler free of concrete Tool names', () => {
    const scheduler = readFileSync(resolve(root, 'packages/agent-kernel/src/scheduler.ts'), 'utf8');
    for (const name of RUNTIME_MODULARIZATION_BUILTIN_FACTS_V1.modelToolNames) {
      expect(scheduler).not.toContain(`'${name}'`);
    }
    expect(existsSync(resolve(root, 'src/core/runtime/runner.ts'))).toBeFalse();
  });

  test('keeps the manifest authority free of deleted Core registry and driver symbols', () => {
    const generator = readFileSync(
      resolve(root, 'scripts/runtime-modularization/manifest-generator.ts'),
      'utf8',
    );
    expect(generator).not.toContain('builtinToolRegistry');
    expect(generator).not.toContain('KITE_RUNTIME_OPERATION_IDS_V1');
    expect(generator).not.toContain('openLegacyV4StorageDriver');
  });
});
