import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { AgentError, ConfigurationPreparationCleanupError } from '@kite-ai/agent';
import type { JsonObject, NamedConfiguration } from '@kite-ai/agent/config';
import { estimateModelContext } from '@kite-ai/agent/context-estimate';
import {
  defineExtension,
  type Extension,
  type Json,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from '@kite-ai/agent/extensions';
import { createFileTools, createWorkspaceFiles } from '@kite-ai/agent/files';
import type { ProfileSelection } from '@kite-ai/agent/profile';
import { registerSkillReadTool, SkillError, type SkillSummary } from '@kite-ai/agent/skills';
import {
  agentContractSource,
  type ContextSource,
  type ContextSources,
  createProjectSources,
  KnowledgeReadCleanupError,
  skillKnowledgeModelContent,
  skillKnowledgeSourceId,
  type WorkingEnvironment,
} from '@kite-ai/agent/sources';
import type { InstalledUserSkill } from './installed-user-skills';
import { createConfiguredSkillSource } from './skill-source';

const fileIds = ['files.read', 'files.write', 'files.edit'];
const optionalFileIds = ['files.view_images', 'files.reinspect_images'];
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

async function skillContentAlreadyVisible(
  context: ToolContext,
  definitionId: string,
  sourceId: string,
  version: string,
  catalogueDigest: string,
  body: string,
): Promise<boolean> {
  if (await context.hasDecisionSkillSource?.(sourceId, body)) return true;
  const results = await context.readDecisionToolResults?.();
  return (
    results?.some(({ execution, content }) => {
      if (
        execution.definitionId !== definitionId ||
        execution.status !== 'succeeded' ||
        content !== body
      )
        return false;
      const details = (
        execution.result as {
          details?: { sourceId?: string; version?: string; catalogueDigest?: string };
        } | null
      )?.details;
      return (
        details?.sourceId === sourceId &&
        details.version === version &&
        (details.catalogueDigest === undefined || details.catalogueDigest === catalogueDigest)
      );
    }) ?? false
  );
}

/** Per-Run host registrations. Configuration chooses capabilities but never creates trusted roots or permission. */
export async function createWorkspaceAssembly(options: {
  workspaceRoot: string;
  workingEnvironment?: WorkingEnvironment;
  profile: ProfileSelection;
  toolIds: readonly string[];
  toolConfigurations?: readonly JsonObject[];
  skills?: readonly JsonObject[];
  installedUserSkills?: readonly InstalledUserSkill[];
  /** Original per-Run selectors from the configured catalogue; never a path or capability. */
  selectedSkills?: readonly string[];
  /** Trusted parent binding fence: exact configured IDs, never name selectors. */
  inheritedSkillIds?: readonly string[];
  inheritedInstalledSkills?: ReadonlyMap<string, string>;
  knownToolIds?: readonly string[];
  allowedCapabilities?: readonly string[];
  /** One trusted global builtin.files registration; this assembly keeps only its selection/facts. */
  externallyRegisteredFileTools?: readonly ToolDefinition[];
  /** Trusted globally registered definitions, kept in the actual selected facts. */
  externallyRegisteredExtensions?: readonly Extension[];
}) {
  // Do not advertise archive access when the parent image capability was deselected.
  const selectedToolIds = options.toolIds.filter(
    (id) => id !== 'files.reinspect_images' || options.toolIds.includes('files.view_images'),
  );
  const root = await realpath(options.workspaceRoot);
  const stat = await lstat(options.workspaceRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new AgentError('workspace_configuration_unavailable');
  const externalExtensions = options.externallyRegisteredExtensions ?? [];
  const externalFiles = options.externallyRegisteredFileTools;
  const known = new Set([
    ...fileIds,
    ...(externalFiles ?? []).map((tool) => tool.id),
    ...skillIds,
    ...(options.knownToolIds ?? []),
    ...externalExtensions.flatMap((extension) => (extension.tools ?? []).map((tool) => tool.id)),
  ]);
  if (selectedToolIds.some((id) => !known.has(id)))
    throw new AgentError('tool_definition_unavailable');
  if (
    externalFiles &&
    (new Set(externalFiles.map((tool) => tool.id)).size !== externalFiles.length ||
      fileIds.some((id) => !externalFiles.some((tool) => tool.id === id)) ||
      externalFiles.some((tool) => ![...fileIds, ...optionalFileIds].includes(tool.id)))
  )
    throw new AgentError('file_registration_conflict');
  for (const selected of options.toolConfigurations ?? []) {
    if (!selectedToolIds.includes(String(selected.id))) continue;
    if (
      selected.options !== undefined &&
      (!selected.options ||
        typeof selected.options !== 'object' ||
        Array.isArray(selected.options) ||
        Object.keys(selected.options).length)
    )
      throw new AgentError('unsupported_tool_options');
  }
  const files =
    !externalFiles && selectedToolIds.some((id) => fileIds.includes(id))
      ? createWorkspaceFiles({ root })
      : undefined;
  let skills: ReturnType<typeof createConfiguredSkillSource> | undefined;
  let project: ReturnType<typeof createProjectSources> | undefined;
  let disposal: Promise<void> | undefined;
  const dispose = () => {
    disposal ??= Promise.allSettled([
      Promise.resolve().then(() => files?.close()),
      Promise.resolve().then(() => skills?.dispose()),
      Promise.resolve().then(() => project?.dispose()),
    ]).then((results) => {
      const failures = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1)
        throw new AggregateError(failures, 'Workspace assembly cleanup failed.', {
          cause: failures[0],
        });
    });
    void disposal.catch(() => {});
    return disposal;
  };
  try {
    const configured = (options.skills ?? []).filter((skill) => skill.enabled !== false);
    const skillSource = createConfiguredSkillSource(options);
    skills = skillSource;
    const initial = await skillSource.list();
    const configuredId = (entry: SkillSummary) => skillSource.configuredId(entry);
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
          // Automatically discovered parent skills are optional after the child's
          // capability ceiling narrows. Explicit requirements and bad IDs still fail.
          if (
            options.selectedSkills === undefined &&
            matches.length === 0 &&
            initial.states.some(
              (entry) =>
                entry.id === id &&
                entry.state === 'unavailable' &&
                entry.reason === 'skill_capability_missing',
            )
          )
            continue;
          failSelected(id);
          throw new AgentError('skill_not_discovered');
        }
        const match = matches[0]!;
        const inheritedDigest = options.inheritedInstalledSkills?.get(id);
        if (
          inheritedDigest !== undefined &&
          (skillSource.installedBinding(match)?.id !== id || match.version !== inheritedDigest)
        )
          throw new AgentError('skill_version_changed');
        selected.add(match.id);
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
      installed: skillSource.installedBinding(entry),
      version: entry.version,
    }));
    const selectedIds = new Set(selectedBindings.map((entry) => entry.id));
    const allowed = [...(options.allowedCapabilities ?? [])].filter((id) =>
      selectedToolIds.includes(id),
    );
    async function catalogue(targetId?: string) {
      const current = await skillSource.list();
      for (const row of current.states) {
        if (
          (targetId === undefined || row.id === targetId) &&
          selectedIds.has(row.id) &&
          row.state !== 'available'
        )
          throw new AgentError(row.reason ?? 'skill_not_discovered');
      }
      for (const original of selectedBindings) {
        if (targetId !== undefined && original.id !== targetId) continue;
        const entry = current.entries.find((entry) => configuredId(entry) === original.id);
        if (
          !entry ||
          entry.id !== original.sourceId ||
          (original.installed &&
            (!skillSource.installedBinding(entry) || entry.version !== original.version))
        )
          throw new AgentError('skill_version_changed');
      }
      return current.entries
        .filter((entry) => selected.has(entry.id))
        .map((entry) => ({
          ...entry,
          id: configuredId(entry) ?? entry.id,
          sourceId: entry.id,
        }));
    }
    async function find(id: string, entries?: Awaited<ReturnType<typeof catalogue>>) {
      const entry = selectedIds.has(id)
        ? (entries ?? (await catalogue(id))).find((entry) => entry.id === id)
        : undefined;
      if (!entry) {
        const unavailable = initial.states.find(
          (row) => row.id === id && row.state === 'unavailable',
        );
        throw new AgentError(unavailable?.reason ?? 'skill_not_discovered');
      }
      return entry;
    }
    async function body(
      id: string,
      version?: string,
      entries?: Awaited<ReturnType<typeof catalogue>>,
    ) {
      const entry = await find(id, entries);
      const pinned = configured.find((skill) => skill.id === id)?.digest;
      if (pinned !== undefined && entry.version !== pinned)
        throw new AgentError('skill_version_changed');
      try {
        return await skillSource.load({
          id: entry.sourceId,
          version: version ?? entry.version,
          availableCapabilities: allowed,
        });
      } catch (error) {
        if (error instanceof KnowledgeReadCleanupError) throw error;
        throw new AgentError(error instanceof SkillError ? error.code : 'skill_unavailable');
      }
    }
    const tools: ToolDefinition[] = skillIds.map((id) => ({
      id,
      version: '1',
      model: {
        name: id === 'skills.load' ? 'load_skill' : 'read_skill_resource',
        snakeCase: true,
        parameterNames: { id: 'skill_id' },
        omitParameters: ['version'],
      },
      description: [
        id === 'skills.load'
          ? 'Load selected Skill knowledge on demand; never execute its resources.'
          : 'Read a declared Skill resource as knowledge; never execute code.',
        'Reuse the full text if already in context. After compaction, read it again only if it is missing and needed.',
        'Wait for a successful result and read the returned guidance before planning dependent tool calls. Do not batch dependent commands with this call.',
      ].join(' '),
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
            const sourceId = skillKnowledgeSourceId(value.id);
            const alreadyLoaded = await skillContentAlreadyVisible(
              context,
              id,
              sourceId,
              selected.version,
              digest(selected.id),
              selected.body,
            );
            if (context.signal.aborted)
              return { outcome: 'cancelled', content: 'cancelled_after_skill_read' };
            return {
              outcome: 'succeeded',
              content: alreadyLoaded
                ? 'already_loaded: The complete Skill instructions are already in this request.'
                : selected.body,
              details: {
                skillId: value.id,
                version: selected.version,
                sourceId,
                catalogueDigest: digest(selected.id),
                resources: selected.resources as unknown as Json,
                ...(alreadyLoaded
                  ? { alreadyLoaded: true, verifiedModelContentDigest: digest(selected.body) }
                  : {}),
              },
            };
          }
          if (typeof value.path !== 'string') throw new AgentError('skill_input_invalid');
          const resource = await skillSource.readResource({
            skillId: selected.id,
            version: selected.version,
            path: value.path,
            availableCapabilities: allowed,
          });
          const sourceId = skillKnowledgeSourceId(value.id, value.path);
          const alreadyLoaded = await skillContentAlreadyVisible(
            context,
            id,
            sourceId,
            resource.version,
            digest(selected.id),
            resource.body,
          );
          if (context.signal.aborted)
            return { outcome: 'cancelled', content: 'cancelled_after_skill_read' };
          return {
            outcome: 'succeeded',
            content: alreadyLoaded
              ? 'already_loaded: The complete Skill resource is already in this request.'
              : resource.body,
            details: {
              version: resource.version,
              sourceId,
              catalogueDigest: digest(selected.id),
              ...(alreadyLoaded
                ? { alreadyLoaded: true, verifiedModelContentDigest: digest(resource.body) }
                : {}),
            },
          };
        } catch (error) {
          if (error instanceof KnowledgeReadCleanupError) throw error;
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
    const projectSource = createProjectSources({
      workspaceRoot: async () => root,
      targetPaths(request) {
        if (
          !fileIds.includes(request.definitionId) ||
          !request.input ||
          typeof request.input !== 'object' ||
          Array.isArray(request.input)
        )
          return [];
        const path = request.input.path;
        if (typeof path !== 'string' || path.includes('\0')) return [];
        // A rejected file target contributes no project instructions. The Files
        // boundary still rejects it as an ordinary Tool result, allowing the Run
        // to explain the failure without reading beyond its Workspace.
        const target = relative(root, resolve(root, path));
        if (isAbsolute(target) || target === '..' || target.startsWith(`..${sep}`)) return [];
        return [path];
      },
    });
    project = projectSource;
    const contract = agentContractSource(
      root,
      options.workingEnvironment ?? { platform: process.platform },
    );
    const captureSources: NonNullable<ContextSources['captureBatch']> = async (
      requests,
      selection,
    ) => {
      if (selection?.workspaceRead)
        return [{ ...contract }, ...(await projectSource.capture(selection.workspaceRead))];
      const result = [{ ...contract }, ...(await projectSource.captureBatch!(requests))];
      if (!requests.length) return result;
      const current = await catalogue();
      const bodies = new Map<string, Awaited<ReturnType<typeof body>>>();
      const checkpointBody = async (id: string) => {
        const existing = bodies.get(id);
        if (existing) return existing;
        const value = await body(id, undefined, current);
        bodies.set(id, value);
        return value;
      };
      const summaries = current.map(({ id, version, name, description, requiredCapabilities }) => ({
        id,
        version,
        name,
        description,
        requiredCapabilities,
      }));
      if (summaries.length) {
        const visible = summaries.map(({ version: _version, ...summary }) => summary);
        const catalogueSource = source(
          'skills.catalogue',
          'skill_catalogue',
          JSON.stringify(visible),
        );
        const sealedDigest = selection?.sealedSkillCatalogueDigest;
        // Recompute the legacy identity to recover an unchanged request recorded before this split.
        if (
          sealedDigest !== undefined &&
          sealedDigest !== catalogueSource.digest &&
          sealedDigest === digest(JSON.stringify(summaries))
        )
          catalogueSource.digest = sealedDigest;
        result.push(catalogueSource);
      }
      const entries = new Map(current.map((entry) => [entry.id, entry]));
      const bodyIds = new Set<string>();
      const resources = new Map<string, { skillId: string; path: string }>();
      const readResource = (skill: Awaited<ReturnType<typeof body>>, path: string) =>
        skillSource.readResource({
          skillId: skill.id,
          version: skill.version,
          path,
          availableCapabilities: allowed,
        });
      const legacyResources = new Map<string, Awaited<ReturnType<typeof readResource>>>();
      for (const read of selection?.skillReads ?? []) {
        const entry = entries.get(read.skillId);
        const definition = read.path === undefined ? 'skills.load' : 'skills.resource';
        if (!selectedToolIds.includes(definition) || !entry) continue;
        if (read.catalogueDigest !== undefined) {
          if (read.catalogueDigest !== digest(entry.sourceId)) continue;
        } else if (read.path === undefined && read.version !== entry.version) {
          continue;
        }
        if (read.path !== undefined) {
          const skill = await checkpointBody(read.skillId);
          if (!skill.resources.some(({ path }) => path === read.path)) continue;
          const sourceId = skillKnowledgeSourceId(read.skillId, read.path);
          if (read.catalogueDigest === undefined) {
            const resource = await readResource(skill, read.path);
            if (resource.version !== read.version) continue;
            legacyResources.set(sourceId, resource);
          }
          resources.set(sourceId, { skillId: read.skillId, path: read.path });
        }
        bodyIds.add(read.skillId);
      }
      for (const id of [...bodyIds].sort()) {
        const sourceId = skillKnowledgeSourceId(id);
        if (selection?.skillBodyIds && !selection.skillBodyIds.has(sourceId)) continue;
        const selected = await checkpointBody(id);
        result.push(source(sourceId, 'skill', selected.body));
      }
      const resourceIds = new Set([
        ...(selection?.skillResourceIds ?? []),
        ...(selection?.coveredSkillResources?.ids ?? []),
      ]);
      let coveredTokens = selection?.coveredSkillResources?.tokens ?? 0;
      for (const sourceId of resourceIds) {
        const selected = resources.get(sourceId);
        if (!selected) continue;
        const covered = selection && !selection.skillResourceIds.has(sourceId);
        if (covered && coveredTokens === 0) break;
        const skill = await checkpointBody(selected.skillId);
        const resource =
          legacyResources.get(sourceId) ?? (await readResource(skill, selected.path));
        if (covered) {
          const cost = estimateModelContext({
            messages: [
              { role: 'user', content: skillKnowledgeModelContent(sourceId, resource.body) },
            ],
            tools: [],
          }).estimate.totalInputTokens;
          if (cost > coveredTokens) continue;
          coveredTokens -= cost;
        }
        result.push(source(sourceId, 'skill_resource', resource.body));
      }
      return result;
    };
    const sources: ContextSources = {
      capture: (request, selection) => captureSources([request], selection),
      captureBatch: captureSources,
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
    if (
      configured.length ||
      selectedEntries.length ||
      selectedToolIds.some((id) => skillIds.includes(id))
    ) {
      tools.forEach(registerSkillReadTool);
      extensions.push(defineExtension({ id: 'builtin.skills', version: '1', apiMajor: 1, tools }));
    }
    const actualTools = new Map([
      ...(externalFiles ?? []).map((tool) => [tool.id, tool] as const),
      ...[...extensions, ...externalExtensions].flatMap((extension) =>
        (extension.tools ?? []).map((tool) => [tool.id, tool] as const),
      ),
    ]);
    for (const selected of options.toolConfigurations ?? []) {
      if (!selectedToolIds.includes(String(selected.id))) continue;
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
          .filter((tool) => selectedToolIds.includes(tool.id))
          .map((tool) => ({
            id: tool.id,
            definitionVersion: tool.version,
            extensionId: 'builtin.files',
          })),
        ...[...extensions, ...externalExtensions].flatMap(
          (extension) =>
            extension.tools
              ?.filter((tool) => selectedToolIds.includes(tool.id))
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
    const projectSkillBindings = selectedEntries.flatMap((entry) => {
      const id = configuredId(entry) ?? entry.id;
      const path = relative(root, entry.location);
      return isAbsolute(entry.location) &&
        path &&
        !isAbsolute(path) &&
        path !== '..' &&
        !path.startsWith(`..${sep}`) &&
        !skillSource.installedBinding(entry) &&
        configured.find((skill) => skill.id === id)?.digest === undefined
        ? [{ id, source: digest(entry.id), path }]
        : [];
    });
    return {
      extensions,
      toolIds: [...selectedToolIds],
      sources,
      knowledgeScope: skillSource.knowledgeScope,
      skillConfigurations: [
        ...configured
          .filter((entry) => selectedIds.has(String(entry.id)))
          .map((entry): NamedConfiguration => ({ ...entry, id: String(entry.id) })),
        ...selectedBindings.flatMap(({ id, installed, version }): NamedConfiguration[] =>
          installed
            ? [{ id, path: installed.path, digest: version, options: { installedUserSkill: true } }]
            : [],
        ),
      ],
      dispose,
      projectSkillBindings,
      snapshotFacts: { ...snapshotFacts, digest: digest(JSON.stringify(snapshotFacts)) },
    };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new ConfigurationPreparationCleanupError({
        originalError: error,
        cleanupError,
        resources: { files, skills, project },
      });
    }
    if (error instanceof AgentError) throw error;
    throw new AgentError(error instanceof SkillError ? error.code : 'assembly_unavailable');
  }
}
