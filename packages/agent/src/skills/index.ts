import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface SkillSummary {
  id: string;
  version: string;
  name: string;
  description: string;
  location: string;
  requiredCapabilities: string[];
}
export interface SkillBody extends SkillSummary {
  body: string;
  resources: { id: string; path: string }[];
}
export interface SkillSourceOptions {
  trustedRoots: readonly string[];
  /** Explicit SKILL.md files or Skill directories; no home/workspace auto-discovery. */
  locations: readonly string[];
  limits?: { maxSkills?: number; maxTextBytes?: number; maxResources?: number };
}
export class SkillError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function inside(root: string, path: string) {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

/** Knowledge only: import/factory performs no I/O and never executes referenced code. */
export function createSkillSource(options: SkillSourceOptions) {
  const roots = [...options.trustedRoots];
  const locations = [...options.locations];
  const maximum = options.limits?.maxSkills;
  const textBytes = options.limits?.maxTextBytes;
  const resourceMaximum = options.limits?.maxResources;
  if (
    !roots.length ||
    roots.some((root) => !isAbsolute(root) || root.length > 4096) ||
    (maximum !== undefined && locations.length > maximum) ||
    locations.some((path) => !isAbsolute(path) || path.length > 4096) ||
    [maximum, textBytes, resourceMaximum].some(
      (value) => value !== undefined && (!Number.isSafeInteger(value) || value < 1),
    )
  )
    throw new SkillError('invalid_skill_configuration');
  let entries = new Map<string, SkillSummary>();
  async function read(path: string) {
    const target = await realpath(path);
    const trusted = await Promise.all(roots.map((root) => realpath(root)));
    if (!trusted.some((root) => inside(root, target))) throw new SkillError('skill_path_denied');
    const expected = await lstat(target);
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (stat.dev !== expected.dev || stat.ino !== expected.ino)
        throw new SkillError('skill_path_changed');
      if (!stat.isFile() || (textBytes !== undefined && stat.size > textBytes))
        throw new SkillError('skill_text_limit');
      // Verify the path after opening; never follow a newly replaced target outside the root.
      if ((await realpath(path)) !== target) throw new SkillError('skill_path_changed');
      // One extra byte detects growth after stat. No implicit content quota: the
      // host may opt into a limit, and allocation/read failures remain local.
      const bytes = Buffer.alloc(stat.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const chunk = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!chunk.bytesRead) break;
        offset += chunk.bytesRead;
      }
      if ((textBytes !== undefined && offset > textBytes) || offset > stat.size)
        throw new SkillError('skill_text_limit');
      let body: string;
      try {
        body = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
      } catch {
        throw new SkillError('skill_text_invalid');
      }
      if (body.includes('\0')) throw new SkillError('skill_text_invalid');
      return { target, body };
    } finally {
      await handle.close();
    }
  }
  function summary(target: string, body: string): SkillSummary {
    const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)?.[1] ?? '';
    const field = (key: string) =>
      new RegExp(`^${key}:\\s*(.*)$`, 'm')
        .exec(front)?.[1]
        ?.trim()
        .replace(/^['"]|['"]$/g, '');
    const name = field('name') ?? relative(resolve(target, '..', '..'), resolve(target, '..'));
    const description = (
      field('description') ??
      body
        .replace(/^---[\s\S]*?---\s*/, '')
        .split(/\r?\n/)
        .find((line) => line.trim() && !line.startsWith('#')) ??
      ''
    ).slice(0, 4096);
    const requires = field('required-capabilities') ?? '';
    const requiredCapabilities = requires
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((value) => value.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    if (
      name.length > 256 ||
      requiredCapabilities.length > 64 ||
      requiredCapabilities.some((value) => value.length > 256)
    )
      throw new SkillError('skill_metadata_limit');
    return {
      id: `skill-${hash(target)}`,
      version: hash(body),
      name,
      description,
      location: target,
      requiredCapabilities,
    };
  }
  return {
    async list() {
      const next = new Map<string, SkillSummary>();
      const errors: { location: string; code: string }[] = [];
      for (const location of locations) {
        try {
          const value = await read(
            location.endsWith('SKILL.md') ? location : join(location, 'SKILL.md'),
          );
          const entry = summary(value.target, value.body);
          if (next.has(entry.id)) throw new SkillError('duplicate_skill_location');
          next.set(entry.id, entry);
        } catch (error) {
          errors.push({
            location,
            code: error instanceof SkillError ? error.code : 'skill_unavailable',
          });
        }
      }
      entries = next;
      return { entries: [...next.values()].sort((a, b) => a.id.localeCompare(b.id)), errors };
    },
    async load(input: {
      id: string;
      version?: string;
      availableCapabilities?: readonly string[];
    }): Promise<SkillBody> {
      const entry = entries.get(input.id);
      if (!entry) throw new SkillError('skill_not_discovered');
      const value = await read(entry.location);
      const current = summary(value.target, value.body);
      if ((input.version ?? entry.version) !== current.version)
        throw new SkillError('skill_version_changed');
      const missing = current.requiredCapabilities.filter(
        (capability) => !input.availableCapabilities?.includes(capability),
      );
      if (missing.length) throw new SkillError('skill_capability_missing');
      const resources: SkillBody['resources'] = [];
      for (const match of value.body.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
        const path = match[1]!;
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) || path.startsWith('#')) continue;
        if (isAbsolute(path) || path.length > 4096 || path.split(/[\\/]/).includes('..'))
          throw new SkillError('skill_resource_denied');
        if (resources.some((item) => item.path === path)) continue;
        if (resourceMaximum !== undefined && resources.length >= resourceMaximum)
          throw new SkillError('skill_resource_limit');
        resources.push({ id: hash(`${current.id}:${current.version}:${path}`), path });
      }
      return { ...current, body: value.body, resources };
    },
    async readResource(input: {
      skillId: string;
      version: string;
      path: string;
      availableCapabilities?: readonly string[];
    }) {
      const skill = await this.load({
        id: input.skillId,
        version: input.version,
        availableCapabilities: input.availableCapabilities,
      });
      if (!skill.resources.some((resource) => resource.path === input.path))
        throw new SkillError('skill_resource_not_declared');
      const value = await read(resolve(skill.location, '..', input.path));
      return {
        id: hash(`${skill.id}:${skill.version}:${input.path}`),
        version: hash(value.body),
        body: value.body,
      };
    },
  };
}
