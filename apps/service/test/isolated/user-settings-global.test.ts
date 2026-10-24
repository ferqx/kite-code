import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';

test('user settings HTTP works in an empty Store and never reads project configuration or invents a Session', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-user-settings-http-')));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  privateDirectory(profile.profilePath);
  const user = join(root, 'user');
  privateDirectory(join(user, 'skills', 'global'));
  writeFileSync(
    join(user, 'skills', 'global', 'SKILL.md'),
    '---\nname: User skill\ndescription: User metadata\n---\nPRIVATE_BODY',
    { mode: 0o600 },
  );
  const configPath = join(user, 'config.jsonc');
  writeFileSync(
    configPath,
    JSON.stringify({ skills: [{ id: 'user-skill', path: 'skills/global' }] }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(profile.profilePath, 'mcp.json'),
    JSON.stringify({
      mcpServers: { global: { type: 'http', url: 'https://mcp.example.test/mcp' } },
    }),
    { mode: 0o600 },
  );
  let vaultEffects = 0;
  const host = createDefaultProcessConfiguration({
    profile,
    userConfigurationPath: configPath,
    localCodex: false,
    credentialBackend: {
      kind: 'temporary',
      async put() {
        vaultEffects++;
      },
      async resolve() {
        return null;
      },
      async remove() {
        vaultEffects++;
      },
    },
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const runtime = createRuntime({ store, permissions: host.permissions! });
  const service = await startService({
    runtime,
    skillCatalogue: host.skillCatalogue,
    userMcpManagement: host.userMcpManagement!(runtime),
    buildId: 'global-settings',
    subjectId: 'owner',
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['user_skill_catalogue', 'user_mcp_settings'],
    },
  });
  const storeId = (await runtime.getMetadata()).storeId;
  const get = (path: string, token = service.bootstrap.token) =>
    fetch(`${service.endpoint}${path}`, { headers: { authorization: `Bearer ${token}` } });
  try {
    await client.connect();
    expect(await client.listWorkspaces()).toEqual([]);
    expect(await client.listSessions()).toEqual([]);
    const before = await runtime.getChanges({ after: '0' });
    const skill = await client.listUserSkills({ storeId });
    expect(skill.scope).toBe('user');
    expect(skill.entries.map((entry) => entry.name)).toEqual(['User skill']);
    expect(JSON.stringify(skill)).not.toContain('PRIVATE_BODY');
    expect(JSON.stringify(skill)).not.toContain(root);
    const mcp = await client.getUserMcpSettings({ storeId });
    expect(mcp.scope).toBe('user');
    expect(mcp.sources.map((source) => source.name)).toEqual(['global']);
    expect(mcp.sources[0]!.connection.state).toBe('disconnected');
    expect(await runtime.getChanges({ after: '0' })).toEqual(before);
    for (const prefix of ['skills', 'mcp']) {
      for (const field of ['workspaceId', 'sessionId', 'workflow'])
        expect(
          (await get(`/v1/config/user/${prefix}?storeId=${storeId}&${field}=project`)).status,
        ).toBe(400);
      expect((await get(`/v1/config/user/${prefix}?storeId=wrong`)).status).toBe(409);
      expect((await get(`/v1/config/user/${prefix}?storeId=${storeId}`, 'wrong')).status).toBe(401);
    }
    const saved = await client.updateUserMcpSettings({
      storeId,
      commandId: 'add-user-mcp',
      expectedReadSet: mcp.readSet!,
      operation: {
        kind: 'add',
        name: 'added',
        entry: { type: 'http', url: 'https://second.example.test/mcp' },
      },
    });
    expect(saved.state).toBe('applied');
    expect(await client.getUserMcpOperation('add-user-mcp', { storeId })).toEqual(saved);
    expect(await client.cancelUserMcpOperation('add-user-mcp', { storeId })).toEqual(saved);
    expect(await client.listWorkspaces()).toEqual([]);
    expect(await client.listSessions()).toEqual([]);
    const project = join(root, 'project');
    privateDirectory(join(project, '.kite-code'));
    writeFileSync(
      join(project, '.kite-code', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          global: { type: 'http', url: 'https://project.example.test/private' },
          projectOnly: { type: 'http', url: 'https://project.example.test/only' },
        },
      }),
      { mode: 0o600 },
    );
    writeFileSync(join(project, 'kite-agent.jsonc'), '{ invalid project configuration');
    await runtime.createWorkspace({
      id: 'project',
      name: 'Project',
      rootUri: pathToFileURL(project).href,
      expectedStoreId: storeId,
    });
    const afterProject = await client.getUserMcpSettings({ storeId });
    expect(afterProject.sources.map((source) => source.name).sort()).toEqual(['added', 'global']);
    expect(afterProject.sources.find((source) => source.name === 'global')!.address).toBe(
      'https://mcp.example.test/mcp',
    );
    expect(await client.listUserSkills({ storeId })).toEqual(skill);
    expect(await client.listSessions()).toEqual([]);
    expect(vaultEffects).toBe(0);
  } finally {
    await service.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
