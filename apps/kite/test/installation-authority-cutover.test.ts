import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sqliteRuntimeStorePathForV2 } from '@kite/runtime-storage-sqlite';
import {
  loadInstalledRuntimeAuthorityKeyV1,
  RUNTIME_PROJECT_IDENTITY_STORE_FILE_V1,
} from '../src/bootstrap/project-identity-composition';

test('legacy header-shim files do not masquerade as target installation authority evidence', () => {
  const root = mkdtempSync(join(process.cwd(), '.kite-installation-authority-cutover-'));
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'project-identities-v1.json'), '{}');
    writeFileSync(join(root, 'checkpoints.runtime-v5.db'), 'legacy-header-shim');

    const targetStorePath = sqliteRuntimeStorePathForV2(join(root, 'checkpoints.sqlite'));
    const authority = loadInstalledRuntimeAuthorityKeyV1([targetStorePath], root);

    expect(authority.keyId).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(existsSync(join(root, 'runtime-authority.key'))).toBe(true);
    expect(existsSync(join(root, RUNTIME_PROJECT_IDENTITY_STORE_FILE_V1))).toBe(false);
    expect(targetStorePath).toBe(join(root, 'checkpoints.runtime-state26-store5.db'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing root still fails closed when target authority evidence exists', () => {
  const root = mkdtempSync(join(process.cwd(), '.kite-installation-authority-loss-'));
  try {
    const targetStorePath = sqliteRuntimeStorePathForV2(join(root, 'checkpoints.sqlite'));
    writeFileSync(targetStorePath, 'target-evidence');

    expect(() => loadInstalledRuntimeAuthorityKeyV1([targetStorePath], root)).toThrow(
      'Runtime authority evidence exists but its installation key is unavailable.',
    );
    expect(existsSync(join(root, 'runtime-authority.key'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
