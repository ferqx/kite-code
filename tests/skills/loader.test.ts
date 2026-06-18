// tests/skills/loader.test.ts

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSkillContent, scanSkills } from '../../src/core/skills/loader';
import type { SkillScanOptions } from '../../src/core/skills/types';

function makeOptions(base: string): SkillScanOptions {
  return {
    projectOpenpxSkillsDir: join(base, 'project-openpx'),
    projectAgentsSkillsDir: join(base, 'project-agents'),
    userOpenpxSkillsDir: join(base, 'user-openpx'),
    userAgentsSkillsDir: join(base, 'user-agents'),
  };
}

function writeSkill(
  baseDir: string,
  name: string,
  fm: Record<string, string>,
  body = 'Skill body content.',
) {
  const dir = join(baseDir, name);
  mkdirSync(dir, { recursive: true });
  const fmLines = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  writeFileSync(join(dir, 'SKILL.md'), `---\n${fmLines}\n---\n\n${body}`);
}

describe('scanSkills', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = join(tmpdir(), `openpx-skills-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns empty array when no dirs exist', () => {
    expect(scanSkills(makeOptions(join(tmp, 'nope')))).toEqual([]);
  });

  it('scans a single dir and returns valid skills', () => {
    const opts = makeOptions(tmp);
    writeSkill(opts.userOpenpxSkillsDir, 'my-skill', {
      name: 'my-skill',
      description: 'A test skill',
    });
    const ms = scanSkills(opts);
    expect(ms).toHaveLength(1);
    expect(ms[0]!.name).toBe('my-skill');
    expect(ms[0]!.source).toBe('user');
    expect(ms[0]!.origin).toBe('.openpx');
  });

  it('skips dir without SKILL.md', () => {
    const opts = makeOptions(tmp);
    mkdirSync(join(opts.userOpenpxSkillsDir, 'empty-skill'), { recursive: true });
    expect(scanSkills(opts)).toEqual([]);
  });

  it('skips skill with missing name', () => {
    const opts = makeOptions(tmp);
    writeSkill(opts.projectOpenpxSkillsDir, 'bad-skill', { description: 'No name' });
    expect(scanSkills(opts)).toEqual([]);
  });

  it('skips skill with missing description', () => {
    const opts = makeOptions(tmp);
    writeSkill(opts.projectOpenpxSkillsDir, 'no-desc', { name: 'no-desc' });
    expect(scanSkills(opts)).toEqual([]);
  });

  it('skips skill with uppercase name', () => {
    const opts = makeOptions(tmp);
    writeSkill(opts.projectOpenpxSkillsDir, 'Bad-Name', {
      name: 'Bad-Name',
      description: 'Uppercase invalid',
    });
    expect(scanSkills(opts)).toEqual([]);
  });

  it('skips skill where name != directory name', () => {
    const opts = makeOptions(tmp);
    writeSkill(opts.projectOpenpxSkillsDir, 'my-skill', {
      name: 'other-name',
      description: 'Mismatch',
    });
    expect(scanSkills(opts)).toEqual([]);
  });

  it('skips name starting with hyphen', () => {
    const opts = makeOptions(tmp);
    writeSkill(opts.projectOpenpxSkillsDir, '-bad', {
      name: '-bad',
      description: 'Starts with hyphen',
    });
    expect(scanSkills(opts)).toEqual([]);
  });

  it('skips name with consecutive hyphens', () => {
    const opts = makeOptions(tmp);
    writeSkill(opts.projectOpenpxSkillsDir, 'bad--skill', {
      name: 'bad--skill',
      description: 'Consecutive hyphens',
    });
    expect(scanSkills(opts)).toEqual([]);
  });

  it('deduplicates: project .openpx overrides user .openpx', () => {
    const opts = makeOptions(tmp);
    writeSkill(opts.userOpenpxSkillsDir, 'shared', { name: 'shared', description: 'User' });
    writeSkill(opts.projectOpenpxSkillsDir, 'shared', { name: 'shared', description: 'Project' });
    const ms = scanSkills(opts);
    expect(ms).toHaveLength(1);
    expect(ms[0]!.description).toBe('Project');
    expect(ms[0]!.source).toBe('project');
  });

  it('deduplicates: project .openpx overrides project .agents', () => {
    const opts = makeOptions(tmp);
    writeSkill(opts.projectAgentsSkillsDir, 'shared', { name: 'shared', description: '.agents' });
    writeSkill(opts.projectOpenpxSkillsDir, 'shared', { name: 'shared', description: '.openpx' });
    const ms = scanSkills(opts);
    expect(ms).toHaveLength(1);
    expect(ms[0]!.description).toBe('.openpx');
  });

  it('sorts by priority: high to low', () => {
    const opts = makeOptions(tmp);
    writeSkill(opts.userAgentsSkillsDir, 'low', { name: 'low', description: 'Lowest' });
    writeSkill(opts.projectOpenpxSkillsDir, 'high', { name: 'high', description: 'Highest' });
    const ms = scanSkills(opts);
    expect(ms[0]!.name).toBe('high');
    expect(ms[1]!.name).toBe('low');
  });

  it('handles frontmatter with metadata block (nested YAML)', () => {
    const opts = makeOptions(tmp);
    const dir = join(opts.projectOpenpxSkillsDir, 'meta-skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: meta-skill
description: Has metadata
metadata:
  author: test
  version: "1.0"
---

Body here.`,
    );
    const ms = scanSkills(opts);
    expect(ms).toHaveLength(1);
    expect(ms[0]!.name).toBe('meta-skill');
  });

  it('handles empty body', () => {
    const opts = makeOptions(tmp);
    const dir = join(opts.projectOpenpxSkillsDir, 'empty-body');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: empty-body\ndescription: No content\n---\n');
    const ms = scanSkills(opts);
    expect(ms).toHaveLength(1);
  });

  it('skips name ending with hyphen', () => {
    const opts = makeOptions(tmp);
    writeSkill(opts.projectOpenpxSkillsDir, 'bad-', {
      name: 'bad-',
      description: 'Ends with hyphen',
    });
    expect(scanSkills(opts)).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const opts = makeOptions(tmp);
    const dir = join(opts.projectOpenpxSkillsDir, 'crlf-skill');
    mkdirSync(dir, { recursive: true });
    // Use \r\n line endings
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\r\nname: crlf-skill\r\ndescription: CRLF test\r\n---\r\n\r\nWorks with Windows line endings.',
    );
    const ms = scanSkills(opts);
    expect(ms).toHaveLength(1);
    expect(ms[0]!.name).toBe('crlf-skill');
  });

  it('parses fields after metadata block', () => {
    const opts = makeOptions(tmp);
    const dir = join(opts.projectOpenpxSkillsDir, 'after-meta');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---
name: after-meta
metadata:
  author: test
description: Should be parsed
---
Body.`,
    );
    const ms = scanSkills(opts);
    expect(ms).toHaveLength(1);
    expect(ms[0]!.name).toBe('after-meta');
    expect(ms[0]!.description).toBe('Should be parsed');
  });
});

describe('getSkillContent', () => {
  let tmp: string;
  let opts: SkillScanOptions;

  beforeEach(() => {
    tmp = join(tmpdir(), `openpx-skills-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmp, { recursive: true });
    opts = makeOptions(tmp);
    writeSkill(
      opts.projectOpenpxSkillsDir,
      'tdd',
      { name: 'tdd', description: 'Write tests first' },
      'Step 1: Red.\nStep 2: Green.',
    );
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns full content by name', () => {
    const ms = scanSkills(opts);
    const result = getSkillContent(ms, 'tdd', opts);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('tdd');
    expect(result?.content).toContain('Step 1: Red.');
  });

  it('returns null for unknown name', () => {
    expect(getSkillContent(scanSkills(opts), 'nope', opts)).toBeNull();
  });

  it('returns null for empty manifests', () => {
    expect(getSkillContent([], 'anything', opts)).toBeNull();
  });

  it('hot-reloads: picks up file changes', () => {
    const ms = scanSkills(opts);
    expect(getSkillContent(ms, 'tdd', opts)?.content).toContain('Step 1:');

    const p = join(opts.projectOpenpxSkillsDir, 'tdd', 'SKILL.md');
    writeFileSync(p, '---\nname: tdd\ndescription: Updated\n---\nUpdated content.');
    expect(getSkillContent(ms, 'tdd', opts)?.content).toBe('Updated content.');
  });

  it('truncates body over 100KB', () => {
    const bigBody = 'x'.repeat(101_000);
    writeSkill(
      opts.projectOpenpxSkillsDir,
      'big',
      { name: 'big', description: 'Big skill' },
      bigBody,
    );
    const ms = scanSkills(opts);
    const result = getSkillContent(ms, 'big', opts);
    expect(result).not.toBeNull();
    expect(result?.content.length).toBeLessThanOrEqual(100 * 1024);
  });

  it('returns null when SKILL.md deleted after scan', () => {
    const ms = scanSkills(opts);
    rmSync(join(opts.projectOpenpxSkillsDir, 'tdd'), { recursive: true, force: true });
    expect(getSkillContent(ms, 'tdd', opts)).toBeNull();
  });
});
