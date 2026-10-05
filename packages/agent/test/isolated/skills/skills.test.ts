import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillSource } from '../../../src/skills';

test('Skill discovery is summary only; explicit body/resource identity and no script execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-skills-'));
  try {
    const skill = join(root, 'guide');
    mkdirSync(skill);
    const script = join(root, 'effect');
    writeFileSync(
      join(skill, 'SKILL.md'),
      `---\nname: guide\ndescription: compact guidance\nrequired-capabilities: [shell]\n---\nRun [reference](notes.txt) and [script](run.sh) only through authorized tools.\n`,
    );
    writeFileSync(join(skill, 'notes.txt'), 'reference body');
    writeFileSync(join(skill, 'run.sh'), `touch ${script}`);
    const source = createSkillSource({
      trustedRoots: [root],
      locations: [skill, join(root, 'missing')],
    });
    expect(existsSync(script)).toBe(false);
    const listed = await source.list();
    expect(listed.errors).toEqual([{ location: join(root, 'missing'), code: 'skill_unavailable' }]);
    expect(listed.entries).toHaveLength(1);
    const entry = listed.entries[0]!;
    expect(entry.name).toBe('guide');
    expect('body' in entry).toBe(false);
    await expect(source.load({ id: entry.id })).rejects.toMatchObject({
      code: 'skill_capability_missing',
    });
    const body = await source.load({ id: entry.id, availableCapabilities: ['shell'] });
    expect(body.version).toBe(entry.version);
    expect(body.resources).toHaveLength(2);
    const resource = await source.readResource({
      skillId: entry.id,
      version: entry.version,
      path: 'notes.txt',
      availableCapabilities: ['shell'],
    });
    expect(resource.body).toBe('reference body');
    expect(resource.version).toHaveLength(64);
    await source.readResource({
      skillId: entry.id,
      version: entry.version,
      path: 'run.sh',
      availableCapabilities: ['shell'],
    });
    expect(existsSync(script)).toBe(false);
    writeFileSync(join(skill, 'SKILL.md'), 'changed');
    await expect(
      source.load({ id: entry.id, version: entry.version, availableCapabilities: ['shell'] }),
    ).rejects.toMatchObject({ code: 'skill_version_changed' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('Skills reject escaped paths and oversized/binary text locally, preserving other summaries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-skills-bounds-'));
  const outside = mkdtempSync(join(tmpdir(), 'kite-skills-outside-'));
  try {
    writeFileSync(join(root, 'SKILL.md'), '[reference](escape.txt)');
    writeFileSync(join(outside, 'secret.txt'), 'untrusted');
    writeFileSync(join(outside, 'SKILL.md'), 'untrusted');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'escape.txt'));
    const source = createSkillSource({ trustedRoots: [root], locations: [root] });
    const entry = (await source.list()).entries[0]!;
    await expect(
      source.readResource({ skillId: entry.id, version: entry.version, path: 'escape.txt' }),
    ).rejects.toMatchObject({ code: 'skill_path_denied' });
    const escaped = createSkillSource({
      trustedRoots: [root],
      locations: [join(outside, 'SKILL.md')],
    });
    expect((await escaped.list()).errors[0]?.code).toBe('skill_path_denied');
    writeFileSync(join(root, 'SKILL.md'), '[reference](../secret.txt)');
    const traversal = (await source.list()).entries[0]!;
    await expect(source.load({ id: traversal.id })).rejects.toMatchObject({
      code: 'skill_resource_denied',
    });
    writeFileSync(join(root, 'SKILL.md'), 'x'.repeat(20));
    const bounded = createSkillSource({
      trustedRoots: [root],
      locations: [root],
      limits: { maxTextBytes: 10 },
    });
    expect((await bounded.list()).errors[0]?.code).toBe('skill_text_limit');
    writeFileSync(join(root, 'SKILL.md'), Buffer.from([255]));
    expect((await source.list()).errors[0]?.code).toBe('skill_text_invalid');
    expect(() =>
      createSkillSource({
        trustedRoots: [root],
        locations: [root, root],
        limits: { maxSkills: 1 },
      }),
    ).toThrow('invalid_skill_configuration');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('default discovery and complete knowledge reads have no legacy count or text quotas', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kite-skills-complete-'));
  try {
    const locations: string[] = [];
    for (let i = 0; i < 300; i++) {
      const skill = join(root, `guide-${i}`);
      mkdirSync(skill);
      writeFileSync(join(skill, 'SKILL.md'), `---\nname: guide-${i}\n---\nGuidance ${i}`);
      locations.push(skill);
    }
    const references = Array.from({ length: 160 }, (_, i) => `[reference ${i}](ref-${i}.txt)`);
    const body = `---\nname: guide-0\n---\n${'knowledge '.repeat(160000)}\n${references.join('\n')}\nBODY_END`;
    const resource = `${'resource '.repeat(160000)}RESOURCE_END`;
    writeFileSync(join(locations[0]!, 'SKILL.md'), body);
    writeFileSync(join(locations[0]!, 'ref-159.txt'), resource);
    const source = createSkillSource({ trustedRoots: [root], locations });
    const listed = await source.list();
    expect(listed.errors).toEqual([]);
    expect(listed.entries).toHaveLength(300);
    expect(listed.entries.every((entry) => !('body' in entry))).toBe(true);
    const entry = listed.entries.find((entry) => entry.name === 'guide-0')!;
    const loaded = await source.load({ id: entry.id, version: entry.version });
    expect(loaded.body).toBe(body);
    expect(loaded.resources).toHaveLength(160);
    expect(
      (
        await source.readResource({
          skillId: entry.id,
          version: entry.version,
          path: 'ref-159.txt',
        })
      ).body,
    ).toBe(resource);
    const limited = createSkillSource({
      trustedRoots: [root],
      locations: [locations[0]!],
      limits: { maxResources: 128, maxSkills: 100000, maxTextBytes: 65 * 1024 * 1024 },
    });
    const limitedEntry = (await limited.list()).entries[0]!;
    await expect(limited.load({ id: limitedEntry.id })).rejects.toMatchObject({
      code: 'skill_resource_limit',
    });
    for (const invalid of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])
      expect(() =>
        createSkillSource({
          trustedRoots: [root],
          locations: [],
          limits: { maxTextBytes: invalid },
        }),
      ).toThrow('invalid_skill_configuration');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
