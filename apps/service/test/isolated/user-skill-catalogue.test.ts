import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRuntime } from '@kite-ai/agent';
import type { JsonObject } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { createDefaultSkillCatalogueSource } from '../../src/skill-catalogue';
import { createUserConfiguration } from '../../src/user-configuration';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-user-skills-')));
  const userRoot = join(root, 'user');
  privateDirectory(userRoot);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  privateDirectory(profile.profilePath);
  const path = join(userRoot, 'config.jsonc');
  const calls: string[] = [];
  const runtime = new Proxy(
    {
      async getMetadata() {
        calls.push('getMetadata');
        return { storeId: 'owned-store' };
      },
    },
    {
      get(target, property) {
        if (property in target) return Reflect.get(target, property);
        throw Error(`unexpected_runtime_operation_${String(property)}`);
      },
    },
  ) as unknown as AgentRuntime;
  const skill = (parent: string, name: string, required = '') => {
    privateDirectory(parent);
    writeFileSync(
      join(parent, 'SKILL.md'),
      `---\nname: ${name}\ndescription: metadata ${name}\n${required}---\nPRIVATE_SKILL_BODY\n`,
      { mode: 0o600 },
    );
  };
  let explicit: JsonObject = {},
    defaults: JsonObject | undefined;
  const source = () =>
    createDefaultSkillCatalogueSource({
      profile,
      userConfiguration: createUserConfiguration(path),
      explicit: () => explicit,
      defaults,
      allowedCapabilities: ['files.read'],
      workflowBindings: async () => {
        throw Error('unexpected_workflow_compilation');
      },
    });
  return {
    root,
    userRoot,
    profile,
    path,
    calls,
    runtime,
    skill,
    source,
    context: { runtime, storeId: 'owned-store', subjectId: 'owner' },
    configure(value: JsonObject) {
      writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    },
    explicit(value: JsonObject) {
      explicit = value;
    },
    defaults(value: JsonObject) {
      defaults = value;
    },
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('global Skills reads only merged user configuration and trusted user/Profile locations without Workspace authority', async () => {
  const f = fixture();
  const rows: JsonObject[] = [];
  for (let i = 0; i < 301; i++) {
    const id = `user-${String(i).padStart(3, '0')}`;
    f.skill(join(f.userRoot, 'skills', id), id);
    rows.push({ id, path: `skills/${id}` });
  }
  f.skill(join(f.profile.profilePath, 'skills', 'owned'), 'Owned profile');
  const projectRoot = join(f.root, 'project');
  f.skill(join(projectRoot, 'private'), 'PROJECT_METADATA_MUST_NOT_APPEAR');
  writeFileSync(join(projectRoot, 'kite-agent.jsonc'), '{ malformed project configuration');
  symlinkSync(projectRoot, join(f.userRoot, 'project-link'), 'dir');
  f.defaults({
    modelId: null,
    models: [],
    tools: [{ id: 'files.read' }],
    skills: [{ id: 'overridden', path: 'absent-default' }],
    mcp: [],
  });
  f.configure({
    skills: [
      ...rows,
      { id: 'profile', path: join(f.profile.profilePath, 'skills', 'owned') },
      { id: 'project-denied', path: join(projectRoot, 'private') },
      { id: 'project-symlink', path: 'project-link/private' },
      { id: 'disabled', path: join(projectRoot, 'private'), enabled: false },
      { id: 'overridden', path: 'absent-user' },
    ],
  });
  f.explicit({ skills: [{ id: 'overridden', enabled: false }] });
  const source = f.source();
  try {
    const first = await source.listUser!({ ...f.context, limit: 37 });
    const all = [...first.entries];
    let page = first;
    while (!page.complete) {
      page = await source.listUser!({
        ...f.context,
        revision: first.revision,
        afterId: page.nextAfterId!,
        limit: 37,
      });
      all.push(...page.entries);
    }
    expect(all).toHaveLength(306);
    expect(new Set(all.map((row) => row.id)).size).toBe(all.length);
    expect(first.scope).toBe('user');
    expect('workspaceId' in first || 'sessionId' in first).toBe(false);
    expect(all.find((row) => row.id === 'user-000')?.source).toEqual({
      scope: 'user',
      origin: 'configured',
    });
    expect(all.find((row) => row.id === 'profile')?.source).toEqual({
      scope: 'user',
      origin: 'profile',
    });
    for (const id of ['project-denied', 'project-symlink'])
      expect(all.find((row) => row.id === id)).toMatchObject({
        state: 'unavailable',
        reason: 'skill_path_denied',
        name: null,
        description: null,
      });
    expect(all.find((row) => row.id === 'disabled')).toMatchObject({
      state: 'disabled',
      source: null,
      name: null,
    });
    expect(all.find((row) => row.id === 'overridden')).toMatchObject({
      state: 'disabled',
      name: null,
    });
    expect(all.every((row) => row.source == null || row.source.scope === 'user')).toBe(true);
    expect(all.every((row) => !('workflow' in row))).toBe(true);
    for (const privateText of [
      f.root,
      'PRIVATE_SKILL_BODY',
      'PROJECT_METADATA_MUST_NOT_APPEAR',
      '"path":',
      '"token":',
    ])
      expect(JSON.stringify(all).includes(privateText)).toBe(false);
    expect(f.calls.every((call) => call === 'getMetadata')).toBe(true);
    expect(await source.listUser!(f.context)).toMatchObject({ revision: first.revision });
    f.skill(join(f.userRoot, 'skills', 'user-000'), 'Changed user metadata');
    await expect(
      source.listUser!({ ...f.context, revision: first.revision, afterId: first.nextAfterId! }),
    ).rejects.toMatchObject({ code: 'skill_catalogue_changed' });
  } finally {
    await source.dispose!();
    f.close();
  }
});

test('global user source has stable empty reads without creating a missing configuration directory', async () => {
  const f = fixture();
  rmSync(f.userRoot, { recursive: true });
  const source = f.source();
  try {
    const first = await source.listUser!(f.context);
    expect(first).toMatchObject({
      scope: 'user',
      availability: 'available',
      reason: null,
      entries: [],
      complete: true,
      nextAfterId: null,
    });
    expect(existsSync(f.userRoot)).toBe(false);
    expect((await source.listUser!(f.context)).revision).toBe(first.revision);
    await expect(source.listUser!({ ...f.context, storeId: 'forged' })).rejects.toMatchObject({
      code: 'store_identity_mismatch',
    });
    await expect(source.listUser!({ ...f.context, afterId: 'unknown' })).rejects.toMatchObject({
      code: 'invalid_skill_catalogue_query',
    });
    await source.dispose!();
    await expect(source.listUser!(f.context)).rejects.toMatchObject({
      code: 'knowledge_source_closed',
    });
  } finally {
    await source.dispose!();
    f.close();
  }
});

test('malformed user JSONC is unavailable, cannot continue a previous revision, and recovers after correction', async () => {
  const f = fixture();
  f.configure({ skills: [] });
  const source = f.source();
  try {
    const initial = await source.listUser!(f.context);
    writeFileSync(f.path, '{ malformed', { mode: 0o600 });
    const unavailable = await source.listUser!(f.context);
    expect(unavailable).toMatchObject({
      scope: 'user',
      availability: 'unavailable',
      reason: 'configuration_unavailable',
      entries: [],
      complete: true,
    });
    await expect(
      source.listUser!({ ...f.context, revision: initial.revision }),
    ).rejects.toMatchObject({ code: 'skill_catalogue_changed' });
    f.configure({ skills: [] });
    expect((await source.listUser!(f.context)).revision).toBe(initial.revision);
  } finally {
    await source.dispose!();
    f.close();
  }
});
