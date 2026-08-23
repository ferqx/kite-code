import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProjectIdentityV1 } from '@kite/runtime-host';
import { sqliteRuntimeStorePathForV2 } from '@kite/runtime-storage-sqlite';

test('target epoch starts without creating or loading an installation authority key', () => {
  const root = mkdtempSync(join(process.cwd(), '.kite-keyless-runtime-cutover-'));
  try {
    writeFileSync(join(root, 'project-identities-v1.json'), '{}');
    writeFileSync(join(root, 'checkpoints.runtime-v5.db'), 'legacy-header-shim');

    const project = resolveProjectIdentityV1(process.cwd());

    expect(project.projectId).toStartWith('project_');
    expect(existsSync(join(root, 'runtime-authority.key'))).toBe(false);
    expect(existsSync(join(root, 'project-identities-state-store-v2.json'))).toBe(false);
    expect(sqliteRuntimeStorePathForV2(join(root, 'checkpoints.sqlite'))).toBe(
      join(root, 'checkpoints.runtime-state-store.db'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
