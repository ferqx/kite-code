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
import { buildSyntheticArtifact } from '../../scripts/release/build-artifact';
import {
  CanonicalJsonError,
  canonicalJson,
  canonicalJsonBytes,
  parseCanonicalJson,
  parseStrictJson,
  sha256Digest,
} from '../../scripts/release/canonical-json';
import { verifySyntheticReleaseArtifact } from '../../scripts/release/verify-artifact';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('release artifact layout', () => {
  test('builds repeatable detached synthetic fixtures without a production claim', () => {
    const first = fixtureDirectory();
    const second = fixtureDirectory();
    const payload = new TextEncoder().encode('deterministic payload bytes\n');

    const firstBuild = buildSyntheticArtifact({ directory: first, payload });
    const secondBuild = buildSyntheticArtifact({ directory: second, payload });

    expect(firstBuild.signature.distributable).toBe(false);
    expect(firstBuild.signature.realSigstoreSigningEnabled).toBe(false);
    expect(firstBuild.manifest).toEqual(secondBuild.manifest);
    expect(readFileSync(join(first, RELEASE_PAYLOAD_FILE))).toEqual(
      readFileSync(join(second, RELEASE_PAYLOAD_FILE)),
    );
    expect(readFileSync(join(first, RELEASE_MANIFEST_FILE))).toEqual(
      readFileSync(join(second, RELEASE_MANIFEST_FILE)),
    );
    expect(readFileSync(join(first, RELEASE_SIGNATURE_FILE))).toEqual(
      readFileSync(join(second, RELEASE_SIGNATURE_FILE)),
    );

    const verified = verifySyntheticReleaseArtifact(first);
    expect(verified.manifest.payloadSha256).toBe(sha256Digest(payload));
    expect(verified.payloadBytes).toEqual(payload);
  });

  test('keeps outer storage identity out of the detached manifest', () => {
    const directory = fixtureDirectory();
    const built = buildSyntheticArtifact({ directory });
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
  });

  test('uses one strict canonical JSON representation', () => {
    expect(canonicalJson({ z: 1, a: ['x', -0, true] })).toBe('{"a":["x",0,true],"z":1}');
    expect(parseCanonicalJson('{"a":1,"z":2}')).toEqual({ a: 1, z: 2 });
    expect(() => parseCanonicalJson('{ "a": 1 }')).toThrow(CanonicalJsonError);
    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow('Duplicate JSON key');
    expect(() => canonicalJson({ invalid: undefined })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ invalid: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => parseStrictJson('1e400')).toThrow(CanonicalJsonError);
    const sparse = Array<unknown>(2);
    sparse[1] = 1;
    expect(() => canonicalJson(sparse)).toThrow(CanonicalJsonError);
    const decorated = [1] as number[] & { extra?: number };
    decorated.extra = 2;
    expect(() => canonicalJson(decorated)).toThrow(CanonicalJsonError);
  });

  test('rejects unknown manifest fields and non-canonical manifest bytes', () => {
    const directory = fixtureDirectory();
    const built = buildSyntheticArtifact({ directory });
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
