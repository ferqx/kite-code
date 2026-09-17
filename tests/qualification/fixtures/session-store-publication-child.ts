import { Database } from 'bun:sqlite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertKiteSessionStoreSchema } from '../../../packages/runtime-storage-sqlite/src/kite-home-store';
import { acquireKiteSessionStoreMaintenance } from '../../../packages/runtime-storage-sqlite/src/kite-session-maintenance';
import { captureKiteSessionPreservationManifest } from '../../../packages/runtime-storage-sqlite/src/kite-session-preservation';
import {
  captureKiteSessionPublicationSource,
  publishVerifiedKiteSessionCandidate,
} from '../../../packages/runtime-storage-sqlite/src/kite-session-store-publication';

const root = process.argv[2];
const mode = process.argv[3] ?? 'crash-after-candidate';
const readyPath = process.argv[4];
if (!root) throw new Error('Fixture root is required.');
const canonicalPath = join(root, 'kite-session.sqlite');
const historicalPath = join(root, 'kite.sqlite');
const migrationDirectory = join(
  root,
  'session-store-recovery',
  'migration-0123456789abcdef01234567',
);
const candidatePath = join(migrationDirectory, 'converted-0', 'kite-session.sqlite');
const candidate = new Database(candidatePath, { readonly: true });
const candidateManifest = captureKiteSessionPreservationManifest(candidate);
candidate.close(false);
const paths = [canonicalPath, historicalPath];
const sources = paths.map((databasePath) => ({
  databasePath,
  files: captureKiteSessionPublicationSource(canonicalPath, databasePath),
  maintenance: acquireKiteSessionStoreMaintenance(databasePath, 'exclusive'),
}));
publishVerifiedKiteSessionCandidate({
  canonicalPath,
  candidatePath,
  migrationDirectory,
  candidateManifest,
  canonicalMaintenance: sources[0]!.maintenance,
  sources,
  validatePublished: assertKiteSessionStoreSchema,
  fault(stage) {
    if (mode === 'hold-after-intent' && stage === 'intent_directory_fsync') {
      if (!readyPath) throw new Error('Ready path is required for hold mode.');
      writeFileSync(readyPath, 'ready', { flag: 'wx', mode: 0o600 });
      Bun.sleepSync(30_000);
    }
    if (mode === 'crash-after-candidate' && stage === 'candidate_rename') process.exit(75);
  },
});
throw new Error('Fault injection did not interrupt publication.');
