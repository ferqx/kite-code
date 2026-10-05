import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createArtifactStore } from '../../../src/artifacts';
import { artifactPath } from '../../../src/artifacts-files';
import { createWindowsArtifactTemporary } from '../../../src/platform/windows-artifact-files';
import { defaultWindowsPathSecurity } from '../../../src/platform/windows-path-security';
import { openSqliteStore } from '../../../src/sqlite';
import { buildStorageAssets } from '../../../src/storage/worker/build-assets';

const body = Buffer.concat([
  Buffer.from('\ufeffowned native media\r\n'),
  Buffer.alloc(200003, 0x61),
]);
const hash = createHash('sha256').update(body).digest('hex');
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-windows-media-')));
  const profile = { dataRoot: join(root, 'private'), profile: 'owned' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: pathToFileURL(root).href,
    name: 'owned',
  });
  await store.createSession({
    expectedStoreId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'owned',
    subjectId: 'owner',
  });
  const artifacts = createArtifactStore({ profile, store });
  const input = {
    expectedStoreId,
    sessionId: 's',
    subjectId: 'owner',
    scope: { kind: 'session' as const, id: 's' },
    refId: 'body',
    mediaType: 'text/plain',
  };
  return {
    root,
    profile,
    store,
    artifacts,
    input,
    async close() {
      await artifacts.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function rejects(work: Promise<unknown>) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  return error;
}
test.skipIf(process.platform === 'win32')(
  'Windows media import is inert in Node/POSIX and does not create authority',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-media-lazy-'));
    try {
      expect(() => createWindowsArtifactTemporary(root)).toThrow('artifact_platform_unsupported');
      const built = await Bun.build({
        entrypoints: [
          fileURLToPath(
            new URL('../../../src/platform/windows-artifact-files.ts', import.meta.url),
          ),
        ],
        outdir: root,
        target: 'node',
        packages: 'external',
      });
      expect(built.success).toBe(true);
      const child = spawnSync(
        'node',
        [
          '--input-type=module',
          '-e',
          `const m=await import(${JSON.stringify(pathToFileURL(join(root, 'windows-artifact-files.js')).href)});if(typeof m.readWindowsArtifactChunks!=='function')throw Error('missing');`,
        ],
        { encoding: 'utf8' },
      );
      expect(child.status).toBe(0);
      expect(child.stderr).toBe('');
      expect(readdirSync(root)).toEqual(['windows-artifact-files.js']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
// Actual Windows cases are mandatory on win32, with no backend availability skip or injected security.
test.skipIf(process.platform !== 'win32')(
  'native complete streams, cancel, early-return and readonly scope retain exact media without extra writes',
  async () => {
    const f = await fixture();
    try {
      async function* content() {
        yield body.subarray(0, 17);
        yield body.subarray(17);
      }
      const ref = await f.artifacts.publishStream({ ...f.input, content: content() });
      expect(ref.hash).toBe(hash);
      expect(ref.size).toBe(String(body.length));
      expect(Buffer.from(await f.artifacts.read(f.input))).toEqual(body);
      await rejects(f.artifacts.read({ ...f.input, subjectId: 'foreign' }));
      await rejects(f.artifacts.read({ ...f.input, expectedStoreId: 'foreign' }));
      const iterator = f.artifacts.readStream(f.input)[Symbol.asyncIterator]();
      expect((await iterator.next()).value?.length).toBe(65536);
      await iterator.return?.();
      const signal = new AbortController();
      async function* canceled() {
        yield body.subarray(0, 65536);
        signal.abort();
        yield body.subarray(65536);
      }
      await rejects(
        f.artifacts.publishStream({
          ...f.input,
          refId: 'canceled',
          content: canceled(),
          signal: signal.signal,
        }),
      );
      expect(await f.store.getArtifactReference({ ...f.input, refId: 'canceled' })).toBeNull();
      expect(
        readdirSync(join(f.profile.dataRoot, 'owned', 'blobs')).some((name) =>
          name.startsWith('.publish-'),
        ),
      ).toBe(false);
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      async function* draining() {
        yield body.subarray(0, 65536);
        enter();
        await gate;
        yield body.subarray(65536);
      }
      const publication = f.artifacts.publishStream({
        ...f.input,
        refId: 'drained',
        content: draining(),
      });
      await entered;
      let closed = false;
      const closing = f.artifacts.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      await rejects(f.artifacts.publish({ ...f.input, refId: 'after-close', content: body }));
      resume();
      expect((await publication).hash).toBe(hash);
      await closing;
      expect(closed).toBe(true);
      await f.store.close();
      const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' }),
        reader = createArtifactStore({ profile: f.profile, store: cold });
      try {
        const before = await cold.getMetadata();
        expect(Buffer.from(await reader.read(f.input))).toEqual(body);
        expect(await cold.getMetadata()).toEqual(before);
      } finally {
        await reader.close();
        await cold.close();
      }
    } finally {
      await f.close();
    }
  },
  10000,
);
test.skipIf(process.platform !== 'win32')(
  'native no-overwrite publication and real SQL failure leave only verified orphan, reject broad ACL and links',
  async () => {
    const f = await fixture();
    const database = new Database(join(f.profile.dataRoot, 'owned', 'core.db'));
    try {
      database.run(
        "CREATE TRIGGER artifact_fault BEFORE INSERT ON blob_ref BEGIN SELECT RAISE(ABORT,'owned media SQL fault'); END",
      );
      await rejects(f.artifacts.publish({ ...f.input, content: body }));
      const path = artifactPath(join(f.profile.dataRoot, 'owned'), hash);
      expect(readFileSync(path)).toEqual(body);
      expect(await f.store.getArtifactReference(f.input)).toBeNull();
      expect(database.query('SELECT count(*) AS n FROM blob_ref').get()).toEqual({ n: 0 });
      database.run('DROP TRIGGER artifact_fault');
      const ref = await f.artifacts.publish({ ...f.input, content: body });
      expect(ref.hash).toBe(hash);
      // Owned native fault probe: valid FR/nlink media with deliberately wrong hash must fail at EOF.
      const original = Buffer.from('expected full EOF'),
        changed = Buffer.from('modified full EOF');
      const badHash = createHash('sha256').update(original).digest('hex');
      const temporary = createWindowsArtifactTemporary(join(f.profile.dataRoot, 'owned'));
      try {
        temporary.write(changed);
        temporary.publish(badHash, String(changed.length));
      } finally {
        temporary.close();
      }
      await rejects(
        f.store.registerArtifact({
          ...f.input,
          refId: 'bad-hash',
          hash: badHash,
          size: String(changed.length),
        }),
      );
      expect(await f.store.getArtifactReference({ ...f.input, refId: 'bad-hash' })).toBeNull();
      // A host path-replacement probe must not redirect a hash publication outside the Profile.
      const junctionBody = Buffer.from('junction publication'),
        junctionHash = createHash('sha256').update(junctionBody).digest('hex');
      const outside = join(f.root, 'outside'),
        junction = join(f.profile.dataRoot, 'owned', 'blobs', junctionHash.slice(0, 2));
      expect(junctionHash.slice(0, 2)).not.toBe(hash.slice(0, 2));
      expect(junctionHash.slice(0, 2)).not.toBe(badHash.slice(0, 2));
      mkdirSync(outside);
      symlinkSync(outside, junction, 'junction');
      try {
        await rejects(
          f.artifacts.publish({ ...f.input, refId: 'junction', content: junctionBody }),
        );
        expect(readdirSync(outside)).toEqual([]);
        expect(await f.store.getArtifactReference({ ...f.input, refId: 'junction' })).toBeNull();
      } finally {
        unlinkSync(junction);
      }
      const other = join(f.root, 'other-link');
      linkSync(path, other);
      try {
        await rejects(f.artifacts.read(f.input));
        await rejects(f.artifacts.publish({ ...f.input, refId: 'hardlink', content: body }));
      } finally {
        unlinkSync(other);
      }
      const acl = spawnSync('icacls', [path, '/grant', '*S-1-1-0:(F)'], { encoding: 'utf8' });
      expect(acl.status).toBe(0);
      const bytesBefore = readFileSync(path);
      await rejects(f.artifacts.read(f.input));
      await rejects(f.artifacts.publish({ ...f.input, refId: 'wide', content: body }));
      expect(readFileSync(path)).toEqual(bytesBefore);
      expect(await f.store.getArtifactReference({ ...f.input, refId: 'wide' })).toBeNull();
      writeFileSync(path, Buffer.alloc(body.length, 0x62));
      await rejects(f.artifacts.read(f.input));
      // The fault is never repaired: the original successful reference remains historical, unreadable.
      expect((await f.store.getArtifactReference(f.input))?.hash).toBe(hash);
    } finally {
      database.close();
      await f.close();
    }
  },
  10000,
);
async function external(root: string) {
  const packageRoot = join(root, 'external', 'node_modules', '@kite-ai', 'agent');
  const dist = join(packageRoot, 'dist');
  mkdirSync(dist, { recursive: true });
  const built = await Bun.build({
    entrypoints: [
      fileURLToPath(new URL('../../../src/artifacts.ts', import.meta.url)),
      fileURLToPath(new URL('../../../src/sqlite.ts', import.meta.url)),
      fileURLToPath(new URL('./windows-child.ts', import.meta.url)),
    ],
    root: fileURLToPath(new URL('../../../', import.meta.url)),
    outdir: dist,
    target: 'bun',
    packages: 'bundle',
    external: ['@kite-ai/agent/artifacts', '@kite-ai/agent/sqlite'],
    splitting: true,
  });
  expect(built.success).toBe(true);
  await buildStorageAssets(join(dist, 'src'));
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: '@kite-ai/agent',
      type: 'module',
      exports: { './artifacts': './dist/src/artifacts.js', './sqlite': './dist/src/sqlite.js' },
    }),
  );
  return join(dist, 'test', 'isolated', 'artifacts', 'windows-child.js');
}
async function runChild(script: string, root: string, mode: string, id: string) {
  const child = Bun.spawn([process.execPath, script, root, mode, id], {
    cwd: tmpdir(),
    env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', BUN_OPTIONS: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    return JSON.parse(stdout);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}
test('source-free public Store/Artifact double-process same-hash and readonly cold query perform no replay', async () => {
  const f = await fixture();
  try {
    const script = await external(f.root);
    const [a, b] = await Promise.all([
      runChild(script, f.profile.dataRoot, 'publish', 'race'),
      runChild(script, f.profile.dataRoot, 'publish', 'race'),
    ]);
    expect(a).toEqual(b);
    expect(a.hash).toBe(hash);
    const before = await f.store.getMetadata();
    const cold = await runChild(script, f.profile.dataRoot, 'cold', 'race');
    expect(cold).toEqual({ hash, size: String(body.length), sameMetadata: true });
    expect(await f.store.getMetadata()).toEqual(before);
    expect(Buffer.from(await f.artifacts.read({ ...f.input, refId: 'race' }))).toEqual(body);
  } finally {
    await f.close();
  }
}, 30000);
test.skipIf(process.platform !== 'win32')(
  'owned Windows processes killed before publication and after native publication-before-SQL do not fabricate references',
  async () => {
    const f = await fixture();
    try {
      const script = await external(f.root);
      for (const mode of ['before_publish', 'before_sql']) {
        const child = Bun.spawn([process.execPath, script, f.profile.dataRoot, mode, mode], {
          cwd: tmpdir(),
          env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', BUN_OPTIONS: '' },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
        try {
          const reader = child.stdout.getReader();
          let output = '';
          try {
            while (!output.includes('\n')) {
              const next = await reader.read();
              if (next.done) throw Error('owned_stage_missing');
              output += new TextDecoder().decode(next.value);
            }
          } finally {
            reader.releaseLock();
          }
          const stage = JSON.parse(output.trim());
          expect(stage.stage).toBe(
            mode === 'before_sql' ? 'published_before_sql' : 'temporary_before_publish',
          );
          child.kill('SIGKILL');
          await child.exited;
          expect(await f.store.getArtifactReference({ ...f.input, refId: mode })).toBeNull();
          const path = artifactPath(join(f.profile.dataRoot, 'owned'), hash);
          expect(existsSync(path)).toBe(mode === 'before_sql');
          if (mode === 'before_sql') expect(readFileSync(path)).toEqual(body);
        } finally {
          clearTimeout(timer);
          if (child.exitCode === null) {
            child.kill('SIGKILL');
            await child.exited;
          }
        }
      }
      expect((await f.store.getMetadata()).storeId).toBe(f.input.expectedStoreId);
      defaultWindowsPathSecurity()!.verifyDirectory(join(f.profile.dataRoot, 'owned'));
    } finally {
      await f.close();
    }
  },
  30000,
);
