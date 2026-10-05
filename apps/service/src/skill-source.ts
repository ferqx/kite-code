import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AgentError } from '@kite-ai/agent';
import type { JsonObject } from '@kite-ai/agent/config';
import type { ProfileSelection } from '@kite-ai/agent/profile';
import { createSkillSource, SkillError, type SkillSummary } from '@kite-ai/agent/skills';

export interface ConfiguredSkillState {
  id: string;
  name: string | null;
  description: string | null;
  version: string | null;
  enabled: boolean;
  state: 'available' | 'disabled' | 'unavailable';
  reason: string | null;
  requiredCapabilities: string[];
  missingCapabilities: string[];
}
function inside(root: string, path: string) {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}
/** Shared metadata/body binding. Disabled locations are never read; failures belong to their configured ID. */
export function createConfiguredSkillSource(options: {
  workspaceRoot: string;
  profile: ProfileSelection;
  skills?: readonly JsonObject[];
  toolIds: readonly string[];
  allowedCapabilities?: readonly string[];
}) {
  const configured = structuredClone(options.skills ?? []);
  const workspaceRoot = options.workspaceRoot;
  const profileRoot = join(options.profile.profilePath, 'skills');
  const allowed = [...(options.allowedCapabilities ?? [])].filter((id) =>
    options.toolIds.includes(id),
  );
  let sources = new Map<string, ReturnType<typeof createSkillSource>>();
  let configuredIds = new Map<string, string>();
  return {
    configuredId(summary: SkillSummary) {
      return configuredIds.get(summary.id) ?? summary.id;
    },
    async list() {
      const root = await realpath(workspaceRoot);
      const stat = await lstat(workspaceRoot);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new AgentError('workspace_configuration_unavailable');
      let profileRootAvailable = false;
      try {
        const entry = await lstat(profileRoot);
        profileRootAvailable = entry.isDirectory() && !entry.isSymbolicLink();
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
      }
      const trustedRoots = [root, ...(profileRootAvailable ? [profileRoot] : [])];
      const states = new Map<string, ConfiguredSkillState>();
      const summaries = new Map<string, SkillSummary>();
      const nextSources = new Map<string, ReturnType<typeof createSkillSource>>();
      const nextIds = new Map<string, string>();
      for (const skill of configured) {
        if (typeof skill.id !== 'string' || !skill.id || states.has(skill.id))
          throw new AgentError('invalid_skill_configuration');
        const state: ConfiguredSkillState = {
          id: skill.id,
          name: null,
          description: null,
          version: null,
          enabled: skill.enabled !== false,
          state: skill.enabled === false ? 'disabled' : 'unavailable',
          reason: null,
          requiredCapabilities: [],
          missingCapabilities: [],
        };
        states.set(skill.id, state);
        if (!state.enabled) continue;
        try {
          if (typeof skill.path !== 'string') throw new AgentError('invalid_skill_configuration');
          const path = isAbsolute(skill.path) ? resolve(skill.path) : resolve(root, skill.path);
          if (!trustedRoots.some((trusted) => inside(trusted, path)))
            throw new AgentError('skill_path_denied');
          if (
            skill.options !== undefined &&
            (!skill.options ||
              typeof skill.options !== 'object' ||
              Array.isArray(skill.options) ||
              Object.keys(skill.options).length)
          )
            throw new AgentError('unsupported_skill_options');
          const target = await realpath(path.endsWith('SKILL.md') ? path : join(path, 'SKILL.md'));
          if (!trustedRoots.some((trusted) => inside(trusted, target)))
            throw new AgentError('skill_path_denied');
          const source = createSkillSource({ trustedRoots, locations: [path] });
          const listed = await source.list();
          if (listed.errors.length) throw new SkillError(listed.errors[0]!.code);
          const summary = listed.entries[0];
          if (!summary) throw new SkillError('skill_unavailable');
          Object.assign(state, {
            name: summary.name,
            description: summary.description,
            version: summary.version,
            requiredCapabilities: summary.requiredCapabilities,
            missingCapabilities: summary.requiredCapabilities.filter((id) => !allowed.includes(id)),
          });
          const duplicate = nextIds.get(summary.id);
          if (duplicate) {
            states.get(duplicate)!.state = 'unavailable';
            states.get(duplicate)!.reason = 'duplicate_skill_location';
            summaries.delete(summary.id);
            nextSources.delete(summary.id);
            throw new SkillError('duplicate_skill_location');
          }
          nextIds.set(summary.id, skill.id);
          if (skill.digest !== undefined && skill.digest !== summary.version)
            throw new SkillError('skill_version_changed');
          if (state.missingCapabilities.length) throw new SkillError('skill_capability_missing');
          state.state = 'available';
          summaries.set(summary.id, summary);
          nextSources.set(summary.id, source);
        } catch (error) {
          state.reason =
            error instanceof AgentError || error instanceof SkillError
              ? error.code
              : 'skill_unavailable';
        }
      }
      sources = nextSources;
      configuredIds = nextIds;
      return {
        entries: [...summaries.values()].sort((a, b) =>
          this.configuredId(a) < this.configuredId(b) ? -1 : 1,
        ),
        states: [...states.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
      };
    },
    load(input: Parameters<ReturnType<typeof createSkillSource>['load']>[0]) {
      const source = sources.get(input.id);
      if (!source) throw new SkillError('skill_not_discovered');
      return source.load(input);
    },
    readResource(input: Parameters<ReturnType<typeof createSkillSource>['readResource']>[0]) {
      const source = sources.get(input.skillId);
      if (!source) throw new SkillError('skill_not_discovered');
      return source.readResource(input);
    },
  };
}
