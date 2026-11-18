import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import type { ShellConfigurationOptions } from '@kite-ai/agent/permissions/shell';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { launchIdentity } from '../../../../packages/agent/src/jobs/launch-identity';
import { privateDirectory, temporaryDirectory } from '../../../../tests/fixtures/test-filesystem';
import { createDesktopShellEnvironments, desktopShellSettingsPath } from '../../src/desktop-shell';
import { startService } from '../../src/index';

test('desktop Shell preference binds new roots atomically and survives cold reopening', async () => {
  const root = realpathSync(temporaryDirectory('kite-desktop-shell-settings-'));
  const profile = selectProfile({ dataRoot: root, profile: 'shell' });
  privateDirectory(profile.profilePath);
  const workspace = join(root, 'workspace');
  privateDirectory(workspace);
  const open = async (desktop: boolean, powerShellVersion = '5.1.26100.10066') => {
    const store = await openSqliteStore(profile);
    const exe = join(profile.profilePath, 'settings-fixture.exe');
    writeFileSync(exe, 'settings identity, never executed');
    const identity = launchIdentity(exe, true);
    const shell: ShellConfigurationOptions = {
      platform: 'win32',
      configurationId: 'settings-fixture',
      env: {},
      bunExecutable: process.execPath,
      supervisorPath: exe,
      shellExecutable: exe,
      windows: {
        kind: 'powershell',
        stateRoot: profile.profilePath,
        powerShell: {
          version: powerShellVersion,
          executable: identity,
          engine: identity,
          systemDirectory: profile.profilePath,
          ...(powerShellVersion.startsWith('5.')
            ? {}
            : { installation: { root: profile.profilePath, dependencies: [] } }),
        },
      },
    };
    const settings = createDesktopShellEnvironments(async () => shell).settings(store);
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
  const creation = (storeId: string, sessionId: string) => ({
    expectedStoreId: storeId,
    commandId: `create-${sessionId}`,
    sessionId,
    workspaceId: 'workspace',
    title: sessionId,
  });

  try {
    const { client, service, store, storeId, request } = await open(true, '7.6.9');
    try {
      await client.connect();
      await store.createWorkspace({
        expectedStoreId: storeId,
        id: 'workspace',
        name: 'workspace',
        rootUri: pathToFileURL(workspace).href,
      });
      const original = await client.createSession(creation(storeId, 'before'));
      expect(await store.readSessionDesktopShell(original.id)).toBe('git-bash');
      expect((await (await request()).json()).preference).toBe('git-bash');
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
      const newer = await client.createSession(creation(storeId, 'after'));
      expect(await store.readSessionDesktopShell(newer.id)).toBe('powershell');
      expect((await client.createSession(creation(storeId, 'before'))).id).toBe(original.id);
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
      const selected = await request({
        method: 'PUT',
        body: JSON.stringify({ expectedStoreId: storeId, preference: 'powershell-7' }),
      });
      expect(selected.status).toBe(200);
      expect(await selected.json()).toMatchObject({
        preference: 'powershell',
        powerShell7Version: '7.6.9',
        automatic: 'git-bash',
      });
      await client.createSession(creation(storeId, 'with-seven'));
      expect(await store.readSessionDesktopShell('with-seven')).toBe('powershell');
    } finally {
      await service.close();
    }
    const cold = await open(true);
    try {
      await cold.client.connect();
      expect(await (await cold.request()).json()).toMatchObject({
        preference: 'powershell',
        powerShellVersion: '5.1.26100.10066',
        powerShell7Version: null,
        powerShellAvailable: true,
      });
      expect(await cold.store.readDesktopShellPreference(cold.storeId)).toBe('powershell');
      expect(await cold.store.readSessionDesktopShell('before')).toBe('git-bash');
      expect(await cold.store.readSessionDesktopShell('after')).toBe('powershell');
      expect(await cold.store.readSessionDesktopShell('fork-after')).toBe('powershell');
      await cold.client.createSession(creation(cold.storeId, 'after-uninstall'));
      expect(await cold.store.readSessionDesktopShell('after-uninstall')).toBe('powershell');
      await cold.client.createSession(creation(cold.storeId, 'with-seven'));
      expect(await cold.store.readSessionDesktopShell('with-seven')).toBe('powershell');
      const missing = createDesktopShellEnvironments(async () => undefined);
      await expect(missing.settings(cold.store).save(cold.storeId, 'git-bash')).rejects.toThrow(
        'desktop_shell_backend_unavailable',
      );
      expect(await cold.store.readDesktopShellPreference(cold.storeId)).toBe('powershell');
      expect(await missing.forSession(cold.store, 'with-seven')).toBeUndefined();
    } finally {
      await cold.service.close();
    }
    const terminal = await open(false);
    try {
      expect((await terminal.request()).status).toBe(404);
    } finally {
      await terminal.service.close();
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
    let installed: ShellConfigurationOptions | undefined;
    const environments = createDesktopShellEnvironments(async (backend) => {
      if (backend === 'git-bash') {
        gitBashLoads++;
        return undefined;
      }
      expect(backend).toBe('powershell');
      if (++powerShellLoads === 1) throw failure;
      await ready.promise;
      return installed;
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
    expect(gitBashLoads).toBe(2);
    expect(powerShellLoads).toBe(2);
    expect(await settings.save(storeId, 'auto')).toMatchObject({ preference: 'git-bash' });
    expect(await store.readDesktopShellPreference(storeId)).toBe('auto');
    expect(powerShellLoads).toBe(3);

    const exe = join(profile.profilePath, 'pwsh.exe');
    writeFileSync(exe, 'initial identity');
    const identity = launchIdentity(exe, true);
    installed = {
      platform: 'win32',
      configurationId: 'powershell-7-fixture',
      env: {},
      bunExecutable: process.execPath,
      supervisorPath: exe,
      shellExecutable: exe,
      windows: {
        kind: 'powershell',
        stateRoot: profile.profilePath,
        powerShell: {
          version: '7.6.9',
          systemDirectory: profile.profilePath,
          executable: identity,
          engine: identity,
          installation: { root: profile.profilePath, dependencies: [] },
        },
      },
    };
    expect(await settings.save(storeId, 'powershell')).toMatchObject({
      preference: 'powershell',
      powerShellVersion: '7.6.9',
      powerShell7Version: '7.6.9',
    });
    expect(await settings.selection()).toBe('powershell');
    const previous = installed;
    if (previous.windows?.kind !== 'powershell') throw Error('invalid fixture');
    const previousWindows = previous.windows;
    installed = {
      ...previous,
      windows: {
        ...previousWindows,
        kind: 'powershell',
        powerShell: {
          ...previousWindows.powerShell,
          version: '8.1.0',
        },
      },
    };
    expect(await settings.read(storeId)).toMatchObject({
      preference: 'powershell',
      powerShellVersion: '8.1.0',
    });
    expect(previous.windows?.kind === 'powershell' && previous.windows.powerShell.version).toBe(
      '7.6.9',
    );
    installed = {
      ...previous,
      windows: {
        kind: 'powershell',
        stateRoot: profile.profilePath,
        powerShell: {
          version: '5.1.26100.10066',
          systemDirectory: profile.profilePath,
          executable: identity,
          engine: identity,
        },
      },
    };
    expect(await settings.read(storeId)).toMatchObject({
      preference: 'powershell',
      powerShellVersion: '5.1.26100.10066',
      powerShell7Version: null,
    });
    installed = undefined;
    expect(await settings.read(storeId)).toMatchObject({
      preference: 'powershell',
      powerShellVersion: null,
      powerShell7Version: null,
    });
    expect(await settings.selection()).toBe('unavailable');
  } finally {
    ready.resolve();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy PowerShell records remain readable without rewriting history and new bindings use the family', async () => {
  const root = temporaryDirectory('kite-shell-family-legacy-');
  const profile = selectProfile({ dataRoot: root, profile: 'shell' });
  privateDirectory(profile.profilePath);
  const workspace = join(root, 'workspace');
  privateDirectory(workspace);
  const store = await openSqliteStore(profile);
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await store.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'legacy',
      rootUri: pathToFileURL(workspace).href,
    });
    const create = (sessionId: string) => ({
      expectedStoreId,
      subjectId: 'owner',
      commandId: `create-${sessionId}`,
      sessionId,
      workspaceId: 'w',
      title: sessionId,
    });
    await store.createSession(create('legacy'), 'powershell');
    await store.saveDesktopShellPreference(expectedStoreId, 'powershell');
    const db = new Database(profile.databasePath);
    try {
      db.query("UPDATE extension_record SET json=? WHERE extension_id='host.desktop-shell'").run(
        JSON.stringify('powershell-7'),
      );
      expect(await store.readDesktopShellPreference(expectedStoreId)).toBe('powershell');
      expect(await store.readSessionDesktopShell('legacy')).toBe('powershell');
      expect(
        db
          .query(
            "SELECT json FROM extension_record WHERE extension_id='host.desktop-shell' AND key='backend'",
          )
          .get(),
      ).toMatchObject({ json: JSON.stringify('powershell-7') });
      await store.createSession(create('new'), 'powershell-7');
      expect(await store.readSessionDesktopShell('new')).toBe('powershell');
      expect(
        db
          .query(
            "SELECT json FROM extension_record WHERE extension_id='host.desktop-shell' AND key='backend' AND scope_id='new'",
          )
          .get(),
      ).toMatchObject({ json: JSON.stringify('powershell') });
    } finally {
      db.close();
    }
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
