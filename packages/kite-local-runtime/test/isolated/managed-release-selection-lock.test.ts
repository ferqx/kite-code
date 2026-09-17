import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireManagedReleaseSelectionLock,
  assertManagedStoreMaintenanceContract,
  declareManagedStoreMaintenanceContract,
  MANAGED_STORE_MAINTENANCE_MARKER,
  MANAGED_STORE_MAINTENANCE_SCRATCH,
} from '../../src/service/managed-release-selection-lock';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('managed release selection holds a stable inode and blocks cross-process mutation', () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  const root = mkdtempSync(join(tmpdir(), 'kite-release-lock-'));
  roots.push(root);
  chmodSync(root, 0o700);
  const first = acquireManagedReleaseSelectionLock(root, 'shared');
  try {
    const second = acquireManagedReleaseSelectionLock(root, 'shared');
    second.release();
    expect(childExit(root, 'exclusive')).toBe(7);
    first.revalidate();
  } finally {
    first.release();
  }
  expect(childExit(root, 'exclusive')).toBe(0);
  const next = acquireManagedReleaseSelectionLock(root, 'exclusive');
  try {
    expect(next.path).toBe(join(root, '.release-selection.lock'));
    // A failed write or crash may leave only the exact, private scratch file.
    writeFileSync(join(root, MANAGED_STORE_MAINTENANCE_SCRATCH), 'partial', { mode: 0o600 });
    declareManagedStoreMaintenanceContract(next);
    expect(existsSync(join(root, MANAGED_STORE_MAINTENANCE_SCRATCH))).toBe(false);
    expect(existsSync(join(root, MANAGED_STORE_MAINTENANCE_MARKER))).toBe(true);
    assertManagedStoreMaintenanceContract(root);
  } finally {
    next.release();
  }
  next.release();
  next.release();
});

test('failed marker write leaves no ready marker and can be retried', () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  const root = mkdtempSync(join(tmpdir(), 'kite-release-marker-failure-'));
  roots.push(root);
  chmodSync(root, 0o700);
  const lock = acquireManagedReleaseSelectionLock(root, 'exclusive');
  try {
    const writer = spyOn(fs, 'writeSync').mockImplementation(() => {
      throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' });
    });
    try {
      expect(() => declareManagedStoreMaintenanceContract(lock)).toThrow('simulated disk full');
    } finally {
      writer.mockRestore();
    }
    expect(existsSync(join(root, MANAGED_STORE_MAINTENANCE_MARKER))).toBe(false);
    expect(existsSync(join(root, MANAGED_STORE_MAINTENANCE_SCRATCH))).toBe(false);
    declareManagedStoreMaintenanceContract(lock);
    assertManagedStoreMaintenanceContract(root);
  } finally {
    lock.release();
  }
});

function childExit(root: string, mode: 'exclusive'): number | null {
  const module = join(import.meta.dir, '../../src/service/managed-release-selection-lock.ts');
  return Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `import {acquireManagedReleaseSelectionLock} from ${JSON.stringify(module)}; try { const lock = acquireManagedReleaseSelectionLock(${JSON.stringify(root)}, ${JSON.stringify(mode)}); lock.release(); } catch { process.exit(7); }`,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  ).exitCode;
}
