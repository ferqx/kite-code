import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AgentError } from '@kite-ai/agent';
import type { JsonObject } from '@kite-ai/agent/config';
import type { ProfileSelection } from '@kite-ai/agent/profile';
import {
  builtinComputerUseSkillId,
  createBuiltinComputerUseSkillSource,
  createSkillSource,
  SkillError,
  type SkillSummary,
} from '@kite-ai/agent/skills';
import {
  createKnowledgeReadScope,
  KnowledgeReadCleanupError,
  type KnowledgeReadScope,
} from '@kite-ai/agent/sources';
import {
  type InstalledUserSkill,
  installedUserSkillDocument,
  verifyInstalledUserSkillResource,
} from './installed-user-skills';

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
export function createConfiguredSkillSource(
  options: (
    | {
        workspaceRoot: string;
        userRoot?: never;
      }
    | {
        userRoot: string;
        workspaceRoot?: never;
      }
  ) & {
    profile: ProfileSelection;
    skills?: readonly JsonObject[];
    installedUserSkills?: readonly InstalledUserSkill[];
    toolIds: readonly string[];
    allowedCapabilities?: readonly string[];
    /** One trusted owner, independent of the replaceable catalogue metadata. */
    knowledgeScope?: KnowledgeReadScope;
  },
) {
  const configured = structuredClone(options.skills ?? []);
  const installed = structuredClone(options.installedUserSkills ?? []);
  const configurationRoot = options.userRoot ?? options.workspaceRoot;
  const userScope = options.userRoot !== undefined;
  const profileRoot = join(options.profile.profilePath, 'skills');
  const allowed = [...(options.allowedCapabilities ?? [])].filter((id) =>
    options.toolIds.includes(id),
  );
  const builtin = createBuiltinComputerUseSkillSource();
  type KnowledgeSource = ReturnType<typeof createSkillSource> | typeof builtin;
  type KnowledgeBinding = { source: KnowledgeSource; installed?: InstalledUserSkill };
  type DocumentBinding = KnowledgeBinding & { id: string };
  let sources = new Map<string, KnowledgeBinding>();
  let configuredIds = new Map<string, string>();
  let documents = new Map<string, DocumentBinding>();
  const knowledgeScope = options.knowledgeScope ?? createKnowledgeReadScope();
  const pending = new Set<Promise<unknown>>();
  let sealed = false;
  let disposal: Promise<void> | undefined;
  function admitted<T>(operation: () => Promise<T>): Promise<T> {
    if (sealed) return Promise.reject(new AgentError('knowledge_source_closed'));
    const task = Promise.resolve().then(operation);
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  }
  return {
    knowledgeScope,
    dispose() {
      if (disposal) return disposal;
      sealed = true;
      disposal = Promise.allSettled([...pending]).then(async () => {
        await builtin.dispose();
        await knowledgeScope.dispose();
      });
      void disposal.catch(() => {});
      return disposal;
    },
    configuredId(summary: SkillSummary) {
      return configuredIds.get(summary.id) ?? summary.id;
    },
    installedBinding(summary: SkillSummary) {
      return sources.get(summary.id)?.installed;
    },
    list() {
      return admitted(async () => {
        const states = new Map<string, ConfiguredSkillState>();
        const summaries = new Map<string, SkillSummary>();
        const nextSources = new Map<string, KnowledgeBinding>();
        const nextIds = new Map<string, string>();
        const nextDocuments = new Map<string, DocumentBinding>();
        const entry = (await builtin.list()).entries[0]!;
        const missingCapabilities = entry.requiredCapabilities.filter(
          (id) => !allowed.includes(id),
        );
        states.set(builtinComputerUseSkillId, {
          id: builtinComputerUseSkillId,
          source: null,
          name: entry.name,
          description: entry.description,
          version: entry.version,
          enabled: true,
          state: missingCapabilities.length ? 'unavailable' : 'available',
          reason: missingCapabilities.length ? 'skill_capability_missing' : null,
          requiredCapabilities: [...entry.requiredCapabilities],
          missingCapabilities,
        });
        nextIds.set(entry.id, builtinComputerUseSkillId);
        // Installation is global and independent of a workspace path or Tool selection.
        // Keeping its reader does not grant dependencies; load rechecks the host's allowed set.
        nextSources.set(entry.id, { source: builtin });
        nextDocuments.set(builtinComputerUseSkillId, { source: builtin, id: entry.id });
        if (!missingCapabilities.length) summaries.set(entry.id, entry);
        const publish = () => {
          sources = nextSources;
          configuredIds = nextIds;
          documents = nextDocuments;
          return {
            entries: [...summaries.values()].sort((a, b) =>
              this.configuredId(a) < this.configuredId(b) ? -1 : 1,
            ),
            states: [...states.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
          };
        };
        if (configured.length === 0 && installed.length === 0) return publish();
        let root = configurationRoot;
        let profileRootAvailable = false;
        if (configured.length) {
          root = await realpath(configurationRoot);
          const stat = await lstat(configurationRoot);
          if (!stat.isDirectory() || stat.isSymbolicLink())
            throw new AgentError(
              userScope ? 'configuration_unavailable' : 'workspace_configuration_unavailable',
            );
          try {
            const entry = await lstat(profileRoot);
            profileRootAvailable = entry.isDirectory() && !entry.isSymbolicLink();
          } catch (error) {
            if ((error as { code?: string }).code !== 'ENOENT') throw error;
          }
        }
        const trustedRoots = [root, ...(profileRootAvailable ? [profileRoot] : [])];
        const locations: {
          skill: JsonObject;
          state: ConfiguredSkillState;
          path?: string;
          roots: string[];
          installed?: InstalledUserSkill;
        }[] = configured.map((skill) => {
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
                    scope: userScope ? 'user' : 'project',
                    origin: inside(join(root, '.agents', 'skills'), path)
                      ? '.agents'
                      : inside(join(root, '.kite-code', 'skills'), path)
                        ? '.kite-code'
                        : 'configured',
                  };
          }
          return { skill, state, path, roots: trustedRoots };
        });
        const pathKey = (path: string) =>
          process.platform === 'win32' ? path.toLowerCase() : path;
        const configuredDocuments = new Set(
          locations.flatMap(({ path, state }) =>
            path && state.source
              ? [pathKey(path.endsWith('SKILL.md') ? path : join(path, 'SKILL.md'))]
              : [],
          ),
        );
        for (const skill of installed) {
          if (
            states.has(skill.id) ||
            configuredDocuments.has(pathKey(join(skill.path, 'SKILL.md')))
          )
            continue;
          const state: ConfiguredSkillState = {
            id: skill.id,
            source: { scope: 'user', origin: '.kite-code' },
            name: null,
            description: null,
            version: null,
            enabled: true,
            state: 'unavailable',
            reason: null,
            requiredCapabilities: [],
            missingCapabilities: [],
          };
          states.set(state.id, state);
          locations.push({
            skill: { id: skill.id, ...(skill.digest ? { digest: skill.digest } : {}) },
            state,
            path: skill.path,
            roots: [skill.path],
            installed: skill,
          });
        }
        // Re-read every location, but bound independent I/O. Fold in configured
        // order so completion order cannot choose a duplicate location's owner.
        for (let offset = 0; offset < locations.length; offset += 4) {
          const discovered = await Promise.all(
            locations
              .slice(offset, offset + 4)
              .map(async ({ skill, state, path, roots, installed }) => {
                if (!state.enabled) return;
                try {
                  if (!path) throw new AgentError('invalid_skill_configuration');
                  if (!roots.some((trusted) => inside(trusted, path)))
                    throw new AgentError('skill_path_denied');
                  if (
                    skill.options !== undefined &&
                    (!skill.options ||
                      typeof skill.options !== 'object' ||
                      Array.isArray(skill.options) ||
                      Object.keys(skill.options).length)
                  )
                    throw new AgentError('unsupported_skill_options');
                  let target: string;
                  if (installed) {
                    try {
                      target = await installedUserSkillDocument(installed);
                    } catch {
                      // No managed catalogue entry is published for a linked or incomplete directory.
                      states.delete(state.id);
                      return;
                    }
                  } else
                    target = await realpath(
                      path.endsWith('SKILL.md') ? path : join(path, 'SKILL.md'),
                    );
                  if (!roots.some((trusted) => inside(trusted, target)))
                    throw new AgentError('skill_path_denied');
                  const source = createSkillSource({
                    trustedRoots: roots,
                    locations: [installed ? target : path],
                    knowledgeScope,
                  });
                  const listed = await source.list();
                  if (listed.errors.length) throw new SkillError(listed.errors[0]!.code);
                  const summary = listed.entries[0];
                  if (!summary) throw new SkillError('skill_unavailable');
                  if (installed && summary.name === builtinComputerUseSkillId)
                    throw new SkillError('invalid_skill_configuration');
                  Object.assign(state, {
                    name: summary.name,
                    description: summary.description,
                    version: summary.version,
                    requiredCapabilities: summary.requiredCapabilities,
                    missingCapabilities: summary.requiredCapabilities.filter(
                      (id) => !allowed.includes(id),
                    ),
                  });
                  return { skill, state, summary, source, installed };
                } catch (error) {
                  if (error instanceof KnowledgeReadCleanupError) throw error;
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
            const { skill, state, summary, source, installed } = entry;
            const duplicate = nextIds.get(summary.id);
            if (duplicate) {
              if (installed) {
                // An explicitly configured alias retains ownership of its canonical file.
                states.delete(state.id);
                continue;
              }
              states.get(duplicate)!.state = 'unavailable';
              states.get(duplicate)!.reason = 'duplicate_skill_location';
              summaries.delete(summary.id);
              nextSources.delete(summary.id);
              nextDocuments.delete(duplicate);
              state.reason = 'duplicate_skill_location';
              continue;
            }
            nextIds.set(summary.id, state.id);
            if (skill.digest !== undefined && skill.digest !== summary.version) {
              state.reason = 'skill_version_changed';
              continue;
            }
            nextDocuments.set(state.id, { source, id: summary.id, installed });
            if (state.missingCapabilities.length) {
              state.reason = 'skill_capability_missing';
              continue;
            }
            state.state = 'available';
            summaries.set(summary.id, summary);
            nextSources.set(summary.id, { source, installed });
          }
        }
        return publish();
      });
    },
    readDocument(input: { id: string; version: string }) {
      const document = documents.get(input.id);
      if (!document) throw new SkillError('skill_not_discovered');
      return admitted(async () => {
        if (document.installed) await installedUserSkillDocument(document.installed);
        return document.source.readDocument({
          id: document.id,
          version: input.version,
          maxTextBytes: 1048576,
        });
      });
    },
    load(input: Parameters<ReturnType<typeof createSkillSource>['load']>[0]) {
      const binding = sources.get(input.id);
      if (!binding) throw new SkillError('skill_not_discovered');
      const { source, installed } = binding;
      return admitted(async () => {
        if (installed) await installedUserSkillDocument(installed);
        return source.load(
          source === builtin
            ? {
                ...input,
                availableCapabilities: input.availableCapabilities?.filter((id) =>
                  allowed.includes(id),
                ),
              }
            : input,
        );
      });
    },
    readResource(input: Parameters<ReturnType<typeof createSkillSource>['readResource']>[0]) {
      const binding = sources.get(input.skillId);
      if (!binding) throw new SkillError('skill_not_discovered');
      const { source, installed } = binding;
      return admitted(async () => {
        if (installed) {
          await installedUserSkillDocument(installed);
          const skill = await source.load({
            id: input.skillId,
            version: input.version,
            availableCapabilities: input.availableCapabilities,
          });
          if (!skill.resources.some((resource) => resource.path === input.path))
            throw new SkillError('skill_resource_not_declared');
          await verifyInstalledUserSkillResource(installed, input.path);
        }
        return source.readResource(
          source === builtin
            ? {
                ...input,
                availableCapabilities: input.availableCapabilities?.filter((id) =>
                  allowed.includes(id),
                ),
              }
            : input,
        );
      });
    },
  };
}
