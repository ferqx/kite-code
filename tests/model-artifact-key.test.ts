import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadOrCreateModelArtifactIntegrityKeyV1,
  ModelArtifactIntegrityKeyError,
} from '@/core/model/model-artifact-key';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-model-key-')));
  roots.push(root);
  const userDirectory = join(root, '.kite-code');
  mkdirSync(userDirectory, { mode: 0o700 });
  return {
    userDirectory,
    keyPath: join(userDirectory, 'model-artifacts.key'),
    artifactRoot: join(userDirectory, 'model-artifacts'),
  };
}

describe('Model Artifact installation integrity key', () => {
  test('creates one owner-only key and reuses its exact identity', () => {
    const paths = fixture();
    const expected = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const first = loadOrCreateModelArtifactIntegrityKeyV1({
      ...paths,
      randomKey: () => expected,
    });
    const second = loadOrCreateModelArtifactIntegrityKeyV1({
      ...paths,
      randomKey: () => new Uint8Array(32).fill(255),
    });

    expect(first).toEqual(expected);
    expect(second).toEqual(expected);
    if (process.platform !== 'win32') {
      expect(statSync(paths.keyPath).mode & 0o777).toBe(0o600);
    }
  });

  test('does not mint a replacement key over an existing evidence namespace', () => {
    const paths = fixture();
    mkdirSync(paths.artifactRoot, { mode: 0o700 });
    writeFileSync(join(paths.artifactRoot, 'retained-evidence'), 'present');

    expect(() =>
      loadOrCreateModelArtifactIntegrityKeyV1({
        ...paths,
        randomKey: () => new Uint8Array(32).fill(7),
      }),
    ).toThrow('evidence exists');
  });

  test('safely tightens an owned canonical installation directory before key creation', () => {
    if (process.platform === 'win32') return;
    const paths = fixture();
    chmodSync(paths.userDirectory, 0o755);

    loadOrCreateModelArtifactIntegrityKeyV1({
      ...paths,
      randomKey: () => new Uint8Array(32).fill(9),
    });

    expect(statSync(paths.userDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(paths.keyPath).mode & 0o777).toBe(0o600);
  });

  test('fails closed on non-owner-only existing key material', () => {
    if (process.platform === 'win32') return;
    const paths = fixture();
    writeFileSync(paths.keyPath, new Uint8Array(32).fill(3), { mode: 0o600 });
    chmodSync(paths.keyPath, 0o644);

    let failure: unknown;
    try {
      loadOrCreateModelArtifactIntegrityKeyV1(paths);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ModelArtifactIntegrityKeyError);
    expect(failure).toMatchObject({ code: 'storage_boundary_violation' });
  });
});
