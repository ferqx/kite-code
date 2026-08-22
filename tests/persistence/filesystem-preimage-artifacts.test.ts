import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FilesystemPreimageArtifactErrorV1,
  FilesystemPreimageArtifactStoreV1,
} from '@kite/builtin-runtime/filesystem';

const INTEGRITY_KEY = Buffer.alloc(32, 0x51);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('FilesystemPreimageArtifactStoreV1', () => {
  test('publishes owner-only immutable evidence under opaque keyed references', () => {
    const storageRoot = root();
    const store = new FilesystemPreimageArtifactStoreV1({
      root: storageRoot,
      integrityKey: INTEGRITY_KEY,
    });
    const input = artifactInput('private preimage');

    const first = store.write(input);
    const second = store.write(input);

    expect(second).toEqual(first);
    expect(first).toMatchObject({ kind: 'filesystem_preimage' });
    expect(first.artifactId).toMatch(/^pa_[0-9a-f]{64}$/u);
    expect(first.integrityIdentifier).toMatch(/^hmac-sha256:[0-9a-f]{64}$/u);
    const rawDigest = createHash('sha256').update(input.preimage.content!).digest('hex');
    expect(first.artifactId).not.toContain(rawDigest);
    expect(first.integrityIdentifier).not.toContain(rawDigest);
    expect(store.read(first)).toEqual({ artifactFormatVersion: 1, ...input });

    if (process.platform !== 'win32') {
      expect(statSync(storageRoot).mode & 0o777).toBe(0o700);
      expect(statSync(join(storageRoot, 'preimages')).mode & 0o777).toBe(0o700);
      expect(statSync(artifactPath(storageRoot, first.artifactId)).mode & 0o777).toBe(0o600);
    }
  });

  test('fails closed for missing and tampered immutable evidence', () => {
    const storageRoot = root();
    const store = new FilesystemPreimageArtifactStoreV1({
      root: storageRoot,
      integrityKey: INTEGRITY_KEY,
    });
    const missing = store.write(artifactInput('missing evidence'));
    unlinkSync(artifactPath(storageRoot, missing.artifactId));
    expectArtifactError(() => store.read(missing), 'artifact_missing');

    const tampered = store.write(artifactInput('tamper evidence'));
    const target = artifactPath(storageRoot, tampered.artifactId);
    writeFileSync(target, '{"tampered":true}', 'utf8');
    if (process.platform !== 'win32') chmodSync(target, 0o600);
    expectArtifactError(() => store.read(tampered), 'artifact_corrupt');
  });

  test('rejects wrong owners, malformed preimages, and broad storage roots', () => {
    const storageRoot = root();
    const store = new FilesystemPreimageArtifactStoreV1({
      root: storageRoot,
      integrityKey: INTEGRITY_KEY,
    });
    const ref = store.write(artifactInput('owned evidence'));
    const otherOwner = new FilesystemPreimageArtifactStoreV1({
      root: storageRoot,
      integrityKey: Buffer.alloc(32, 0x52),
    });
    expectArtifactError(() => otherOwner.read(ref), 'artifact_corrupt');

    expectArtifactError(
      () =>
        store.write({
          ...artifactInput('mismatch'),
          preimage: {
            ...artifactInput('mismatch').preimage,
            contentDigest: `sha256:${'0'.repeat(64)}`,
          },
        }),
      'invalid_preimage',
    );

    const broad = join(storageRoot, '..');
    expectArtifactError(
      () =>
        new FilesystemPreimageArtifactStoreV1({ root: broad, integrityKey: INTEGRITY_KEY }).write(
          artifactInput('broad root'),
        ),
      'storage_boundary_violation',
    );
  });
});

function artifactInput(content: string) {
  const bytes = Buffer.from(content, 'utf8');
  return {
    invocationId: 'invocation-1',
    operationDigest: `sha256:${'1'.repeat(64)}`,
    targetIdentityDigest: `sha256:${'2'.repeat(64)}`,
    preimage: {
      existed: true,
      content,
      contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      byteLength: bytes.byteLength,
    },
  } as const;
}

function artifactPath(storageRoot: string, artifactId: string): string {
  return join(storageRoot, 'preimages', `${artifactId}.json`);
}

function root(): string {
  const parent = mkdtempSync(join(tmpdir(), 'kite-filesystem-preimages-'));
  roots.push(parent);
  return join(parent, 'filesystem-preimages');
}

function expectArtifactError(
  operation: () => unknown,
  code: FilesystemPreimageArtifactErrorV1['code'],
): void {
  try {
    operation();
    throw new Error('expected FilesystemPreimageArtifactErrorV1');
  } catch (error) {
    expect(error).toBeInstanceOf(FilesystemPreimageArtifactErrorV1);
    if (!(error instanceof FilesystemPreimageArtifactErrorV1)) throw error;
    expect(error.code).toBe(code);
  }
}
