import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AfterTurnPolicy,
  AgentError,
  type AgentRuntime,
  ConfigurationPreparationCleanupError,
  type ContextCompressor,
  type ContextSource,
  createExecutionEvidenceExtension,
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
  type ModelConfiguration,
  type NamedConfiguration,
  readConfigurationFile,
  resolveConfiguration,
} from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import { filesNativeAssets, imageAssets, pdfAssets } from '@kite-ai/agent/files';
import { ripgrepAsset } from '@kite-ai/agent/jobs/shell';
import {
  createMcpResourceModelSource,
  type McpLifecycleOptions,
  mcpResourceModelToolIds,
  mcpSchemaWorkerAssets,
} from '@kite-ai/agent/mcp';
import {
  hostReadOnlyTool,
  type PermissionPolicyOptions,
  shellRiskReviewContractDigest,
} from '@kite-ai/agent/permissions';
import {
  createShellCommandPolicy,
  createShellConfiguration,
  readOnlySearchCommand,
  type ShellConfigurationOptions,
  shellToolIds,
} from '@kite-ai/agent/permissions/shell';
import {
  createPlanFiles,
  createPlanningValidation,
  type PlanningOptions,
} from '@kite-ai/agent/planning';
import type { ProfileSelection } from '@kite-ai/agent/profile';
import { createSessionTitleExtension } from '@kite-ai/agent/session-title';
import { KnowledgeReadCleanupError } from '@kite-ai/agent/sources';
import { sqliteStorageAssets } from '@kite-ai/agent/sqlite';
import { WebFetchError, webExtractorAssets } from '@kite-ai/agent/web-fetch';
import { createCompatibleModelBinding, type ReasoningEffort } from '@kite-ai/ai/sdk';
import { createWorkspaceAssembly } from './assembly';
import { createRunModelAdapters } from './authorization-check-model';
import type { ProcessHostConfiguration } from './bootstrap';
import {
  type BrowserConfigurationOptions,
  createBrowserConfiguration,
} from './browser-configuration';
import {
  type ChildRole,
  createChildConfiguration,
  readSkillSelection,
  type SkillSelection,
} from './child-configuration';
import { CODEX_BASE_URL, createCodexLocalSource } from './codex-auth';
import {
  createSummaryCompressor,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
} from './compression-configuration';
import { defaultConfiguration, ordinaryHostConfigurationDefaults } from './configuration-defaults';
import { createConfigurationManagement } from './configuration-management';
import type { DesktopBrowserEndpoint } from './desktop-browser';
import { createDefaultFileCheckpointConfiguration } from './file-checkpoint-configuration';
import { readHostState } from './host-read';
import { createDefaultHostStatusSource } from './host-status';
import { createMcpConfiguration } from './mcp-configuration';
import { createMcpManagement } from './mcp-management';
import {
  createMcpSourceConfiguration,
  type McpSourceConfigurationOptions,
} from './mcp-source-configuration';
import { parseModelPreset } from './model-options';
import { isSupportedModelProvider, modelProtocol } from './model-providers';
import { resolveModelTransport } from './model-transport';
import {
  createDefaultPermissionConfiguration,
  defaultAutoReviewContract,
  parentAutoReviewContract,
} from './permission-configuration';
import {
  planningSnapshotDigest,
  readBusinessRunInputs,
  readPlanningIntent,
} from './planning-configuration';
import { assertSessionModelProtocol } from './session-model-protocol';
import { createDefaultSkillCatalogueSource } from './skill-catalogue';
import { createTaskConfiguration, defaultTaskRoles } from './task-configuration';
import { createUserConfiguration, withoutProjectModels } from './user-configuration';
import { createUserMcpManagement } from './user-mcp-management';
import { disabledUserMcpSources } from './user-mcp-selection';
import {
  createWebFetchConfiguration,
  type WebFetchConfigurationOptions,
} from './web-fetch-configuration';
import { resolveWebTransport } from './web-fetch-proxy';

export type { ShellConfigurationOptions } from '@kite-ai/agent/permissions/shell';
export type { BrowserConfigurationOptions } from './browser-configuration';
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
function readOnlyTaskGuidanceSource(root: string, description?: string): ContextSource {
  const content = [
    'This is a read-only task assignment: do not create, modify, or delete business files, make unauthorized network connections, or disclose task data outside its authorized scope.',
    'Necessary exploration may create temporary scripts and temporary artifacts within the inherited tool permissions, preferably in the private temporary directory. Keep business source, configuration and data unchanged; a temporary-looking name does not establish safety or permission.',
    'Read-only is a task constraint, not a separate approval mode or execution sandbox. You inherit the current parent permission mode and ordinary Shell sandbox; the actual permission checks and host restrictions still apply.',
    'Complete read-only Shell commands, including cat, command chains such as &&, and pipelines may be used when they fit the authorized task and current permissions. Command names or the number of commands do not establish their actual effects. Inspect the complete command, including scripts, substitutions, redirects, hooks, targets, and outgoing data.',
    'Use the actual Tool feedback to distinguish a task restriction, an approval refusal, a sandbox limit, and a technical failure. Do not replay unknown effects or bypass a real refusal. Correct a known unexecuted request only within the original authorized task and the applicable restriction.',
    ...(description ? [`Role assignment: ${description}`] : []),
  ].join('\n');
  return {
    id: 'builtin.task:read-only-assignment',
    kind: 'task_role',
    scope: root,
    role: 'system',
    content,
    digest: createHash('sha256').update(content).digest('hex'),
  };
}
function frozenReadOnlyTaskSource(root: string, value: Json): ContextSource {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !['id', 'kind', 'scope', 'role', 'content', 'digest'].includes(key),
    ) ||
    value.id !== 'builtin.task:read-only-assignment' ||
    value.kind !== 'task_role' ||
    value.scope !== root ||
    value.role !== 'system' ||
    typeof value.content !== 'string' ||
    value.digest !== createHash('sha256').update(value.content).digest('hex')
  )
    throw new AgentError('recovery_configuration_unavailable');
  return structuredClone(value) as unknown as ContextSource;
}
function assertSelectedToolVersions(
  toolIds: readonly string[],
  configurations: readonly NamedConfiguration[] | undefined,
  registrations: readonly Iterable<{ readonly id: string; readonly version: string }>[],
) {
  const tools = registrations.flatMap((definitions) => [...definitions]);
  for (const selected of configurations ?? []) {
    if (!toolIds.includes(selected.id)) continue;
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
  /** Trusted local source. Embedded hosts with a custom user file opt in explicitly. */
  localCodex?: ReturnType<typeof createCodexLocalSource> | false;
  /** Verified host runtime closure deny paths; never supplied by JSONC, Model or public API. */
  runtimeAssets?: readonly string[];
  hostConfiguration?: Json;
  /** Trusted packaged clients select everyday tools; embedded hosts keep explicit selection. */
  ordinaryHostTools?: true;
  credentialBackend?: CredentialBackend;
  /** Trusted host policy; configuration files cannot supply permissions or capability grants. */
  permissions?: RuntimeOptions['permissions'];
  /** Optional trusted authorization checker override, also available to runless Actions. JSONC cannot supply it. */
  authorizationCheck?: RuntimeOptions['authorizationCheck'];
  /** Programmatic current host policy only; JSONC never grants execution authority. */
  permissionPolicy?: Pick<PermissionPolicyOptions, 'readPolicy'>;
  /** Trusted host business constraints; JSONC selects tools, never these permission/requirement options. */
  planning?: PlanningOptions;
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
  /** Trusted browser assets and host ceiling; JSONC may only select existing Tool IDs. */
  browser?: BrowserConfigurationOptions | false;
  desktopBrowser?: DesktopBrowserEndpoint;
  knownToolIds?: readonly string[];
  allowedToolCapabilities?: readonly string[];
}): ProcessHostConfiguration {
  const localCodex =
    options.localCodex === false
      ? undefined
      : (options.localCodex ??
        (options.userConfigurationPath === undefined ? createCodexLocalSource() : undefined));
  const userConfiguration = createUserConfiguration(options.userConfigurationPath, localCodex);
  const codexProtectionPath = localCodex?.protectedAuthPath;
  const externalPermissionAuthority =
    options.permissions !== undefined || options.permissionPolicy !== undefined;
  const explicit = structuredClone(options.hostConfiguration);
  explicitConfiguration(explicit);
  const planningOptions = structuredClone({ completionGuidance: true, ...options.planning });
  const childRoles = structuredClone(options.child ?? defaultTaskRoles);
  const classifyDefaultTasks = !options.child;
  const browser = createBrowserConfiguration({
    runtime: () => {
      if (!policyRuntime) throw new AgentError('execution_scope_unavailable');
      return policyRuntime;
    },
    configuration: options.browser,
    desktopBrowser: options.desktopBrowser,
    resolveDesktopStoreId: async (context) => {
      if (!policyRuntime) throw Error('desktop_browser_store_unbound');
      const execution = await policyRuntime.getExecution(context.executionId);
      if (!execution || execution.sessionId !== context.sessionId || !execution.originStoreId)
        throw Error('desktop_browser_store_unbound');
      return execution.originStoreId;
    },
    privateDirectory: join(
      process.platform === 'win32'
        ? tmpdir()
        : process.platform === 'darwin'
          ? realpathSync('/tmp')
          : '/tmp',
      `kite-ab-${process.getuid?.() ?? 'user'}-${options.profile.profileAccessKey.slice(0, 16)}`,
    ),
  });
  const browserTools = new Map((browser.extension.tools ?? []).map((tool) => [tool.id, tool]));
  let shellOptions = options.shell ? structuredClone(options.shell) : undefined;
  if (shellOptions?.host)
    shellOptions = {
      ...shellOptions,
      host: {
        ...shellOptions.host,
        protectedRoots: [
          ...new Set([...shellOptions.host.protectedRoots, dirname(userConfiguration.path)]),
        ],
        readonlyAssets: [
          ...new Set([...shellOptions.host.readonlyAssets, ...browser.runtimeAssets]),
        ],
        protectedFiles: [
          ...new Set([
            ...(shellOptions.host.protectedFiles ?? []),
            // Linux masks this exact private parent, even before the first Browser Job.
            join(browser.privateDirectory, 'private'),
            ...(shellOptions.platform === 'darwin' ? [browser.privateDirectory] : []),
            ...(codexProtectionPath === undefined ? [] : [codexProtectionPath]),
          ]),
        ],
      },
    };
  const afterTurn = options.afterTurn
    ? Object.freeze({ authorize: options.afterTurn.authorize.bind(options.afterTurn) })
    : undefined;
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
  const task = createTaskConfiguration(childRoles);
  const configurationDefaults = options.ordinaryHostTools
    ? ordinaryHostConfigurationDefaults(
        options.shell !== undefined,
        task.extension !== undefined,
        browser.available,
        options.desktopBrowser !== undefined,
      )
    : defaultConfiguration;
  const planning = createPlanningValidation(
    planningOptions,
    createPlanFiles(options.profile.profilePath),
    async (id) => {
      if (!policyRuntime) throw new AgentError('execution_scope_unavailable');
      const execution = await policyRuntime.getExecution(id);
      if (!execution) throw new AgentError('execution_scope_unavailable');
      return execution.input;
    },
    async (input) => {
      if (
        !shellOptions ||
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        typeof input.command !== 'string'
      )
        return false;
      const policy = await createShellCommandPolicy({
        cwd: options.profile.profilePath,
        shellExecutable: shellOptions.shellExecutable,
      });
      const result = await policy.classify(input.command);
      return (
        !result.hardDenied &&
        readOnlySearchCommand(
          result.plainCommands,
          shellOptions.shellExecutable,
          shellOptions.windows?.coreutilsPath,
        ) !== undefined
      );
    },
  );
  const askUser = createAskUserExtension();
  const executionEvidence = createExecutionEvidenceExtension({
    read: (request) => {
      if (!policyRuntime) throw new AgentError('execution_evidence_scope_denied');
      return policyRuntime.readExecutionEvidence(request);
    },
  });
  const builtinReadTools = new Map(
    [...(askUser.tools ?? []), ...(executionEvidence.tools ?? [])].map((tool) => [tool.id, tool]),
  );
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
    const pdf = pdfAssets();
    const image = imageAssets();
    const compilers = [mcpSchemaWorkerAssets()];
    return [
      dirname(userConfiguration.path),
      ...(codexProtectionPath === undefined ? [] : [codexProtectionPath]),
      process.execPath,
      fileURLToPath(import.meta.url),
      ripgrepAsset(),
      ...filesNativeAssets().map((asset) => fileURLToPath(asset)),
      fileURLToPath(storage.module),
      fileURLToPath(storage.worker),
      ...storage.migrations.map((migration) => fileURLToPath(migration)),
      fileURLToPath(storage.preload),
      ...storage.observerModules.map((module) => fileURLToPath(module)),
      ...compilers.flatMap((assets) => [
        assets.worker,
        assets.checksum,
        assets.preload,
        ...assets.observerModules,
      ]),
      ...(options.shell
        ? [options.shell.supervisorPath, options.shell.bunExecutable, options.shell.shellExecutable]
        : []),
      ...(options.mcpSources?.stdio
        ? [options.mcpSources.stdio.guardianPath, options.mcpSources.stdio.bunExecutable]
        : []),
      ...(options.webFetch?.extractor ? [] : [extractor.worker, extractor.checksum]),
      pdf.worker,
      pdf.checksum,
      ...pdf.dependencies,
      image.child,
      image.checksum,
      ...image.dependencies,
      browser.privateDirectory,
      ...browser.runtimeAssets,
      ...(options.runtimeAssets ?? []),
    ];
  };
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
    executionEvidence,
    planning.extension,
    files.extension,
    browser.extension,
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
        disabledUserServerIds: disabledUserMcpSources(user),
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
  let automaticWeb = web;
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
  const businessTools = new Map((planning.extension.tools ?? []).map((tool) => [tool.id, tool]));
  const permissionConfiguration = createDefaultPermissionConfiguration({
    profile: options.profile,
    authority: options,
    externalPermissionAuthority,
    afterTurn,
    nativeShellRead: shellOptions?.platform === 'darwin' && process.platform === 'darwin',
    childRoles,
    defaultTaskRoles: classifyDefaultTasks,
    defaultAutoReview: !options.authorizationCheck && !options.permissions,
    readRuntime: () => policyRuntime,
    bindRuntime: (runtime) => {
      policyRuntime = runtime;
    },
    planning,
    files,
    task,
    browser,
    mcp,
    mcpManagement,
    mcpSources,
    authorizeTitle: (request) => titles.authorize(request),
    async readGlobalMcpAdmissionError(request) {
      if (!policyRuntime) return 'execution_scope_unavailable';
      const session = await policyRuntime.getSession(request.sessionId);
      const workspace = session && (await policyRuntime.getWorkspace(session.workspaceId));
      if (!workspace) return 'execution_scope_unavailable';
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
      if (!session || !command) return 'execution_scope_unavailable';
      const selectedSources = mcpSources.select(
        await mcpSources.capture({ command, session, workspace }),
        {
          present: [user, project, current].some((layer) => Object.hasOwn(layer, 'mcp')),
          disabledUserServerIds: disabledUserMcpSources(user),
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
      return error;
    },
  });
  const titles = createSessionTitleExtension({
    runtime: () => {
      if (!policyRuntime) throw new AgentError('execution_scope_unavailable');
      return policyRuntime;
    },
    resolveModel: ({ modelId, ...input }) =>
      resolveConfigurationBinding(input, { modelId, modelOnly: true }),
  });
  const resolveModel = async (
    selected: ModelConfiguration,
    transport: Awaited<ReturnType<typeof resolveModelTransport>>,
  ) => {
    if (selected.provider === 'codex') {
      if (!localCodex) throw new ConfigurationError('codex_auth_required');
      if (selected.baseURL !== CODEX_BASE_URL || typeof selected.providerName !== 'string')
        throw new ConfigurationError('invalid_model_configuration');
      const preset = parseModelPreset(selected.options);
      if (preset.maxOutputTokens !== undefined)
        throw new ConfigurationError('codex_model_options_unsupported');
      const credentials = await localCodex.binding(selected.providerName, transport.fetch);
      const binding = createCompatibleModelBinding({
        name: 'codex',
        protocol: modelProtocol(selected.provider, selected.protocol),
        baseURL: CODEX_BASE_URL,
        modelId: selected.model,
        ...credentials,
      });
      return createRunModelAdapters({
        modelId: selected.id,
        models: new Map([[selected.id, binding]]),
        preset,
        supportsCheckOutputLimit: false,
      });
    }
    const apiKey =
      selected.credentialRef === undefined
        ? undefined
        : await modelVault.resolve(selected.credentialRef);
    const binding = createCompatibleModelBinding({
      name: selected.provider,
      protocol: modelProtocol(selected.provider, selected.protocol),
      baseURL: selected.baseURL!,
      modelId: selected.model,
      apiKey,
      fetch: transport.fetch,
    });
    return createRunModelAdapters({
      modelId: selected.id,
      models: new Map([[selected.id, binding]]),
      preset: parseModelPreset(selected.options),
      supportsCheckOutputLimit: true,
    });
  };
  type ResolveInput = Parameters<NonNullable<RuntimeOptions['resolveRunConfiguration']>>[0];
  const resolveConfigurationBinding = async (
    { command, session, workspace }: ResolveInput,
    selection?: {
      modelId: string;
      modelOnly?: boolean;
      toolIds?: readonly string[];
      inheritedModelHiddenToolIds?: readonly string[];
      skillSelection?: SkillSelection;
      mcpParent?: Parameters<typeof mcpSources.deriveChildSelection>[0];
      parentTools?: Parameters<
        NonNullable<RuntimeOptions['resolveChildRunConfiguration']>
      >[0]['parentTools'];
      inheritDynamicMcp?: boolean;
      readOnlyTask?: boolean;
      readOnlyTaskDescription?: string;
      defaultAutoReview?: 'shell_risk' | null;
    },
    recovery?: {
      digest: string;
      signal: AbortSignal;
      planningSnapshot: Json;
      mcpSourceSnapshot: Json;
      webSnapshot: Json;
      browserSnapshot: Json;
      browserSnapshotPresent: boolean;
      modelTransportSnapshot: Json;
      runIdentity: { runId: string; sessionId: string };
      readOnlyTaskSource?: Json;
      defaultAutoReview?: 'shell_risk';
    },
  ) => {
    let modelTransport: Awaited<ReturnType<typeof resolveModelTransport>> | undefined;
    try {
      recovery?.signal.throwIfAborted();
      const inheritedReview = recovery
        ? recovery.defaultAutoReview
        : selection?.defaultAutoReview === null
          ? undefined
          : (selection?.defaultAutoReview ?? 'shell_risk');
      if (
        (options.authorizationCheck || options.permissions) &&
        ((recovery && inheritedReview) || selection?.defaultAutoReview === 'shell_risk')
      )
        throw new AgentError('recovery_configuration_changed');
      const defaultAutoReview =
        !options.authorizationCheck && !options.permissions ? inheritedReview : undefined;
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
      const user = (await readHostState(() => userConfiguration.read(), recovery?.signal)).value;
      let root: string;
      try {
        const uri = new URL(workspace.rootUri);
        if (uri.protocol !== 'file:' || (uri.hostname && uri.hostname !== 'localhost'))
          throw new Error();
        root = fileURLToPath(uri);
      } catch {
        throw new ConfigurationError('workspace_configuration_unavailable');
      }
      // A recovered binding uses its original source, never today's role text. Old runs retain absence.
      const readOnlyTaskSource = recovery
        ? recovery.readOnlyTaskSource === undefined
          ? undefined
          : frozenReadOnlyTaskSource(root, recovery.readOnlyTaskSource)
        : selection?.readOnlyTask
          ? readOnlyTaskGuidanceSource(root, selection.readOnlyTaskDescription)
          : undefined;
      if (readOnlyTaskSource && !selection?.readOnlyTask)
        throw new AgentError('recovery_configuration_unavailable');
      const project = (
        await readHostState(
          () => readConfigurationFile({ path: join(root, 'kite-agent.jsonc') }),
          recovery?.signal,
        )
      ).value;
      if (project.webFetch !== undefined)
        throw new ConfigurationError('web_configuration_user_only');
      if (user.browser !== undefined || project.browser !== undefined)
        throw new ConfigurationError('browser_configuration_host_owned');
      const current = explicitConfiguration(explicit);
      const request = command.request as { modelId?: string; reasoningEffort?: ReasoningEffort };
      if (selection) current.modelId = selection.modelId;
      else if (request.modelId !== undefined) current.modelId = request.modelId;
      const explicitBrowser = [user, project, current]
        .flatMap((layer) => (Array.isArray(layer.tools) ? layer.tools : []))
        .filter((tool) => tool && typeof tool === 'object' && !Array.isArray(tool)) as JsonObject[];
      const legacyBrowser =
        explicitBrowser.some(
          (tool) =>
            typeof tool.id === 'string' &&
            browser.toolIds.includes(tool.id) &&
            tool.id !== 'browser.execute' &&
            tool.enabled !== false,
        ) &&
        !explicitBrowser.some((tool) => tool.id === 'browser.execute' && tool.enabled !== false);
      const legacyRecovery =
        recovery &&
        recovery.browserSnapshot &&
        typeof recovery.browserSnapshot === 'object' &&
        !Array.isArray(recovery.browserSnapshot) &&
        recovery.browserSnapshot.execution === undefined;
      const runDefaults =
        options.ordinaryHostTools && options.desktopBrowser && (legacyBrowser || legacyRecovery)
          ? ordinaryHostConfigurationDefaults(
              options.shell !== undefined,
              task.extension !== undefined,
              browser.available,
              false,
            )
          : configurationDefaults;
      const effective = resolveConfiguration({
        defaults: runDefaults,
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
      if (!selection || (recovery && !selection.modelOnly))
        await assertSessionModelProtocol(
          policyRuntime,
          session.id,
          modelProtocol(selected.provider, selected.protocol),
        );
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
      modelTransport = await resolveModelTransport();
      if (selection?.modelOnly)
        return {
          model: (await resolveModel(selected, modelTransport)).model,
          modelId: selected.id,
          dispose: modelTransport.close,
          toolIds: [],
          extensions: [],
          permissions: permissionConfiguration.forModelOnly(selected.id),
          snapshot: {
            ...createConfigurationSnapshot({ ...effective, tools: [], skills: [] }),
            modelTransport: modelTransport.snapshot,
          } as unknown as Json,
        } satisfies RunConfiguration;
      // Freeze the host's declared default along with this Run's actual model.
      // Core's generic configuration leaf still preserves absent metadata verbatim.
      selected.modelCapabilities = {
        contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
        ...selected.modelCapabilities,
      };
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
                : selection.toolIds?.includes('browser.execute') &&
                    browser.executionAvailable &&
                    browser.toolIds.includes(id) &&
                    browser.extension.id === 'builtin.browser' &&
                    browser.extension.version === '1'
                  ? browser.extension
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
      const unifiedBrowser = toolIds.includes('browser.execute');
      const browserRunSnapshot = unifiedBrowser
        ? { ...browser.snapshot, execution: 'isolated-browser-code-1' }
        : browser.snapshot;
      const browserInternalTools = browser.toolIds.filter((id) => id !== 'browser.execute');
      const modelHiddenToolIds = unifiedBrowser
        ? browserInternalTools.filter(
            (id) => !toolIds.includes(id) || selection?.inheritedModelHiddenToolIds?.includes(id),
          )
        : [];
      if (unifiedBrowser) {
        for (const id of browserInternalTools) {
          if (effective.tools?.some((tool) => tool.id === id && tool.enabled === false))
            throw new AgentError('browser_dependency_disabled');
          if (!toolIds.includes(id)) toolIds.push(id);
        }
      }
      task.validateSelection(toolIds);
      const sourceSelection = {
        present: [user, project, current].some((layer) => Object.hasOwn(layer, 'mcp')),
        disabledUserServerIds: disabledUserMcpSources(user),
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
        signal: recovery?.signal,
      });
      const shellTools = new Map(
        shell.extensions.flatMap((extension) =>
          (extension.tools ?? []).map((tool) => [tool.id, tool] as const),
        ),
      );
      assertSelectedToolVersions(toolIds, effective.tools, [
        builtinReadTools.values(),
        businessTools.values(),
        fileTools.values(),
        task.tools.values(),
        shellTools.values(),
        webTools.values(),
        browserTools.values(),
        mcp.tools.values(),
      ]);
      const assembly = await createWorkspaceAssembly({
        workspaceRoot: root,
        profile: options.profile,
        externallyRegisteredFileTools: files.tools,
        externallyRegisteredExtensions: [askUser, executionEvidence, browser.extension],
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
          ...browser.toolIds,
          ...mcp.tools.keys(),
          selectedSources.directoryToolId,
        ],
        allowedCapabilities: [
          ...(options.allowedToolCapabilities ?? []),
          ...(unifiedBrowser && browser.executionAvailable ? ['browser.execute'] : []),
        ],
      });
      let webBinding: ReturnType<typeof web.bind> | undefined;
      let runWeb = web;
      let disposal: Promise<void> | undefined;
      const dispose = () =>
        (disposal ??= Promise.allSettled([
          Promise.resolve().then(async () => {
            await assembly.dispose();
          }),
          Promise.resolve().then(() => webBinding?.dispose()),
          Promise.resolve().then(() => browser.disposeCommand(session.id, command.id)),
          Promise.resolve().then(() => modelTransport?.close()),
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
          if (!options.webFetch) {
            const { unavailableReason, ...transport } = await resolveWebTransport(user.webFetch);
            const candidate = createWebFetchConfiguration({
              ...(unavailableReason ? { unavailableReason } : {}),
              network: {
                policy: { mode: 'public' },
                admitHop: async () => ({ allowed: true, revision: 'default-public-network-1' }),
                ...transport,
              },
            });
            if (
              planningSnapshotDigest(candidate.snapshot as unknown as Json) !==
              planningSnapshotDigest(automaticWeb.snapshot as unknown as Json)
            )
              automaticWeb = candidate;
            runWeb = automaticWeb;
          } else if (user.webFetch !== undefined)
            throw new ConfigurationError('web_configuration_host_owned');
          webBinding = runWeb.bind();
          assembly.extensions.push(webBinding.extension);
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
          readOnlyTask: selection?.readOnlyTask === true,
          intent: planningIntent,
          requirePlan,
          readOnlyDefinitions,
          policy: {
            completionGuidance: planningOptions.completionGuidance === true,
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
            (recovery.modelTransportSnapshot !== null &&
              planningSnapshotDigest(modelTransport.snapshot) !==
                planningSnapshotDigest(recovery.modelTransportSnapshot)) ||
            planningSnapshotDigest(
              (assembly.toolIds.includes('web_fetch') ? runWeb.snapshot : null) as unknown as Json,
            ) !== planningSnapshotDigest(recovery.webSnapshot) ||
            planningSnapshotDigest(
              (assembly.toolIds.some((id) => browserTools.has(id))
                ? browserRunSnapshot
                : null) as Json,
            ) !== planningSnapshotDigest(recovery.browserSnapshot) ||
            !recovery.planningSnapshot ||
            typeof recovery.planningSnapshot !== 'object' ||
            Array.isArray(recovery.planningSnapshot) ||
            planningSnapshotDigest(planningBinding as unknown as Json) !==
              planningSnapshotDigest(recovery.planningSnapshot.binding ?? null) ||
            planningSnapshotDigest(selectedSources.snapshot as unknown as Json) !==
              planningSnapshotDigest(recovery.mcpSourceSnapshot))
        )
          throw new AgentError('recovery_configuration_changed');
        const { model, checkModel, checkOptions } = await resolveModel(selected, modelTransport);
        const authorizationCheck = {
          ...(options.authorizationCheck ?? {
            id: 'builtin.auto',
            version: createHash('sha256')
              .update(
                JSON.stringify({
                  provider: selected.provider,
                  id: selected.id,
                  model: selected.model,
                  baseURL: selected.baseURL,
                  credentialRef: selected.credentialRef ?? null,
                  options: checkOptions,
                  ...(defaultAutoReview
                    ? { defaultAutoReview, defaultAutoReviewDigest: shellRiskReviewContractDigest }
                    : {}),
                }),
              )
              .digest('hex'),
            modelId: selected.id,
            model: checkModel,
            ...(defaultAutoReview ? { prepareRiskReview: shell.prepareRiskReview } : {}),
          }),
          timeoutMs:
            options.authorizationCheck?.timeoutMs ??
            snapshot.configuration.autoApproval?.timeoutMs ??
            10000,
        };
        const runPermissions = permissionConfiguration.forRun({
          command,
          modelId: selected.id,
          models: effective.models,
          extensions: runExtensions,
          toolIds: assembly.toolIds,
          shell,
          web,
          selectedMcp,
          selectedSources,
          requirePlan,
          readOnlyDefinitions,
          recoveryRunIdentity: recovery?.runIdentity,
          ...(defaultAutoReview ? { defaultAutoReview } : {}),
          trustedExtensions: runExtensions,
        });
        return {
          ...runPermissions,
          ...(permissionConfiguration.afterTurn
            ? { afterTurn: permissionConfiguration.afterTurn }
            : {}),
          compressor:
            compressor ??
            createSummaryCompressor({
              automatic: {
                ...selected.modelCapabilities,
                thresholdTokens: snapshot.configuration.compression?.thresholdTokens,
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
          authorizationCheck,
          conditions: planning.conditions,
          model,
          modelId: selected.id,
          toolIds: assembly.toolIds,
          modelHiddenToolIds,
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
              return [
                ...(await assembly.sources.capture(request)),
                ...(await selectedSources.sources.capture(request)),
                ...(mcpResourceSource ? [mcpResourceSource] : []),
                ...(readOnlyTaskSource ? [structuredClone(readOnlyTaskSource)] : []),
              ];
            },
            async captureBatch(
              requests: readonly Parameters<
                NonNullable<RunConfiguration['sources']>['capture']
              >[0][],
            ) {
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
              if (readOnlyTaskSource) append([structuredClone(readOnlyTaskSource)]);
              return [...sources.values()];
            },
          },
          dispose,
          snapshot: {
            ...snapshot,
            ...(defaultAutoReview
              ? { defaultAutoReview, defaultAutoReviewDigest: shellRiskReviewContractDigest }
              : {}),
            ...(readOnlyTaskSource ? { readOnlyTaskSource } : {}),
            modelTransport: modelTransport.snapshot,
            skillSelection: {
              requested: selection
                ? (selection.skillSelection?.requested ?? null)
                : (skillSelection ?? null),
              resolvedIds: assembly.snapshotFacts.skills.map((entry) => entry.id),
            },
            actualCapabilities: assembly.snapshotFacts,
            ...(modelHiddenToolIds.length ? { modelHiddenToolIds } : {}),
            mcp: { ...selectedMcp.snapshot, sources: selectedSources.snapshot },
            shell: shell.snapshot,
            web: assembly.toolIds.includes('web_fetch') ? runWeb.snapshot : null,
            ...(recovery && !recovery.browserSnapshotPresent
              ? {}
              : {
                  browser: assembly.toolIds.some((id) => browserTools.has(id))
                    ? browserRunSnapshot
                    : null,
                }),
            task: {
              ...task.snapshot,
              tools: task.snapshot.tools.filter((tool) => assembly.toolIds.includes(tool.id)),
            },
            planning: {
              intent: planningIntent,
              binding: planningBinding,
              requirePlan,
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
            resources: { assembly, webBinding, modelTransport },
          });
        }
        throw error;
      }
    } catch (error) {
      if (!(error instanceof ConfigurationPreparationCleanupError))
        try {
          await modelTransport?.close();
        } catch (cleanupError) {
          throw new ConfigurationPreparationCleanupError({
            originalError: error,
            cleanupError,
            resources: { modelTransport },
          });
        }
      if (error instanceof KnowledgeReadCleanupError)
        throw new ConfigurationPreparationCleanupError({
          originalError: error,
          cleanupError: error.cause.cleanupError,
          resources: error.cause.resources,
        });
      if (error instanceof AgentError) throw error;
      throw new AgentError(
        error instanceof ConfigurationError || error instanceof WebFetchError
          ? error.code
          : 'configuration_unavailable',
      );
    }
  };
  const resolveRunConfiguration: NonNullable<RuntimeOptions['resolveRunConfiguration']> = (input) =>
    resolveConfigurationBinding(input);
  const resolveRecoveryRunConfiguration: NonNullable<
    RuntimeOptions['resolveRecoveryRunConfiguration']
  > = async (input) => {
    const manifest = input.run.configuration;
    const outerSnapshot =
      manifest && typeof manifest === 'object' && !Array.isArray(manifest)
        ? manifest.snapshot
        : undefined;
    let snapshot = outerSnapshot;
    if (
      outerSnapshot &&
      typeof outerSnapshot === 'object' &&
      !Array.isArray(outerSnapshot) &&
      outerSnapshot.kind === 'human_input_processing'
    ) {
      const raw =
        typeof outerSnapshot.inputCommandId === 'string'
          ? await policyRuntime?.getCommand(outerSnapshot.inputCommandId)
          : null;
      if (
        !raw ||
        raw.kind !== 'human.input' ||
        raw.originStoreId !== input.run.originStoreId ||
        raw.sessionId !== input.run.sessionId ||
        raw.subjectId !== input.command.subjectId ||
        raw.requestDigest !== outerSnapshot.inputDigest ||
        (raw.receipt as { processingCommandId?: string }).processingCommandId !== input.command.id
      )
        throw new AgentError('recovery_configuration_unavailable');
      snapshot = outerSnapshot.originalConfiguration;
    }
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
    const defaultAutoReview = defaultAutoReviewContract(
      snapshot.defaultAutoReview,
      snapshot.defaultAutoReviewDigest,
    );
    return resolveConfigurationBinding(
      input,
      {
        modelId: manifest.modelId,
        skillSelection: readSkillSelection({ ...manifest, snapshot }),
        readOnlyTask:
          !!snapshot.planning &&
          typeof snapshot.planning === 'object' &&
          !Array.isArray(snapshot.planning) &&
          !!snapshot.planning.binding &&
          typeof snapshot.planning.binding === 'object' &&
          !Array.isArray(snapshot.planning.binding) &&
          snapshot.planning.binding.readOnlyTask === true,
      },
      {
        digest: snapshot.digest,
        signal: input.signal,
        planningSnapshot: snapshot.planning ?? null,
        webSnapshot: snapshot.web ?? null,
        browserSnapshot: snapshot.browser ?? null,
        browserSnapshotPresent: Object.hasOwn(snapshot, 'browser'),
        modelTransportSnapshot: snapshot.modelTransport ?? null,
        ...(defaultAutoReview ? { defaultAutoReview } : {}),
        runIdentity: { runId: input.run.id, sessionId: input.run.sessionId },
        mcpSourceSnapshot:
          snapshot.mcp && typeof snapshot.mcp === 'object' && !Array.isArray(snapshot.mcp)
            ? (snapshot.mcp.sources ?? null)
            : null,
        ...(Object.hasOwn(snapshot, 'readOnlyTaskSource')
          ? { readOnlyTaskSource: snapshot.readOnlyTaskSource }
          : {}),
      },
    );
  };
  const child = createChildConfiguration({
    roles: childRoles,
    resolve: async (input, selection) => {
      try {
        return await resolveConfigurationBinding(
          { command: input.command, session: input.parentSession, workspace: input.workspace },
          {
            modelId: selection.modelId,
            toolIds: selection.role.toolIds,
            readOnlyTask: selection.role.toolPolicy === 'read_only',
            readOnlyTaskDescription: selection.role.description,
            defaultAutoReview: input.parentRun
              ? parentAutoReviewContract(input.parentRun.configuration)
              : undefined,
            parentTools: input.parentTools,
            inheritedModelHiddenToolIds: (() => {
              if (!selection.role.toolPolicy) return undefined;
              const original = input.parentRun?.configuration;
              if (!original || typeof original !== 'object' || Array.isArray(original))
                return undefined;
              const snapshot = original.snapshot;
              if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
                return undefined;
              const hidden = snapshot.modelHiddenToolIds;
              if (hidden === undefined) return undefined;
              if (
                !Array.isArray(hidden) ||
                hidden.some(
                  (id) =>
                    typeof id !== 'string' || !input.parentTools.some((tool) => tool.id === id),
                )
              )
                throw new AgentError('child_tool_source_unavailable');
              return hidden as string[];
            })(),
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
    sessionInputMetadata: { preserve: (command) => titles.preserveInputFallback(command) },
    childConfigurations: child.childConfigurations ?? [],
    resolveChildRunConfiguration: child.resolveChildRunConfiguration,
    skillCatalogue: createDefaultSkillCatalogueSource({
      defaults: configurationDefaults,
      userConfiguration,
      profile: options.profile,
      explicit: () => explicitConfiguration(explicit),
      allowedCapabilities: options.allowedToolCapabilities,
    }),
    diagnosticSource: createDefaultHostStatusSource({
      shell: shellOptions,
      externalPermissionAuthority,
    }),
    supportsSelectedSkills: true,
    supportsExtensionInputs: true,
    extensions: [
      ...builtinExtensions,
      titles.extension,
      ...(mcp.extension ? [mcp.extension] : []),
      mcpManagement.extension,
      mcpSources.extension,
    ],
    bindWorkspaceSerialLocks(locks) {
      if (oauthSerialLocks && oauthSerialLocks !== locks)
        throw new AgentError('resource_host_already_bound');
      oauthSerialLocks = locks;
    },
    ...(options.authorizationCheck ? { authorizationCheck: options.authorizationCheck } : {}),
    resolveRunConfiguration,
    resolveRecoveryRunConfiguration,
    userMcpManagement: (runtime) =>
      runtime
        ? createUserMcpManagement({
            profile: options.profile,
            runtime: () => runtime,
            credentialVault: vault,
            ...(options.observerSubjectId ? { subjectId: options.observerSubjectId } : {}),
            userConfigurationPath: userConfiguration.path,
            ...options.mcpSources,
          })
        : undefined,
    configurationManagement: (runtime) =>
      createConfigurationManagement({
        userConfiguration,
        profile: options.profile,
        runtime,
        vault: modelVault,
        persistence: options.credentialBackend?.kind ?? 'os',
        explicit: () => explicitConfiguration(explicit),
      }),
    permissionManagement: permissionConfiguration.permissionManagement,
    permissions: permissionConfiguration.permissions,
  };
}
