import { expect, test } from 'bun:test';
import { realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { privateDirectory, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import {
  createDesktopShellEnvironments,
  type DesktopShellSettingsPort,
  desktopShellSettingsPath,
} from '../../src/desktop-shell';
import { startService } from '../../src/index';

test('desktop Shell preference binds new roots atomically and survives cold reopening', async () => {
  const root = realpathSync(temporaryDirectory('kite-desktop-shell-settings-'));
  const profile = selectProfile({ dataRoot: root, profile: 'shell' });
  privateDirectory(profile.profilePath);
  const workspace = join(root, 'workspace');
  privateDirectory(workspace);
  const open = async (desktop: boolean) => {
    const store = await openSqliteStore(profile);
    const settings: DesktopShellSettingsPort = {
      automatic: 'git-bash',
      async read(storeId) {
        return {
          kind: 'settings.general.shell',
          storeId,
          preference: await store.readDesktopShellPreference(storeId),
          automatic: 'git-bash',
          gitBashAvailable: true,
          powerShellAvailable: true,
        };
      },
      async save(storeId, preference) {
        await store.saveDesktopShellPreference(storeId, preference);
        return this.read(storeId);
      },
    };
    const runtime = createRuntime({
      store,
      permissions: {
        async authorize() {
          return { allowed: false, revision: 'test' };
        },
      },
    });
    const service = await startService({
      runtime,
      ...(desktop ? { desktopShell: settings } : {}),
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      },
      buildId: 'desktop-shell-settings-fixture',
    });
    const { endpoint, token } = service.bootstrap;
    const client = createClient({
      endpoint,
      token,
      bootstrap: service.bootstrap,
      expected: {
        profile: service.bootstrap.profile,
        apiMajor: 1,
        instanceId: service.bootstrap.instanceId,
        buildId: service.bootstrap.buildId,
        requiredCapabilities: ['sessions'],
      },
    });
    const storeId = (await store.getMetadata()).storeId;
    const request = (init?: RequestInit) => {
      const url = new URL(desktopShellSettingsPath, endpoint);
      if (!init?.method) url.searchParams.set('storeId', storeId);
      return fetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          ...init?.headers,
        },
      });
    };
    return { client, service, store, storeId, request };
  };

  try {
    const { client, service, store, storeId, request } = await open(true);
    try {
      await client.connect();
      await store.createWorkspace({
        expectedStoreId: storeId,
        id: 'workspace',
        name: 'workspace',
        rootUri: pathToFileURL(workspace).href,
      });
      const creation = (sessionId: string) => ({
        expectedStoreId: storeId,
        commandId: `create-${sessionId}`,
        sessionId,
        workspaceId: 'workspace',
        title: sessionId,
      });
      const original = await client.createSession(creation('before'));
      expect(await store.readSessionDesktopShell(original.id)).toBe('git-bash');
      expect((await (await request()).json()).preference).toBe('auto');
      const badOrigin = await request({ headers: { origin: service.bootstrap.endpoint } });
      expect(badOrigin.status).toBe(403);
      const badValue = await request({
        method: 'PUT',
        body: JSON.stringify({ expectedStoreId: storeId, preference: 'cmd.exe' }),
      });
      expect(badValue.status).toBe(400);
      const changed = await request({
        method: 'PUT',
        body: JSON.stringify({ expectedStoreId: storeId, preference: 'powershell' }),
      });
      expect(changed.status).toBe(200);
      expect((await changed.json()).preference).toBe('powershell');
      const newer = await client.createSession(creation('after'));
      expect(await store.readSessionDesktopShell(newer.id)).toBe('powershell');
      expect((await client.createSession(creation('before'))).id).toBe(original.id);
      expect(await store.readSessionDesktopShell(original.id)).toBe('git-bash');
      const fork = await client.forkSession(original.id, {
        expectedStoreId: storeId,
        commandId: 'fork-after',
        newSessionId: 'fork-after',
        expectedContextSelectionId: original.contextSelectionId,
        boundary: null,
        title: 'fork after save',
      });
      expect(await store.readSessionDesktopShell(fork.session.id)).toBe('powershell');
    } finally {
      await service.close();
    }
    const cold = await open(false);
    try {
      expect(await cold.store.readDesktopShellPreference(cold.storeId)).toBe('powershell');
      expect(await cold.store.readSessionDesktopShell('before')).toBe('git-bash');
      expect(await cold.store.readSessionDesktopShell('after')).toBe('powershell');
      expect(await cold.store.readSessionDesktopShell('fork-after')).toBe('powershell');
      expect((await cold.request()).status).toBe(404);
      const missing = createDesktopShellEnvironments(undefined, async () => undefined);
      await expect(missing.settings(cold.store).save(cold.storeId, 'git-bash')).rejects.toThrow(
        'desktop_shell_backend_unavailable',
      );
      expect(await cold.store.readDesktopShellPreference(cold.storeId)).toBe('powershell');
      expect(await missing.forSession(cold.store, 'after')).toBeUndefined();
    } finally {
      await cold.service.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 25000);

test('Shell settings retry failed preparation without writing a preference or returning a stale read', async () => {
  const root = temporaryDirectory('kite-desktop-shell-retry-');
  const profile = selectProfile({ dataRoot: root, profile: 'shell' });
  privateDirectory(profile.profilePath);
  const store = await openSqliteStore(profile);
  const ready = Promise.withResolvers<void>();
  try {
    const storeId = (await store.getMetadata()).storeId;
    const failure = Error('windows_shell_asset_changed');
    let gitBashLoads = 0;
    let powerShellLoads = 0;
    const environments = createDesktopShellEnvironments(undefined, async (backend) => {
      if (backend === 'git-bash') {
        gitBashLoads++;
        return undefined;
      }
      if (++powerShellLoads === 1) throw failure;
      await ready.promise;
      return undefined;
    });
    const settings = environments.settings(store);
    await store.saveDesktopShellPreference(storeId, 'git-bash');
    await expect(settings.save(storeId, 'auto')).rejects.toBe(failure);
    expect(await store.readDesktopShellPreference(storeId)).toBe('git-bash');

    const pending = Promise.all([settings.read(storeId), settings.read(storeId)]);
    await store.saveDesktopShellPreference(storeId, 'powershell');
    ready.resolve();
    const [first, second] = await pending;
    expect(first).toMatchObject({ preference: 'powershell', powerShellAvailable: false });
    expect(second).toEqual(first);
    expect(gitBashLoads).toBe(1);
    expect(powerShellLoads).toBe(2);
    expect(await settings.save(storeId, 'auto')).toMatchObject({ preference: 'auto' });
    expect(await store.readDesktopShellPreference(storeId)).toBe('auto');
    expect(powerShellLoads).toBe(2);
  } finally {
    ready.resolve();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
