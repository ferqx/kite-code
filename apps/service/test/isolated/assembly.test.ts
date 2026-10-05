import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { createWorkspaceAssembly } from '../../src/assembly';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kite-assembly-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  return {
    root,
    workspace,
    profile,
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const request = {
  workspaceId: 'workspace',
  sessionId: 'session',
  definitionId: 'model',
  input: null,
};
test('per-Run host assembly discovers summaries only, binds actual versions and never executes Skill resources', async () => {
  const f = fixture();
  let assembly: Awaited<ReturnType<typeof createWorkspaceAssembly>> | undefined;
  try {
    const skill = join(f.workspace, 'skills', 'guide');
    mkdirSync(join(skill, 'scripts'), { recursive: true });
    writeFileSync(
      join(skill, 'SKILL.md'),
      '---\nname: Guide\ndescription: Safe summary\n---\nprivate-body-marker\n[helper](scripts/helper.sh)\n',
    );
    writeFileSync(join(skill, 'scripts/helper.sh'), 'echo harmless > must-not-run\n');
    assembly = await createWorkspaceAssembly({
      workspaceRoot: f.workspace,
      profile: f.profile,
      toolIds: ['skills.load', 'skills.resource', 'files.write'],
      skills: [{ id: 'guide', path: 'skills/guide' }],
      allowedCapabilities: [],
    });
    const sources = await assembly.sources.capture(request);
    expect(sources.some((source) => source.kind === 'skill_catalogue')).toBe(true);
    expect(JSON.stringify(sources)).toContain('Safe summary');
    expect(JSON.stringify(sources)).not.toContain('private-body-marker');
    expect(assembly.snapshotFacts.allowedCapabilities).toEqual([]);
    expect(assembly.snapshotFacts.skills[0]!.requiredCapabilities).toEqual([]);
    expect(
      assembly.extensions.flatMap((extension) => extension.tools?.map((tool) => tool.id) ?? []),
    ).toContain('files.write');
    expect(
      assembly.snapshotFacts.tools.find((tool) => tool.id === 'files.write')!.definitionVersion,
    ).toBe('2');
    writeFileSync(
      join(skill, 'SKILL.md'),
      '---\nname: Guide\ndescription: New summary\n---\nnew-body-marker\n',
    );
    const current = await assembly.sources.capture(request);
    expect(JSON.stringify(current)).toContain('New summary');
    expect(JSON.stringify(current)).not.toContain('new-body-marker');
    expect(current.find((source) => source.id === 'skills.catalogue')!.digest).not.toBe(
      sources.find((source) => source.id === 'skills.catalogue')!.digest,
    );
    expect(assembly.snapshotFacts.skills[0]!.version).toBe(
      JSON.parse(sources.find((source) => source.id === 'skills.catalogue')!.content)[0].version,
    );
  } finally {
    await assembly?.dispose();
    f.close();
  }
});

test('configuration cannot invent Tool IDs or trusted Skill roots, and disabled Skills are not discovered', async () => {
  const f = fixture();
  let assembly: Awaited<ReturnType<typeof createWorkspaceAssembly>> | undefined;
  try {
    await expect(
      createWorkspaceAssembly({
        workspaceRoot: f.workspace,
        profile: f.profile,
        toolIds: ['unknown.tool'],
      }),
    ).rejects.toMatchObject({ code: 'tool_definition_unavailable' });
    await expect(
      createWorkspaceAssembly({
        workspaceRoot: f.workspace,
        profile: f.profile,
        toolIds: ['files.read'],
        toolConfigurations: [{ id: 'files.read', options: { maxBytes: 10 } }],
      }),
    ).rejects.toMatchObject({ code: 'unsupported_tool_options' });
    await expect(
      createWorkspaceAssembly({
        workspaceRoot: f.workspace,
        profile: f.profile,
        toolIds: ['files.read'],
        toolConfigurations: [{ id: 'files.read', definitionVersion: '1' }],
      }),
    ).rejects.toMatchObject({ code: 'tool_definition_version_unavailable' });
    const outside = join(f.root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'SKILL.md'), 'outside');
    await expect(
      createWorkspaceAssembly({
        workspaceRoot: f.workspace,
        profile: f.profile,
        toolIds: ['skills.load'],
        skills: [{ id: 'outside', path: outside }],
        selectedSkills: ['outside'],
      }),
    ).rejects.toMatchObject({ code: 'skill_path_denied' });
    symlinkSync(outside, join(f.workspace, 'escape'));
    await expect(
      createWorkspaceAssembly({
        workspaceRoot: f.workspace,
        profile: f.profile,
        toolIds: ['skills.load'],
        skills: [{ id: 'outside', path: 'escape' }],
        selectedSkills: ['outside'],
      }),
    ).rejects.toMatchObject({ code: 'skill_path_denied' });
    assembly = await createWorkspaceAssembly({
      workspaceRoot: f.workspace,
      profile: f.profile,
      toolIds: [],
      skills: [{ id: 'disabled', enabled: false, path: outside }],
    });
    expect(assembly.snapshotFacts.skills).toEqual([]);
    expect(await assembly.sources.capture(request)).toEqual([]);
  } finally {
    await assembly?.dispose();
    f.close();
  }
});

test('private Skill selection resolves one canonical ID/name and narrows all catalogue facts; ambiguous and unknown selectors fail closed', async () => {
  const f = fixture();
  let assembly: Awaited<ReturnType<typeof createWorkspaceAssembly>> | undefined;
  try {
    for (const id of ['alpha', 'beta']) {
      const path = join(f.workspace, id);
      mkdirSync(path);
      writeFileSync(
        join(path, 'SKILL.md'),
        `---\nname: SharedName\ndescription: ${id}\n---\n${id}-body\n`,
      );
    }
    const options = {
      workspaceRoot: f.workspace,
      profile: f.profile,
      toolIds: ['skills.load'],
      skills: [
        { id: 'alpha', path: 'alpha' },
        { id: 'beta', path: 'beta' },
      ],
    };
    for (const [selector, code] of [
      ['SharedName', 'skill_selection_ambiguous'],
      ['../outside/SKILL.md', 'skill_not_discovered'],
    ]) {
      let failure: unknown;
      try {
        await createWorkspaceAssembly({ ...options, selectedSkills: [selector!] });
      } catch (error) {
        failure = error;
      }
      expect((failure as { code: string }).code).toBe(code!);
    }
    assembly = await createWorkspaceAssembly({ ...options, selectedSkills: ['alpha', 'alpha'] });
    expect(assembly.skillConfigurations).toEqual([{ id: 'alpha', path: 'alpha' }]);
    expect(assembly.snapshotFacts.skills.map((entry) => entry.id)).toEqual(['alpha']);
    const sources = await assembly.sources.capture(request);
    expect(
      JSON.parse(sources.find((entry) => entry.id === 'skills.catalogue')!.content),
    ).toMatchObject([{ id: 'alpha', name: 'SharedName' }]);
    expect(JSON.stringify(sources)).not.toContain('beta');
    await assembly.dispose();
    assembly = await createWorkspaceAssembly({ ...options, selectedSkills: [] });
    expect(assembly.snapshotFacts.skills).toEqual([]);
    expect(await assembly.sources.capture(request)).toEqual([]);
  } finally {
    await assembly?.dispose();
    f.close();
  }
});

test('unselected local errors do not gate default assembly; explicit selectors see bad rows and all known ambiguous names', async () => {
  const f = fixture();
  let assembly: Awaited<ReturnType<typeof createWorkspaceAssembly>> | undefined;
  try {
    for (const [id, name] of [
      ['good', 'guide'],
      ['bad-name', 'Shared'],
      ['other', 'Shared'],
    ] as const) {
      mkdirSync(join(f.workspace, id));
      writeFileSync(
        join(f.workspace, id, 'SKILL.md'),
        `---\nname: ${name}\ndescription: summary\n---\nprivate body`,
      );
    }
    const options: Parameters<typeof createWorkspaceAssembly>[0] = {
      workspaceRoot: f.workspace,
      profile: f.profile,
      toolIds: ['skills.load'],
      skills: [
        { id: 'guide', path: 'absent' },
        { id: 'good', path: 'good' },
        { id: 'bad-name', path: 'bad-name', digest: 'f'.repeat(64) },
        { id: 'other', path: 'other' },
        { id: 'bad-options', path: 'good', options: { x: true } },
      ],
    };
    assembly = await createWorkspaceAssembly(options);
    expect(assembly.snapshotFacts.skills.map((s) => s.id)).toEqual(['good', 'other']);
    expect(assembly.skillConfigurations.map((s) => s.id)).toEqual(['good', 'other']);
    await assembly.dispose();
    assembly = undefined;
    await expect(
      createWorkspaceAssembly({ ...options, selectedSkills: ['guide'] }),
    ).rejects.toMatchObject({ code: 'skill_selection_ambiguous' });
    await expect(
      createWorkspaceAssembly({ ...options, selectedSkills: ['bad-name'] }),
    ).rejects.toMatchObject({ code: 'skill_version_changed' });
    await expect(
      createWorkspaceAssembly({ ...options, selectedSkills: ['Shared'] }),
    ).rejects.toMatchObject({ code: 'skill_selection_ambiguous' });
    await expect(
      createWorkspaceAssembly({ ...options, inheritedSkillIds: ['guide'] }),
    ).rejects.toMatchObject({ code: 'skill_unavailable' });
    await expect(
      createWorkspaceAssembly({ ...options, selectedSkills: ['bad-options'] }),
    ).rejects.toMatchObject({ code: 'unsupported_skill_options' });
  } finally {
    await assembly?.dispose();
    f.close();
  }
});

test('selected canonical source identity cannot silently disappear when a trusted path is rebound', async () => {
  const f = fixture();
  let assembly: Awaited<ReturnType<typeof createWorkspaceAssembly>> | undefined;
  try {
    for (const id of ['one', 'two']) {
      mkdirSync(join(f.workspace, id));
      writeFileSync(
        join(f.workspace, id, 'SKILL.md'),
        `---\nname: ${id}\ndescription: summary\n---\nbody`,
      );
    }
    symlinkSync(join(f.workspace, 'one'), join(f.workspace, 'alias'));
    assembly = await createWorkspaceAssembly({
      workspaceRoot: f.workspace,
      profile: f.profile,
      toolIds: ['skills.load'],
      skills: [{ id: 'selected', path: 'alias' }],
      selectedSkills: ['selected'],
    });
    rmSync(join(f.workspace, 'alias'));
    symlinkSync(join(f.workspace, 'two'), join(f.workspace, 'alias'));
    await expect(assembly.sources.capture(request)).rejects.toMatchObject({
      code: 'skill_version_changed',
    });
  } finally {
    await assembly?.dispose();
    f.close();
  }
});
