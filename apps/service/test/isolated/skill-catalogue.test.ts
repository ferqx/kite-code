import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { createConfiguredSkillSource } from '../../src/skill-source';

test('default scoped Skill HTTP catalogue is complete, locally unavailable and strictly read only', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-skills-http-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const skills: Array<{
    id: string;
    path: string;
    enabled?: boolean;
    digest?: string;
    options?: Record<string, unknown>;
  }> = [];
  for (let i = 0; i < 301; i++) {
    const id = `skill-${String(i).padStart(3, '0')}`;
    mkdirSync(join(workspace, id));
    writeFileSync(
      join(workspace, id, 'SKILL.md'),
      `---\nname: ${id}\ndescription: Metadata ${i}\n---\nprivate-body-${i}\n`,
    );
    skills.push({ id, path: id });
  }
  mkdirSync(join(workspace, 'needs'));
  writeFileSync(
    join(workspace, 'needs', 'SKILL.md'),
    '---\nname: Needs\ndescription: requires authority\nrequired-capabilities: files.write\n---\nprivate-needs',
  );
  skills.push(
    { id: 'missing', path: 'absent' },
    { id: 'disabled', path: '/outside/secret', enabled: false },
    { id: 'needs', path: 'needs' },
    { id: 'options', path: 'skill-000', options: { unsupported: true } },
    { id: 'pinned', path: 'skill-001', digest: 'f'.repeat(64) },
  );
  const configPath = join(profile.profilePath, 'config.jsonc');
  const config = { skills, tools: [] };
  writeFileSync(configPath, JSON.stringify(config));
  let model = 0,
    vault = 0;
  const host = createDefaultProcessConfiguration({
    profile,
    credentialBackend: {
      kind: 'temporary',
      async put() {
        vault++;
      },
      async remove() {
        vault++;
      },
      async resolve() {
        vault++;
        return 'secret';
      },
    },
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const runtime = createRuntime({
    store,
    permissions: host.permissions!,
    resolveRunConfiguration: async (input) => {
      model++;
      return host.resolveRunConfiguration!(input);
    },
  });
  const permissions = host.permissionManagement!(runtime);
  const storeId = (await runtime.getMetadata()).storeId;
  const identity = { expectedStoreId: storeId, subjectId: 'owner' };
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'owned',
    rootUri: `file://${workspace}`,
  });
  const service = await startService({
    runtime,
    skillCatalogue: host.skillCatalogue,
    permissionManagement: permissions,
    subjectId: 'owner',
    buildId: 'owned-skills',
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
      apiMajor: 1,
      profile: service.bootstrap.profile,
      instanceId: service.bootstrap.instanceId,
      buildId: service.bootstrap.buildId,
      requiredCapabilities: ['skill_catalogue'],
    },
  });
  const get = (query: string, id = 'w') =>
    fetch(`${service.endpoint}/v1/workspaces/${id}/skills?${query}`, {
      headers: { authorization: `Bearer ${service.bootstrap.token}` },
    });
  try {
    await client.connect();
    expect((await get(`storeId=${storeId}`)).status).toBe(403);
    const trust = await permissions.readTrust({ ...identity, workspaceId: 'w' });
    await permissions.setTrust({
      ...identity,
      workspaceId: 'w',
      commandId: 'trust',
      trusted: true,
      canonicalIdentity: trust.canonicalIdentity,
      externalReadScopeDigest: trust.externalReadScopeDigest,
      ifRevision: trust.revision,
    });
    const before = await runtime.getChanges({ after: '0' });
    const first = await client.listSkills('w', { storeId, limit: 37 });
    expect(first.entries).toHaveLength(37);
    expect(first.complete).toBe(false);
    const all = [...first.entries];
    let page = first;
    while (!page.complete) {
      page = await client.listSkills('w', {
        storeId,
        limit: 37,
        revision: first.revision,
        afterId: page.nextAfterId!,
      });
      all.push(...page.entries);
    }
    expect(all).toHaveLength(skills.length);
    expect(new Set(all.map((e) => e.id)).size).toBe(skills.length);
    expect(all.every((entry) => Object.hasOwn(entry, 'source'))).toBe(true);
    expect(all.find((entry) => entry.id === 'skill-000')?.source).toEqual({
      scope: 'project',
      origin: 'configured',
    });
    expect(all.find((e) => e.id === 'disabled')).toMatchObject({
      state: 'disabled',
      source: null,
      name: null,
      version: null,
      reason: null,
    });
    expect(all.find((e) => e.id === 'missing')).toMatchObject({
      state: 'unavailable',
      source: { scope: 'project', origin: 'configured' },
      reason: 'skill_unavailable',
    });
    expect(all.find((e) => e.id === 'needs')).toMatchObject({
      state: 'unavailable',
      reason: 'skill_capability_missing',
      missingCapabilities: ['files.write'],
    });
    expect(all.find((e) => e.id === 'options')).toMatchObject({
      state: 'unavailable',
      reason: 'unsupported_skill_options',
    });
    expect(all.find((e) => e.id === 'pinned')).toMatchObject({
      state: 'unavailable',
      reason: 'duplicate_skill_location',
    });
    expect((await client.listAllSkills('w', { storeId })).entries).toEqual(all);
    for (const hidden of [
      root,
      'private-body',
      'private-needs',
      '/outside/secret',
      'secret',
      service.bootstrap.token,
    ])
      expect(JSON.stringify(all)).not.toContain(hidden);
    for (const query of [
      `storeId=${storeId}&subjectId=forged`,
      `storeId=${storeId}&owner=forged`,
      `storeId=${storeId}&path=/tmp`,
      `storeId=${storeId}&storeId=other`,
    ])
      expect((await get(query)).status).toBe(400);
    expect((await get('storeId=wrong')).status).toBe(409);
    expect((await get(`storeId=${storeId}`, 'absent')).status).toBe(404);
    expect((await get(`storeId=${storeId}&afterId=forged&revision=${first.revision}`)).status).toBe(
      400,
    );
    writeFileSync(
      join(workspace, 'skill-100', 'SKILL.md'),
      '---\nname: Changed\ndescription: changed\n---\nchanged body',
    );
    expect(
      (await get(`storeId=${storeId}&afterId=${first.nextAfterId}&revision=${first.revision}`))
        .status,
    ).toBe(409);
    const fresh = await client.listSkills('w', { storeId, limit: 37 });
    writeFileSync(configPath, '{ malformed');
    expect(
      (await get(`storeId=${storeId}&afterId=${fresh.nextAfterId}&revision=${fresh.revision}`))
        .status,
    ).toBe(409);
    expect(await client.listAllSkills('w', { storeId })).toMatchObject({
      availability: 'unavailable',
      reason: 'configuration_unavailable',
      entries: [],
      complete: true,
    });
    const unavailable = await startService({
      runtime,
      capabilities: ['skill_catalogue', 'skill_workflow_catalogue'],
      subjectId: 'owner',
      buildId: 'no-source',
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      },
    });
    try {
      const read = (id: string, suffix = '') =>
        fetch(`${unavailable.endpoint}/v1/workspaces/${id}/skills?storeId=${storeId}${suffix}`, {
          headers: { authorization: `Bearer ${unavailable.bootstrap.token}` },
        });
      const advertised = await fetch(`${unavailable.endpoint}/v1/server`, {
        headers: { authorization: `Bearer ${unavailable.bootstrap.token}` },
      }).then((r) => r.json());
      expect(advertised.capabilities).not.toContain('skill_catalogue');
      expect(advertised.capabilities).not.toContain('skill_workflow_catalogue');
      const unsupportedWorkflow = await read('w', '&workflow=manual');
      expect(unsupportedWorkflow.status).toBe(404);
      expect(await unsupportedWorkflow.json()).toMatchObject({
        code: 'skill_workflow_catalogue_unavailable',
      });
      expect((await read('absent')).status).toBe(404);
      expect(await (await read('w')).json()).toMatchObject({
        availability: 'unavailable',
        reason: 'skill_catalogue_source_unavailable',
        workspaceId: 'w',
      });
      expect((await read('w', `&revision=${first.revision}`)).status).toBe(409);
      const unavailablePage = await (await read('w')).json();
      expect((await read('w', `&afterId=forged&revision=${unavailablePage.revision}`)).status).toBe(
        400,
      );
      expect(await runtime.getChanges({ after: '0' })).toEqual(before);
      expect(await runtime.listSessions()).toHaveLength(0);
      expect(await runtime.listWorkspaces()).toHaveLength(1);
      expect(model).toBe(0);
      expect(vault).toBe(0);
      expect(client.lastAppliedCursor).toBeUndefined();
    } finally {
      await unavailable.close();
    }
  } finally {
    client.disposeNetwork();
    await service.close();
    await runtime.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('configured Skill source reports bounded location facts and never reads disabled metadata', async () => {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-skill-source-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  const locations = [
    {
      id: 'agents',
      path: join(workspace, '.agents', 'skills', 'agents'),
      source: { scope: 'project', origin: '.agents' },
    },
    {
      id: 'kite',
      path: join(workspace, '.kite-code', 'skills', 'kite'),
      source: { scope: 'project', origin: '.kite-code' },
    },
    {
      id: 'custom',
      path: join(workspace, 'custom'),
      source: { scope: 'project', origin: 'configured' },
    },
    {
      id: 'profile',
      path: join(profile.profilePath, 'skills', 'profile'),
      source: { scope: 'user', origin: 'profile' },
    },
    {
      id: 'disabled',
      path: join(workspace, '.agents', 'skills', 'disabled'),
      source: { scope: 'project', origin: '.agents' },
    },
  ] as const;
  try {
    for (const location of locations) {
      mkdirSync(location.path, { recursive: true });
      writeFileSync(
        join(location.path, 'SKILL.md'),
        `---\nname: ${location.id}\ndescription: private metadata ${location.id}\n---\nprivate-body`,
      );
    }
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(
      join(outside, 'SKILL.md'),
      '---\nname: outside\ndescription: private outside\n---\nprivate-body',
    );
    symlinkSync(outside, join(workspace, 'escaped'));
    const source = createConfiguredSkillSource({
      workspaceRoot: workspace,
      profile,
      toolIds: [],
      skills: [
        ...locations.map(({ id, path }) => ({
          id,
          path,
          ...(id === 'disabled' ? { enabled: false } : {}),
        })),
        { id: 'disabled-missing', path: '.kite-code/skills/absent', enabled: false },
        { id: 'denied', path: outside },
        { id: 'escaped', path: 'escaped' },
        { id: 'invalid', path: 42 },
        { id: 'empty', path: '' },
        { id: 'missing', path: 'absent' },
      ],
    });
    const listed = await source.list();
    for (const location of locations) {
      expect(listed.states.find((row) => row.id === location.id)?.source).toEqual(location.source);
    }
    expect(listed.states.find((row) => row.id === 'disabled')).toMatchObject({
      state: 'disabled',
      name: null,
      description: null,
      version: null,
      reason: null,
    });
    expect(listed.states.find((row) => row.id === 'disabled-missing')).toMatchObject({
      state: 'disabled',
      name: null,
      source: { scope: 'project', origin: '.kite-code' },
    });
    for (const id of ['denied', 'escaped', 'invalid', 'empty'])
      expect(listed.states.find((row) => row.id === id)?.source).toBeNull();
    expect(listed.states.find((row) => row.id === 'missing')).toMatchObject({
      state: 'unavailable',
      source: { scope: 'project', origin: 'configured' },
    });
    expect(listed.entries).toHaveLength(4);
    expect(JSON.stringify(listed.states)).not.toContain(root);
    expect(JSON.stringify(listed.states)).not.toContain('private-body');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
