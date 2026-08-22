import { readFileSync } from 'node:fs';
import {
  generatedManifestPath,
  generateRuntimeModularizationManifests,
  serializeGeneratedManifest,
  validateRuntimeModularizationManualManifests,
} from './runtime-modularization/manifest-generator';

const root = process.cwd();
const generated = generateRuntimeModularizationManifests(root);
const drift: string[] = [];
for (const [file, manifest] of Object.entries(generated)) {
  const expected = serializeGeneratedManifest(manifest);
  let actual: string;
  try {
    actual = readFileSync(generatedManifestPath(root, file), 'utf8');
  } catch {
    drift.push(`${file}: missing`);
    continue;
  }
  if (actual !== expected) drift.push(`${file}: generated facts drifted`);
}
if (drift.length > 0) {
  console.error('Runtime modularization generated manifests are not reproducible:');
  for (const entry of drift) console.error(`  - ${entry}`);
  console.error('Run: bun run scripts/generate-runtime-modularization-manifests.ts');
  process.exit(1);
}

const result = validateRuntimeModularizationManualManifests(root, generated);
console.log(
  JSON.stringify({
    status: 'passed',
    generatedManifestCount: Object.keys(generated).length,
    ...result,
    runtimeStateSchemaVersion: generated['runtime-state-shape.generated.json'].facts.schemaVersion,
    runtimeStoreSchemaVersion: generated['store-schema.generated.json'].facts.storeSchemaVersion,
    formatEpoch: generated['store-schema.generated.json'].facts.formatEpoch,
  }),
);
