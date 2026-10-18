import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildNativeFilesFixture } from '../../../../../tests/fixtures/build-tool-environment';
import { privateDirectory } from '../../../src/platform/windows-path-security';
import { buildStorageAssets } from '../../../src/storage/worker/build-assets';

test('built sqlite entry opens with its bundled Worker and SQL asset', async () => {
  const output = realpathSync(mkdtempSync(join(tmpdir(), 'kite-store-build-')));
  const profileRoot = realpathSync(mkdtempSync(join(tmpdir(), 'kite-store-built-profile-')));
  const dataRoot = join(profileRoot, 'data');
  privateDirectory(dataRoot);
  try {
    const owner = resolve(import.meta.dir, '../../..');
    const repository = resolve(owner, '../..');
    const manifest = JSON.parse(readFileSync(join(owner, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const [dependency, version] of Object.entries({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    })) {
      if (version.startsWith('workspace:')) continue;
      const installed = [
        join(owner, 'node_modules', dependency),
        join(repository, 'node_modules', dependency),
      ].find(existsSync);
      if (!installed) throw Error(`public_dependency_missing:${dependency}`);
      const target = join(output, 'node_modules', dependency);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(
        realpathSync(installed),
        target,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    const result = await Bun.build({
      entrypoints: [
        fileURLToPath(new URL('../../../src/sqlite.ts', import.meta.url)),
        fileURLToPath(new URL('../../../src/profile.ts', import.meta.url)),
        fileURLToPath(new URL('../../../src/resources.ts', import.meta.url)),
        fileURLToPath(new URL('../../../src/files.ts', import.meta.url)),
        fileURLToPath(new URL('../../../src/artifacts.ts', import.meta.url)),
      ],
      outdir: output,
      target: 'bun',
      packages: 'external',
    });
    expect(result.success).toBe(true);
    await buildNativeFilesFixture(output);
    const profile = (await import(
      pathToFileURL(join(output, 'profile.js')).href
    )) as typeof import('../../../src/profile');
    const selected = profile.selectProfile({ dataRoot, profile: 'built' });
    expect(selected.databasePath).toBe(join(dataRoot, 'built', 'core.db'));
    expect((await import('node:fs')).existsSync(selected.coordinationPath)).toBe(false);
    await buildStorageAssets(output);
    const runner = (await import(
      pathToFileURL(join(output, 'sqlite.js')).href
    )) as typeof import('../../../src/sqlite');
    const store = await runner.openSqliteStore({ dataRoot, profile: 'built' });
    try {
      expect((await store.getMetadata()).formatMajor).toBe(1);
      // A loaded Windows DLL remains mapped until process exit. Run the built file
      // capability in its own process so cleanup does not pretend it was unloaded.
      const child = Bun.spawn(
        [
          process.execPath,
          '--eval',
          `import assert from 'node:assert/strict';
const filesEntry=await import(${JSON.stringify(pathToFileURL(join(output, 'files.js')).href)});
const files=filesEntry.createWorkspaceFiles({root:${JSON.stringify(dataRoot)}});
try {
 const written=await files.write({path:'built-file',base:null,content:'built UTF-8'});
 assert.deepEqual((await files.read('built-file')).baseline,written.baseline);
 console.log(JSON.stringify(filesEntry.createFileTools(files).map(tool=>tool.id)));
}finally{await files.close();}`,
        ],
        { cwd: output, stdout: 'pipe', stderr: 'pipe' },
      );
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exit, stderr).toBe(0);
      expect(readFileSync(join(dataRoot, 'built-file'), 'utf8')).toBe('built UTF-8');
      expect(JSON.parse(stdout)).toEqual([
        'files.read',
        'files.write',
        'files.edit',
        'files.list',
        'files.glob',
        'files.search',
      ]);
      const expectedStoreId = (await store.getMetadata()).storeId;
      await store.createWorkspace({
        expectedStoreId,
        id: 'w',
        rootUri: 'file:///disposable',
        name: 'built',
      });
      await store.createSession({
        expectedStoreId,
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        subjectId: 'owner',
        title: 'built',
      });
      const artifactsEntry = (await import(
        pathToFileURL(join(output, 'artifacts.js')).href
      )) as typeof import('../../../src/artifacts');
      const artifacts = artifactsEntry.createArtifactStore({
        profile: { dataRoot, profile: 'built' },
        store,
      });
      try {
        const input = {
          expectedStoreId,
          refId: 'ref',
          sessionId: 's',
          subjectId: 'owner',
          scope: { kind: 'session' as const, id: 's' },
          content: Buffer.from('built immutable'),
          mediaType: 'text/plain',
        };
        await artifacts.publish(input);
        expect(Buffer.from(await artifacts.read(input)).toString()).toBe('built immutable');
      } finally {
        await artifacts.close();
      }
      const resourceEntry = (await import(
        pathToFileURL(join(output, 'resources.js')).href
      )) as typeof import('../../../src/resources');
      const locks = resourceEntry.createWorkspaceSerialLocks(selected);
      const release = await locks.acquire(
        { workspaceId: 'w', key: 'write' },
        new AbortController().signal,
      );
      release();
      await locks.close();
    } finally {
      await store.close();
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
    rmSync(profileRoot, { recursive: true, force: true });
  }
}, 30000);
