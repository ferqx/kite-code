import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfigurationFile, updateConfigurationFile } from '../../../src/config/files';
import { readMcpSources } from '../../../src/config/mcp-sources';
import {
  acquireProfileAccess,
  acquireSessionLock,
  resolveProfile,
} from '../../../src/platform/profile';
import {
  defaultWindowsPathSecurity,
  privateDirectory,
} from '../../../src/platform/windows-path-security';
import { openSqliteStore } from '../../../src/sqlite';

test.skipIf(process.platform === 'win32')(
  'POSIX and Node import do not load a Windows DLL or acquire path authority',
  async () => {
    expect(defaultWindowsPathSecurity()).toBeUndefined();
    const root = mkdtempSync(join(tmpdir(), 'kite-windows-lazy-'));
    try {
      const result = await Bun.build({
        entrypoints: [
          new URL('../../../src/platform/windows-path-security.ts', import.meta.url).pathname,
        ],
        target: 'node',
        outdir: root,
        packages: 'external',
      });
      expect(result.success).toBe(true);
      const probe = spawnSync(
        'node',
        [
          '--input-type=module',
          '-e',
          `const m=await import(${JSON.stringify(new URL(`file://${join(root, 'windows-path-security.js')}`).href)});if(m.defaultWindowsPathSecurity()!==undefined)throw Error('unexpected authority')`,
        ],
        { encoding: 'utf8' },
      );
      expect(probe.status).toBe(0);
      expect(probe.stderr).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// This is native Windows qualification, never an emulation or optional availability skip.
test.skipIf(process.platform !== 'win32')(
  'default native private Profile/Worker/WAL/config and cold logs retain their real ACL and identities',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-windows-native-'));
    const options = { dataRoot: join(root, 'data'), profile: 'owned' };
    const native = defaultWindowsPathSecurity()!;
    let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
    try {
      store = await openSqliteStore(options);
      const storeId = (await store.getMetadata()).storeId;
      await store.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        rootUri: new URL(`file:///${root.replaceAll('\\', '/')}`).href,
        name: 'owned',
      });
      await store.createSession({
        expectedStoreId: storeId,
        subjectId: 'owner',
        commandId: 'create',
        sessionId: 's',
        workspaceId: 'w',
        title: 'owned',
      });
      await store.acceptCommand({
        expectedStoreId: storeId,
        subjectId: 'owner',
        commandId: 'work',
        sessionId: 's',
        request: { kind: 'run.start', content: 'private original input' },
      });
      const page = await store.getSessionLogs({
        expectedStoreId: storeId,
        subjectId: 'owner',
        sessionId: 's',
        afterCursor: '0',
      });
      expect(page.entries.some((entry) => entry.objectId === 'work')).toBe(true);
      expect(JSON.stringify(page)).not.toContain('private original input');
      const paths = resolveProfile(options);
      for (const path of [
        paths.dataRoot,
        join(paths.dataRoot, '.coordination'),
        paths.coordinationPath,
        paths.profilePath,
      ])
        expect(() => native.verifyDirectory(path)).not.toThrow();
      for (const suffix of ['', '-wal', '-shm']) {
        expect(existsSync(paths.databasePath + suffix)).toBe(true);
        expect(() => native.verifyFile(paths.databasePath + suffix)).not.toThrow();
      }
      const access = acquireProfileAccess(options);
      try {
        const lock = acquireSessionLock(access, 's');
        try {
          expect(() => acquireSessionLock(access, 's')).toThrow();
        } finally {
          lock.release();
        }
      } finally {
        access.lock.release();
      }
      const config = join(paths.profilePath, 'config.jsonc');
      const missing = readConfigurationFile({ path: config });
      const changed = updateConfigurationFile({
        path: config,
        ifMatch: missing.etag,
        operations: [{ kind: 'set', path: ['test'], value: true }],
      });
      expect(changed.value.test).toBe(true);
      expect(() => native.verifyFile(config)).not.toThrow();
      await store.close();
      store = undefined;
      const original = readFileSync(paths.databasePath);
      linkSync(paths.databasePath, join(root, 'hardlink'));
      try {
        let denied = false;
        try {
          store = await openSqliteStore({ ...options, mode: 'readonly' });
        } catch {
          denied = true;
        }
        expect(denied).toBe(true);
      } finally {
        unlinkSync(join(root, 'hardlink'));
      }
      symlinkSync(paths.profilePath, join(root, 'junction'), 'junction');
      try {
        expect(() => native.verifyDirectory(join(root, 'junction'))).toThrow();
      } finally {
        unlinkSync(join(root, 'junction'));
      }
      store = await openSqliteStore({ ...options, mode: 'readonly' });
      const before = (await store.getMetadata()).lastChangeCursor;
      const cold = await store.getSessionLogs({
        expectedStoreId: storeId,
        subjectId: 'owner',
        sessionId: 's',
        afterCursor: '0',
        upperCursor: page.upperCursor,
      });
      expect(cold.entries).toEqual(page.entries);
      expect((await store.getMetadata()).lastChangeCursor).toBe(before);
      expect(readFileSync(paths.databasePath)).toEqual(original);
    } finally {
      await store?.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  10000,
);

test.skipIf(process.platform !== 'win32')(
  'unsafe existing ACL is rejected without repair or profile creation',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-windows-broad-'));
    try {
      // This ordinary OS-created temp directory intentionally retains its inherited ACL.
      expect(() => defaultWindowsPathSecurity()!.verifyDirectory(root)).toThrow();
      expect(() => resolveProfile({ dataRoot: root, profile: 'owned' })).toThrow();
      expect(existsSync(join(root, '.coordination'))).toBe(false);
      const owned = join(root, 'private');
      privateDirectory(owned);
      expect(() => defaultWindowsPathSecurity()!.verifyDirectory(owned)).not.toThrow();
      const file = join(owned, 'unsafe-existing');
      defaultWindowsPathSecurity()!.createFile(file);
      const changed = spawnSync('icacls.exe', [file, '/grant', '*S-1-1-0:(F)'], {
        encoding: 'utf8',
      });
      expect(changed.status).toBe(0);
      expect(() => defaultWindowsPathSecurity()!.verifyFile(file)).toThrow();
      expect(() => defaultWindowsPathSecurity()!.secureFile(file)).toThrow();
      // secureFile is verification, not ACL repair: the native denial remains afterwards.
      expect(() => defaultWindowsPathSecurity()!.verifyFile(file)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== 'win32')(
  'ordinary inherited-ACL Workspace absent/read/edit and project declarations do not become private grants',
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-windows-workspace-')));
    const native = defaultWindowsPathSecurity()!;
    try {
      native.verifyScopeDirectory(root);
      expect(() => native.verifyDirectory(root)).toThrow();
      const aclBefore = spawnSync('icacls.exe', [root], { encoding: 'utf8' });
      expect(aclBefore.status).toBe(0);
      const path = join(root, 'kite-agent.jsonc');
      expect(readConfigurationFile({ path }).exists).toBe(false);
      const original = '// keep comment\r\n{"unknown":{"keep":1},"tools":[]}\r\n';
      writeFileSync(path, original);
      const document = readConfigurationFile({ path });
      expect(document.value.unknown).toEqual({ keep: 1 });
      expect(() => readConfigurationFile({ path, windowsPathPolicy: 'private' })).toThrow();
      const changed = updateConfigurationFile({
        path,
        ifMatch: document.etag,
        operations: [{ kind: 'set', path: ['tools'], value: [{ id: 'Files.read' }] }],
      });
      expect(changed.value.tools).toEqual([{ id: 'Files.read' }]);
      expect(readFileSync(path, 'utf8')).toContain('// keep comment');
      expect(readFileSync(path, 'utf8')).toContain('\r\n');
      expect(() => native.verifyFile(`${path}.lock`)).not.toThrow();
      expect(() => native.verifyFile(path)).not.toThrow();
      const aclAfter = spawnSync('icacls.exe', [root], { encoding: 'utf8' });
      expect(aclAfter.status).toBe(0);
      expect(aclAfter.stdout).toBe(aclBefore.stdout);
      expect(() => native.verifyDirectory(root)).toThrow();

      const profilePath = join(root, 'profile');
      privateDirectory(profilePath);
      native.writePrivateFile(
        join(profilePath, 'mcp.json'),
        Buffer.from(
          JSON.stringify({
            mcpServers: {
              same: { type: 'http', url: 'https://example.test/user', auth: { type: 'none' } },
            },
          }),
        ),
      );
      mkdirSync(join(root, '.kite-code'));
      const project = join(root, '.kite-code', 'mcp.json');
      writeFileSync(
        project,
        JSON.stringify({
          mcpServers: {
            same: { type: 'http', url: 'https://example.test/project', auth: { type: 'none' } },
          },
        }),
      );
      const options = {
        profilePath,
        workspacePath: root,
        scope: { profileId: 'owned', storeId: 'store', sessionId: 's', workspaceId: 'w' },
      };
      const sources = readMcpSources(options);
      expect(sources.user.error).toBeNull();
      expect(sources.workspace?.error).toBeNull();
      expect(sources.registry.servers).toHaveLength(1);
      expect(sources.registry.servers[0]?.admitted).toBe(false);
      expect(sources.registry.servers[0]?.reason).toBe('mcp_project_approval_pending');
      // The exact same broad source ACL cannot become private approval metadata authority.
      writeFileSync(join(profilePath, 'mcp-approvals.json'), '{}');
      const widened = spawnSync(
        'icacls.exe',
        [join(profilePath, 'mcp-approvals.json'), '/grant', '*S-1-1-0:(F)'],
        { encoding: 'utf8' },
      );
      expect(widened.status).toBe(0);
      expect(readMcpSources(options).approvals.error).toBe('mcp_source_unavailable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== 'win32')(
  'Workspace publication rejects actual path replacement after final host validation without overwriting the replacement',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-windows-path-replace-'));
    try {
      const path = join(root, 'kite-agent.jsonc'),
        saved = join(root, 'original.jsonc'),
        foreign = join(root, 'foreign.jsonc');
      writeFileSync(path, '{"value":1}');
      writeFileSync(foreign, '{"foreign":true}');
      const original = readConfigurationFile({ path });
      expect(() =>
        updateConfigurationFile({
          path,
          ifMatch: original.etag,
          operations: [{ kind: 'set', path: ['value'], value: 2 }],
          validatePublication() {
            renameSync(path, saved);
            linkSync(foreign, path);
          },
        }),
      ).toThrow();
      expect(readFileSync(foreign, 'utf8')).toBe('{"foreign":true}');
      expect(readFileSync(path, 'utf8')).toBe('{"foreign":true}');
      expect(readFileSync(saved, 'utf8')).toBe('{"value":1}');
      unlinkSync(path);
      renameSync(saved, path);
      const alias = join(root, 'alias');
      symlinkSync(root, alias, 'junction');
      try {
        expect(() => readConfigurationFile({ path: join(alias, 'absent.jsonc') })).toThrow();
      } finally {
        unlinkSync(alias);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
