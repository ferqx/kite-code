import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELEASE_MANIFEST_FILE, RELEASE_PAYLOAD_FILE } from '../../scripts/release/artifact-layout';
import { buildSyntheticArtifact } from '../../scripts/release/build-artifact';
import { canonicalJsonBytes } from '../../scripts/release/canonical-json';
import {
  createSyntheticPlatformLauncherIdentity,
  PlatformArtifactSmokeError,
  runPlatformArtifactSmoke,
} from '../../scripts/release/platform-smoke';

const roots: string[] = [];
const launcherBytes = new TextEncoder().encode('synthetic pre-exec launcher fixture\n');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('platform artifact supply-chain smoke', () => {
  test('verifies synthetic bytes but remains blocked by the empty production support set', () => {
    const { directory, identity } = fixture();
    const result = runPlatformArtifactSmoke({
      artifactDirectory: directory,
      launcherBytes,
      launcherIdentity: identity,
    });
    expect(result).toEqual({
      version: 1,
      status: 'blocked',
      reason: 'production_support_set_empty',
      platform: 'ubuntu-24.04-bubblewrap',
      nonDistributable: true,
      productionArtifact: false,
      checks: {
        canonicalManifest: 'verified_synthetic',
        payloadDigest: 'verified_synthetic',
        launcherDigest: 'verified_synthetic',
        nativePlatformSignature: 'not_run',
      },
    });
  });

  test('detects tampered payload bytes before any platform claim', () => {
    const { directory, identity } = fixture();
    writeFileSync(join(directory, RELEASE_PAYLOAD_FILE), 'tampered payload');
    expect(() =>
      runPlatformArtifactSmoke({
        artifactDirectory: directory,
        launcherBytes,
        launcherIdentity: identity,
      }),
    ).toThrow('Payload sha256');
  });

  test('detects tampered canonical manifest bytes before any platform claim', () => {
    const { directory, identity } = fixture();
    const manifestPath = join(directory, RELEASE_MANIFEST_FILE);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.productVersion = '0.0.0-tampered';
    writeFileSync(manifestPath, canonicalJsonBytes(manifest));
    expect(() =>
      runPlatformArtifactSmoke({
        artifactDirectory: directory,
        launcherBytes,
        launcherIdentity: identity,
      }),
    ).toThrow('subject digest');
  });

  test('detects launcher bytes and production-looking platform-signature substitution', () => {
    const { directory, identity } = fixture();
    expect(() =>
      runPlatformArtifactSmoke({
        artifactDirectory: directory,
        launcherBytes: new TextEncoder().encode('tampered launcher'),
        launcherIdentity: identity,
      }),
    ).toThrow(new PlatformArtifactSmokeError('launcher_digest_mismatch'));

    const productionLooking = {
      ...identity,
      nativeSignatureStatus: 'verified',
      nonDistributable: false,
      productionSupportClaim: true,
      realPlatformSigningEnabled: true,
    };
    expect(() =>
      runPlatformArtifactSmoke({
        artifactDirectory: directory,
        launcherBytes,
        launcherIdentity: productionLooking,
      }),
    ).toThrow(new PlatformArtifactSmokeError('launcher_identity_invalid'));
  });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'kite-platform-smoke-'));
  roots.push(directory);
  const artifact = buildSyntheticArtifact({ directory });
  const identity = createSyntheticPlatformLauncherIdentity({
    platform: 'ubuntu-24.04-bubblewrap',
    launcherBytes,
    canonicalManifestDigest: artifact.signature.manifestSha256,
  });
  return { directory, identity };
}
