import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AgentError } from '@kite-ai/agent';
import type { Json } from '@kite-ai/agent/extensions';
import { builtinComputerUseSkillId, SkillError } from '@kite-ai/agent/skills';

const prefix = 'user-skill.';
const slug = /^[a-z\d](?:[a-z\d-]{0,62}[a-z\d])?$/;
const reserved = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
const validDirectory = (name: string) =>
  slug.test(name) && !reserved.test(name) && name !== builtinComputerUseSkillId;

export interface InstalledUserSkill {
  readonly id: string;
  readonly path: string;
  readonly root: string;
  readonly digest?: string;
}

async function ordinaryDirectory(path: string) {
  return (await lstat(path)).isDirectory() && relative(path, await realpath(path)) === '';
}

export async function installedUserSkillDocument(skill: InstalledUserSkill) {
  const document = join(skill.path, 'SKILL.md');
  try {
    if (!(await ordinaryDirectory(skill.root)) || !(await ordinaryDirectory(skill.path)))
      throw new AgentError('skill_path_denied');
    const stat = await lstat(document);
    if (!stat.isFile() || stat.nlink !== 1 || relative(document, await realpath(document)) !== '')
      throw new AgentError('skill_path_denied');
    return document;
  } catch (cause) {
    if (cause instanceof AgentError) throw cause;
    throw new SkillError('skill_unavailable');
  }
}

export async function verifyInstalledUserSkillResource(skill: InstalledUserSkill, path: string) {
  const target = resolve(skill.path, path);
  const within = relative(skill.path, target);
  if (!within || isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`))
    throw new SkillError('skill_resource_denied');
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.nlink !== 1 || relative(target, await realpath(target)) !== '')
      throw new SkillError('skill_resource_denied');
  } catch (cause) {
    if (cause instanceof SkillError) throw cause;
    throw new SkillError('skill_unavailable');
  }
}

/** Only the host's fixed user directory can supply these rows. A saved selection reads only its IDs. */
export async function discoverInstalledUserSkills(
  userRoot: string,
  inherited?: ReadonlyMap<string, string>,
): Promise<InstalledUserSkill[]> {
  if (inherited?.size === 0) return [];
  let root: string;
  let names: string[];
  try {
    if (!(await lstat(userRoot)).isDirectory()) return [];
    root = join(await realpath(userRoot), 'skills');
    if (!(await ordinaryDirectory(root))) return [];
    names = inherited
      ? [...inherited.keys()].map((id) => id.slice(prefix.length))
      : (await readdir(root, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
  } catch {
    // An absent or unsafe optional directory has no installed entries.
    return [];
  }
  return names
    .filter(validDirectory)
    .sort()
    .map((name) => {
      const id = `${prefix}${name}`;
      return { id, path: join(root, name), root, digest: inherited?.get(id) };
    });
}

/** Decode only the installed rows sealed by Service into the original Run's configuration. */
export function readInstalledUserSkillBindings(configuration: Json | undefined) {
  const bindings = new Map<string, string>();
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration))
    return bindings;
  const skills = configuration.skills;
  if (!Array.isArray(skills)) return bindings;
  for (const row of skills) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const { id, digest, options } = row;
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      options.installedUserSkill !== true
    )
      continue;
    if (
      Object.keys(options).length !== 1 ||
      typeof id !== 'string' ||
      !id.startsWith(prefix) ||
      !validDirectory(id.slice(prefix.length)) ||
      typeof digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      bindings.has(id)
    )
      throw new AgentError('child_skill_selection_unavailable');
    bindings.set(id, digest);
  }
  return bindings;
}
