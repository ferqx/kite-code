import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pairedDesktopManifestDigest,
  parsePairedDesktopServiceManifest,
} from '../../../src/paired-desktop-manifest';
import { observeLegacyKiteStoreProcesses } from '../../../src/service/legacy-store-processes';
import { verifyPairedDesktopServiceArtifact } from '../../../src/service/paired-desktop-admission';

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

test('live legacy Service only blocks its own Store home', async () => {
  if (process.platform !== 'darwin') return;
  const root = mkdtempSync(join(tmpdir(), 'kite-paired-homes-'));
  roots.push(root);
  const firstHome = join(root, 'first');
  const secondHome = join(root, 'second');
  const entrypoint = join(root, 'scripts', 'release', 'entrypoints', 'service.ts');
  mkdirSync(firstHome);
  mkdirSync(secondHome);
  mkdirSync(join(root, 'scripts', 'release', 'entrypoints'), { recursive: true });
  writeFileSync(
    entrypoint,
    "process.stdout.write('ready\\n'); setInterval(() => undefined, 1000);\n",
  );
  const child = Bun.spawn([process.execPath, entrypoint, 'app-server', 'run-stdio'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, KITE_CODE_CONFIG_HOME: firstHome, KITE_CODE_HOME: firstHome },
  });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain('ready');
    reader.releaseLock();
    const first = observeLegacyKiteStoreProcesses({ canonicalKiteHome: firstHome });
    expect(first.status).toBe('busy');
    if (first.status === 'busy')
      expect(first.matches.some((match) => match.pid === child.pid)).toBe(true);
    const second = observeLegacyKiteStoreProcesses({ canonicalKiteHome: secondHome });
    expect(second.status).toBe('complete');
  } finally {
    child.kill('SIGTERM');
    await child.exited;
  }
});
