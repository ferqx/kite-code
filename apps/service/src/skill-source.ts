import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AgentError } from '@kite-ai/agent';
import type { JsonObject } from '@kite-ai/agent/config';
import type { ProfileSelection } from '@kite-ai/agent/profile';
import { createSkillSource, SkillError, type SkillSummary } from '@kite-ai/agent/skills';

export interface ConfiguredSkillState {
  id: string;
  /** Configured location metadata only; never installation or execution authority. */
  source: {
    scope: 'project' | 'user';
    origin: '.agents' | '.kite-code' | 'profile' | 'configured';
  } | null;
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
      const locations = configured.map((skill) => {
        if (typeof skill.id !== 'string' || !skill.id || states.has(skill.id))
          throw new AgentError('invalid_skill_configuration');
        const state: ConfiguredSkillState = {
          id: skill.id,
          source: null,
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
        // Classify the admitted configured location without opening disabled Skill files.
        const path =
          typeof skill.path === 'string'
            ? isAbsolute(skill.path)
              ? resolve(skill.path)
              : resolve(root, skill.path)
            : undefined;
        if (
          path &&
          skill.path !== '' &&
          !path.includes('\0') &&
          trustedRoots.some((trusted) => inside(trusted, path))
        ) {
          state.source =
            profileRootAvailable && inside(profileRoot, path)
              ? { scope: 'user', origin: 'profile' }
              : {
                  scope: 'project',
                  origin: inside(join(root, '.agents', 'skills'), path)
                    ? '.agents'
                    : inside(join(root, '.kite-code', 'skills'), path)
                      ? '.kite-code'
                      : 'configured',
                };
        }
        return { skill, state, path };
      });
      // Re-read every location, but bound independent I/O. Fold in configured
      // order so completion order cannot choose a duplicate location's owner.
      for (let offset = 0; offset < locations.length; offset += 4) {
        const discovered = await Promise.all(
          locations.slice(offset, offset + 4).map(async ({ skill, state, path }) => {
            if (!state.enabled) return;
            try {
              if (!path) throw new AgentError('invalid_skill_configuration');
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
              const target = await realpath(
                path.endsWith('SKILL.md') ? path : join(path, 'SKILL.md'),
              );
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
                missingCapabilities: summary.requiredCapabilities.filter(
                  (id) => !allowed.includes(id),
                ),
              });
              return { skill, state, summary, source };
            } catch (error) {
              if (error instanceof AgentError && error.code === 'skill_path_denied')
                state.source = null;
              state.reason =
                error instanceof AgentError || error instanceof SkillError
                  ? error.code
                  : 'skill_unavailable';
              return;
            }
          }),
        );
        for (const entry of discovered) {
          if (!entry) continue;
          const { skill, state, summary, source } = entry;
          const duplicate = nextIds.get(summary.id);
          if (duplicate) {
            states.get(duplicate)!.state = 'unavailable';
            states.get(duplicate)!.reason = 'duplicate_skill_location';
            summaries.delete(summary.id);
            nextSources.delete(summary.id);
            state.reason = 'duplicate_skill_location';
            continue;
          }
          nextIds.set(summary.id, state.id);
          if (skill.digest !== undefined && skill.digest !== summary.version) {
            state.reason = 'skill_version_changed';
            continue;
          }
          if (state.missingCapabilities.length) {
            state.reason = 'skill_capability_missing';
            continue;
          }
          state.state = 'available';
          summaries.set(summary.id, summary);
          nextSources.set(summary.id, source);
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
