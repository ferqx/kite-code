import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pairedDesktopManifestDigest,
  parsePairedDesktopServiceManifest,
} from '../../src/paired-desktop-manifest';
import {
  inspectPairedDesktopDistribution,
  verifyPairedDesktopServiceArtifact,
} from '../../src/service/paired-desktop-admission';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kite-paired-desktop-'));
  roots.push(root);
  const service = join(root, 'service', 'kite-service');
  mkdirSync(join(root, 'service'));
  writeFileSync(service, 'paired-service-fixture');
  const manifest = {
    buildId: 'paired-fixture',
    environmentKeys: ['PATH', 'OPENAI_API_KEY'],
    executableSha256: sha('paired-service-fixture'),
    expectedServerVersion: `kite-app-server-v1-${sha('paired-fixture')}`,
  };
  writeFileSync(join(root, 'service', 'desktop.json'), JSON.stringify(manifest));
  return { root, service, manifest, digest: pairedDesktopManifestDigest(manifest) };
}

test('manifest digest is field-order stable and paired artifact rejects any digest or binary drift', () => {
  const data = fixture();
  expect(
    pairedDesktopManifestDigest({
      expectedServerVersion: data.manifest.expectedServerVersion,
      executableSha256: data.manifest.executableSha256,
      environmentKeys: data.manifest.environmentKeys,
      buildId: data.manifest.buildId,
    }),
  ).toBe(data.digest);
  expect(() =>
    parsePairedDesktopServiceManifest({ ...data.manifest, extra: 'unsupported' }),
  ).toThrow();
  for (const reserved of [
    'KITE_HOME',
    'kite_build_id',
    'HOME',
    'Home',
    'USERPROFILE',
    'node_env',
  ]) {
    expect(() =>
      parsePairedDesktopServiceManifest({ ...data.manifest, environmentKeys: ['PATH', reserved] }),
    ).toThrow();
  }
  expect(
    verifyPairedDesktopServiceArtifact({
      executablePath: data.service,
      expectedManifestDigest: data.digest,
      expectedBuildId: data.manifest.buildId,
    }).serviceSha256,
  ).toBe(data.manifest.executableSha256);
  expect(() =>
    verifyPairedDesktopServiceArtifact({
      executablePath: data.service,
      expectedManifestDigest: sha('wrong'),
      expectedBuildId: data.manifest.buildId,
    }),
  ).toThrow();
  writeFileSync(data.service, 'different-binary');
  expect(() =>
    verifyPairedDesktopServiceArtifact({
      executablePath: data.service,
      expectedManifestDigest: data.digest,
      expectedBuildId: data.manifest.buildId,
    }),
  ).toThrow();
});

test('distribution gate permits the same active Service and rejects unknown or different entrypoints', () => {
  const data = fixture();
  const prefix = join(data.root, 'managed');
  const apps = join(data.root, 'Applications');
  const missingPath = join(data.root, 'optional-bin');
  mkdirSync(prefix);
  mkdirSync(apps);
  const input = {
    serviceSha256: data.manifest.executableSha256,
    manifestSha256: data.digest,
    knownManagedPrefixes: [] as string[],
    searchPath: `${missingPath}:/usr/bin:/bin`,
    defaultManagedPrefix: prefix,
    applicationRoots: [apps],
  };
  expect(inspectPairedDesktopDistribution(input)).toBe('distribution_inspection_incomplete');
  const candidateId = 'a'.repeat(24);
  const candidateDir = join(prefix, 'releases', candidateId, 'bin');
  mkdirSync(candidateDir, { recursive: true });
  writeFileSync(join(prefix, 'active'), `${candidateId}\n`);
  writeFileSync(join(candidateDir, 'kite-service'), 'paired-service-fixture');
  expect(inspectPairedDesktopDistribution(input)).toBe('clear');
  writeFileSync(join(candidateDir, 'kite-service'), 'different-service');
  expect(inspectPairedDesktopDistribution(input)).toBe('other_distribution_differs');
  writeFileSync(join(candidateDir, 'kite-service'), 'paired-service-fixture');
  const unknownBin = join(data.root, 'unknown-bin');
  mkdirSync(unknownBin);
  writeFileSync(join(unknownBin, 'kite'), 'unknown');
  expect(
    inspectPairedDesktopDistribution({ ...input, searchPath: `${unknownBin}:/usr/bin:/bin` }),
  ).toBe('other_distribution_unknown');
  const appService = join(apps, 'kite.app', 'Contents', 'Resources', 'service');
  mkdirSync(appService, { recursive: true });
  writeFileSync(join(appService, 'kite-service'), 'paired-service-fixture');
  writeFileSync(join(appService, 'desktop.json'), JSON.stringify(data.manifest));
  expect(inspectPairedDesktopDistribution(input)).toBe('clear');
  writeFileSync(
    join(appService, 'desktop.json'),
    JSON.stringify({ ...data.manifest, buildId: 'different' }),
  );
  expect(inspectPairedDesktopDistribution(input)).toBe('other_distribution_differs');
});
