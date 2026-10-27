import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeReleaseManifest,
  RELEASE_MANIFEST_FILE,
  RELEASE_PAYLOAD_FILE,
  RELEASE_SIGNATURE_FILE,
  ReleaseArtifactError,
  releaseArtifactLayout,
} from '../../scripts/release/artifact-layout';
import {
  canonicalJson,
  canonicalJsonBytes,
  sha256Digest,
} from '../../scripts/release/canonical-json';
import { verifySyntheticReleaseArtifact } from '../../scripts/release/verify-artifact';
import { writeSyntheticArtifactFixture } from './helpers/synthetic-artifact-fixture';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('release artifact layout', () => {
  test('keeps outer storage identity out of the detached manifest', () => {
    const directory = fixtureDirectory();
    const built = writeSyntheticArtifactFixture(directory);
    const layout = releaseArtifactLayout(directory);
    const manifest = JSON.parse(readFileSync(layout.manifest, 'utf8')) as Record<string, unknown>;

    expect(layout).toEqual({
      directory,
      payload: join(directory, RELEASE_PAYLOAD_FILE),
      manifest: join(directory, RELEASE_MANIFEST_FILE),
      signature: join(directory, RELEASE_SIGNATURE_FILE),
    });
    expect(Object.keys(manifest)).not.toContain('storageIdentity');
    expect(Object.keys(manifest)).not.toContain('bundleSha256');
    expect(JSON.stringify(manifest)).not.toContain(directory);
    expect(built.manifest.payloadSha256).toBe(sha256Digest(readFileSync(layout.payload)));
    const verified = verifySyntheticReleaseArtifact(directory);
    expect(verified.manifest).toEqual(built.manifest);
    expect(verified.payloadBytes).toEqual(readFileSync(layout.payload));
  });

  test('rejects unknown manifest fields and non-canonical manifest bytes', () => {
    const directory = fixtureDirectory();
    const built = writeSyntheticArtifactFixture(directory);
    const unknown = { ...built.manifest, storageIdentity: 'outside-manifest' };

    expect(() => decodeReleaseManifest(canonicalJsonBytes(unknown))).toThrow(ReleaseArtifactError);
    expect(() => decodeReleaseManifest(`${canonicalJson(built.manifest)}\n`)).toThrow(
      'not in canonical form',
    );
  });
});

function fixtureDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kite-release-layout-'));
  roots.push(directory);
  return directory;
}
