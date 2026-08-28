import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import {
  createKiteHomeIdentity,
  ensureLocalRuntimeServiceHome,
} from '@kite-ai/kite-local-runtime/service';
import {
  installOssCandidate as installCandidate,
  readInstallStatus,
  rollbackOssCandidate as rollbackCandidate,
  uninstallOssCandidate as uninstallCandidate,
} from '../../scripts/release/install-oss-candidate';
import {
  currentOssReleaseTarget,
  type OssReleaseTarget,
} from '../../scripts/release/oss-candidate';
import { createOssCandidateFixture } from './helpers/oss-candidate-fixture';

const roots: string[] = [];

setDefaultTimeout(60_000);

function serviceHome(prefix: string) {
  const root = join(realpathSync(dirname(resolve(prefix))), 'service-home');
  return ensureLocalRuntimeServiceHome(createKiteHomeIdentity(root, 'explicit_argument'));
}

function installOssCandidate(input: { archivePath: string; prefix: string }) {
  if (resolve(input.prefix) === parse(resolve(input.prefix)).root) return installCandidate(input);
  return installCandidate({ ...input, serviceHome: serviceHome(input.prefix) });
}

function rollbackOssCandidate(prefix: string) {
  return rollbackCandidate(prefix, { serviceHome: serviceHome(prefix) });
}

function uninstallOssCandidate(prefix: string) {
  return uninstallCandidate(prefix, { serviceHome: serviceHome(prefix) });
}

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
    expectAdjacentCompanionAssets(prefix, firstMarker.currentCandidateId);
    const secondMarker = await installOssCandidate({ archivePath: second.archivePath, prefix });
    expectAdjacentCompanionAssets(prefix, secondMarker.currentCandidateId);
    expect(secondMarker.previousCandidateId).toBe(firstMarker.currentCandidateId);
    const rolledBack = rollbackOssCandidate(prefix);
    expect(rolledBack.currentCandidateId).toBe(firstMarker.currentCandidateId);
    expect(readInstallStatus(prefix)).toEqual(rolledBack);
    uninstallOssCandidate(prefix);
    expect(existsSync(prefix)).toBe(false);
  });

  test('fails closed when the active pointer no longer matches its marker', async () => {
    const fixture = await createOssCandidateFixture('0.1.0');
    roots.push(fixture.root);
    const parent = mkdtempSync(join(tmpdir(), 'kite-oss-pointer-integrity-'));
    roots.push(parent);
    const prefix = join(parent, 'managed');
    const marker = await installOssCandidate({ archivePath: fixture.archivePath, prefix });
    writeFileSync(join(prefix, 'active'), `${'f'.repeat(24)}\n`);

    expect(() => readInstallStatus(prefix)).toThrow('pointer');
    expect(
      readFileSync(join(prefix, 'releases', marker.currentCandidateId, '.candidate-id'), 'utf8'),
    ).toBe(`${marker.currentCandidateId}\n`);
  });

  test('uses the supplied custom Service home when uninstall stops the active Service', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'kite-oss-custom-service-home-'));
    roots.push(parent);
    const prefix = join(parent, 'managed');
    const identity = serviceHome(prefix);
    const firstLog = join(parent, 'first-arguments.log');
    const secondLog = join(parent, 'second-arguments.log');
    const first = await createOssCandidateFixture(
      '0.1.0',
      currentOssReleaseTarget(),
      'applied',
      firstLog,
    );
    const second = await createOssCandidateFixture(
      '0.1.1',
      currentOssReleaseTarget(),
      'applied',
      secondLog,
    );
    roots.push(first.root, second.root);

    await installCandidate({ archivePath: first.archivePath, prefix, serviceHome: identity });
    await installCandidate({ archivePath: second.archivePath, prefix, serviceHome: identity });
    rollbackCandidate(prefix, { serviceHome: identity });
    uninstallCandidate(prefix, { serviceHome: identity });

    expectAllKiteHomeArguments(firstLog, identity.root);
    expect(existsSync(secondLog)).toBe(false);
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

  test('rejects repository descendants even when invoked from an unrelated cwd', async () => {
    const fixture = await createOssCandidateFixture('0.1.0');
    roots.push(fixture.root);
    const unrelated = mkdtempSync(join(tmpdir(), 'kite-oss-unrelated-cwd-'));
    roots.push(unrelated);
    const previousCwd = process.cwd();
    process.chdir(unrelated);
    try {
      await expect(
        installCandidate({
          archivePath: fixture.archivePath,
          prefix: join(resolve(import.meta.dir, '../..'), '.installer-must-not-write-here'),
        }),
      ).rejects.toThrow('repository');
    } finally {
      process.chdir(previousCwd);
    }
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

  test('switches the active pointer while ordinary Service stop is busy', async () => {
    const target = currentOssReleaseTarget();
    const parent = mkdtempSync(join(tmpdir(), 'kite-oss-upgrade-busy-'));
    roots.push(parent);
    const stopLog = join(parent, 'stop-arguments.log');
    const first = await createOssCandidateFixture('0.1.0', target, 'service_busy', stopLog);
    const second = await createOssCandidateFixture('0.1.1');
    roots.push(first.root, second.root);
    const prefix = join(parent, 'managed');
    const firstMarker = await installOssCandidate({ archivePath: first.archivePath, prefix });

    const firstPayload = readFileSync(
      join(prefix, 'releases', firstMarker.currentCandidateId, 'bin', 'kite'),
    );
    const stableLauncher = readFileSync(join(prefix, 'bin', 'kite'));
    const secondMarker = await installOssCandidate({ archivePath: second.archivePath, prefix });
    expect(secondMarker.currentCandidateId).not.toBe(firstMarker.currentCandidateId);
    expect(readFileSync(join(prefix, 'active'), 'utf8')).toBe(
      `${secondMarker.currentCandidateId}\n`,
    );
    expect(
      readFileSync(join(prefix, 'releases', firstMarker.currentCandidateId, 'bin', 'kite')),
    ).toEqual(firstPayload);
    expect(readFileSync(join(prefix, 'bin', 'kite'))).toEqual(stableLauncher);
    expect(readdirSync(join(prefix, 'releases'))).toHaveLength(2);
    expect(existsSync(stopLog)).toBe(false);
  });

  test('refuses to replace a managed install with a different platform target', async () => {
    const first = await createOssCandidateFixture('0.1.0');
    const otherTarget = await createOssCandidateFixture('0.1.1', nonNativeTarget());
    roots.push(first.root, otherTarget.root);
    const parent = mkdtempSync(join(tmpdir(), 'kite-oss-target-safety-'));
    roots.push(parent);
    const prefix = join(parent, 'managed');
    const firstMarker = await installOssCandidate({ archivePath: first.archivePath, prefix });

    await expect(
      installOssCandidate({ archivePath: otherTarget.archivePath, prefix }),
    ).rejects.toThrow('does not match');
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

function expectAdjacentCompanionAssets(prefix: string, candidateId: string): void {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  for (const name of ['kite-coordinator', 'kite-worker', 'kite-web-gateway']) {
    const stable = join(prefix, 'bin', `${name}${suffix}`);
    const candidate = join(prefix, 'releases', candidateId, 'bin', `${name}${suffix}`);
    const stableStat = lstatSync(stable);
    const candidateStat = lstatSync(candidate);
    expect(stableStat.isSymbolicLink()).toBe(false);
    expect(candidateStat.isSymbolicLink()).toBe(false);
    expect(stableStat.isFile()).toBe(true);
    expect(candidateStat.isFile()).toBe(true);
  }
}

function nonNativeTarget(): OssReleaseTarget {
  const current = currentOssReleaseTarget();
  return current.id === 'macos-arm64'
    ? { id: 'linux-x64', os: 'linux', arch: 'x64', executableSuffix: '' }
    : { id: 'macos-arm64', os: 'darwin', arch: 'arm64', executableSuffix: '' };
}

function expectAllKiteHomeArguments(path: string, expectedHome: string): void {
  const args = readFileSync(path, 'utf8').trim().split('\n');
  const positions = args.flatMap((value, index) => (value === '--kite-home' ? [index] : []));
  expect(positions.length).toBeGreaterThan(0);
  for (const position of positions) expect(args[position + 1]).toBe(expectedHome);
}
