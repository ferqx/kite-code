import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentError, type AgentRuntime } from '@kite-ai/agent';
import {
  type JsonObject,
  readConfigurationFile,
  resolveConfiguration,
} from '@kite-ai/agent/config';
import type { ProfileSelection } from '@kite-ai/agent/profile';
import { validateWorkflowArguments } from '@kite-ai/agent/skill-workflow';
import type { z } from 'zod';
import {
  SkillCataloguePageSchema,
  type SkillCatalogueQuerySchema,
  skillUnavailableReasons,
} from './http/schema/skill-catalogue';
import type { PermissionManagementPort } from './permission-management';
import { inspectShellAssets } from './shell-configuration';
import { createConfiguredSkillSource } from './skill-source';
import {
  compileConfiguredWorkflows,
  type createWorkflowConfiguration,
  readSkillWorkflowFlags,
} from './skill-workflow-configuration';

type Query = z.infer<typeof SkillCatalogueQuerySchema>;
export type SkillCataloguePage = z.infer<typeof SkillCataloguePageSchema>;
export interface SkillCatalogueContext extends Query {
  runtime: AgentRuntime;
  permissions?: PermissionManagementPort;
  subjectId: string;
  workspaceId: string;
}
export interface SkillCatalogueSource {
  /** This source supplies the separately validated manual Workflow projection. */
  readonly supportsWorkflow?: true;
  list(context: SkillCatalogueContext): Promise<SkillCataloguePage>;
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
/** Reads configured knowledge only; never resolves a Model, credential or executor. */
export function createDefaultSkillCatalogueSource(options: {
  profile: ProfileSelection;
  explicit: () => JsonObject;
  allowedCapabilities?: readonly string[];
  workflowBindings?: (input: {
    workspaceRoot: string;
    effective: ReturnType<typeof resolveConfiguration>;
    toolIds: string[];
  }) => Promise<
    Pick<
      Parameters<typeof createWorkflowConfiguration>[0],
      'capabilities' | 'forkConfigurations' | 'shell'
    >
  >;
}): SkillCatalogueSource {
  const profile = Object.freeze({ ...options.profile });
  const explicit = options.explicit;
  const allowedCapabilities = [...(options.allowedCapabilities ?? [])];
  return Object.freeze({
    ...(options.workflowBindings ? { supportsWorkflow: true as const } : {}),
    async list(context: SkillCatalogueContext) {
      if (context.afterId && !context.revision)
        throw new AgentError('invalid_skill_catalogue_query');
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
        if (uri.protocol !== 'file:' || (uri.hostname && uri.hostname !== 'localhost'))
          throw Error();
        root = fileURLToPath(uri);
      } catch {
        return unavailableSkillCatalogue(context, 'workspace_configuration_unavailable');
      }
      let effective: ReturnType<typeof resolveConfiguration>;
      try {
        effective = resolveConfiguration({
          defaults: { modelId: null, models: [], tools: [], skills: [], mcp: [] },
          user: readConfigurationFile({
            path: join(profile.profilePath, 'config.jsonc'),
            windowsPathPolicy: 'private',
          }).value,
          workspace: readConfigurationFile({ path: join(root, 'kite-agent.jsonc') }).value,
          explicit: explicit(),
        });
      } catch {
        return unavailableSkillCatalogue(context, 'configuration_unavailable');
      }
      const toolIds =
        effective.tools?.filter((tool) => tool.enabled !== false).map((tool) => tool.id) ?? [];
      const source = createConfiguredSkillSource({
        workspaceRoot: root,
        profile,
        skills: effective.skills,
        toolIds,
        allowedCapabilities,
      });
      let listed: Awaited<ReturnType<typeof source.list>>;
      try {
        listed = await source.list();
      } catch {
        return unavailableSkillCatalogue(context, 'workspace_configuration_unavailable');
      }
      const entries: SkillCataloguePage['entries'] = listed.states.map((entry) => ({
        ...entry,
        reason:
          entry.reason &&
          !skillUnavailableReasons.includes(
            entry.reason as (typeof skillUnavailableReasons)[number],
          )
            ? ('skill_unavailable' as const)
            : (entry.reason as SkillCataloguePage['entries'][number]['reason']),
      }));
      let workflowFacts: unknown;
      if (context.workflow === 'manual' && options.workflowBindings) {
        const base = () => ({
          extensionId: 'builtin.skill-workflow' as const,
          definitionVersion: '1' as const,
          skillId: null,
          name: null,
          revision: null,
          state: 'unavailable' as 'available' | 'disabled' | 'unavailable',
          reason: 'skill_unavailable' as NonNullable<
            SkillCataloguePage['entries'][number]['workflow']
          >['reason'],
          manualAllowed: false,
          emptyInputValid: false,
          contextMode: null as 'inline' | 'fork' | null,
        });
        for (const row of entries) row.workflow = base();
        try {
          const flags = readSkillWorkflowFlags(profile);
          workflowFacts = { flags };
          if (!flags.skillActivation || !flags.skillWorkflow) {
            for (const row of entries)
              row.workflow = { ...base(), state: 'disabled', reason: 'workflow_disabled' };
          } else {
            const bindings = await options.workflowBindings({
              workspaceRoot: root,
              effective,
              toolIds,
            });
            const capabilities = new Map(
              bindings.capabilities.map((binding) => [
                binding.capability.capabilityId,
                binding.capability,
              ]),
            );
            const compiled = await compileConfiguredWorkflows({
              profile,
              source,
              listed,
              resolveCapability: (id) => capabilities.get(id),
            });
            let assets: Awaited<ReturnType<typeof inspectShellAssets>> | null = null;
            let verifierAvailable = false;
            if (
              flags.verification &&
              bindings.shell &&
              compiled.entries.some(
                (entry) =>
                  entry.descriptor.availability === 'available' &&
                  entry.contract?.verification.strategy === 'script',
              )
            ) {
              try {
                assets = await inspectShellAssets(bindings.shell);
                verifierAvailable = true;
              } catch {
                /* Local verifier unavailable; no process is entered. */
              }
            }
            workflowFacts = {
              flags,
              capabilities: bindings.capabilities,
              forkConfigurations: bindings.forkConfigurations,
              assets,
              entries: compiled.entries.map((entry) => ({
                revision: entry.descriptor.revision,
                sourceBinding: entry.sourceBinding,
                diagnostics: entry.diagnostics,
              })),
              failures: [...compiled.failures],
            };
            for (const row of entries) {
              if (!row.enabled) {
                row.workflow = { ...base(), state: 'disabled', reason: 'workflow_disabled' };
                continue;
              }
              if (compiled.failures.has(row.id)) {
                row.workflow = { ...base(), reason: 'workflow_source_changed' };
                continue;
              }
              const entry = compiled.byConfiguredId.get(row.id);
              if (!entry) continue;
              const contract = entry.contract;
              const projection = {
                ...base(),
                skillId: contract ? entry.descriptor.capabilityId : null,
                name: contract?.name ?? null,
                revision: entry.descriptor.revision,
                manualAllowed: contract?.invocation.allowManual ?? false,
                emptyInputValid: contract
                  ? !validateWorkflowArguments(contract.inputSchema, {})
                  : false,
                contextMode: contract?.context.mode ?? null,
              };
              if (entry.descriptor.availability !== 'available' || !contract)
                projection.reason = entry.diagnostics.some(
                  (d) => d.code === 'missing_capability' || d.code === 'dependency_changed',
                )
                  ? 'workflow_dependency_unavailable'
                  : 'workflow_contract_unavailable';
              else if (!projection.manualAllowed) projection.reason = 'workflow_manual_not_allowed';
              else if (!projection.emptyInputValid) projection.reason = 'workflow_input_required';
              else if (
                contract.context.mode === 'fork' &&
                !bindings.forkConfigurations.some((role) => role.agent === contract.context.agent)
              )
                projection.reason = 'workflow_fork_unavailable';
              else if (
                flags.verification &&
                contract.verification.strategy === 'script' &&
                !verifierAvailable
              )
                projection.reason = 'workflow_verifier_unavailable';
              else {
                projection.state = 'available';
                projection.reason = null;
              }
              row.workflow = projection;
            }
          }
        } catch {
          workflowFacts = { unavailable: true };
          for (const row of entries)
            row.workflow = {
              ...base(),
              state: row.enabled ? 'unavailable' : 'disabled',
              reason: row.enabled ? 'workflow_configuration_unavailable' : 'workflow_disabled',
            };
        }
      }
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
        ...(context.workflow === 'manual' ? { workflowFacts } : {}),
      });
      if (context.revision && context.revision !== revision)
        throw new AgentError('skill_catalogue_changed');
      if (context.afterId && !entries.some((entry) => entry.id === context.afterId))
        throw new AgentError('invalid_skill_catalogue_query');
      const pending = entries.filter((entry) => !context.afterId || entry.id > context.afterId);
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
      return SkillCataloguePageSchema.parse(page);
    },
  });
}
