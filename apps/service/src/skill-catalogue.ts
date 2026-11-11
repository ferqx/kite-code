import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentError,
  type AgentRuntime,
  ConfigurationPreparationCleanupError,
} from '@kite-ai/agent';
import {
  type JsonObject,
  readConfigurationFile,
  resolveConfiguration,
} from '@kite-ai/agent/config';
import type { ProfileSelection } from '@kite-ai/agent/profile';
import { createKnowledgeReadScope, KnowledgeReadCleanupError } from '@kite-ai/agent/sources';
import type { z } from 'zod';
import { defaultConfiguration } from './configuration-defaults';
import {
  SkillCataloguePageSchema,
  type SkillCatalogueQuerySchema,
  skillUnavailableReasons,
  UserSkillCataloguePageSchema,
  type UserSkillCatalogueQuerySchema,
  type UserSkillDocumentQuerySchema,
  UserSkillDocumentSchema,
} from './http/schema/skill-catalogue';
import { discoverInstalledUserSkills } from './installed-user-skills';
import type { PermissionManagementPort } from './permission-management';
import { createConfiguredSkillSource } from './skill-source';
import { type UserConfiguration, withoutProjectModels } from './user-configuration';

type Query = z.infer<typeof SkillCatalogueQuerySchema>;
export type SkillCataloguePage = z.infer<typeof SkillCataloguePageSchema>;
export type UserSkillCataloguePage = z.infer<typeof UserSkillCataloguePageSchema>;
export type UserSkillDocument = z.infer<typeof UserSkillDocumentSchema>;
export type UserSkillDocumentContext = z.infer<typeof UserSkillDocumentQuerySchema> & {
  runtime: AgentRuntime;
  subjectId: string;
};
export interface SkillCatalogueContext extends Query {
  runtime: AgentRuntime;
  permissions?: PermissionManagementPort;
  subjectId: string;
  workspaceId: string;
}
export interface UserSkillCatalogueContext extends z.infer<typeof UserSkillCatalogueQuerySchema> {
  runtime: AgentRuntime;
  subjectId: string;
}
export interface SkillCatalogueSource {
  list(context: SkillCatalogueContext): Promise<SkillCataloguePage>;
  /** Global knowledge metadata from trusted user locations, independent of a Workspace or Session. */
  listUser?(context: UserSkillCatalogueContext): Promise<UserSkillCataloguePage>;
  readUserDocument?(context: UserSkillDocumentContext): Promise<UserSkillDocument>;
  /** Trusted host lifecycle; omitted by metadata-only sources without owned resources. */
  dispose?(): Promise<void>;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function unavailableSkillCatalogue(
  context: Query & { workspaceId: string },
  reason: NonNullable<SkillCataloguePage['reason']>,
): SkillCataloguePage {
  const revision = hash([context.storeId, context.workspaceId, reason]);
  if (context.revision && context.revision !== revision)
    throw new AgentError('skill_catalogue_changed');
  if (context.afterId) throw new AgentError('invalid_skill_catalogue_query');
  return {
    version: 1,
    storeId: context.storeId,
    workspaceId: context.workspaceId,
    revision,
    availability: 'unavailable',
    reason,
    entries: [],
    nextAfterId: null,
    complete: true,
  };
}
export function unavailableUserSkillCatalogue(
  context: z.infer<typeof UserSkillCatalogueQuerySchema>,
  reason: NonNullable<UserSkillCataloguePage['reason']>,
): UserSkillCataloguePage {
  const revision = hash([context.storeId, 'user', reason]);
  if (context.revision && context.revision !== revision)
    throw new AgentError('skill_catalogue_changed');
  if (context.afterId) throw new AgentError('invalid_skill_catalogue_query');
  return {
    version: 1,
    scope: 'user',
    storeId: context.storeId,
    revision,
    availability: 'unavailable',
    reason,
    entries: [],
    nextAfterId: null,
    complete: true,
  };
}
function paginate<Entry extends SkillCataloguePage['entries'][number]>(
  context: Query,
  page: { entries: Entry[]; nextAfterId: string | null; complete: boolean; revision: string },
  entries: readonly Entry[],
) {
  if (context.revision && context.revision !== page.revision)
    throw new AgentError('skill_catalogue_changed');
  if (context.afterId && !entries.some((entry) => entry.id === context.afterId))
    throw new AgentError('invalid_skill_catalogue_query');
  const pending = entries.filter((entry) => !context.afterId || entry.id > context.afterId);
  const maximum = context.byteLimit ?? 131072;
  for (const entry of pending) {
    if (page.entries.length >= (context.limit ?? Number.MAX_SAFE_INTEGER)) break;
    const candidate = {
      ...page,
      entries: [...page.entries, entry],
      nextAfterId: entry.id,
      complete: false,
    };
    if (Buffer.byteLength(JSON.stringify(candidate)) > maximum) {
      if (!page.entries.length) throw new AgentError('skill_catalogue_page_too_small');
      break;
    }
    page.entries.push(entry);
  }
  if (page.entries.length < pending.length) {
    page.nextAfterId = page.entries.at(-1)!.id;
    page.complete = false;
  }
}
/** Reads local knowledge only; never resolves a Model, credential or executor. */
export function createDefaultSkillCatalogueSource(options: {
  defaults?: JsonObject;
  profile: ProfileSelection;
  userConfiguration: UserConfiguration;
  explicit: () => JsonObject;
  allowedCapabilities?: readonly string[];
}): SkillCatalogueSource {
  const profile = Object.freeze({ ...options.profile });
  const userRoot = dirname(options.userConfiguration.path);
  const explicit = options.explicit;
  const allowedCapabilities = [...(options.allowedCapabilities ?? [])];
  const knowledgeScope = createKnowledgeReadScope();
  const pending = new Set<Promise<unknown>>();
  const retainedPreparationFailures = new Set<
    ConfigurationPreparationCleanupError | KnowledgeReadCleanupError
  >();
  let sealed = false;
  let disposal: Promise<void> | undefined;
  const isCleanupFailure = (
    error: unknown,
  ): error is ConfigurationPreparationCleanupError | KnowledgeReadCleanupError =>
    error instanceof KnowledgeReadCleanupError ||
    error instanceof ConfigurationPreparationCleanupError;
  const list = async (context: SkillCatalogueContext): Promise<SkillCataloguePage> => {
    if (context.afterId && !context.revision) throw new AgentError('invalid_skill_catalogue_query');
    const metadata = await context.runtime.getMetadata();
    if (metadata.storeId !== context.storeId) throw new AgentError('store_identity_mismatch');
    const workspace = await context.runtime.getWorkspace(context.workspaceId);
    if (!workspace) throw new AgentError('workspace_not_found');
    if (!context.permissions) throw new AgentError('permission_controls_unavailable');
    const trust = await context.permissions.readTrust({
      expectedStoreId: context.storeId,
      subjectId: context.subjectId,
      workspaceId: context.workspaceId,
    });
    if (!trust.trusted) throw new AgentError('workspace_untrusted');
    let root: string;
    try {
      const uri = new URL(workspace.rootUri);
      if (uri.protocol !== 'file:' || (uri.hostname && uri.hostname !== 'localhost')) throw Error();
      root = fileURLToPath(uri);
    } catch {
      return unavailableSkillCatalogue(context, 'workspace_configuration_unavailable');
    }
    let effective: ReturnType<typeof resolveConfiguration>;
    try {
      effective = resolveConfiguration({
        defaults: options.defaults ?? defaultConfiguration,
        user: options.userConfiguration.read().value,
        workspace: withoutProjectModels(
          readConfigurationFile({ path: join(root, 'kite-agent.jsonc') }).value,
        ),
        explicit: explicit(),
      });
    } catch {
      return unavailableSkillCatalogue(context, 'configuration_unavailable');
    }
    const toolIds =
      effective.tools?.filter((tool) => tool.enabled !== false).map((tool) => tool.id) ?? [];
    const source = createConfiguredSkillSource({
      knowledgeScope,
      workspaceRoot: root,
      profile,
      skills: effective.skills,
      installedUserSkills: await discoverInstalledUserSkills(userRoot),
      toolIds,
      allowedCapabilities,
    });
    let listed: Awaited<ReturnType<typeof source.list>>;
    try {
      listed = await source.list();
    } catch (error) {
      if (isCleanupFailure(error)) throw error;
      return unavailableSkillCatalogue(context, 'workspace_configuration_unavailable');
    }
    const entries: SkillCataloguePage['entries'] = listed.states.map((entry) => ({
      ...entry,
      reason:
        entry.reason &&
        !skillUnavailableReasons.includes(entry.reason as (typeof skillUnavailableReasons)[number])
          ? ('skill_unavailable' as const)
          : (entry.reason as SkillCataloguePage['entries'][number]['reason']),
    }));
    const revision = hash({
      storeId: context.storeId,
      workspaceId: context.workspaceId,
      subjectId: context.subjectId,
      canonicalIdentity: trust.canonicalIdentity,
      externalReadScopeDigest: trust.externalReadScopeDigest,
      trustRevision: trust.revision,
      skills: effective.skills ?? [],
      toolIds,
      allowedCapabilities,
      entries,
    });
    const page: SkillCataloguePage = {
      version: 1,
      storeId: context.storeId,
      workspaceId: context.workspaceId,
      revision,
      availability: 'available',
      reason: null,
      entries: [],
      nextAfterId: null,
      complete: true,
    };
    paginate(context, page, entries);
    return SkillCataloguePageSchema.parse(page);
  };
  const userCatalogue = async (context: UserSkillCatalogueContext) => {
    if (context.afterId && !context.revision) throw new AgentError('invalid_skill_catalogue_query');
    if ((await context.runtime.getMetadata()).storeId !== context.storeId)
      throw new AgentError('store_identity_mismatch');
    let effective: ReturnType<typeof resolveConfiguration>;
    try {
      effective = resolveConfiguration({
        defaults: options.defaults ?? defaultConfiguration,
        user: options.userConfiguration.read().value,
        explicit: explicit(),
      });
    } catch {
      return { page: unavailableUserSkillCatalogue(context, 'configuration_unavailable') };
    }
    const toolIds =
      effective.tools?.filter((tool) => tool.enabled !== false).map((tool) => tool.id) ?? [];
    const source = createConfiguredSkillSource({
      knowledgeScope,
      userRoot,
      profile,
      skills: effective.skills,
      installedUserSkills: await discoverInstalledUserSkills(userRoot),
      toolIds,
      allowedCapabilities,
    });
    let listed: Awaited<ReturnType<typeof source.list>>;
    try {
      listed = await source.list();
    } catch (error) {
      if (isCleanupFailure(error)) throw error;
      return { page: unavailableUserSkillCatalogue(context, 'configuration_unavailable') };
    }
    const entries: UserSkillCataloguePage['entries'] = listed.states.map((entry) => {
      if (entry.source?.scope === 'project')
        throw new AgentError('skill_catalogue_identity_mismatch');
      return {
        ...entry,
        source: entry.source ? { ...entry.source, scope: 'user' as const } : null,
        reason:
          entry.reason &&
          !skillUnavailableReasons.includes(
            entry.reason as (typeof skillUnavailableReasons)[number],
          )
            ? 'skill_unavailable'
            : (entry.reason as UserSkillCataloguePage['entries'][number]['reason']),
      };
    });
    const page: UserSkillCataloguePage = {
      version: 1,
      scope: 'user',
      storeId: context.storeId,
      revision: hash({
        scope: 'user',
        storeId: context.storeId,
        subjectId: context.subjectId,
        skills: effective.skills ?? [],
        toolIds,
        allowedCapabilities,
        entries,
      }),
      availability: 'available',
      reason: null,
      entries: [],
      nextAfterId: null,
      complete: true,
    };
    return { page, source, entries };
  };
  const listUser = async (context: UserSkillCatalogueContext): Promise<UserSkillCataloguePage> => {
    const { page, entries } = await userCatalogue(context);
    if (entries) paginate(context, page, entries);
    return UserSkillCataloguePageSchema.parse(page);
  };
  const readUserDocument = async (
    context: UserSkillDocumentContext,
  ): Promise<UserSkillDocument> => {
    const { page, source, entries } = await userCatalogue(context);
    if (!source || !entries) throw new AgentError('skill_unavailable');
    if (page.revision !== context.revision) throw new AgentError('skill_catalogue_changed');
    const entry = entries.find((entry) => entry.id === context.skillId);
    if (!entry?.enabled || !entry.version) throw new AgentError('skill_unavailable');
    if (entry.version !== context.skillVersion) throw new AgentError('skill_version_changed');
    const document = await source.readDocument({ id: entry.id, version: entry.version });
    if (Buffer.byteLength(document.body) > 1048576) throw new AgentError('skill_text_limit');
    return UserSkillDocumentSchema.parse({
      storeId: context.storeId,
      skillId: entry.id,
      skillVersion: document.version,
      revision: page.revision,
      body: document.body,
    });
  };
  function admit<T>(operation: () => Promise<T>) {
    if (sealed) return Promise.reject(new AgentError('knowledge_source_closed'));
    if (retainedPreparationFailures.size)
      return Promise.reject(retainedPreparationFailures.values().next().value);
    const task = operation().catch((error) => {
      if (isCleanupFailure(error)) retainedPreparationFailures.add(error);
      throw error;
    });
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  }
  return Object.freeze({
    list(context: SkillCatalogueContext) {
      return admit(() => list(context));
    },
    listUser(context: UserSkillCatalogueContext) {
      return admit(() => listUser(context));
    },
    readUserDocument(context: UserSkillDocumentContext) {
      return admit(() => readUserDocument(context));
    },
    dispose() {
      if (disposal) return disposal;
      sealed = true;
      disposal = Promise.allSettled([...pending]).then(async () => {
        const results = await Promise.allSettled([knowledgeScope.dispose()]);
        const failures = [
          ...new Set([
            ...results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
            ...retainedPreparationFailures,
          ]),
        ];
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1)
          throw new AggregateError(failures, 'Skill catalogue cleanup failed.', {
            cause: failures[0],
          });
      });
      void disposal.catch(() => {});
      return disposal;
    },
  });
}
