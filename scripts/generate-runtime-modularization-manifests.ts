import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  generatedManifestPath,
  generateRuntimeModularizationManifests,
  serializeGeneratedManifest,
} from './runtime-modularization/manifest-generator';

const root = process.cwd();
const generated = generateRuntimeModularizationManifests(root);
for (const [file, manifest] of Object.entries(generated)) {
  const path = generatedManifestPath(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeGeneratedManifest(manifest));
}
console.log(
  `Generated ${Object.keys(generated).length} Runtime modularization source-fact manifests.`,
);
