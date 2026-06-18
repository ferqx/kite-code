import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSkills } from '../../src/core/skills/loader';
import { createSkillTool } from '../../src/core/skills/skill-tool';
import type { SkillScanOptions } from '../../src/core/skills/types';

function makeOptions(base: string): SkillScanOptions {
  return {
    projectOpenpxSkillsDir: join(base, 'project-openpx'),
    projectAgentsSkillsDir: join(base, 'project-agents'),
    userOpenpxSkillsDir: join(base, 'user-openpx'),
    userAgentsSkillsDir: join(base, 'user-agents'),
  };
}

describe('createSkillTool', () => {
  let tmp: string;
  let opts: SkillScanOptions;

  beforeEach(() => {
    tmp = join(tmpdir(), `openpx-st-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmp, { recursive: true });
    opts = makeOptions(tmp);
    const dir = join(opts.projectOpenpxSkillsDir, 'tdd');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: tdd
description: Use when writing tests before implementation
---

Always write tests first. Follow red-green-refactor.`,
    );
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns skill content when skill exists', async () => {
    const manifests = scanSkills(opts);
    const skillTool = createSkillTool(manifests, opts);
    const result = await skillTool.invoke({ skill: 'tdd' });
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.name).toBe('tdd');
    expect(parsed.content).toContain('Always write tests first.');
  });

  it('returns error when skill not found', async () => {
    const manifests = scanSkills(opts);
    const skillTool = createSkillTool(manifests, opts);
    const result = await skillTool.invoke({ skill: 'nope' });
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('Skill not found');
  });

  it('has correct name and description', () => {
    const manifests = scanSkills(opts);
    const skillTool = createSkillTool(manifests, opts);
    expect(skillTool.name).toBe('Skill');
    expect(skillTool.description).toContain('Invoke a skill');
  });

  it('works with empty manifests', async () => {
    const skillTool = createSkillTool([], opts);
    const result = await skillTool.invoke({ skill: 'anything' });
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(false);
  });
});
