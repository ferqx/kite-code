import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '#kite-test';
import { build as buildBundle } from '../../../../../scripts/tooling/build';
import {
  which as findExecutable,
  spawn as spawnProcess,
} from '../../../../../scripts/tooling/process';
import { testRuntimeFlags } from '../../../../../scripts/tooling/test-command';
import {
  privateDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import { runtimeNativeAsset } from '../../../src/runtime-native';
import {
  type DynamicSqliteEngineManifest,
  parseSqliteEngineManifest,
  verifySqliteEngineAsset,
} from '../../../src/sqlite-engine';
import { buildStorageAssets } from '../../../src/storage/worker/build-assets';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sourceId =
  '2026-03-13 10:38:09 737ae4a34738ffa0c3ff7f9bb18df914dd1cad163f28fd6b6e114a344fe6d618';
const manifest = (bytes: Uint8Array): DynamicSqliteEngineManifest => ({
  version: 1,
  driver: 'node-api:sqlite',
  target: { platform: process.platform, arch: process.arch },
  library: 'libsqlite3.dylib',
  size: bytes.length,
  sha256: sha(bytes),
  sqlite: { version: '3.51.3', sourceId },
});
test('engine metadata is closed and cannot supply path traversal, extra authority or malformed identity', () => {
  const valid = manifest(new Uint8Array([1]));
  expect(parseSqliteEngineManifest(valid)).toEqual(valid);
  for (const value of [
    { ...valid, library: '../sqlite.dylib' },
    { ...valid, authority: 'user' },
    { ...valid, target: { ...valid.target, extra: true } },
    { ...valid, sqlite: { ...valid.sqlite, extra: true } },
    { ...valid, size: 0 },
    { ...valid, sha256: 'bad' },
  ])
    expect(() => parseSqliteEngineManifest(value)).toThrow('sqlite_engine_manifest_invalid');
});
test.skipIf(process.platform !== 'darwin')(
  'owned relocated patched engine selects before first DB, shared Worker measures exact source; missing/changed/late/wrong identity never silently fall back',
  async () => {
    const root = temporaryDirectory('kite-sqlite-engine-');
    try {
      const staging = join(root, 'staging'),
        selected = join(root, 'selected');
      privateDirectory(staging);
      copyFileSync(
        '/opt/homebrew/Cellar/sqlite/3.51.3/lib/libsqlite3.3.51.3.dylib',
        join(staging, 'libsqlite3.dylib'),
      );
      chmodSync(join(staging, 'libsqlite3.dylib'), 0o644);
      const bytes = readFileSync(join(staging, 'libsqlite3.dylib')),
        metadata = manifest(bytes),
        metadataBytes = Buffer.from(JSON.stringify(metadata));
      writeFileSync(join(staging, 'engine-manifest.json'), metadataBytes, { mode: 0o600 });
      renameSync(staging, selected);
      const selection = { root: selected, manifestSha256: sha(metadataBytes) };
      expect(verifySqliteEngineAsset(selection).manifest.sqlite).toEqual({
        version: '3.51.3',
        sourceId,
      });
      const node = findExecutable('node');
      if (!node) throw Error('sqlite_engine_test_node_unavailable');
      const nodeBuild = await buildBundle({
        entrypoints: [join(import.meta.dirname, '../../../src/sqlite-engine.ts')],
        outdir: join(root, 'node'),
        target: 'node',
        packages: 'external',
      });
      expect(nodeBuild.success).toBe(true);
      const legacyBytes = Buffer.from(JSON.stringify({ ...metadata, driver: 'bun:sqlite' }));
      writeFileSync(join(selected, 'engine-manifest.json'), legacyBytes, { mode: 0o600 });
      const nodeProbe = spawnProcess(
        [
          node,
          '--input-type=module',
          '-e',
          `import assert from 'node:assert/strict'; import {verifySqliteEngineAsset,getLoadedSqliteEngine,initializeSqliteEngine} from ${JSON.stringify(join(root, 'node/sqlite-engine.js'))}; const selected=JSON.parse(process.argv[1]);assert.equal(getLoadedSqliteEngine(),null);assert.equal(verifySqliteEngineAsset(selected).manifest.sqlite.version,'3.51.3');assert.throws(()=>initializeSqliteEngine(selected),/sqlite_engine_runtime_unsupported/);console.log('node_safe_verification_no_db');`,
          JSON.stringify({ root: selected, manifestSha256: sha(legacyBytes) }),
        ],
        { cwd: root, env: { HOME: root, PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' },
      );
      const [nodeExit, nodeOut, nodeError] = await Promise.all([
        nodeProbe.exited,
        new Response(nodeProbe.stdout).text(),
        new Response(nodeProbe.stderr).text(),
      ]);
      expect(nodeExit).toBe(0);
      expect(nodeError).toBe('');
      expect(nodeOut).toContain('node_safe_verification_no_db');
      writeFileSync(join(selected, 'engine-manifest.json'), metadataBytes, { mode: 0o600 });
      const built = await buildBundle({
        entrypoints: [
          join(import.meta.dirname, '../../fixtures/sqlite-engine/probe.ts'),
          join(import.meta.dirname, '../../fixtures/sqlite-engine/worker.ts'),
        ],
        outdir: join(root, 'probe'),
        target: 'node',
        packages: 'bundle',
        naming: '[name].js',
      });
      expect(built.success).toBe(true);
      copyFileSync(fileURLToPath(runtimeNativeAsset()), join(root, 'probe/runtime-native.node'));
      async function run(mode: string, digest = selection.manifestSha256) {
        const child = spawnProcess([node!, join(root, 'probe/probe.js'), selected, digest, mode], {
          cwd: root,
          env: { HOME: root, PATH: '/usr/bin:/bin' },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
        try {
          const [exit, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          expect(stderr).toBe('');
          expect(exit).toBe(0);
          return stdout;
        } finally {
          clearTimeout(timeout);
        }
      }
      expect(JSON.parse(await run('selected'))).toMatchObject({
        qualification: 'selected',
        version: '3.51.3',
        sourceId,
      });
      expect(await run('late')).toContain('late_rejected');
      writeFileSync(join(selected, 'libsqlite3.dylib'), Buffer.from('changed'));
      expect(() => verifySqliteEngineAsset(selection)).toThrow('sqlite_engine_asset_changed');
      writeFileSync(join(selected, 'libsqlite3.dylib'), bytes);
      rmSync(join(selected, 'libsqlite3.dylib'));
      expect(() => verifySqliteEngineAsset(selection)).toThrow('sqlite_engine_asset_unavailable');
      writeFileSync(join(selected, 'libsqlite3.dylib'), bytes, { mode: 0o644 });
      const falseBytes = Buffer.from(
        JSON.stringify({
          ...metadata,
          sqlite: { ...metadata.sqlite, sourceId: `${sourceId} false` },
        }),
      );
      writeFileSync(join(selected, 'engine-manifest.json'), falseBytes);
      expect(await run('identity', sha(falseBytes))).toContain('identity_rejected_no_fallback');
      console.log(
        JSON.stringify({
          librarySha256: metadata.sha256,
          sourceId,
          version: '3.51.3',
          firstDB: 'selected',
          worker: 'same-native-engine',
          late: 'rejected',
          platform: process.platform,
          arch: process.arch,
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);

test('legacy builtin exact identity verifies without establishing runtime qualification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-sqlite-builtin-'));
  try {
    const child = spawnProcess(
      [
        process.execPath,
        ...testRuntimeFlags,
        join(import.meta.dirname, '../../fixtures/sqlite-engine/builtin.ts'),
        root,
      ],
      { cwd: root, env: { HOME: root, PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' },
    );
    const [exit, out, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(error).toBe('');
    expect(exit).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ linkage: 'builtin', releaseQualified: false });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('compiled default sidecar rejects missing manifest or changed asset before any profile creation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-sqlite-sidecar-'));
  try {
    const output = join(root, 'package');
    const built = await buildBundle({
      entrypoints: [join(import.meta.dirname, '../../../src/sqlite.ts')],
      outdir: output,
      target: 'node',
      packages: 'bundle',
    });
    expect(built.success).toBe(true);
    const engine = join(output, 'storage/engine');
    privateDirectory(engine);
    const data = join(root, 'never-profile');
    const run = async () => {
      const script = join(root, 'check.ts');
      writeFileSync(
        script,
        `import assert from 'node:assert/strict';import {openSqliteStore} from ${JSON.stringify(join(output, 'sqlite.js'))}; let denied=false;try{await openSqliteStore({dataRoot:${JSON.stringify(data)},profile:'blocked'});}catch(e){denied=e.code.startsWith('sqlite_engine_');}assert(denied);console.log('engine_rejected_before_profile');`,
      );
      const child = spawnProcess([process.execPath, ...testRuntimeFlags, script], {
        cwd: root,
        env: { HOME: root, PATH: '/usr/bin:/bin' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exit, out, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(error).toBe('');
      expect(exit).toBe(0);
      expect(out).toContain('engine_rejected_before_profile');
      expect(existsSync(data)).toBe(false);
    };
    await run();
    writeFileSync(
      join(engine, 'engine-selection.json'),
      JSON.stringify({ version: 1, manifestSha256: 'a'.repeat(64) }),
      { mode: 0o600 },
    );
    await run();
    writeFileSync(join(engine, 'engine-manifest.json'), 'changed', { mode: 0o600 });
    await run();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== 'darwin')(
  'compiled public Store default sidecar loads the owned patched engine before Worker/profile IO',
  async () => {
    const root = temporaryDirectory('kite-sqlite-default-');
    try {
      const output = join(root, 'package');
      const node = findExecutable('node');
      if (!node) throw Error('sqlite_engine_test_node_unavailable');
      const built = await buildBundle({
        entrypoints: [
          join(import.meta.dirname, '../../../src/sqlite.ts'),
          join(import.meta.dirname, '../../../src/runtime-native.ts'),
          join(import.meta.dirname, '../../../src/maintenance/index.ts'),
        ],
        root: join(import.meta.dirname, '../../../src'),
        outdir: output,
        target: 'node',
        packages: 'bundle',
        splitting: true,
      });
      expect(built.success).toBe(true);
      copyFileSync(fileURLToPath(runtimeNativeAsset()), join(output, 'runtime-native.node'));
      const previous = process.env.KITE_RELEASE_JS_RUNTIME;
      process.env.KITE_RELEASE_JS_RUNTIME = 'node';
      try {
        await buildStorageAssets(output);
      } finally {
        if (previous === undefined) delete process.env.KITE_RELEASE_JS_RUNTIME;
        else process.env.KITE_RELEASE_JS_RUNTIME = previous;
      }
      const engine = join(output, 'storage/engine');
      privateDirectory(engine);
      const bytes = readFileSync('/opt/homebrew/Cellar/sqlite/3.51.3/lib/libsqlite3.3.51.3.dylib');
      writeFileSync(join(engine, 'libsqlite3.dylib'), bytes, { mode: 0o644 });
      const metadata = Buffer.from(JSON.stringify(manifest(bytes)));
      writeFileSync(join(engine, 'engine-manifest.json'), metadata, { mode: 0o600 });
      writeFileSync(
        join(engine, 'engine-selection.json'),
        JSON.stringify({ version: 1, manifestSha256: sha(metadata) }),
        { mode: 0o600 },
      );
      const data = join(root, 'actual-profile');
      const script = join(root, 'default.mjs');
      writeFileSync(
        script,
        readFileSync(
          join(import.meta.dirname, '../../fixtures/sqlite-engine/public-store.ts'),
          'utf8',
        )
          .replace(
            "'@kite-ai/agent/maintenance'",
            JSON.stringify(join(output, 'maintenance/index.js')),
          )
          .replace("'@kite-ai/agent/sqlite'", JSON.stringify(join(output, 'sqlite.js'))),
      );
      const child = spawnProcess([node, script, data], {
        cwd: root,
        env: { HOME: root, PATH: '/usr/bin:/bin' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
      try {
        const [exit, out, error] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(error).toBe('');
        expect(exit).toBe(0);
        expect(JSON.parse(out)).toMatchObject({
          publicStores: 2,
          walWrites: 24,
          restored: true,
          readonlyCold: true,
        });
        expect(existsSync(data)).toBe(true);
        const lateData = join(root, 'late-never-profile'),
          lateScript = join(root, 'late.mjs');
        writeFileSync(
          lateScript,
          `import assert from 'node:assert/strict';import {nativeRuntime} from ${JSON.stringify(join(output, 'runtime-native.js'))};import {openSqliteStore} from ${JSON.stringify(join(output, 'sqlite.js'))};const native=nativeRuntime();assert(native.sqliteSelect(${JSON.stringify(join(engine, 'libsqlite3.dylib'))},true));native.sqliteClose(native.sqliteOpen(':memory:',6));let code='';try{await openSqliteStore({dataRoot:${JSON.stringify(lateData)},profile:'late'});}catch(e){code=e.code;}assert.equal(code,'sqlite_engine_load_failed');console.log('late_default_rejected_before_profile');`,
        );
        const lateChild = spawnProcess([node, lateScript], {
          cwd: root,
          env: { HOME: root, PATH: '/usr/bin:/bin' },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [lateExit, lateOut, lateError] = await Promise.all([
          lateChild.exited,
          new Response(lateChild.stdout).text(),
          new Response(lateChild.stderr).text(),
        ]);
        expect(lateError).toBe('');
        expect(lateExit).toBe(0);
        expect(lateOut).toContain('late_default_rejected_before_profile');
        expect(existsSync(lateData)).toBe(false);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000,
);
