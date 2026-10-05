import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildStorageAssets } from '../../../src/storage/worker/build-assets';

test('built sqlite entry opens with its bundled Worker and SQL asset', async () => {
  const output = mkdtempSync('/private/tmp/kite-store-build-');
  const dataRoot = mkdtempSync('/private/tmp/kite-store-built-profile-');
  chmodSync(dataRoot, 0o700);
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
      symlinkSync(realpathSync(installed), target, 'dir');
    }
    const result = await Bun.build({
      entrypoints: [
        new URL('../../../src/sqlite.ts', import.meta.url).pathname,
        new URL('../../../src/profile.ts', import.meta.url).pathname,
        new URL('../../../src/resources.ts', import.meta.url).pathname,
        new URL('../../../src/files.ts', import.meta.url).pathname,
        new URL('../../../src/artifacts.ts', import.meta.url).pathname,
      ],
      outdir: output,
      target: 'bun',
      packages: 'external',
    });
    expect(result.success).toBe(true);
    const profile = (await import(
      join(output, 'profile.js')
    )) as typeof import('../../../src/profile');
    const selected = profile.selectProfile({ dataRoot, profile: 'built' });
    expect(selected.databasePath).toBe(join(dataRoot, 'built', 'core.db'));
    expect((await import('node:fs')).existsSync(selected.coordinationPath)).toBe(false);
    await buildStorageAssets(output);
    const runner = (await import(
      join(output, 'sqlite.js')
    )) as typeof import('../../../src/sqlite');
    const store = await runner.openSqliteStore({ dataRoot, profile: 'built' });
    try {
      expect((await store.getMetadata()).formatMajor).toBe(1);
      const filesEntry = (await import(
        join(output, 'files.js')
      )) as typeof import('../../../src/files');
      const files = filesEntry.createWorkspaceFiles({ root: dataRoot });
      try {
        const written = await files.write({
          path: 'built-file',
          base: null,
          content: 'built UTF-8',
        });
        expect((await files.read('built-file')).baseline).toEqual(written.baseline);
        expect(filesEntry.createFileTools(files).map((tool) => tool.id)).toEqual([
          'files.read',
          'files.write',
          'files.edit',
          'files.list',
          'files.glob',
          'files.search',
        ]);
      } finally {
        await files.close();
      }
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
        join(output, 'artifacts.js')
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
        join(output, 'resources.js')
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
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
