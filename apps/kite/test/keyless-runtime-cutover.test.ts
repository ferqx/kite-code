import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sqliteRuntimeStorePathForV2 } from '@kite/runtime-storage-sqlite';
import {
  createInstalledProjectIdentityStoreV1,
  RUNTIME_PROJECT_IDENTITY_STORE_FILE_V1,
} from '../src/bootstrap/project-identity-composition';

test('target epoch starts without creating or loading an installation authority key', () => {
  const root = mkdtempSync(join(process.cwd(), '.kite-keyless-runtime-cutover-'));
  try {
    writeFileSync(join(root, 'project-identities-v1.json'), '{}');
    writeFileSync(join(root, 'checkpoints.runtime-v5.db'), 'legacy-header-shim');

    const store = createInstalledProjectIdentityStoreV1(root);
    const project = store.resolveOrCreateSync(process.cwd());

    expect(project.projectId).toStartWith('project_');
    expect(existsSync(join(root, 'runtime-authority.key'))).toBe(false);
    expect(existsSync(join(root, RUNTIME_PROJECT_IDENTITY_STORE_FILE_V1))).toBe(true);
    expect(sqliteRuntimeStorePathForV2(join(root, 'checkpoints.sqlite'))).toBe(
      join(root, 'checkpoints.runtime-state26-store5.db'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
