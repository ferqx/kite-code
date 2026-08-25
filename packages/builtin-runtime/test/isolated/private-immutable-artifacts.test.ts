import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PrivateArtifactStorageError,
  PrivateImmutableArtifactStorage,
} from '@kite-ai/builtin-runtime/model';

type FixtureKind = 'surface' | 'response';

const PARTITIONS = [
  { kind: 'surface', directory: 'surfaces', extension: '.json' },
  { kind: 'response', directory: 'responses', extension: '.json' },
] as const;

let tempRoot: string | undefined;

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

function root(): string {
  tempRoot = mkdtempSync(join(tmpdir(), 'kite-private-artifacts-'));
  return join(tempRoot, 'private-store');
}

function store(
  storageRoot: string,
  options: {
    maxArtifactBytes?: number;
    faultInjector?: ConstructorParameters<
      typeof PrivateImmutableArtifactStorage<FixtureKind>
    >[0]['faultInjector'];
  } = {},
): PrivateImmutableArtifactStorage<FixtureKind> {
  return new PrivateImmutableArtifactStorage({
    root: storageRoot,
    namespace: 'private-store',
    partitions: PARTITIONS,
    maxArtifactBytes: options.maxArtifactBytes ?? 1024,
    ...(options.faultInjector ? { faultInjector: options.faultInjector } : {}),
  });
}

function artifactPath(storageRoot: string, kind: FixtureKind, artifactId: string): string {
  const directory = kind === 'surface' ? 'surfaces' : 'responses';
  return join(storageRoot, directory, `${artifactId}.json`);
}

describe('PrivateImmutableArtifactStorage', () => {
  test('publishes owner-only immutable content under content-addressed identities', () => {
    const storageRoot = root();
    const artifacts = store(storageRoot);
    const payload = Buffer.from('{"private":"request body"}', 'utf8');

    const first = artifacts.write('surface', payload);
    const second = artifacts.write('surface', payload);
    const otherKind = artifacts.write('response', payload);

    expect(second).toEqual(first);
    expect(otherKind.artifactId).not.toBe(first.artifactId);
    expect(Buffer.from(artifacts.read(first))).toEqual(payload);
    expect(first.artifactId).toMatch(/^pa_[0-9a-f]{64}$/);
    expect(first.integrityIdentifier).toMatch(/^sha256:[0-9a-f]{64}$/);
    const rawDigest = createHash('sha256').update(payload).digest('hex');
    expect(first.artifactId).not.toContain(rawDigest);
    expect(first.integrityIdentifier).not.toContain(rawDigest);
    if (process.platform !== 'win32') {
      expect(statSync(storageRoot).mode & 0o777).toBe(0o700);
      expect(statSync(join(storageRoot, 'surfaces')).mode & 0o777).toBe(0o700);
      expect(statSync(artifactPath(storageRoot, 'surface', first.artifactId)).mode & 0o777).toBe(
        0o600,
      );
    }
  });

  test('fails closed for malformed refs, corruption, and oversize content', () => {
    const storageRoot = root();
    const artifacts = store(storageRoot);
    const ref = artifacts.write('surface', Buffer.from('private body'));
    expect(() => artifacts.read({ ...ref, extra: true } as typeof ref)).toThrow(
      PrivateArtifactStorageError,
    );
    let getterCalled = false;
    const accessorRef = { ...ref };
    Object.defineProperty(accessorRef, 'artifactId', {
      enumerable: true,
      get() {
        getterCalled = true;
        return ref.artifactId;
      },
    });
    expect(() => artifacts.read(accessorRef)).toThrow(PrivateArtifactStorageError);
    expect(getterCalled).toBe(false);
    const target = artifactPath(storageRoot, 'surface', ref.artifactId);
    writeFileSync(target, 'tampered', 'utf8');
    chmodSync(target, 0o600);
    expect(() => artifacts.read(ref)).toThrow(PrivateArtifactStorageError);
    expect(() =>
      store(storageRoot, { maxArtifactBytes: 2 }).write('surface', Buffer.from('xxx')),
    ).toThrow(PrivateArtifactStorageError);
  });

  test('rejects symlink roots, symlink targets, and hardlinked targets', () => {
    const storageRoot = root();
    const realRoot = join(tempRoot!, 'real-store');
    mkdirSync(realRoot, { mode: 0o700 });
    symlinkSync(realRoot, storageRoot, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => store(storageRoot).write('surface', Buffer.from('x'))).toThrow(
      PrivateArtifactStorageError,
    );

    rmSync(storageRoot, { force: true });
    const artifacts = store(storageRoot);
    const symlinkRef = artifacts.write('surface', Buffer.from('symlink target'));
    const symlinkTarget = artifactPath(storageRoot, 'surface', symlinkRef.artifactId);
    const external = join(tempRoot!, 'external.json');
    writeFileSync(external, readFileSync(symlinkTarget));
    chmodSync(external, 0o600);
    unlinkSync(symlinkTarget);
    symlinkSync(external, symlinkTarget);
    expect(() => artifacts.read(symlinkRef)).toThrow(PrivateArtifactStorageError);

    unlinkSync(symlinkTarget);
    const hardlinkRef = artifacts.write('surface', Buffer.from('hardlink target'));
    const hardlinkTarget = artifactPath(storageRoot, 'surface', hardlinkRef.artifactId);
    linkSync(hardlinkTarget, join(storageRoot, 'surfaces', 'second-link.json'));
    expect(lstatSync(hardlinkTarget).nlink).toBeGreaterThan(1);
    expect(() => artifacts.read(hardlinkRef)).toThrow(PrivateArtifactStorageError);
  });

  test('recovers idempotently at both immutable publish crash boundaries', () => {
    const storageRoot = root();
    const beforePublish = store(storageRoot, {
      faultInjector(point) {
        if (point === 'after_temporary_file_fsync') throw new Error('synthetic crash');
      },
    });
    expect(() => beforePublish.write('surface', Buffer.from('before publish'))).toThrow(
      PrivateArtifactStorageError,
    );
    expect(readdirSync(join(storageRoot, 'surfaces'))).toEqual([]);

    const afterPublish = store(storageRoot, {
      faultInjector(point) {
        if (point === 'after_atomic_publish_before_directory_fsync') {
          throw new Error('synthetic crash');
        }
      },
    });
    expect(() => afterPublish.write('surface', Buffer.from('after publish'))).toThrow(
      PrivateArtifactStorageError,
    );
    const recoveredStore = store(storageRoot);
    const recovered = recoveredStore.write('surface', Buffer.from('after publish'));
    expect(Buffer.from(recoveredStore.read(recovered)).toString('utf8')).toBe('after publish');
  });

  test('lets concurrent same-content publishers converge on one immutable reference', async () => {
    const storageRoot = root();
    const env = {
      ...process.env,
      KITE_PRIVATE_ARTIFACT_TEST_ROOT: storageRoot,
      KITE_PRIVATE_ARTIFACT_TEST_PAYLOAD: '{"same":"content"}',
    };
    const command = [process.execPath, 'tests/fixtures/private-artifact-writer.ts'];
    const children = [
      Bun.spawn(command, { cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe' }),
      Bun.spawn(command, { cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe' }),
    ];
    const results = await Promise.all(
      children.map(async (child) => ({
        exitCode: await child.exited,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      })),
    );
    expect(results.map((result) => [result.exitCode, result.stderr])).toEqual([
      [0, ''],
      [0, ''],
    ]);
    const refs = results.map((result) => JSON.parse(result.stdout));
    expect(refs[0]).toEqual(refs[1]);
    expect(Buffer.from(store(storageRoot).read(refs[0])).toString('utf8')).toBe(
      '{"same":"content"}',
    );
  });

  test('collects only old artifacts outside a complete all-fork reachability union', () => {
    const storageRoot = root();
    const artifacts = store(storageRoot);
    const sharedBySourceAndFork = artifacts.write('surface', Buffer.from('shared'));
    const orphan = artifacts.write('response', Buffer.from('orphan'));
    const old = new Date('2026-01-01T00:00:00.000Z');
    utimesSync(artifactPath(storageRoot, 'surface', sharedBySourceAndFork.artifactId), old, old);
    utimesSync(artifactPath(storageRoot, 'response', orphan.artifactId), old, old);

    expect(() =>
      artifacts.collectGarbage({
        reachability: { complete: false, reachable: [sharedBySourceAndFork] },
        minimumRetentionMs: 0,
        nowMs: Date.parse('2026-08-16T00:00:00.000Z'),
      }),
    ).toThrow(PrivateArtifactStorageError);
    expect(Buffer.from(artifacts.read(orphan)).toString('utf8')).toBe('orphan');

    const result = artifacts.collectGarbage({
      reachability: {
        complete: true,
        reachable: [sharedBySourceAndFork, sharedBySourceAndFork],
      },
      minimumRetentionMs: 1,
      nowMs: Date.parse('2026-08-16T00:00:00.000Z'),
    });
    expect(result.deletedArtifacts).toBe(1);
    expect(result.retainedArtifacts).toBe(1);
    expect(Buffer.from(artifacts.read(sharedBySourceAndFork)).toString('utf8')).toBe('shared');
    expect(() => artifacts.read(orphan)).toThrow(PrivateArtifactStorageError);
  });

  test('finishes a bounded validation scan before deleting and fails closed on unknown entries', () => {
    const storageRoot = root();
    const artifacts = store(storageRoot);
    const orphan = artifacts.write('surface', Buffer.from('orphan'));
    const old = new Date('2026-01-01T00:00:00.000Z');
    const orphanPath = artifactPath(storageRoot, 'surface', orphan.artifactId);
    utimesSync(orphanPath, old, old);
    const unknown = join(storageRoot, 'surfaces', 'unknown.json');
    writeFileSync(unknown, 'unknown', { mode: 0o600 });

    expect(() =>
      artifacts.collectGarbage({
        reachability: { complete: true, reachable: [] },
        minimumRetentionMs: 1,
        nowMs: Date.parse('2026-08-16T00:00:00.000Z'),
      }),
    ).toThrow(PrivateArtifactStorageError);
    expect(readFileSync(orphanPath, 'utf8')).toBe('orphan');
  });

  test('collects aged crash residue only with a complete reachability proof', () => {
    const storageRoot = root();
    const artifacts = store(storageRoot);
    const retained = artifacts.write('surface', Buffer.from('retained'));
    const residue = join(
      storageRoot,
      'surfaces',
      `.${retained.artifactId}.123.00000000-0000-4000-8000-000000000000.tmp`,
    );
    writeFileSync(residue, 'crash residue', { mode: 0o600 });
    const old = new Date('2026-01-01T00:00:00.000Z');
    utimesSync(residue, old, old);

    expect(() =>
      store(storageRoot).collectGarbage({
        reachability: { complete: false, reachable: [] },
        minimumRetentionMs: 1,
        nowMs: Date.parse('2026-08-16T00:00:00.000Z'),
      }),
    ).toThrow(PrivateArtifactStorageError);
    expect(readFileSync(residue, 'utf8')).toBe('crash residue');

    const result = artifacts.collectGarbage({
      reachability: { complete: true, reachable: [retained] },
      minimumRetentionMs: 1,
      nowMs: Date.parse('2026-08-16T00:00:00.000Z'),
    });
    expect(result.deletedTemporaryFiles).toBe(1);
    expect(() => readFileSync(residue, 'utf8')).toThrow();
    expect(Buffer.from(artifacts.read(retained)).toString('utf8')).toBe('retained');
  });

  test('does not delete an orphan when any reachable artifact is missing', () => {
    const storageRoot = root();
    const artifacts = store(storageRoot);
    const reachable = artifacts.write('surface', Buffer.from('reachable'));
    const orphan = artifacts.write('response', Buffer.from('orphan'));
    const orphanPath = artifactPath(storageRoot, 'response', orphan.artifactId);
    const old = new Date('2026-01-01T00:00:00.000Z');
    utimesSync(orphanPath, old, old);
    unlinkSync(artifactPath(storageRoot, 'surface', reachable.artifactId));

    expect(() =>
      artifacts.collectGarbage({
        reachability: { complete: true, reachable: [reachable] },
        minimumRetentionMs: 1,
        nowMs: Date.parse('2026-08-16T00:00:00.000Z'),
      }),
    ).toThrow(PrivateArtifactStorageError);
    expect(readFileSync(orphanPath, 'utf8')).toBe('orphan');
  });
});
