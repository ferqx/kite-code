import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { AgentError } from '@kite-ai/agent';
import type { JsonObject, NamedConfiguration } from '@kite-ai/agent/config';
import {
  defineExtension,
  type Extension,
  type Json,
  type ToolDefinition,
  type ToolResult,
} from '@kite-ai/agent/extensions';
import { createFileTools, createWorkspaceFiles } from '@kite-ai/agent/files';
import type { ProfileSelection } from '@kite-ai/agent/profile';
import { SkillError, type SkillSummary } from '@kite-ai/agent/skills';
import {
  type ContextSource,
  type ContextSources,
  createProjectSources,
  type SourceRequest,
} from '@kite-ai/agent/sources';
import { createConfiguredSkillSource } from './skill-source';

const fileIds = [
  'files.read',
  'files.write',
  'files.edit',
  'files.list',
  'files.glob',
  'files.search',
];
const skillIds = ['skills.load', 'skills.resource'];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function source(id: string, kind: string, content: string): ContextSource {
  return { id, kind, scope: 'run-knowledge', digest: digest(content), content };
}
function object(input: Json): JsonObject {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new AgentError('skill_input_invalid');
  return input;
}

/** Per-Run host registrations. Configuration chooses capabilities but never creates trusted roots or permission. */
export async function createWorkspaceAssembly(options: {
  workspaceRoot: string;
  profile: ProfileSelection;
  toolIds: readonly string[];
  toolConfigurations?: readonly JsonObject[];
  skills?: readonly JsonObject[];
  /** Original per-Run selectors from the configured catalogue; never a path or capability. */
  selectedSkills?: readonly string[];
  /** Trusted parent binding fence: exact configured IDs, never name selectors. */
  inheritedSkillIds?: readonly string[];
  knownToolIds?: readonly string[];
  allowedCapabilities?: readonly string[];
  /** One trusted global builtin.files registration; this assembly keeps only its selection/facts. */
  externallyRegisteredFileTools?: readonly ToolDefinition[];
  /** Trusted globally registered definitions, kept in the actual selected facts. */
  externallyRegisteredExtensions?: readonly Extension[];
}) {
  const root = await realpath(options.workspaceRoot);
  const stat = await lstat(options.workspaceRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new AgentError('workspace_configuration_unavailable');
  const externalExtensions = options.externallyRegisteredExtensions ?? [];
  const known = new Set([
    ...fileIds,
    ...skillIds,
    ...(options.knownToolIds ?? []),
    ...externalExtensions.flatMap((extension) => (extension.tools ?? []).map((tool) => tool.id)),
  ]);
  if (options.toolIds.some((id) => !known.has(id)))
    throw new AgentError('tool_definition_unavailable');
  const externalFiles = options.externallyRegisteredFileTools;
  if (
    externalFiles &&
    (externalFiles.length !== fileIds.length ||
      new Set(externalFiles.map((tool) => tool.id)).size !== fileIds.length ||
      externalFiles.some((tool) => !fileIds.includes(tool.id)))
  )
    throw new AgentError('file_registration_conflict');
  for (const selected of options.toolConfigurations ?? []) {
    if (!options.toolIds.includes(String(selected.id))) continue;
    if (
      selected.options !== undefined &&
      (!selected.options ||
        typeof selected.options !== 'object' ||
        Array.isArray(selected.options) ||
        Object.keys(selected.options).length)
    )
      throw new AgentError('unsupported_tool_options');
  }
  const files = options.toolIds.some((id) => fileIds.includes(id))
    ? createWorkspaceFiles({ root })
    : undefined;
  try {
    const configured = (options.skills ?? []).filter((skill) => skill.enabled !== false);
    const skills = createConfiguredSkillSource(options);
    const initial = await skills.list();
    const configuredId = (entry: SkillSummary) => skills.configuredId(entry);
    const failSelected = (selector: string) => {
      const unavailable = initial.states.find(
        (entry) => entry.id === selector && entry.state !== 'available',
      );
      if (unavailable) throw new AgentError(unavailable.reason ?? 'skill_not_discovered');
    };
    const selected = new Set<string>();
    if (options.inheritedSkillIds !== undefined) {
      for (const id of options.inheritedSkillIds) {
        const matches = initial.entries.filter((entry) => (configuredId(entry) ?? entry.id) === id);
        if (matches.length !== 1) {
          failSelected(id);
          throw new AgentError('skill_not_discovered');
        }
        selected.add(matches[0]!.id);
      }
    } else if (options.selectedSkills !== undefined)
      for (const selector of options.selectedSkills) {
        const states = initial.states.filter(
          (entry) => entry.id === selector || entry.name === selector,
        );
        if (!states.length) throw new AgentError('skill_not_discovered');
        if (states.length !== 1) throw new AgentError('skill_selection_ambiguous');
        const state = states[0]!;
        if (state.state !== 'available')
          throw new AgentError(state.reason ?? 'skill_not_discovered');
        const entry = initial.entries.find((entry) => configuredId(entry) === state.id);
        if (!entry) throw new AgentError('skill_not_discovered');
        selected.add(entry.id);
      }
    else for (const entry of initial.entries) selected.add(entry.id);
    const selectedEntries = initial.entries.filter((entry) => selected.has(entry.id));
    const selectedBindings = selectedEntries.map((entry) => ({
      id: configuredId(entry),
      sourceId: entry.id,
    }));
    const selectedIds = new Set(selectedBindings.map((entry) => entry.id));
    const loaded = new Set<string>();
    const loadedResources = new Map<string, { skillId: string; path: string }>();
    const allowed = [...(options.allowedCapabilities ?? [])].filter((id) =>
      options.toolIds.includes(id),
    );
    async function catalogue() {
      const current = await skills.list();
      for (const row of current.states) {
        if (selectedIds.has(row.id) && row.state !== 'available')
          throw new AgentError(row.reason ?? 'skill_not_discovered');
      }
      for (const original of selectedBindings) {
        const entry = current.entries.find((entry) => configuredId(entry) === original.id);
        if (!entry || entry.id !== original.sourceId) throw new AgentError('skill_version_changed');
      }
      return current.entries
        .filter((entry) => selected.has(entry.id))
        .map((entry) => ({
          ...entry,
          id: configuredId(entry) ?? entry.id,
          sourceId: entry.id,
        }));
    }
    async function find(id: string) {
      const entry = (await catalogue()).find((entry) => entry.id === id);
      if (!entry) {
        const unavailable = initial.states.find(
          (row) => row.id === id && row.state === 'unavailable',
        );
        throw new AgentError(unavailable?.reason ?? 'skill_not_discovered');
      }
      return entry;
    }
    async function body(id: string, version?: string) {
      const entry = await find(id);
      const pinned = configured.find((skill) => skill.id === id)?.digest;
      if (pinned !== undefined && entry.version !== pinned)
        throw new AgentError('skill_version_changed');
      try {
        return await skills.load({
          id: entry.sourceId,
          version: version ?? entry.version,
          availableCapabilities: allowed,
        });
      } catch (error) {
        throw new AgentError(error instanceof SkillError ? error.code : 'skill_unavailable');
      }
    }
    const tools: ToolDefinition[] = skillIds.map((id) => ({
      id,
      version: '1',
      description:
        id === 'skills.load'
          ? 'Load selected Skill knowledge on demand; never execute its resources'
          : 'Read a declared Skill resource as knowledge; never execute code',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: id === 'skills.load' ? ['id'] : ['id', 'path'],
        properties: {
          id: { type: 'string', maxLength: 128 },
          version: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          ...(id === 'skills.resource' ? { path: { type: 'string', maxLength: 4096 } } : {}),
        },
      },
      async execute(input, context): Promise<ToolResult> {
        if (context.signal.aborted)
          return { outcome: 'cancelled', content: 'cancelled_before_skill_read' };
        try {
          const value = object(input);
          if (typeof value.id !== 'string') throw new AgentError('skill_input_invalid');
          const selected = await body(
            value.id,
            typeof value.version === 'string' ? value.version : undefined,
          );
          if (context.signal.aborted)
            return { outcome: 'cancelled', content: 'cancelled_after_skill_read' };
          if (id === 'skills.load') {
            loaded.add(value.id);
            return {
              outcome: 'succeeded',
              content: selected.body,
              details: {
                skillId: value.id,
                version: selected.version,
                sourceId: `skill.body:${value.id}`,
                resources: selected.resources as unknown as Json,
              },
            };
          }
          if (typeof value.path !== 'string') throw new AgentError('skill_input_invalid');
          const resource = await skills.readResource({
            skillId: selected.id,
            version: selected.version,
            path: value.path,
            availableCapabilities: allowed,
          });
          if (context.signal.aborted)
            return { outcome: 'cancelled', content: 'cancelled_after_skill_read' };
          loaded.add(value.id);
          loadedResources.set(`${value.id}:${value.path}`, { skillId: value.id, path: value.path });
          return {
            outcome: 'succeeded',
            content: resource.body,
            details: {
              version: resource.version,
              sourceId: `skill.resource:${value.id}:${value.path}`,
            },
          };
        } catch (error) {
          if (context.signal.aborted)
            return { outcome: 'cancelled', content: 'cancelled_skill_read' };
          const code =
            error instanceof AgentError || error instanceof SkillError
              ? error.code
              : 'skill_unavailable';
          return { outcome: 'failed', content: code, details: { code } };
        }
      },
    }));
    const project = createProjectSources({
      workspaceRoot: async () => root,
      targetPaths(request) {
        if (
          !fileIds.includes(request.definitionId) ||
          !request.input ||
          typeof request.input !== 'object' ||
          Array.isArray(request.input)
        )
          return [];
        return typeof request.input.path === 'string' ? [request.input.path] : [];
      },
    });
    const sources: ContextSources = {
      async capture(request: SourceRequest) {
        const result = await project.capture(request);
        const current = await catalogue();
        const summaries = current.map(
          ({ id, version, name, description, requiredCapabilities }) => ({
            id,
            version,
            name,
            description,
            requiredCapabilities,
          }),
        );
        if (summaries.length)
          result.push(source('skills.catalogue', 'skill_catalogue', JSON.stringify(summaries)));
        for (const id of [...loaded].sort()) {
          const selected = await body(id);
          result.push(source(`skill.body:${id}`, 'skill', selected.body));
        }
        for (const [key, selected] of [...loadedResources.entries()].sort(([a], [b]) =>
          a.localeCompare(b),
        )) {
          const skill = await body(selected.skillId);
          const resource = await skills.readResource({
            skillId: skill.id,
            version: skill.version,
            path: selected.path,
            availableCapabilities: allowed,
          });
          result.push(source(`skill.resource:${key}`, 'skill_resource', resource.body));
        }
        return result;
      },
    };
    const extensions: Extension[] = [];
    if (files && !externalFiles)
      extensions.push(
        defineExtension({
          id: 'builtin.files',
          version: '1',
          apiMajor: 1,
          tools: createFileTools(files),
        }),
      );
    if (configured.length || options.toolIds.some((id) => skillIds.includes(id)))
      extensions.push(defineExtension({ id: 'builtin.skills', version: '1', apiMajor: 1, tools }));
    const actualTools = new Map([
      ...(externalFiles ?? []).map((tool) => [tool.id, tool] as const),
      ...[...extensions, ...externalExtensions].flatMap((extension) =>
        (extension.tools ?? []).map((tool) => [tool.id, tool] as const),
      ),
    ]);
    for (const selected of options.toolConfigurations ?? []) {
      if (!options.toolIds.includes(String(selected.id))) continue;
      if (
        selected.definitionVersion !== undefined &&
        actualTools.has(String(selected.id)) &&
        selected.definitionVersion !== actualTools.get(String(selected.id))?.version
      )
        throw new AgentError('tool_definition_version_unavailable');
    }
    const snapshotFacts = {
      tools: [
        ...(externalFiles ?? [])
          .filter((tool) => options.toolIds.includes(tool.id))
          .map((tool) => ({
            id: tool.id,
            definitionVersion: tool.version,
            extensionId: 'builtin.files',
          })),
        ...[...extensions, ...externalExtensions].flatMap(
          (extension) =>
            extension.tools
              ?.filter((tool) => options.toolIds.includes(tool.id))
              .map((tool) => ({
                id: tool.id,
                definitionVersion: tool.version,
                extensionId: extension.id,
              })) ?? [],
        ),
      ],
      skills: selectedEntries.map((entry) => ({
        id: configuredId(entry) ?? entry.id,
        version: entry.version,
        requiredCapabilities: entry.requiredCapabilities,
      })),
      allowedCapabilities: allowed,
    };
    return {
      extensions,
      toolIds: [...options.toolIds],
      sources,
      skillConfigurations: configured
        .filter((entry) => selectedIds.has(String(entry.id)))
        .map((entry): NamedConfiguration => ({ ...entry, id: String(entry.id) })),
      dispose: async () => {
        await files?.close();
      },
      snapshotFacts: { ...snapshotFacts, digest: digest(JSON.stringify(snapshotFacts)) },
    };
  } catch (error) {
    await files?.close();
    if (error instanceof AgentError) throw error;
    throw new AgentError(error instanceof SkillError ? error.code : 'assembly_unavailable');
  }
}
