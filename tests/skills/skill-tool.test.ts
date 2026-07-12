import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSkills } from '../../src/core/skills/loader';
import { createSkillTool } from '../../src/core/skills/skill-tool';
import type { SkillScanOptions } from '../../src/core/skills/types';

function makeOptions(base: string): SkillScanOptions {
  return {
    projectKiteCodeSkillsDir: join(base, 'project-kite-code'),
    projectAgentsSkillsDir: join(base, 'project-agents'),
    userKiteCodeSkillsDir: join(base, 'user-kite-code'),
    userAgentsSkillsDir: join(base, 'user-agents'),
  };
}

describe('createSkillTool', () => {
  let tmp: string;
  let opts: SkillScanOptions;

  beforeEach(() => {
    tmp = join(tmpdir(), `kite-code-st-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmp, { recursive: true });
    opts = makeOptions(tmp);
    const dir = join(opts.projectKiteCodeSkillsDir, 'tdd');
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
    // AI SDK tools use .execute() instead of .invoke()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- execute() union return type
    const result = (await (skillTool as any).execute({ skill: 'tdd' })) as string;
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.name).toBe('tdd');
    expect(parsed.content).toContain('Always write tests first.');
  });

  it('returns error when skill not found', async () => {
    const manifests = scanSkills(opts);
    const skillTool = createSkillTool(manifests, opts);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- execute() union return type
    const result = (await (skillTool as any).execute({ skill: 'nope' })) as string;
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('Skill not found');
  });

  it('has correct description', () => {
    const manifests = scanSkills(opts);
    const skillTool = createSkillTool(manifests, opts);
    // AI SDK tools don't have a .name property — name is the Record key in ToolSet
    // Check description and that execute is available
    expect(skillTool.description).toContain('Invoke a skill');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- execute() union type
    expect(typeof (skillTool as any).execute).toBe('function');
  });

  it('works with empty manifests', async () => {
    const skillTool = createSkillTool([], opts);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- execute() union return type
    const result = (await (skillTool as any).execute({ skill: 'anything' })) as string;
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(false);
  });
});
