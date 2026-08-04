import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import {
  installOssCandidate,
  readInstallStatus,
  rollbackOssCandidate,
  uninstallOssCandidate,
} from '../../scripts/release/install-oss-candidate';
import { createOssCandidateFixture } from './helpers/oss-candidate-fixture';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});

describe('managed candidate install lifecycle', () => {
  test('installs, upgrades, rolls back, and uninstalls inside one marked prefix', async () => {
    const first = await createOssCandidateFixture('0.1.0');
    const second = await createOssCandidateFixture('0.1.1');
    roots.push(first.root, second.root);
    const parent = mkdtempSync(join(tmpdir(), 'kite-oss-install-test-'));
    roots.push(parent);
    const prefix = join(parent, 'managed');
    const firstMarker = await installOssCandidate({ archivePath: first.archivePath, prefix });
    const secondMarker = await installOssCandidate({ archivePath: second.archivePath, prefix });
    expect(secondMarker.previousCandidateId).toBe(firstMarker.currentCandidateId);
    const rolledBack = rollbackOssCandidate(prefix);
    expect(rolledBack.currentCandidateId).toBe(firstMarker.currentCandidateId);
    expect(readInstallStatus(prefix)).toEqual(rolledBack);
    uninstallOssCandidate(prefix);
    expect(existsSync(prefix)).toBe(false);
  });

  test('refuses unmanaged, broad, or link-containing targets', async () => {
    const fixture = await createOssCandidateFixture('0.1.0');
    roots.push(fixture.root);
    const parent = mkdtempSync(join(tmpdir(), 'kite-oss-install-safety-'));
    roots.push(parent);
    const unmanaged = join(parent, 'unmanaged');
    mkdirSync(unmanaged);
    writeFileSync(join(unmanaged, 'keep.txt'), 'user data');
    await expect(
      installOssCandidate({ archivePath: fixture.archivePath, prefix: unmanaged }),
    ).rejects.toThrow('not managed');
    await expect(
      installOssCandidate({ archivePath: fixture.archivePath, prefix: parse(parent).root }),
    ).rejects.toThrow('filesystem root');
  });

  test('refuses to uninstall an install tree containing an unknown user file', async () => {
    const fixture = await createOssCandidateFixture('0.1.0');
    roots.push(fixture.root);
    const parent = mkdtempSync(join(tmpdir(), 'kite-oss-uninstall-safety-'));
    roots.push(parent);
    const prefix = join(parent, 'managed');
    await installOssCandidate({ archivePath: fixture.archivePath, prefix });
    const unknown = join(prefix, 'keep.txt');
    writeFileSync(unknown, 'user data');
    expect(() => uninstallOssCandidate(prefix)).toThrow('unknown entry');
    expect(existsSync(unknown)).toBe(true);
    rmSync(unknown);
    uninstallOssCandidate(prefix);
  });

  test('refuses an upgrade when the managed tree was altered', async () => {
    const first = await createOssCandidateFixture('0.1.0');
    const second = await createOssCandidateFixture('0.1.1');
    roots.push(first.root, second.root);
    const parent = mkdtempSync(join(tmpdir(), 'kite-oss-upgrade-safety-'));
    roots.push(parent);
    const prefix = join(parent, 'managed');
    const firstMarker = await installOssCandidate({ archivePath: first.archivePath, prefix });
    const unknown = join(prefix, 'keep.txt');
    writeFileSync(unknown, 'user data');

    await expect(installOssCandidate({ archivePath: second.archivePath, prefix })).rejects.toThrow(
      'unknown entry',
    );
    expect(readInstallStatus(prefix)).toEqual(firstMarker);
    expect(existsSync(unknown)).toBe(true);
  });

  test('refuses to replace a managed install with a different platform target', async () => {
    const first = await createOssCandidateFixture('0.1.0');
    const otherTarget = await createOssCandidateFixture('0.1.1', {
      id: 'linux-x64',
      os: 'linux',
      arch: 'x64',
    });
    roots.push(first.root, otherTarget.root);
    const parent = mkdtempSync(join(tmpdir(), 'kite-oss-target-safety-'));
    roots.push(parent);
    const prefix = join(parent, 'managed');
    const firstMarker = await installOssCandidate({ archivePath: first.archivePath, prefix });

    await expect(
      installOssCandidate({ archivePath: otherTarget.archivePath, prefix }),
    ).rejects.toThrow('cannot be replaced');
    expect(readInstallStatus(prefix)).toEqual(firstMarker);
  });

  test('refuses rollback when the managed tree was altered', async () => {
    const first = await createOssCandidateFixture('0.1.0');
    const second = await createOssCandidateFixture('0.1.1');
    roots.push(first.root, second.root);
    const parent = mkdtempSync(join(tmpdir(), 'kite-oss-rollback-safety-'));
    roots.push(parent);
    const prefix = join(parent, 'managed');
    await installOssCandidate({ archivePath: first.archivePath, prefix });
    const secondMarker = await installOssCandidate({ archivePath: second.archivePath, prefix });
    const unknown = join(prefix, 'keep.txt');
    writeFileSync(unknown, 'user data');

    expect(() => rollbackOssCandidate(prefix)).toThrow('unknown entry');
    expect(readInstallStatus(prefix)).toEqual(secondMarker);
    expect(existsSync(unknown)).toBe(true);
  });
});
