import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { privateDirectory } from '../../../../tests/fixtures/test-filesystem';
import { createWorkspaceAssembly } from '../../src/assembly';
import { createConfiguredSkillSource } from '../../src/skill-source';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-builtin-computer-use-')));
  const workspaces = ['a', 'b'].map((name) => join(root, name));
  for (const workspace of workspaces) mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  privateDirectory(profile.profilePath);
  return { root, workspaces, profile };
}
const tools = ['browser.execute', 'skills.load', 'skills.resource'];
const request = {
  workspaceId: 'workspace',
  sessionId: 'session',
  definitionId: 'model',
  input: null,
};
const context = { signal: new AbortController().signal } as ToolContext;

test('the same packaged computer-use skill is discoverable in different workspaces and loads only on demand', async () => {
  const f = fixture();
  const assemblies: Awaited<ReturnType<typeof createWorkspaceAssembly>>[] = [];
  try {
    for (const workspaceRoot of f.workspaces) {
      const assembly = await createWorkspaceAssembly({
        workspaceRoot,
        profile: f.profile,
        toolIds: tools,
        knownToolIds: ['browser.execute'],
        allowedCapabilities: ['browser.execute'],
      });
      assemblies.push(assembly);
      expect(assembly.skillConfigurations).toEqual([]);
      expect(assembly.snapshotFacts.skills).toMatchObject([
        { id: 'computer-use', requiredCapabilities: ['browser.execute'] },
      ]);
      const sources = await assembly.sources.capture(request);
      const catalogue = sources.find((entry) => entry.id === 'skills.catalogue')!;
      expect(JSON.parse(catalogue.content)).toMatchObject([{ id: 'computer-use' }]);
      expect(sources.some((entry) => entry.kind === 'skill')).toBe(false);
      const skillTools = assembly.extensions.find((entry) => entry.id === 'builtin.skills')!.tools!;
      const loaded = await skillTools
        .find((tool) => tool.id === 'skills.load')!
        .execute({ id: 'computer-use' }, context);
      expect(loaded.outcome).toBe('succeeded');
      expect(loaded.content).toContain('registered capabilities, the exact task and page scope');
      expect(loaded.content).toContain(
        'do not require automatic review, user approval or an extra permission question',
      );
      expect(loaded.content).toContain('If the user asks to open a specified URL as new work');
      expect(loaded.content).toContain('When continuing a previously controlled page');
      expect(loaded.content).toContain('Do not create a human request, ask for Continue');
      expect(loaded.content).toContain('tell the user what remains and end this task');
      expect(loaded.content).toContain('report the actual result in a normal final answer');
      const resource = await skillTools
        .find((tool) => tool.id === 'skills.resource')!
        .execute({ id: 'computer-use', path: 'references/browser-api.md' }, context);
      expect(resource.outcome).toBe('succeeded');
      expect(resource.content).toContain('page.close(): end automation and release control');
      expect(resource.content).not.toContain('page.requestHuman');
      expect(resource.content).toContain('stale-element failure occurred before dispatch');
      expect(resource.content).toContain('Do not replay the whole batch');
      const after = await assembly.sources.capture(request);
      expect(after.some((entry) => entry.id === 'skill.body:computer-use')).toBe(true);
      expect(
        after.some((entry) => entry.id === 'skill.resource:computer-use:references/browser-api.md'),
      ).toBe(true);
    }
    expect(assemblies[0]!.snapshotFacts.skills).toEqual(assemblies[1]!.snapshotFacts.skills);
    const inherited = await createWorkspaceAssembly({
      workspaceRoot: f.workspaces[1]!,
      profile: f.profile,
      toolIds: tools,
      knownToolIds: ['browser.execute'],
      allowedCapabilities: ['browser.execute'],
      inheritedSkillIds: ['computer-use'],
    });
    assemblies.push(inherited);
    expect(inherited.snapshotFacts.skills).toEqual(assemblies[0]!.snapshotFacts.skills);
  } finally {
    for (const assembly of assemblies) await assembly.dispose();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('builtin dependencies are local unavailability, never permission grants or configuration overrides', async () => {
  const f = fixture();
  const source = createConfiguredSkillSource({
    workspaceRoot: f.workspaces[0]!,
    profile: f.profile,
    toolIds: tools,
    allowedCapabilities: [],
  });
  try {
    const listed = await source.list();
    expect(listed.entries).toEqual([]);
    expect(listed.states).toEqual([
      {
        id: 'computer-use',
        source: null,
        name: 'computer-use',
        description: expect.any(String),
        version: expect.stringMatching(/^[a-f0-9]{64}$/),
        enabled: true,
        state: 'unavailable',
        reason: 'skill_capability_missing',
        requiredCapabilities: ['browser.execute'],
        missingCapabilities: ['browser.execute'],
      },
    ]);
    await expect(
      createWorkspaceAssembly({
        workspaceRoot: f.workspaces[0]!,
        profile: f.profile,
        toolIds: tools,
        knownToolIds: ['browser.execute'],
        allowedCapabilities: [],
        selectedSkills: ['computer-use'],
      }),
    ).rejects.toMatchObject({ code: 'skill_capability_missing' });
    const collision = createConfiguredSkillSource({
      workspaceRoot: f.workspaces[0]!,
      profile: f.profile,
      toolIds: tools,
      allowedCapabilities: ['browser.execute'],
      skills: [{ id: 'computer-use', path: 'malicious' }],
    });
    try {
      await expect(collision.list()).rejects.toMatchObject({ code: 'invalid_skill_configuration' });
    } finally {
      await collision.dispose();
    }
  } finally {
    await source.dispose();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('installed computer-use metadata is global before any browser capability is selected and needs no project or user directory', async () => {
  const f = fixture();
  const missingUserRoot = join(f.root, 'not-created-user-configuration');
  const sources = [
    ...f.workspaces.map((workspaceRoot) =>
      createConfiguredSkillSource({
        workspaceRoot,
        profile: f.profile,
        toolIds: [],
        allowedCapabilities: ['browser.execute'],
      }),
    ),
    createConfiguredSkillSource({
      userRoot: missingUserRoot,
      profile: f.profile,
      toolIds: [],
      allowedCapabilities: [],
    }),
    createConfiguredSkillSource({
      workspaceRoot: join(f.root, 'not-created-workspace'),
      profile: f.profile,
      toolIds: ['skills.load'],
      allowedCapabilities: [],
    }),
  ];
  try {
    const versions: string[] = [];
    for (const source of sources) {
      const listed = await source.list();
      expect(listed.entries).toEqual([]);
      expect(listed.states).toHaveLength(1);
      expect(listed.states[0]).toMatchObject({
        id: 'computer-use',
        name: 'computer-use',
        enabled: true,
        source: null,
        state: 'unavailable',
        reason: 'skill_capability_missing',
        requiredCapabilities: ['browser.execute'],
        missingCapabilities: ['browser.execute'],
      });
      versions.push(listed.states[0]!.version!);
      await expect(
        source.load({ id: 'builtin:computer-use', availableCapabilities: ['browser.execute'] }),
      ).rejects.toMatchObject({ code: 'skill_capability_missing' });
      await expect(
        source.readResource({
          skillId: 'builtin:computer-use',
          version: listed.states[0]!.version!,
          path: 'references/browser-api.md',
          availableCapabilities: ['browser.execute'],
        }),
      ).rejects.toMatchObject({ code: 'skill_capability_missing' });
    }
    expect(new Set(versions).size).toBe(1);
    expect(existsSync(missingUserRoot)).toBe(false);
    expect(existsSync(join(f.root, 'not-created-workspace'))).toBe(false);
    await expect(
      createWorkspaceAssembly({
        workspaceRoot: f.workspaces[0]!,
        profile: f.profile,
        toolIds: ['skills.load'],
        toolConfigurations: [{ id: 'browser.execute', enabled: false }],
        selectedSkills: ['computer-use'],
        allowedCapabilities: ['browser.execute'],
      }),
    ).rejects.toMatchObject({ code: 'skill_capability_missing' });
  } finally {
    for (const source of sources) await source.dispose();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a selected builtin reader preserves the caller capability narrowing instead of treating knowledge as a grant', async () => {
  const f = fixture();
  const source = createConfiguredSkillSource({
    workspaceRoot: f.workspaces[0]!,
    profile: f.profile,
    toolIds: tools,
    allowedCapabilities: ['browser.execute'],
  });
  try {
    const listed = await source.list();
    const builtin = listed.entries[0]!;
    await expect(source.load({ id: builtin.id, availableCapabilities: [] })).rejects.toMatchObject({
      code: 'skill_capability_missing',
    });
    expect(
      (await source.load({ id: builtin.id, availableCapabilities: ['browser.execute'] })).name,
    ).toBe('computer-use');
    await expect(
      source.readResource({
        skillId: builtin.id,
        version: builtin.version,
        path: 'references/browser-api.md',
        availableCapabilities: [],
      }),
    ).rejects.toMatchObject({ code: 'skill_capability_missing' });
  } finally {
    await source.dispose();
    rmSync(f.root, { recursive: true, force: true });
  }
});
