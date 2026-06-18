// src/core/skills/loader.ts

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SkillManifest, SkillScanOptions, ValidatedSkill } from './types';

/** Parse YAML frontmatter from SKILL.md content */
function parseFrontmatter(
  content: string,
): { fields: Record<string, string>; body: string } | null {
  // Normalize line endings: CRLF / CR -> LF
  content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!content.startsWith('---')) return null;
  const afterStart = content.slice(3);
  const nextNewline = afterStart.indexOf('\n');
  if (nextNewline === -1) return null;
  const fmStart = nextNewline + 1;

  const endMatch = afterStart.slice(fmStart).match(/\n---(\n|$)/);
  if (!endMatch || endMatch.index === undefined) return null;

  const fmText = afterStart.slice(fmStart, fmStart + endMatch.index);
  const bodyStart = fmStart + endMatch.index + endMatch[0].length;
  const body = afterStart.slice(bodyStart);

  const fields: Record<string, string> = {};
  const lines = fmText.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const match = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (match) {
      const key = match[1]!;
      let value = match[2]!.trim();
      // Nested block (e.g. metadata:) -> skip indented continuation lines
      if (value === '' || value === '|' || value === '>') {
        i++;
        while (i < lines.length && (lines[i]!.startsWith('  ') || lines[i]!.trim() === '')) {
          i++;
        }
        i--; // compensate for the outer i++
        continue;
      }
      // Strip surrounding quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      fields[key] = value;
    }
    i++;
  }

  return { fields, body };
}

const VALID_SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function scanDir(
  dirPath: string,
  source: 'project' | 'user',
  origin: '.openpx' | '.agents',
): SkillManifest[] {
  const resolved = resolve(dirPath);
  if (!existsSync(resolved)) return [];

  const manifests: SkillManifest[] = [];
  let entries: string[];
  try {
    entries = readdirSync(resolved);
  } catch {
    return [];
  }

  for (const entry of entries) {
    try {
      const entryPath = join(resolved, entry);
      if (!statSync(entryPath).isDirectory()) continue;

      const skillMdPath = join(entryPath, 'SKILL.md');
      if (!existsSync(skillMdPath)) continue;

      const raw = readFileSync(skillMdPath, 'utf-8');
      const parsed = parseFrontmatter(raw);
      if (!parsed) continue;

      const { fields } = parsed;
      const name = fields.name;
      const description = fields.description;

      if (!name || !VALID_SKILL_NAME.test(name)) continue;
      if (name !== entry) continue;
      if (!description) continue;

      manifests.push({ name, description, source, origin });
    } catch {
      // Skip individual broken skill directories silently
    }
  }

  return manifests;
}

/** Scan all 4 skill directories, return deduplicated manifest list (higher priority wins) */
export function scanSkills(options: SkillScanOptions): SkillManifest[] {
  const all: SkillManifest[] = [];

  // Priority order: project .openpx > project .agents > user .openpx > user .agents
  all.push(...scanDir(options.projectOpenpxSkillsDir, 'project', '.openpx'));
  all.push(...scanDir(options.projectAgentsSkillsDir, 'project', '.agents'));
  all.push(...scanDir(options.userOpenpxSkillsDir, 'user', '.openpx'));
  all.push(...scanDir(options.userAgentsSkillsDir, 'user', '.agents'));

  // Dedup: first occurrence wins (highest priority)
  const seen = new Set<string>();
  const deduped: SkillManifest[] = [];
  for (const m of all) {
    if (!seen.has(m.name)) {
      seen.add(m.name);
      deduped.push(m);
    }
  }
  return deduped;
}

/** Read full skill content by name (hot-reload: reads from disk every call) */
export function getSkillContent(
  manifests: SkillManifest[],
  name: string,
  options: SkillScanOptions,
): ValidatedSkill | null {
  const manifest = manifests.find((m) => m.name === name);
  if (!manifest) return null;

  const dirKey =
    manifest.source === 'project'
      ? manifest.origin === '.openpx'
        ? 'projectOpenpxSkillsDir'
        : 'projectAgentsSkillsDir'
      : manifest.origin === '.openpx'
        ? 'userOpenpxSkillsDir'
        : 'userAgentsSkillsDir';
  const skillMdPath = join(options[dirKey], manifest.name, 'SKILL.md');

  try {
    if (!existsSync(skillMdPath)) return null;
    const raw = readFileSync(skillMdPath, 'utf-8');
    const parsed = parseFrontmatter(raw);
    if (!parsed) return null;

    let body = parsed.body.trimStart();
    // Truncate bodies over 100KB
    if (body.length > 100 * 1024) {
      body = body.slice(0, 100 * 1024);
    }

    return {
      name: manifest.name,
      description: manifest.description,
      content: body,
    };
  } catch {
    return null;
  }
}
