import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AfterTurnPolicy,
  AgentError,
  type AgentRuntime,
  ConfigurationPreparationCleanupError,
  type ContextCompressor,
  type ContextSource,
  type RunConfiguration,
  type RuntimeOptions,
} from '@kite-ai/agent';
import { createAskUserExtension } from '@kite-ai/agent/ask-user';
import {
  ConfigurationError,
  type CredentialBackend,
  createConfigurationSnapshot,
  createCredentialVault,
  createOsCredentialBackend,
  type JsonObject,
  type McpRegistry,
  type NamedConfiguration,
  readConfigurationFile,
  resolveConfiguration,
} from '@kite-ai/agent/config';
import { defineExtension, type Extension, type Json } from '@kite-ai/agent/extensions';
import { createPathFileTools } from '@kite-ai/agent/files';
import {
  createMcpResourceModelSource,
  type McpLifecycleOptions,
  mcpResourceModelToolIds,
} from '@kite-ai/agent/mcp';
import {
  builtinCapability,
  type CapabilityDescription,
  type CapabilityIdentity,
  createDefaultAfterTurnPolicy,
  createPermissionPolicy,
  createPermissionReviewContextReader,
  createPlanningPermissionPolicy,
  hostReadOnlyTool,
  type PermissionPolicyOptions,
  type PermissionPolicySnapshot,
  requireFileRestoreApproval,
  requireWorkflowApproval,
  workflowCapabilityDescription,
} from '@kite-ai/agent/permissions';
import {
  createShellConfiguration,
  type ShellConfigurationOptions,
  shellToolIds,
} from '@kite-ai/agent/permissions/shell';
import { createPlanningValidation, type PlanningOptions } from '@kite-ai/agent/planning';
import type { ProfileSelection } from '@kite-ai/agent/profile';
import { KnowledgeReadCleanupError } from '@kite-ai/agent/sources';
import { sqliteStorageAssets } from '@kite-ai/agent/sqlite';
import { createDefaultTaskRequestClassifier } from '@kite-ai/agent/task';
import { webExtractorAssets } from '@kite-ai/agent/web-fetch';
import {
  createCompatibleModelBinding,
  createSdkModelAdapter,
  type ReasoningEffort,
} from '@kite-ai/ai/sdk';
import { createWorkspaceAssembly } from './assembly';
import type { ProcessHostConfiguration } from './bootstrap';
import {
  type ChildRole,
  createChildConfiguration,
  readSkillSelection,
  type SkillSelection,
} from './child-configuration';
import { createSummaryCompressor } from './compression-configuration';
import { defaultConfiguration, ordinaryHostConfigurationDefaults } from './configuration-defaults';
import { createConfigurationManagement } from './configuration-management';
import { createDefaultFileCheckpointConfiguration } from './file-checkpoint-configuration';
import { createDefaultHostStatusSource } from './host-status';
import { createMcpConfiguration } from './mcp-configuration';
import { createMcpManagement } from './mcp-management';
import {
  createMcpSourceConfiguration,
  type McpSourceConfigurationOptions,
} from './mcp-source-configuration';
import { parseModelPreset } from './model-options';
import { isSupportedModelProvider, modelProtocol } from './model-providers';
import { createPermissionManagement, type PermissionManagementPort } from './permission-management';
import {
  planningSnapshotDigest,
  readBoundJobReportParent,
  readBusinessRunInputs,
  readPlanningIntent,
  readPlanningPermissionState,
} from './planning-configuration';
import { createDefaultSkillCatalogueSource } from './skill-catalogue';
import {
  assertWorkflowForkCurrent,
  composeRequirementInitializers,
  createWorkflowConfiguration,
  readSkillWorkflowFlags,
  type WorkflowUserDecisions,
  workflowForkFence,
  workflowSnapshotDigest,
  workflowToolIds,
} from './skill-workflow-configuration';
import { createTaskConfiguration, defaultTaskRoles } from './task-configuration';
import { createUserConfiguration, withoutProjectModels } from './user-configuration';
import {
  createWebFetchConfiguration,
  type WebFetchConfigurationOptions,
} from './web-fetch-configuration';

export type { ShellConfigurationOptions } from '@kite-ai/agent/permissions/shell';
export type { ChildRole } from './child-configuration';
export type { SummaryCompressionOptions } from './compression-configuration';
export { createSummaryCompressor } from './compression-configuration';
export type {
  ConfigurationManagementPort,
  ConfigurationRead,
  ManagementMutation,
} from './configuration-management';
export { createMcpManagement } from './mcp-management';
export { parseModelPreset } from './model-options';
export type {
  ModeState,
  PermissionManagementPort,
  PermissionMutation,
  TrustState,
} from './permission-management';
export { createUserConfiguration } from './user-configuration';
export { userConfigurationPath } from './user-configuration-path';
export type { WebFetchConfigurationOptions } from './web-fetch-configuration';

const assemblyKeys = ['modelId', 'models', 'tools', 'skills', 'mcp'];
function assertSelectedToolVersions(
  toolIds: readonly string[],
  configurations: readonly NamedConfiguration[] | undefined,
  registrations: readonly Iterable<{ readonly id: string; readonly version: string }>[],
) {
  const tools = registrations.flatMap((definitions) => [...definitions]);
  for (const selected of configurations ?? []) {
    if (!toolIds.includes(selected.id)) continue;
    if (
      workflowToolIds.includes(selected.id) &&
      selected.definitionVersion !== undefined &&
      selected.definitionVersion !== '1'
    )
      throw new AgentError('tool_definition_version_unavailable');
    const actual = tools.find((tool) => tool.id === selected.id);
    if (
      actual &&
      selected.definitionVersion !== undefined &&
      selected.definitionVersion !== actual.version
    )
      throw new AgentError('tool_definition_version_unavailable');
  }
}
function explicitConfiguration(value: Json | undefined): JsonObject {
  if (value === undefined) return {};
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== 'configuration')
  )
    throw new ConfigurationError('invalid_host_configuration');
  const configuration = value.configuration ?? {};
  if (
    !configuration ||
    typeof configuration !== 'object' ||
    Array.isArray(configuration) ||
    Object.keys(configuration).some((key) => !assemblyKeys.includes(key))
  )
    throw new ConfigurationError('invalid_host_configuration');
  return structuredClone(configuration);
}
function commandSkills(value: Json): readonly string[] | undefined {
  const selection =
    value && typeof value === 'object' && !Array.isArray(value) ? value.selectedSkills : undefined;
  if (selection === undefined) return undefined;
  if (
    !Array.isArray(selection) ||
    selection.length > 256 ||
    selection.some((item) => typeof item !== 'string' || !item.length || item.length > 128)
  )
    throw new AgentError('invalid_skill_selection');
  return Object.freeze([...(selection as string[])]);
}
export type McpHostFactory = (host: {
  readonly profile: ProfileSelection;
  readonly credentialVault: ReturnType<typeof createCredentialVault>;
}) => McpLifecycleOptions;
/** New scoped configuration only; reading/binding happens per new Run, never during startup. */
export function createDefaultProcessConfiguration(options: {
  /** Same immutable identity as the actual HTTP Service; absent denies history queries. */
  observerSubjectId?: string;
  profile: ProfileSelection;
  /** Explicit owned configuration file for embedded hosts and tests; formal clients use the user directory. */
  userConfigurationPath?: string;
  /** Verified host runtime closure deny paths; never supplied by JSONC, Model or public API. */
  runtimeAssets?: readonly string[];
  hostConfiguration?: Json;
  /** Trusted packaged clients select everyday tools; embedded hosts keep explicit selection. */
  ordinaryHostTools?: true;
  credentialBackend?: CredentialBackend;
  /** Trusted host policy; configuration files cannot supply permissions or capability grants. */
  permissions?: RuntimeOptions['permissions'];
  /** Optional trusted reviewer override, also available to runless Actions. JSONC cannot supply it. */
  authorizationReview?: RuntimeOptions['authorizationReview'];
  /** Programmatic current host policy only; JSONC never grants execution authority. */
  permissionPolicy?: Pick<PermissionPolicyOptions, 'readPolicy'>;
  /** Trusted host business constraints; JSONC selects tools, never these permission/requirement options. */
  planning?: PlanningOptions;
  /** Trusted Workflow user decision policy; never selected by JSONC or Skill text. */
  skillWorkflow?: { readonly userDecisions?: WorkflowUserDecisions };
  /** Trusted server/transport admission only; JSONC selects allowlisted IDs. */
  mcp?: McpLifecycleOptions | McpHostFactory;
  /** Trusted source transport assets and network policy; raw JSON never supplies these ports. */
  mcpSources?: Pick<McpSourceConfigurationOptions, 'variables' | 'http' | 'stdio' | 'oauth'>;
  /** Trusted finite child roles, never supplied by JSONC. */
  child?: readonly ChildRole[];
  /** Trusted explicit continuation authority. JSONC never registers an authorizer or enables it. */
  afterTurn?: AfterTurnPolicy;
  /** Trusted pure single compression slot. JSONC cannot provide callbacks or automatic authority. */
  compressor?: ContextCompressor;
  /** Explicit qualified host Shell assets/environment; JSONC cannot provide these. */
  shell?: ShellConfigurationOptions;
  /** Trusted per-hop network policy/admission; JSONC can only select the ordinary Tool. */
  webFetch?: WebFetchConfigurationOptions;
  knownToolIds?: readonly string[];
  allowedToolCapabilities?: readonly string[];
}): ProcessHostConfiguration {
  const userConfiguration = createUserConfiguration(options.userConfigurationPath);
  const externalPermissionAuthority =
    options.permissions !== undefined || options.permissionPolicy !== undefined;
  const configurationDefaults = options.ordinaryHostTools
    ? ordinaryHostConfigurationDefaults(options.shell !== undefined)
    : defaultConfiguration;
  const explicit = structuredClone(options.hostConfiguration);
  explicitConfiguration(explicit);
  const planningOptions = structuredClone({ completionGuidance: true, ...options.planning });
  const workflowUserDecisions: WorkflowUserDecisions = Object.freeze(
    structuredClone(
      options.skillWorkflow?.userDecisions ?? {
        version: '1' as const,
        allowWaiver: true,
        allowReplan: true,
        allowCompensation: true,
      },
    ),
  );
  const childRoles = structuredClone(options.child ?? defaultTaskRoles);
  const describeDefaultTask = createDefaultTaskRequestClassifier(options.child ? [] : childRoles);
  let shellOptions = options.shell ? structuredClone(options.shell) : undefined;
  if (shellOptions?.host)
    shellOptions = {
      ...shellOptions,
      host: {
        ...shellOptions.host,
        protectedRoots: [
          ...new Set([...shellOptions.host.protectedRoots, dirname(userConfiguration.path)]),
        ],
      },
    };
  const afterTurn = options.afterTurn
    ? Object.freeze({ authorize: options.afterTurn.authorize.bind(options.afterTurn) })
    : createDefaultAfterTurnPolicy({
        roles: childRoles,
        async readCurrent(input) {
          input.signal.throwIfAborted();
          if (options.permissions && !options.permissionPolicy)
            return { workspaceTrust: false, revision: 'after-turn-current-policy-unavailable-1' };
          const request = {
            kind: 'tool' as const,
            sessionId: input.session.id,
            runId: input.run.id,
            executionId: input.execution.id,
            definitionId: input.execution.definitionId,
            definitionVersion: input.execution.definitionVersion,
            input: input.execution.input,
            signal: input.signal,
          };
          const current = options.permissionPolicy
            ? await options.permissionPolicy.readPolicy(request)
            : await persistedPolicy(request, [], {
                sessionId: input.session.id,
                expectedStoreId: input.run.originStoreId,
                subjectId: input.command.subjectId,
              });
          input.signal.throwIfAborted();
          return {
            workspaceTrust: current.workspaceTrust,
            revision: createHash('sha256')
              .update(
                JSON.stringify({
                  mode: current.mode,
                  trust: current.workspaceTrust,
                  revision: current.revision,
                  allowed: current.allowed,
                  controlReads: current.controlReads ?? null,
                }),
              )
              .digest('hex'),
            controlReads: current.controlReads,
          };
        },
      });
  const selectedCompressor = options.compressor;
  const compressor: ContextCompressor | undefined =
    selectedCompressor &&
    Object.freeze({
      id: selectedCompressor.id,
      version: selectedCompressor.version,
      prepare: selectedCompressor.prepare.bind(selectedCompressor),
      ...(selectedCompressor.shouldCompress
        ? { shouldCompress: selectedCompressor.shouldCompress.bind(selectedCompressor) }
        : {}),
      ...(selectedCompressor.validateSummary
        ? { validateSummary: selectedCompressor.validateSummary.bind(selectedCompressor) }
        : {}),
      ...(selectedCompressor.validateExpanded
        ? { validateExpanded: selectedCompressor.validateExpanded.bind(selectedCompressor) }
        : {}),
    });
  const task = createTaskConfiguration(
    childRoles,
    afterTurn ? { afterTurn: { enabled: true } } : {},
  );
  const planning = createPlanningValidation(planningOptions);
  const askUser = createAskUserExtension();
  const askUserTools = new Map((askUser.tools ?? []).map((tool) => [tool.id, tool]));
  const vault = createCredentialVault({
    backend:
      options.credentialBackend ??
      createOsCredentialBackend({
        service: 'kite-agent',
        accountNamespace: `profile-${options.profile.profileAccessKey}`,
      }),
  });
  const userModelVault = options.credentialBackend
    ? vault
    : createCredentialVault({
        backend: createOsCredentialBackend({
          service: 'kite-agent',
          accountNamespace: 'user-models',
        }),
      });
  const modelVault: typeof vault = {
    ...userModelVault,
    async resolve(reference) {
      return (
        userConfiguration.resolveCredential(
          typeof reference === 'string' ? reference : reference.id,
        ) ?? (await userModelVault.resolve(reference))
      );
    },
  };
  const mcpOptions =
    typeof options.mcp === 'function'
      ? options.mcp({ profile: Object.freeze({ ...options.profile }), credentialVault: vault })
      : options.mcp;
  let policyRuntime: AgentRuntime | undefined;
  const runtimeAssets = () => {
    const storage = sqliteStorageAssets();
    const extractor = webExtractorAssets();
    return [
      dirname(userConfiguration.path),
      process.execPath,
      fileURLToPath(import.meta.url),
      fileURLToPath(storage.module),
      fileURLToPath(storage.worker),
      ...storage.migrations.map((migration) => fileURLToPath(migration)),
      fileURLToPath(storage.preload),
      ...storage.observerModules.map((module) => fileURLToPath(module)),
      ...(options.shell
        ? [options.shell.supervisorPath, options.shell.bunExecutable, options.shell.shellExecutable]
        : []),
      ...(options.mcpSources?.stdio
        ? [options.mcpSources.stdio.guardianPath, options.mcpSources.stdio.bunExecutable]
        : []),
      ...(options.webFetch?.extractor ? [] : [extractor.worker, extractor.checksum]),
      ...(options.runtimeAssets ?? []),
    ];
  };
  const pathFiles = createPathFileTools({
    qualifiedPlatforms: ['darwin', 'linux', 'win32'],
    protectedRoots: [
      options.profile.dataRoot,
      options.profile.coordinationPath,
      ...runtimeAssets(),
    ],
  });
  const pathFilesExtension: Extension = defineExtension({
    id: 'builtin.files.path',
    version: '1',
    apiMajor: 1,
    tools: pathFiles.tools,
  });
  const files = createDefaultFileCheckpointConfiguration({
    profile: options.profile,
    runtimeAssets,
    runtime: () => {
      if (!policyRuntime) throw new AgentError('execution_scope_unavailable');
      return policyRuntime;
    },
  });
  const fileTools = new Map(files.tools.map((tool) => [tool.id, tool]));
  const builtinExtensions = [
    askUser,
    planning.extension,
    files.extension,
    pathFilesExtension,
    ...(task.extension ? [task.extension] : []),
  ];
  const sourceOptions = options.mcpSources;
  let oauthSerialLocks: NonNullable<RuntimeOptions['workspaceSerialLocks']> | undefined;
  const mcpSources = createMcpSourceConfiguration({
    ...(options.observerSubjectId === undefined
      ? {}
      : { observerSubjectId: options.observerSubjectId }),
    profile: options.profile,
    runtime: () => {
      if (!policyRuntime) throw new AgentError('execution_scope_unavailable');
      return policyRuntime;
    },
    credentialVault: vault,
    ...(sourceOptions?.variables ? { variables: sourceOptions.variables.bind(sourceOptions) } : {}),
    ...(sourceOptions?.http ? { http: sourceOptions.http } : {}),
    ...(sourceOptions?.stdio ? { stdio: sourceOptions.stdio } : {}),
    oauth: { ...sourceOptions?.oauth, serialLocks: () => oauthSerialLocks },
    programmaticServerIds: (mcpOptions?.servers ?? []).map((server) => server.id),
    selection: (_scope, workspaceRoot) => {
      const user = userConfiguration.read().value;
      const workspace = readConfigurationFile({
        path: join(workspaceRoot, 'kite-agent.jsonc'),
      }).value;
      const current = explicitConfiguration(explicit);
      return {
        present: [user, workspace, current].some((layer) => Object.hasOwn(layer, 'mcp')),
        configurations:
          resolveConfiguration({
            defaults: configurationDefaults,
            user,
            workspace: withoutProjectModels(workspace),
            explicit: current,
          }).mcp ?? [],
      };
    },
  });
  if (mcpOptions?.scopedSources) throw new AgentError('mcp_source_host_conflict');
  const mcp = createMcpConfiguration({
    ...(mcpOptions ?? { servers: [] }),
    scopedSources: mcpSources.sourcePort,
  });
  const registeredMcp = (mcpOptions?.servers ?? []).map((server) => {
    const connection = mcp
      .listCapabilities()
      .find(
        (capability) =>
          capability.kind === 'job' && capability.definitionId === `mcp.connection.${server.id}`,
      );
    if (!connection) throw new AgentError('mcp_server_unavailable');
    return {
      id: server.id,
      configDigest: connection.definitionVersion,
      transport: server.transport.type,
      source: {
        kind: 'programmatic' as const,
        id: `host:${server.id}`,
        revision: connection.definitionVersion,
      },
      admitted: !!mcpOptions?.transportPort,
    };
  });
  const mcpRegistry: McpRegistry = {
    revision: createHash('sha256').update(JSON.stringify(registeredMcp)).digest('hex'),
    servers: registeredMcp,
  };
  const web = createWebFetchConfiguration(
    options.webFetch ?? {
      network: {
        policy: { mode: 'public' },
        admitHop: async () => ({ allowed: true, revision: 'default-public-network-1' }),
      },
    },
  );
  const webTools = new Map((web.extension.tools ?? []).map((tool) => [tool.id, tool]));
  const mcpManagement = createMcpManagement({
    userConfigurationPath: userConfiguration.path,
    runtime: () => {
      if (!policyRuntime) throw new AgentError('execution_scope_unavailable');
      return policyRuntime;
    },
    profile: options.profile,
    explicit: () => explicitConfiguration(explicit),
    registry: (scope) => {
      const sources = mcpSources.registry(scope);
      const servers = [
        ...mcpRegistry.servers,
        ...sources.servers.filter(
          (source) => !mcpRegistry.servers.some((server) => server.id === source.id),
        ),
      ];
      return {
        revision: createHash('sha256')
          .update(
            JSON.stringify({ static: mcpRegistry.revision, sources: sources.revision, servers }),
          )
          .digest('hex'),
        servers,
      };
    },
  });
  let managed: PermissionManagementPort | undefined;
  const permissionManagement = (runtime?: AgentRuntime) => {
    if (policyRuntime && runtime !== policyRuntime)
      throw new AgentError('permission_host_already_bound');
    policyRuntime = runtime;
    managed = createPermissionManagement({
      runtime,
      profile: options.profile,
      writable: !externalPermissionAuthority,
      nativeShellRead: shellOptions?.platform === 'darwin' && process.platform === 'darwin',
    });
    return managed;
  };
  async function persistedPolicy(
    request: Parameters<NonNullable<RuntimeOptions['permissions']>['authorize']>[0],
    allowed: readonly CapabilityIdentity[],
    original?: { sessionId: string; expectedStoreId: string; subjectId: string },
  ): Promise<PermissionPolicySnapshot> {
    if (!policyRuntime || !managed)
      return { mode: 'auto', workspaceTrust: false, revision: 'unbound-auto-untrusted-1', allowed };
    if (!original) {
      const execution = await policyRuntime.getExecution(request.executionId);
      if (!execution || execution.sessionId !== request.sessionId)
        throw new AgentError('execution_scope_unavailable');
      const command = await policyRuntime.getCommand(execution.originCommandId);
      if (!command || command.originStoreId !== execution.originStoreId)
        throw new AgentError('execution_scope_unavailable');
      original = {
        sessionId: execution.sessionId,
        expectedStoreId: execution.originStoreId,
        subjectId: command.subjectId,
      };
    }
    const selected = await policyRuntime.getSession(original.sessionId);
    if (!selected) throw new AgentError('session_not_found');
    const [mode, trust] = await Promise.all([
      managed.readMode(original),
      managed.readTrust({
        expectedStoreId: original.expectedStoreId,
        subjectId: original.subjectId,
        workspaceId: selected.workspaceId,
      }),
    ]);
    return {
      mode: mode.mode,
      workspaceTrust: trust.trusted,
      controlReads: [
        {
          kind: 'permission.mode',
          scope: `session:${mode.scopeSessionId}`,
          revision: mode.revision,
        },
        { kind: 'permission.mode', scope: 'user', revision: mode.defaultRevision },
        {
          kind: 'workspace.trust',
          scope: `workspace:${selected.workspaceId}`,
          revision: trust.revision,
        },
      ],
      revision: createHash('sha256')
        .update(
          JSON.stringify({
            scope: mode.scopeSessionId,
            modeRevision: mode.revision,
            defaultRevision: mode.defaultRevision,
            trustRevision: trust.revision,
            canonicalIdentity: trust.canonicalIdentity,
            externalReadScopeDigest: trust.externalReadScopeDigest,
            trust: trust.status,
          }),
        )
        .digest('hex'),
      allowed,
    };
  }
  const businessTools = new Map((planning.extension.tools ?? []).map((tool) => [tool.id, tool]));
  const globalCapabilities = new Map<string, CapabilityDescription>();
  for (const extension of [planning.extension, files.extension])
    for (const action of extension.actions ?? []) {
      const definitionId = `${extension.id}/${action.id}`;
      const capability = builtinCapability(
        extension.id,
        action.id,
        'action',
        planning.extension.id,
        action.version,
      );
      globalCapabilities.set(JSON.stringify(['job', definitionId, action.version]), {
        kind: 'job',
        definitionId,
        definitionVersion: action.version,
        revision: `${extension.id}:${extension.version}:${action.version}`,
        effects: capability.effects,
        hardAllowed: true,
        safeRead: capability.safeRead,
      });
    }
  const globalDefaultPolicy = createPermissionPolicy({
    readPolicy:
      options.permissionPolicy?.readPolicy ??
      ((request) =>
        persistedPolicy(
          request,
          [
            ...globalCapabilities.values(),
            ...mcp.listCapabilities(),
            ...mcpManagement.listCapabilities(),
            ...mcpSources.listCapabilities(),
          ].map(({ kind, definitionId, definitionVersion }) => ({
            kind,
            definitionId,
            definitionVersion,
          })),
        )),
    describeCapability: (request) =>
      globalCapabilities.get(
        JSON.stringify([request.kind, request.definitionId, request.definitionVersion]),
      ) ??
      mcp.describe(request) ??
      mcpSources.describe(request) ??
      mcpManagement.describe(request),
  });
  type ResolveInput = Parameters<NonNullable<RuntimeOptions['resolveRunConfiguration']>>[0];
  const resolveConfigurationBinding = async (
    { command, session, workspace }: ResolveInput,
    selection?: {
      modelId: string;
      toolIds?: readonly string[];
      skillSelection?: SkillSelection;
      workflowFence?: Awaited<ReturnType<typeof workflowForkFence>>;
      workflowCarrier?: {
        parentExecutionId: string;
        sessionId: string;
        roleId: string;
        roleVersion: string;
      };
      mcpParent?: Parameters<typeof mcpSources.deriveChildSelection>[0];
      parentTools?: Parameters<
        NonNullable<RuntimeOptions['resolveChildRunConfiguration']>
      >[0]['parentTools'];
      inheritDynamicMcp?: boolean;
    },
    recovery?: {
      digest: string;
      signal: AbortSignal;
      workflowSnapshot: Json;
      planningSnapshot: Json;
      mcpSourceSnapshot: Json;
      runIdentity: { runId: string; sessionId: string };
    },
  ) => {
    try {
      recovery?.signal.throwIfAborted();
      const businessInputs = readBusinessRunInputs(command.request);
      const planningIntent = recovery
        ? readPlanningIntent(recovery.planningSnapshot)
        : selection
          ? null
          : businessInputs.planning;
      const requirePlan = planningOptions.requirePlan === true || planningIntent !== null;
      const skillSelection = selection
        ? (selection.skillSelection?.requested ?? undefined)
        : commandSkills(command.request);
      const workflowFlags = readSkillWorkflowFlags(options.profile);
      const user = userConfiguration.read().value;
      let root: string;
      try {
        const uri = new URL(workspace.rootUri);
        if (uri.protocol !== 'file:' || (uri.hostname && uri.hostname !== 'localhost'))
          throw new Error();
        root = fileURLToPath(uri);
      } catch {
        throw new ConfigurationError('workspace_configuration_unavailable');
      }
      const project = readConfigurationFile({ path: join(root, 'kite-agent.jsonc') }).value;
      const current = explicitConfiguration(explicit);
      const request = command.request as { modelId?: string; reasoningEffort?: ReasoningEffort };
      if (selection) current.modelId = selection.modelId;
      else if (request.modelId !== undefined) current.modelId = request.modelId;
      const effective = resolveConfiguration({
        defaults: configurationDefaults,
        user,
        workspace: withoutProjectModels(project),
        explicit: current,
      });
      const selected = effective.models?.find((model) => model.id === effective.modelId);
      if (!selected || selected.enabled === false)
        throw new ConfigurationError('model_unavailable');
      if (!isSupportedModelProvider(selected.provider))
        throw new ConfigurationError('model_provider_unsupported');
      if (!selected.baseURL || !selected.model)
        throw new ConfigurationError('invalid_model_configuration');
      // A root command owns its temporary effort. Apply it before snapshot sealing;
      // a child selection uses its configured preset, while recovery reproduces
      // the original root request rather than inheriting the current default.
      if ((!selection || recovery) && request.reasoningEffort !== undefined) {
        selected.options = { ...selected.options, reasoningEffort: request.reasoningEffort };
      }
      const actualOptions = parseModelPreset(selected.options);
      // Preserve the non-Skill credential/shape preflight before constructing any
      // adapters. Skill rows are validated locally by discovery, then the exact
      // selected subset is included in the final immutable snapshot below.
      createConfigurationSnapshot({ ...effective, skills: [] });
      const toolIds =
        effective.tools?.filter((tool) => tool.enabled !== false).map((tool) => tool.id) ?? [];
      if (selection?.toolIds) {
        const parentTools = selection.parentTools ?? [];
        assertSelectedToolVersions(selection.toolIds, effective.tools, [parentTools]);
        const inheritedDynamic = (id: string) =>
          selection.inheritDynamicMcp === true &&
          !effective.tools?.some((tool) => tool.id === id && tool.enabled === false) &&
          parentTools.some(
            (tool) =>
              tool.id === id &&
              ((tool.extensionId?.startsWith('builtin.mcp.remote.') &&
                tool.extensionId.length > 'builtin.mcp.remote.'.length) ||
                (tool.extensionId === 'builtin.mcp.discovery' &&
                  tool.id === 'mcp.tools.search' &&
                  tool.version === '1')),
          );
        const inheritedBuiltin = (id: string) => {
          const sourceExtension =
            id === 'mcp.sources.list'
              ? mcpSources.extension.id === 'builtin.mcp.sources' &&
                mcpSources.extension.version === '1'
                ? mcpSources.extension
                : undefined
              : ['mcp.connect', ...mcpResourceModelToolIds].includes(id)
                ? mcp.extension?.id === 'builtin.mcp' && mcp.extension.version === '1'
                  ? mcp.extension
                  : undefined
                : undefined;
          const definition =
            businessTools.get(id) ??
            sourceExtension?.tools?.find((tool) => tool.id === id && tool.version === '1');
          const owner = businessTools.has(id) ? planning.extension.id : sourceExtension?.id;
          return (
            definition !== undefined &&
            !effective.tools?.some((tool) => tool.id === id && tool.enabled === false) &&
            parentTools.some(
              (tool) =>
                tool &&
                typeof tool === 'object' &&
                !Array.isArray(tool) &&
                tool.id === id &&
                tool.version === definition.version &&
                tool.extensionId === owner,
            )
          );
        };
        if (
          selection.toolIds.some(
            (id) => !toolIds.includes(id) && !inheritedBuiltin(id) && !inheritedDynamic(id),
          )
        )
          throw new AgentError('child_tool_unavailable');
        toolIds.splice(
          0,
          toolIds.length,
          ...selection.toolIds.filter((id) => !inheritedDynamic(id)),
        );
      }
      // Root recovery also carries a persisted Model/Skill selection. Only a new child
      // binding suppresses the root human question capability.
      if (selection && !recovery) {
        const index = toolIds.indexOf('ask_user');
        if (index >= 0) toolIds.splice(index, 1);
      }
      if (planningIntent) {
        for (const id of [
          'planning.read',
          'planning.write',
          'planning.review',
          'planning.update',
        ]) {
          if (effective.tools?.some((tool) => tool.id === id && tool.enabled === false))
            throw new AgentError('planning_tool_unavailable');
          if (!toolIds.includes(id)) toolIds.push(id);
        }
      }
      task.validateSelection(toolIds);
      const sourceSelection = {
        present: [user, project, current].some((layer) => Object.hasOwn(layer, 'mcp')),
        configurations: effective.mcp ?? [],
        toolIds,
      };
      const selectedSources = policyRuntime
        ? selection?.mcpParent
          ? await mcpSources.deriveChildSelection(selection.mcpParent, sourceSelection)
          : mcpSources.select(
              await mcpSources.capture({ command, session, workspace }),
              sourceSelection,
            )
        : mcpSources.unboundSelection({ command, session, workspace }, sourceSelection);
      if (selectedSources.servers.length) {
        for (const id of [selectedSources.directoryToolId, 'mcp.connect'])
          if (!toolIds.includes(id) && (!selection?.toolIds || selection.toolIds.includes(id)))
            toolIds.push(id);
      }
      const selectedMcp = mcp.select(
        effective.mcp?.filter(
          (server) =>
            mcpRegistry.servers.some((registered) => registered.id === server.id) ||
            !/^mcp-[a-f0-9]{64}$/.test(server.id),
        ),
        toolIds,
        selectedSources.servers,
      );
      const shell = await createShellConfiguration({
        workspaceRoot: root,
        toolIds,
        options: shellOptions,
      });
      const shellTools = new Map(
        shell.extensions.flatMap((extension) =>
          (extension.tools ?? []).map((tool) => [tool.id, tool] as const),
        ),
      );
      assertSelectedToolVersions(toolIds, effective.tools, [
        askUserTools.values(),
        businessTools.values(),
        fileTools.values(),
        pathFiles.tools,
        task.tools.values(),
        shellTools.values(),
        webTools.values(),
        mcp.tools.values(),
      ]);
      const assembly = await createWorkspaceAssembly({
        workspaceRoot: root,
        profile: options.profile,
        externallyRegisteredFileTools: files.tools,
        externallyRegisteredExtensions: [askUser, pathFilesExtension],
        toolIds,
        toolConfigurations: effective.tools,
        skills: effective.skills,
        selectedSkills: skillSelection,
        inheritedSkillIds: selection?.skillSelection?.resolvedIds,
        knownToolIds: [
          ...(options.knownToolIds ?? []),
          ...businessTools.keys(),
          ...task.tools.keys(),
          ...shellToolIds,
          ...web.toolIds,
          ...mcp.tools.keys(),
          selectedSources.directoryToolId,
          ...(workflowFlags.skillActivation && workflowFlags.skillWorkflow ? workflowToolIds : []),
        ],
        allowedCapabilities: options.allowedToolCapabilities,
      });
      let webBinding: ReturnType<typeof web.bind> | undefined;
      let disposal: Promise<void> | undefined;
      const dispose = () =>
        (disposal ??= Promise.allSettled([
          Promise.resolve().then(() => assembly.dispose()),
          Promise.resolve().then(() => webBinding?.dispose()),
        ]).then((results) => {
          const failures = results.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : [],
          );
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1)
            throw new AggregateError(failures, 'Run configuration cleanup failed.', {
              cause: failures[0],
            });
        }));
      try {
        assembly.extensions.push(...shell.extensions);
        if (toolIds.some((id) => webTools.has(id))) {
          webBinding = web.bind();
          assembly.extensions.push(webBinding.extension);
        }
        const workflowCapabilities = workflowCapabilitiesFor(assembly);
        const workflow = await createWorkflowConfiguration({
          knowledgeScope: assembly.knowledgeScope,
          profile: options.profile,
          workspaceRoot: root,
          skills: effective.skills ?? [],
          toolIds: assembly.toolIds,
          allowedCapabilities: options.allowedToolCapabilities,
          flags: workflowFlags,
          userDecisions: workflowUserDecisions,
          shell: shellOptions,
          request: businessInputs.workflowRequest,
          capabilities: workflowCapabilities,
          forkConfigurations: childRoles.map((role) => ({
            agent: role.id,
            configurationId: role.id,
            definitionVersion: role.version,
          })),
        });
        if (workflow.enabled) {
          assembly.extensions.push(workflow.extension);
          if (workflow.verifierExtension) assembly.extensions.push(workflow.verifierExtension);
          if (workflow.compensatorExtension)
            assembly.extensions.push(workflow.compensatorExtension);
          assembly.toolIds.push(
            ...workflowToolIds.filter(
              (id) =>
                !assembly.toolIds.includes(id) &&
                (!selection?.workflowFence ||
                  selection.workflowFence.capabilities.some(
                    (binding) =>
                      binding.kind === 'tool' &&
                      binding.definitionId === id &&
                      binding.definitionVersion === '1',
                  )),
            ),
          );
        }
        // The original selection and parent fence narrow the catalogue before credential reads.
        const snapshot = createConfigurationSnapshot({
          ...effective,
          skills: assembly.skillConfigurations,
        });
        let mcpResourceSource: ContextSource | null = null;
        const runExtensions = [...builtinExtensions, ...assembly.extensions];
        const readOnlyDefinitions = [...runExtensions, mcpSources.extension].flatMap((extension) =>
          (extension.tools ?? [])
            .filter(
              (tool) =>
                assembly.toolIds.includes(tool.id) && hostReadOnlyTool(extension.id, tool.id),
            )
            .map((tool) => ({
              kind: 'tool' as const,
              definitionId: tool.id,
              definitionVersion: tool.version,
            })),
        );
        const planningBinding = {
          version: '1',
          intent: planningIntent,
          requirePlan,
          readOnlyDefinitions,
          policy: {
            automaticValidation: planningOptions.automaticValidation ?? null,
            requiredValidation: planningOptions.requiredValidation === true,
            completionGuidance: planningOptions.completionGuidance === true,
            allowWaiver: planningOptions.allowWaiver === true,
            requiredReceiptDefinitions: planningOptions.requiredReceiptDefinitions ?? [],
            fileHashChecker: planningOptions.fileHashChecker ?? null,
            commandChecker: planningOptions.commandChecker ?? null,
            mcpCheckers: planningOptions.mcpCheckers ?? [],
            allowedExecutionModes: planningOptions.allowedExecutionModes ?? [
              'auto',
              'accept_edits',
            ],
          },
          tools: runExtensions.flatMap((extension) =>
            (extension.tools ?? [])
              .filter((tool) => assembly.toolIds.includes(tool.id))
              .map((tool) => ({
                extensionId: extension.id,
                extensionVersion: extension.version,
                definitionId: tool.id,
                definitionVersion: tool.version,
              })),
          ),
        };
        // Reopening a binding is explicit and must reproduce the original supported
        // configuration before credentials are read. Core also verifies its complete
        // tool/extension/reviewer manifest before publishing any continuation.
        recovery?.signal.throwIfAborted();
        if (
          recovery &&
          (snapshot.digest !== recovery.digest ||
            workflowSnapshotDigest(workflow.snapshot as unknown as Json) !==
              workflowSnapshotDigest(recovery.workflowSnapshot) ||
            !recovery.planningSnapshot ||
            typeof recovery.planningSnapshot !== 'object' ||
            Array.isArray(recovery.planningSnapshot) ||
            planningSnapshotDigest(planningBinding as unknown as Json) !==
              planningSnapshotDigest(recovery.planningSnapshot.binding ?? null) ||
            planningSnapshotDigest(selectedSources.snapshot as unknown as Json) !==
              planningSnapshotDigest(recovery.mcpSourceSnapshot))
        )
          throw new AgentError('recovery_configuration_changed');
        const apiKey =
          selected.credentialRef === undefined
            ? undefined
            : await modelVault.resolve(selected.credentialRef);
        const binding = createCompatibleModelBinding({
          name: selected.provider,
          protocol: modelProtocol(selected.provider, selected.protocol),
          baseURL: selected.baseURL,
          modelId: selected.model,
          apiKey,
        });
        const model = createSdkModelAdapter({
          models: new Map([[selected.id, binding]]),
          presets: new Map([[selected.id, actualOptions]]),
        });
        const authorizationReview = options.authorizationReview ?? {
          id: 'builtin.auto',
          version: createHash('sha256')
            .update(
              JSON.stringify({
                provider: selected.provider,
                id: selected.id,
                model: selected.model,
                baseURL: selected.baseURL,
                credentialRef: selected.credentialRef ?? null,
                options: actualOptions,
              }),
            )
            .digest('hex'),
          modelId: selected.id,
          model,
        };
        const actual = new Map<string, CapabilityDescription>();
        const key = (kind: string, id: string, version: string) =>
          JSON.stringify([kind, id, version]);
        const modelDescription: CapabilityDescription = {
          kind: 'model',
          definitionId: selected.id,
          definitionVersion: '1',
          revision: 'compatible-model-1',
          effects: ['network'],
          hardAllowed: true,
          safeRead: false,
        };
        actual.set(key('model', selected.id, '1'), modelDescription);
        // Trusted roles can name Model capabilities only. This adds no Tool/Job authority.
        for (const role of childRoles) {
          actual.set(key('job', `agent/${role.id}`, role.version), {
            kind: 'job',
            definitionId: `agent/${role.id}`,
            definitionVersion: role.version,
            revision: `trusted-child:${role.id}:${role.version}`,
            effects: ['unknown'],
            hardAllowed: true,
            safeRead: false,
          });
          const candidate = effective.models?.find((entry) => entry.id === role.modelId);
          if (
            candidate &&
            candidate.enabled !== false &&
            isSupportedModelProvider(candidate.provider) &&
            candidate.baseURL &&
            candidate.model
          )
            actual.set(key('model', candidate.id, '1'), {
              ...modelDescription,
              definitionId: candidate.id,
            });
        }
        for (const extension of runExtensions) {
          for (const tool of extension.tools ?? []) {
            if (!assembly.toolIds.includes(tool.id)) continue;
            const hostCapability =
              extension.id === web.extension.id
                ? web.capabilities.find(
                    (capability) =>
                      capability.kind === 'tool' &&
                      capability.definitionId === tool.id &&
                      capability.definitionVersion === tool.version,
                  )
                : undefined;
            actual.set(
              key('tool', tool.id, tool.version),
              hostCapability ?? {
                kind: 'tool',
                definitionId: tool.id,
                definitionVersion: tool.version,
                revision: `${extension.id}:${extension.version}:${tool.version}`,
                hardAllowed: true,
                ...builtinCapability(
                  extension.id,
                  tool.id,
                  'tool',
                  planning.extension.id,
                  tool.version,
                ),
              },
            );
          }
          for (const job of extension.jobs ?? []) {
            const capability = builtinCapability(
              extension.id,
              job.id,
              'job',
              planning.extension.id,
              job.version,
            );
            actual.set(key('job', job.id, job.version), {
              kind: 'job',
              definitionId: job.id,
              definitionVersion: job.version,
              revision: `${extension.id}:${extension.version}:${job.version}`,
              effects: capability.effects,
              hardAllowed: true,
              safeRead: capability.safeRead,
            });
          }
        }
        // A selected mutation must match the actual definition/effect metadata; a typo
        // cannot silently leave its real mutation outside the sealed obligation.
        if (planningOptions.automaticValidation) {
          for (const mutation of planningOptions.automaticValidation.mutations) {
            if (!assembly.toolIds.includes(mutation.definitionId)) continue;
            const capability = actual.get(
              key('tool', mutation.definitionId, mutation.definitionVersion),
            );
            if (
              !capability?.hardAllowed ||
              capability.effects.length !== mutation.effects.length ||
              capability.effects.some(
                (effect) =>
                  !mutation.effects.includes(
                    effect as 'workspace_write' | 'destructive' | 'unknown',
                  ),
              )
            )
              throw new AgentError('automatic_validation_definition_unavailable');
          }
          const checker = planningOptions.automaticValidation.fileHashChecker;
          if (assembly.toolIds.includes(checker.definitionId)) {
            const capability = actual.get(
              key('tool', checker.definitionId, checker.definitionVersion),
            );
            if (!capability?.hardAllowed || !capability.safeRead)
              throw new AgentError('automatic_validation_checker_unavailable');
          }
        }
        const classifiedPermissions =
          options.permissions ??
          createPermissionPolicy({
            readReviewContext: createPermissionReviewContextReader({
              readRuntime: () => policyRuntime ?? null,
              subjectId: command.subjectId,
              originStoreId: command.originStoreId,
            }),
            readPolicy:
              options.permissionPolicy?.readPolicy ??
              ((request) =>
                persistedPolicy(
                  request,
                  [
                    ...actual.values(),
                    ...selectedMcp.listCapabilities(),
                    ...mcpSources.listCapabilities(),
                  ].map(({ kind, definitionId, definitionVersion }) => ({
                    kind,
                    definitionId,
                    definitionVersion,
                  })),
                  {
                    sessionId: command.sessionId,
                    expectedStoreId: command.originStoreId,
                    subjectId: command.subjectId,
                  },
                )),
            describeCapability: async (request) => {
              const description = actual.get(
                key(request.kind, request.definitionId, request.definitionVersion),
              );
              const commandDigest = shell.commandDigest(request);
              return description
                ? {
                    ...description,
                    ...(await shell.describeRequest(request)),
                    ...(await pathFiles.describeRequest(request)),
                    ...describeDefaultTask(request),
                    ...(commandDigest ? { commandDigest } : {}),
                  }
                : (mcpSources.describe(request) ?? selectedMcp.describe(request));
            },
          });
        let planningRun: { runId: string; sessionId: string } | undefined = recovery?.runIdentity;
        const initializeBusinessRequirements = composeRequirementInitializers(
          requirePlan || planningOptions.requiredValidation || planningOptions.automaticValidation
            ? (input) =>
                planning.initializeRequirements(input, {
                  requirePlan,
                  readOnlyDefinitions,
                })
            : undefined,
          workflow.enabled ? workflow.initializeRequirements : undefined,
        );
        const hasBusinessInitializer =
          requirePlan ||
          planningOptions.requiredValidation ||
          planningOptions.automaticValidation ||
          workflow.enabled;
        const planningOriginStoreId = command.originStoreId;
        const planningPermissions = createPlanningPermissionPolicy({
          required: requirePlan,
          run: () => planningRun,
          current: classifiedPermissions,
          async readState(request, identity) {
            const runtime = policyRuntime;
            if (!runtime || !identity) throw new AgentError('planning_run_scope_unavailable');
            return readPlanningPermissionState(
              runtime,
              planning,
              request,
              planningOriginStoreId,
              identity,
            );
          },
          describe: (request) => {
            const description = actual.get(
              key(request.kind, request.definitionId, request.definitionVersion),
            );
            const commandDigest = shell.commandDigest(request);
            return description
              ? {
                  ...description,
                  ...(commandDigest ? { commandDigest } : {}),
                }
              : (mcpSources.describe(request) ?? selectedMcp.describe(request));
          },
        });
        const permissions: RuntimeOptions['permissions'] = {
          toolDispatchOrder: planningPermissions.toolDispatchOrder,
          async authorize(request) {
            if (
              'assertExecutionScope' in selectedSources &&
              typeof selectedSources.assertExecutionScope === 'function'
            ) {
              try {
                await selectedSources.assertExecutionScope(request);
              } catch {
                return {
                  allowed: false,
                  revision: 'mcp-child-source-scope-1',
                  reason: 'mcp_source_scope_invalid',
                };
              }
            }
            if (selection?.workflowFence) {
              try {
                assertWorkflowForkCurrent(selection.workflowFence, assembly.knowledgeScope);
              } catch (error) {
                if (error instanceof KnowledgeReadCleanupError) throw error;
                return {
                  allowed: false,
                  revision: 'workflow-fork-source-1',
                  reason: 'workflow_source_changed',
                };
              }
            }
            let carrier = false;
            if (
              selection?.workflowCarrier &&
              policyRuntime &&
              request.kind === 'job' &&
              request.definitionId === `agent/${selection.workflowCarrier.roleId}` &&
              request.definitionVersion === selection.workflowCarrier.roleVersion &&
              request.sessionId === selection.workflowCarrier.sessionId
            ) {
              const execution = await policyRuntime.getExecution(request.executionId);
              carrier =
                execution?.parentExecutionId === selection.workflowCarrier.parentExecutionId &&
                execution.originStoreId === command.originStoreId &&
                execution.rootWorkCommandId === command.rootWorkCommandId;
            }
            if (
              selection?.workflowFence &&
              !carrier &&
              request.kind !== 'model' &&
              !selection.workflowFence.capabilities.some(
                (binding) =>
                  binding.kind === request.kind &&
                  binding.definitionId === request.definitionId &&
                  binding.definitionVersion === request.definitionVersion,
              )
            )
              return {
                allowed: false,
                revision: 'workflow-fork-ceiling-1',
                reason: 'workflow_capability_denied',
              };
            const error =
              selectedSources.admissionError(request) ?? selectedMcp.admissionError(request);
            if (error) return { allowed: false, revision: 'mcp-selected-server-1', reason: error };
            const decision = await planningPermissions.authorize(request);
            let minimum =
              request.kind === 'model' ? undefined : selection?.workflowFence?.minimumApproval;
            if (
              workflow.enabled &&
              ((request.kind === 'tool' && workflowToolIds.includes(request.definitionId)) ||
                (request.kind === 'job' &&
                  ['skill.workflow.verify', 'skill.workflow.compensate'].includes(
                    request.definitionId,
                  )))
            ) {
              const input =
                request.input && typeof request.input === 'object' && !Array.isArray(request.input)
                  ? request.input
                  : {};
              let skillId = request.kind === 'job' ? input.skillId : input.skill_id;
              if (request.kind === 'tool' && request.definitionId !== 'activate_skill') {
                const activationId = input.activation_id;
                if (
                  policyRuntime &&
                  request.runId &&
                  typeof activationId === 'string' &&
                  /^[A-Za-z0-9_.-]{1,128}$/.test(activationId)
                ) {
                  const anchor = await policyRuntime.readRunExtensionRecord({
                    sessionId: request.sessionId,
                    runId: request.runId,
                    extensionId: 'builtin.skill-workflow',
                    key: `run/${request.runId}/workflow.${createHash('sha256').update(activationId).digest('hex')}`,
                  });
                  const frame = anchor?.value;
                  if (
                    anchor?.contentType === 'application/vnd.kite.skill-activation+json' &&
                    anchor.contentVersion === 1 &&
                    frame &&
                    typeof frame === 'object' &&
                    !Array.isArray(frame) &&
                    frame.kind === 'activation' &&
                    frame.runId === request.runId &&
                    frame.sessionId === request.sessionId &&
                    frame.activationId === activationId
                  )
                    skillId = frame.skillId;
                }
              }
              const entry = workflow.entries.find(
                (entry) => entry.descriptor.capabilityId === skillId,
              );
              if (!entry?.contract)
                return {
                  allowed: false,
                  revision: decision.revision,
                  reason: 'workflow_activation_unavailable',
                  controlReads: decision.controlReads,
                };
              minimum =
                request.kind === 'job' && request.definitionId === 'skill.workflow.compensate'
                  ? 'user'
                  : entry.contract.effectiveMinimumApproval;
            }
            return requireWorkflowApproval(decision, minimum);
          },
        };
        return {
          permissions,
          ...(afterTurn ? { afterTurn } : {}),
          compressor:
            compressor ??
            createSummaryCompressor({
              automatic: {
                ...selected.modelCapabilities,
                requestMaxOutputTokens: actualOptions.maxOutputTokens,
                tools: assembly.extensions.flatMap((extension) =>
                  (extension.tools ?? [])
                    .filter((tool) => assembly.toolIds.includes(tool.id))
                    .map((tool) => ({
                      id: tool.id,
                      definitionVersion: tool.version,
                      description: tool.description,
                      inputSchema: tool.inputSchema,
                    })),
                ),
              },
            }),
          authorizationReview,
          conditions: planning.conditions,
          initializeRequirements: !hasBusinessInitializer
            ? initializeBusinessRequirements
            : async (
                input: Parameters<NonNullable<RunConfiguration['initializeRequirements']>>[0],
              ) => {
                if (input.command.kind === 'job.report') {
                  if (!policyRuntime || !planningRun)
                    throw new AgentError('planning_run_scope_unavailable');
                  await readBoundJobReportParent(
                    policyRuntime,
                    command.originStoreId,
                    planningRun,
                    input.run,
                    input.command,
                  );
                  // Store already inherited the exact original refs at report activation.
                  return [];
                }
                if (
                  planningRun &&
                  (planningRun.runId !== input.run.id ||
                    planningRun.sessionId !== input.run.sessionId)
                )
                  throw new AgentError('planning_run_scope_unavailable');
                planningRun = { runId: input.run.id, sessionId: input.run.sessionId };
                return initializeBusinessRequirements(input);
              },
          model,
          modelId: selected.id,
          toolIds: assembly.toolIds,
          extensions: assembly.extensions,
          readStepCapabilities: async (
            input: Parameters<NonNullable<RunConfiguration['readStepCapabilities']>>[0],
          ) => {
            const step = await selectedMcp.readStepCapabilities(input);
            mcpResourceSource = createMcpResourceModelSource({
              storeId: input.command.originStoreId,
              sessionId: input.session.id,
              runId: input.run.id,
              facts:
                step.snapshot && typeof step.snapshot === 'object' && !Array.isArray(step.snapshot)
                  ? (step.snapshot.cached ?? [])
                  : [],
            });
            return {
              extensions: [...assembly.extensions, ...(step.extensions ?? [])],
              toolIds: [
                ...assembly.toolIds,
                ...(mcpResourceSource
                  ? mcpResourceModelToolIds.filter(
                      (id) =>
                        !assembly.toolIds.includes(id) &&
                        (!selection?.toolIds || selection.toolIds.includes(id)),
                    )
                  : []),
                ...(step.toolIds ?? []).filter(
                  (id) =>
                    (!selection?.toolIds ||
                      selection.toolIds.includes(id) ||
                      selection.inheritDynamicMcp === true) &&
                    !effective.tools?.some((tool) => tool.id === id && tool.enabled === false),
                ),
              ],
              snapshot: step.snapshot,
            };
          },
          sources: {
            async capture(
              request: Parameters<NonNullable<RunConfiguration['sources']>['capture']>[0],
            ) {
              if (selection?.workflowFence)
                assertWorkflowForkCurrent(selection.workflowFence, assembly.knowledgeScope);
              return [
                ...(await assembly.sources.capture(request)),
                ...(await selectedSources.sources.capture(request)),
                ...(mcpResourceSource ? [mcpResourceSource] : []),
              ];
            },
            async captureBatch(
              requests: readonly Parameters<
                NonNullable<RunConfiguration['sources']>['capture']
              >[0][],
            ) {
              if (selection?.workflowFence)
                assertWorkflowForkCurrent(selection.workflowFence, assembly.knowledgeScope);
              const sources = new Map<string, ContextSource>();
              const append = (values: ContextSource[]) => {
                if (!Array.isArray(values)) throw new AgentError('context_source_invalid');
                for (const source of values) {
                  const previous = sources.get(source.id);
                  if (previous && previous.digest !== source.digest)
                    throw new AgentError('context_refresh_required');
                  sources.set(source.id, source);
                }
              };
              if (assembly.sources.captureBatch)
                append(await assembly.sources.captureBatch(requests));
              else for (const request of requests) append(await assembly.sources.capture(request));
              for (const request of requests)
                append(await selectedSources.sources.capture(request));
              if (mcpResourceSource) append([mcpResourceSource]);
              return [...sources.values()];
            },
          },
          dispose,
          snapshot: {
            ...snapshot,
            skillWorkflow: workflow.snapshot,
            workflowForkFence: selection?.workflowFence ?? null,
            workflowCarrier: selection?.workflowCarrier ?? null,
            skillSelection: {
              requested: selection
                ? (selection.skillSelection?.requested ?? null)
                : (skillSelection ?? null),
              resolvedIds: assembly.snapshotFacts.skills.map((entry) => entry.id),
            },
            actualCapabilities: assembly.snapshotFacts,
            mcp: { ...selectedMcp.snapshot, sources: selectedSources.snapshot },
            shell: shell.snapshot,
            pathFiles: pathFiles.snapshot,
            web: assembly.toolIds.includes('web_fetch') ? web.snapshot : null,
            task: {
              ...task.snapshot,
              tools: task.snapshot.tools.filter((tool) => assembly.toolIds.includes(tool.id)),
            },
            planning: {
              intent: planningIntent,
              binding: planningBinding,
              automaticValidation: planningOptions.automaticValidation
                ? {
                    ...structuredClone(planningOptions.automaticValidation),
                    selected: {
                      mutations: planningOptions.automaticValidation.mutations.map((mutation) => ({
                        ...mutation,
                        actualEffects:
                          actual.get(key('tool', mutation.definitionId, mutation.definitionVersion))
                            ?.effects ?? null,
                        selected: actual.has(
                          key('tool', mutation.definitionId, mutation.definitionVersion),
                        ),
                      })),
                      checker: actual.has(
                        key(
                          'tool',
                          planningOptions.automaticValidation.fileHashChecker.definitionId,
                          planningOptions.automaticValidation.fileHashChecker.definitionVersion,
                        ),
                      ),
                      autoCheck: actual.has(key('tool', 'validation.auto_check', '1')),
                    },
                  }
                : null,
              requirePlan,
              requiredValidation: planningOptions.requiredValidation === true,
              allowWaiver: planningOptions.allowWaiver === true,
              requiredReceiptDefinitions: planningOptions.requiredReceiptDefinitions ?? [],
              fileHashChecker: planningOptions.fileHashChecker
                ? { ...planningOptions.fileHashChecker }
                : null,
              commandChecker: planningOptions.commandChecker
                ? { ...planningOptions.commandChecker }
                : null,
              mcpCheckers: (planningOptions.mcpCheckers ?? []).map((checker) => ({ ...checker })),
              allowedExecutionModes: planningOptions.allowedExecutionModes ?? [
                'auto',
                'accept_edits',
              ],
              tools: [...businessTools.values()]
                .filter((tool) => assembly.toolIds.includes(tool.id))
                .map((tool) => ({ id: tool.id, definitionVersion: tool.version })),
              extensionId: planning.extension.id,
              definitionVersion: planning.extension.version,
            },
          } as unknown as Json,
        };
      } catch (error) {
        try {
          await dispose();
        } catch (cleanupError) {
          throw new ConfigurationPreparationCleanupError({
            originalError: error,
            cleanupError,
            resources: { assembly, webBinding },
          });
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof KnowledgeReadCleanupError)
        throw new ConfigurationPreparationCleanupError({
          originalError: error,
          cleanupError: error.cause.cleanupError,
          resources: error.cause.resources,
        });
      if (error instanceof AgentError) throw error;
      throw new AgentError(
        error instanceof ConfigurationError ? error.code : 'configuration_unavailable',
      );
    }
  };
  function workflowCapabilitiesFor(assembly: Awaited<ReturnType<typeof createWorkspaceAssembly>>) {
    const extensions = [...builtinExtensions, ...assembly.extensions];
    const workflowCapabilities: Parameters<
      typeof createWorkflowConfiguration
    >[0]['capabilities'][number][] = extensions.flatMap((extension) =>
      (extension.tools ?? [])
        .filter((tool) => assembly.toolIds.includes(tool.id))
        .map((tool) => {
          const effects = builtinCapability(
            extension.id,
            tool.id,
            'tool',
            planning.extension.id,
            tool.version,
          ).effects;
          return workflowCapabilityDescription({
            kind: 'tool',
            definitionId: tool.id,
            definitionVersion: tool.version,
            revision: `${extension.id}:${extension.version}:${tool.version}`,
            extensionId: extension.id,
            effects,
          });
        }),
    );
    const registeredJobs = extensions.flatMap((extension) => [
      ...(extension.jobs ?? []).map((job) => ({
        id: job.id,
        version: job.version,
        revision: `${extension.id}:${extension.version}:${job.version}`,
      })),
      ...(extension.actions ?? []).map((action) => ({
        id: `${extension.id}/${action.id}`,
        version: action.version,
        revision: `${extension.id}:${extension.version}:${action.version}`,
      })),
    ]);
    registeredJobs.push(
      ...childRoles.map((role) => ({
        id: `agent/${role.id}`,
        version: role.version,
        revision: `trusted-child:${role.id}:${role.version}`,
      })),
    );
    workflowCapabilities.push(
      ...registeredJobs.map((job) =>
        workflowCapabilityDescription({
          kind: 'job',
          definitionId: job.id,
          definitionVersion: job.version,
          revision: job.revision,
          effects: ['unknown'],
        }),
      ),
    );
    return workflowCapabilities;
  }
  const resolveRunConfiguration: NonNullable<RuntimeOptions['resolveRunConfiguration']> = (input) =>
    resolveConfigurationBinding(input);
  const resolveRecoveryRunConfiguration: NonNullable<
    RuntimeOptions['resolveRecoveryRunConfiguration']
  > = async (input) => {
    const manifest = input.run.configuration;
    const snapshot =
      manifest && typeof manifest === 'object' && !Array.isArray(manifest)
        ? manifest.snapshot
        : undefined;
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      Array.isArray(manifest) ||
      typeof manifest.modelId !== 'string' ||
      !snapshot ||
      typeof snapshot !== 'object' ||
      Array.isArray(snapshot) ||
      snapshot.version !== 1 ||
      typeof snapshot.digest !== 'string' ||
      !snapshot.configuration ||
      typeof snapshot.configuration !== 'object' ||
      Array.isArray(snapshot.configuration) ||
      createConfigurationSnapshot(snapshot.configuration).digest !== snapshot.digest
    )
      throw new AgentError('recovery_configuration_unavailable');
    return resolveConfigurationBinding(
      input,
      {
        modelId: manifest.modelId,
        skillSelection: readSkillSelection(manifest),
      },
      {
        digest: snapshot.digest,
        signal: input.signal,
        workflowSnapshot: snapshot.skillWorkflow ?? null,
        planningSnapshot: snapshot.planning ?? null,
        runIdentity: { runId: input.run.id, sessionId: input.run.sessionId },
        mcpSourceSnapshot:
          snapshot.mcp && typeof snapshot.mcp === 'object' && !Array.isArray(snapshot.mcp)
            ? (snapshot.mcp.sources ?? null)
            : null,
      },
    );
  };
  const child = createChildConfiguration({
    roles: childRoles,
    resolve: async (input, selection) => {
      try {
        if (workflowToolIds.includes(input.parentExecution.definitionId ?? '') && !input.parentRun)
          throw new AgentError('workflow_fork_unavailable');
        const workflowFence =
          input.parentRun &&
          ['activate_skill', 'repair_skill', 'decide_skill_verification'].includes(
            input.parentExecution.definitionId ?? '',
          )
            ? await workflowForkFence(
                input.parentRun.configuration,
                input.parentExecution,
                selection.role,
                {
                  runId: input.parentRun.id,
                  records: input.records.forExtension('builtin.skill-workflow'),
                },
              )
            : undefined;
        if (workflowFence) assertWorkflowForkCurrent(workflowFence);
        return await resolveConfigurationBinding(
          { command: input.command, session: input.parentSession, workspace: input.workspace },
          {
            modelId: selection.modelId,
            toolIds: workflowFence?.toolIds ?? selection.role.toolIds,
            workflowFence,
            workflowCarrier: workflowFence
              ? {
                  parentExecutionId: input.parentExecution.id,
                  sessionId: input.parentExecution.sessionId,
                  roleId: selection.role.id,
                  roleVersion: selection.role.version,
                }
              : undefined,
            parentTools: input.parentTools,
            inheritDynamicMcp: selection.inheritDynamicMcp,
            mcpParent: {
              parentExecution: input.parentExecution,
              parentRun: input.parentRun,
              parentSession: input.parentSession,
              workspace: input.workspace,
              command: input.command,
            },
            skillSelection: input.parentRun
              ? readSkillSelection(input.parentRun.configuration)
              : undefined,
          },
        );
      } catch (error) {
        if (error instanceof KnowledgeReadCleanupError)
          throw new ConfigurationPreparationCleanupError({
            originalError: error,
            cleanupError: error.cause.cleanupError,
            resources: error.cause.resources,
          });
        throw error;
      }
    },
  });
  return {
    ...child,
    skillCatalogue: createDefaultSkillCatalogueSource({
      defaults: configurationDefaults,
      userConfiguration,
      profile: options.profile,
      explicit: () => explicitConfiguration(explicit),
      allowedCapabilities: options.allowedToolCapabilities,
      workflowBindings: async ({ workspaceRoot, effective, toolIds }) => {
        task.validateSelection(toolIds);
        mcp.select(
          effective.mcp?.filter(
            (server) =>
              mcpRegistry.servers.some((registered) => registered.id === server.id) ||
              !/^mcp-[a-f0-9]{64}$/.test(server.id),
          ),
          toolIds.filter((id) => !id.startsWith('mcp.')),
        );
        const shell = await createShellConfiguration({
          workspaceRoot,
          toolIds,
          options: shellOptions,
        });
        const assembly = await createWorkspaceAssembly({
          workspaceRoot,
          profile: options.profile,
          externallyRegisteredFileTools: files.tools,
          externallyRegisteredExtensions: [askUser, pathFilesExtension],
          toolIds,
          toolConfigurations: effective.tools,
          skills: [],
          knownToolIds: [
            ...(options.knownToolIds ?? []),
            ...businessTools.keys(),
            ...task.tools.keys(),
            ...shellToolIds,
            ...web.toolIds,
            ...mcp.tools.keys(),
            ...workflowToolIds,
          ],
          allowedCapabilities: options.allowedToolCapabilities,
        });
        const resolveBindings = () => {
          assembly.extensions.push(...shell.extensions);
          if (toolIds.some((id) => webTools.has(id))) assembly.extensions.push(web.extension);
          assertSelectedToolVersions(toolIds, effective.tools, [
            askUserTools.values(),
            businessTools.values(),
            fileTools.values(),
            pathFiles.tools,
            task.tools.values(),
            ...assembly.extensions.map((extension) => extension.tools ?? []),
            mcp.tools.values(),
          ]);
          return {
            capabilities: workflowCapabilitiesFor(assembly),
            forkConfigurations: childRoles.map((role) => ({
              agent: role.id,
              configurationId: role.id,
              definitionVersion: role.version,
            })),
            shell: shellOptions,
          };
        };
        let bindings: ReturnType<typeof resolveBindings> | undefined;
        let failed = false;
        let originalError: unknown;
        try {
          bindings = resolveBindings();
        } catch (error) {
          failed = true;
          originalError = error;
        }
        try {
          await assembly.dispose();
        } catch (cleanupError) {
          throw new ConfigurationPreparationCleanupError({
            originalError,
            cleanupError,
            resources: { assembly },
          });
        }
        if (failed) throw originalError;
        return bindings!;
      },
    }),
    diagnosticSource: createDefaultHostStatusSource({
      shell: shellOptions,
      externalPermissionAuthority,
    }),
    supportsSelectedSkills: true,
    supportsExtensionInputs: true,
    extensions: [
      ...builtinExtensions,
      ...(mcp.extension ? [mcp.extension] : []),
      mcpManagement.extension,
      mcpSources.extension,
    ],
    bindWorkspaceSerialLocks(locks) {
      if (oauthSerialLocks && oauthSerialLocks !== locks)
        throw new AgentError('resource_host_already_bound');
      oauthSerialLocks = locks;
    },
    ...(options.authorizationReview ? { authorizationReview: options.authorizationReview } : {}),
    resolveRunConfiguration,
    resolveRecoveryRunConfiguration,
    configurationManagement: (runtime) =>
      createConfigurationManagement({
        userConfiguration,
        profile: options.profile,
        runtime,
        vault: modelVault,
        persistence: options.credentialBackend?.kind ?? 'os',
        explicit: () => explicitConfiguration(explicit),
      }),
    permissionManagement,
    permissions: {
      toolDispatchOrder: (options.permissions ?? globalDefaultPolicy).toolDispatchOrder,
      async authorize(request) {
        if (
          request.kind === 'job' &&
          (request.definitionId.startsWith('builtin.mcp/mcp.resources.') ||
            request.definitionId.startsWith('builtin.mcp/mcp.prompts.') ||
            request.definitionId === 'builtin.mcp/mcp.catalogue.refresh' ||
            request.definitionId === 'builtin.mcp/mcp.connect' ||
            request.definitionId === 'mcp.source.connection')
        ) {
          if (!policyRuntime)
            return {
              allowed: false,
              revision: 'mcp-selected-server-1',
              reason: 'execution_scope_unavailable',
            };
          const session = await policyRuntime.getSession(request.sessionId);
          const workspace = session && (await policyRuntime.getWorkspace(session.workspaceId));
          if (!workspace)
            return {
              allowed: false,
              revision: 'mcp-selected-server-1',
              reason: 'execution_scope_unavailable',
            };
          const root = fileURLToPath(workspace.rootUri);
          const user = userConfiguration.read().value;
          const project = readConfigurationFile({ path: join(root, 'kite-agent.jsonc') }).value;
          const current = explicitConfiguration(explicit);
          const effective = resolveConfiguration({
            defaults: configurationDefaults,
            user,
            workspace: withoutProjectModels(project),
            explicit: current,
          });
          const execution = await policyRuntime.getExecution(request.executionId);
          const command = execution && (await policyRuntime.getCommand(execution.originCommandId));
          if (!session || !command)
            return {
              allowed: false,
              revision: 'mcp-selected-server-1',
              reason: 'execution_scope_unavailable',
            };
          const selectedSources = mcpSources.select(
            await mcpSources.capture({ command, session, workspace }),
            {
              present: [user, project, current].some((layer) => Object.hasOwn(layer, 'mcp')),
              configurations: effective.mcp ?? [],
            },
          );
          const error =
            selectedSources.admissionError(request) ??
            mcp
              .select(
                effective.mcp?.filter(
                  (server) =>
                    mcpRegistry.servers.some((registered) => registered.id === server.id) ||
                    !/^mcp-[a-f0-9]{64}$/.test(server.id),
                ),
                [],
                selectedSources.servers,
              )
              .admissionError(request);
          if (error) return { allowed: false, revision: 'mcp-selected-server-1', reason: error };
        }
        const decision = await (options.permissions ?? globalDefaultPolicy).authorize(request);
        return options.permissions ? decision : requireFileRestoreApproval(request, decision);
      },
    },
  };
}
