import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentError, type AgentRuntime } from '@kite-ai/agent';
import {
  ConfigurationError,
  deriveMcpSourceReadSet,
  type McpSourceApproval,
  type McpSourceCredentialBinding,
  type McpSourceOptions,
  type McpSourceReadSet,
  type McpSourceScope,
  type McpSourceServer,
  mcpCanonical,
  type NamedConfiguration,
  readMcpSources,
  writeMcpSourceMetadata,
} from '@kite-ai/agent/config';
import type {
  ActionContext,
  AuthorizationRequest,
  Extension,
  Json,
  ReadContext,
  ToolResult,
} from '@kite-ai/agent/extensions';
import {
  createMcpAdapter,
  createMcpCredentialBroker,
  createMcpStdioTransportPort,
  McpAdapterError,
  type McpCredentialIdentity,
  type McpLifecycleTransportPort,
  type McpScopedSourcePort,
  type McpScopedSourceResolution,
  type McpStdioPortOptions,
  type McpTransportConfiguration,
  mcpSourceConnectionJobId,
} from '@kite-ai/agent/mcp';
import type { ProfileSelection } from '@kite-ai/agent/profile';
import type { ContextSources } from '@kite-ai/agent/sources';
import type {
  CommandRecord,
  ExecutionRecord,
  RunRecord,
  SessionRecord,
  WorkspaceRecord,
} from '@kite-ai/agent/storage';
import { createMcpHttpTransportPort, type McpHttpPortOptions } from './mcp-http-port';
import { createMcpSourceResultQuery } from './mcp-source-result';
import type { CapabilityDescription } from './permissions';

export const mcpSourcesExtensionId = 'builtin.mcp.sources';
export const mcpSourcesDirectoryToolId = 'mcp.sources.list';
const hash = (value: unknown) => createHash('sha256').update(mcpCanonical(value)).digest('hex');
const object = (value: unknown): Record<string, Json> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
function seal<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) seal(child);
    Object.freeze(value);
  }
  return value;
}
type Host = Pick<
  AgentRuntime,
  | 'getMetadata'
  | 'getSession'
  | 'getWorkspace'
  | 'getExecution'
  | 'getRun'
  | 'getView'
  | 'getCommand'
  | 'getInteraction'
  | 'beginHostMutation'
  | 'finishHostMutation'
  | 'getHostMutation'
>;
export interface McpSourceSelectionInput {
  present: boolean;
  configurations: readonly NamedConfiguration[];
  toolIds?: readonly string[];
}
export interface McpSourceCapture {
  version: 1;
  scope: McpSourceScope;
  scopeDigest: string;
  readSet: McpSourceReadSet;
  registryRevision: string;
  servers: readonly (McpSourceServer & { configDigest: string | null })[];
}
export interface McpSelectedSourceSnapshot {
  version: 1;
  scope: McpSourceScope;
  scopeDigest: string;
  selection: { present: boolean; serverIds: readonly string[] };
  servers: McpSourceCapture['servers'];
  /** No selected source means ordinary cold recovery does not depend on raw MCP files. */
  readSet: McpSourceReadSet | null;
  inheritance?: McpChildSourceInheritance;
}
export interface McpChildSourceInheritance {
  version: 1;
  parentExecutionId: string;
  parentExecutionDigest: string;
  parentRunId: string;
  parentSessionId: string;
  rootSessionId: string;
  rootWorkCommandId: string;
  rootWorkSeq: string;
  parentSnapshotDigest: string;
  parentSnapshot: McpSelectedSourceSnapshot;
}
export interface McpChildSourceInput {
  parentExecution: ExecutionRecord;
  parentRun: RunRecord | null;
  parentSession: SessionRecord;
  workspace: WorkspaceRecord;
  command: CommandRecord;
}
/** The public default role wrapper has one fixed payload layer. Never walk arbitrary
 * configuration-shaped input or accept a competing flattened MCP marker.
 */
function selectedSourceSnapshot(configuration: unknown): McpSelectedSourceSnapshot | undefined {
  const snapshot = object(object(configuration).snapshot);
  if (
    ['roleId', 'roleVersion', 'roleModelId', 'roleToolIds'].some((key) =>
      Object.hasOwn(snapshot, key),
    )
  ) {
    if (
      Object.keys(snapshot).some(
        (key) =>
          ![
            'skillSelection',
            'roleId',
            'roleVersion',
            'roleModelId',
            'roleToolIds',
            'configuration',
          ].includes(key),
      ) ||
      typeof snapshot.roleId !== 'string' ||
      !snapshot.roleId ||
      typeof snapshot.roleVersion !== 'string' ||
      !snapshot.roleVersion ||
      (snapshot.roleModelId !== null && typeof snapshot.roleModelId !== 'string') ||
      (snapshot.roleToolIds !== null &&
        (!Array.isArray(snapshot.roleToolIds) ||
          snapshot.roleToolIds.some((id) => typeof id !== 'string'))) ||
      !snapshot.configuration ||
      typeof snapshot.configuration !== 'object' ||
      Array.isArray(snapshot.configuration)
    )
      throw new McpAdapterError('mcp_source_capture_unavailable');
    return object(object(snapshot.configuration).mcp).sources as unknown as
      | McpSelectedSourceSnapshot
      | undefined;
  }
  return object(snapshot.mcp).sources as unknown as McpSelectedSourceSnapshot | undefined;
}
export interface McpSourceConfigurationOptions {
  /** Actual HTTP observer identity supplied only by trusted composition. */
  observerSubjectId?: string;
  profile: ProfileSelection;
  runtime: () => Host;
  credentialVault: { resolve(ref: string): Promise<string> };
  variables?: () => Readonly<Record<string, string>>;
  /** Current general JSONC overlay; absent defaults to enabled raw source set, empty selects none. */
  selection?: (scope: Readonly<McpSourceScope>, workspacePath: string) => McpSourceSelectionInput;
  programmaticServerIds?: readonly string[];
  http?: Pick<McpHttpPortOptions, 'resolveAddresses' | 'allowLoopbackForTests' | 'limits'>;
  /** Trusted packaged manifest assets supplied by the host; never source fallback. */
  stdio?: Pick<McpStdioPortOptions, 'guardianPath' | 'bunExecutable' | 'limits'>;
}
const pageSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    afterId: { type: 'string', maxLength: 128 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
};
const sourceReadSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['identity', 'etag', 'error'],
  properties: {
    identity: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'pathDigest', 'rootIdentity'],
      properties: {
        kind: { type: 'string', enum: ['user', 'workspace'] },
        pathDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        rootIdentity: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      },
    },
    etag: { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' },
    error: { type: ['string', 'null'] },
  },
};
const readSetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['scopeDigest', 'user', 'workspace', 'approvalEtag', 'bindingEtag', 'variablesDigest'],
  properties: {
    scopeDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    variablesDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    user: sourceReadSchema,
    workspace: { anyOf: [sourceReadSchema, { type: 'null' }] },
    approvalEtag: { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' },
    bindingEtag: { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' },
  },
};

/** Late host composition; construction performs no filesystem, vault or transport operation. */
export function createMcpSourceConfiguration(options: McpSourceConfigurationOptions) {
  const runtime = options.runtime;
  const profile = Object.freeze({ ...options.profile });
  const broker = createMcpCredentialBroker({ vault: options.credentialVault });
  const programmatic = new Set(options.programmaticServerIds ?? []);
  // A finite trusted resolution association, not an execution/approval permit. Pending
  // bindings are never evicted; a new factory is required after the bound is reached.
  const replacements = new Map<
    string,
    {
      sessionId: string;
      originStoreId: string;
      serverId: string;
      configDigest: string;
      parentInputDigest: string;
      captureDigest: string;
    }
  >();
  function replacementAdmission(request: AuthorizationRequest): boolean {
    if (
      request.kind !== 'job' ||
      request.definitionId !== mcpSourceConnectionJobId ||
      request.definitionVersion !== '1'
    )
      return false;
    const value = object(request.input);
    if (
      !closedKeys(value, [
        'serverId',
        'configDigest',
        'originStoreId',
        'key',
        'bootstrapId',
        'captureDigest',
        'parentExecutionId',
        'parentInputDigest',
      ]) ||
      typeof value.parentExecutionId !== 'string' ||
      typeof value.key !== 'string' ||
      typeof value.bootstrapId !== 'string' ||
      !value.bootstrapId
    )
      return false;
    const binding = replacements.get(value.parentExecutionId);
    return (
      !!binding &&
      request.sessionId === binding.sessionId &&
      value.originStoreId === binding.originStoreId &&
      value.serverId === binding.serverId &&
      value.configDigest === binding.configDigest &&
      value.captureDigest === binding.captureDigest &&
      value.parentInputDigest === binding.parentInputDigest
    );
  }

  async function scope(sessionId: string) {
    const host = runtime();
    const [metadata, session] = await Promise.all([host.getMetadata(), host.getSession(sessionId)]);
    if (!session || session.deletedAt !== null) throw new AgentError('session_not_found');
    const workspace = await host.getWorkspace(session.workspaceId);
    if (!workspace) throw new AgentError('workspace_missing');
    const uri = new URL(workspace.rootUri);
    if (uri.protocol !== 'file:' || (uri.hostname && uri.hostname !== 'localhost'))
      throw new AgentError('workspace_configuration_unavailable');
    const lexical = resolve(fileURLToPath(uri)),
      stat = lstatSync(lexical),
      root = realpathSync(lexical),
      canonicalStat = lstatSync(root);
    // macOS /var ancestors may alias /private/var. Bind the actual canonical root/inode;
    // reject a symlink at the Workspace directory itself rather than supported ancestor aliases.
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !canonicalStat.isDirectory() ||
      canonicalStat.isSymbolicLink() ||
      canonicalStat.dev !== stat.dev ||
      canonicalStat.ino !== stat.ino
    )
      throw new AgentError('workspace_configuration_unavailable');
    const identity = hash({ root, dev: stat.dev, ino: stat.ino });
    const sourceScope: McpSourceScope = {
      profileId: profile.profileAccessKey,
      storeId: metadata.storeId,
      sessionId: session.id,
      workspaceId: workspace.id,
    };
    const sourceOptions: McpSourceOptions = {
      profilePath: profile.profilePath,
      workspacePath: root,
      scope: sourceScope,
      variables: options.variables?.() ?? {},
    };
    return { host, session, workspace, root, identity, sourceScope, sourceOptions };
  }
  function configuration(
    entry: ReturnType<typeof readMcpSources>['entries'][number],
    root: string,
  ): McpTransportConfiguration | null {
    const transport = entry.transport;
    if (!transport) return null;
    if (transport.type === 'http') return { type: 'http', url: String(transport.url) };
    if (transport.type === 'stdio')
      return {
        type: 'stdio',
        command: String(transport.command),
        cwd: typeof transport.cwd === 'string' ? transport.cwd : root,
        args: transport.args as string[],
        env: transport.env as Record<string, string>,
      };
    return null;
  }
  function observe(
    source: Pick<Awaited<ReturnType<typeof scope>>, 'root' | 'sourceScope' | 'sourceOptions'>,
  ) {
    const state = readMcpSources({
      ...source.sourceOptions,
      variables: options.variables?.() ?? {},
    });
    const servers = state.entries.map((entry) => {
      const transport = configuration(entry, source.root);
      let server = {
        ...entry.server,
        configDigest: transport
          ? createMcpAdapter({ id: entry.server.id, transport }).getCatalogue().configDigest
          : null,
      };
      if (programmatic.has(server.id))
        server = { ...server, admitted: false, reason: 'mcp_registration_conflict' };
      else if (server.transport === 'stdio' && !options.stdio)
        server = { ...server, admitted: false, reason: 'mcp_stdio_asset_unavailable' };
      return server;
    });
    const capture: McpSourceCapture = seal({
      version: 1,
      scope: structuredClone(source.sourceScope),
      scopeDigest: state.readSet.scopeDigest,
      readSet: state.readSet,
      registryRevision: hash({ revision: state.registry.revision, servers }),
      servers,
    });
    return { state, capture };
  }
  const selection = (sourceScope: McpSourceScope, workspacePath: string) =>
    options.selection?.(sourceScope, workspacePath) ?? { present: false, configurations: [] };
  async function acceptedMetadata(
    source: Awaited<ReturnType<typeof scope>>,
    state: ReturnType<typeof readMcpSources>,
    entry: ReturnType<typeof readMcpSources>['entries'][number],
  ) {
    const verify = async (
      saved: McpSourceApproval | McpSourceCredentialBinding,
      kind: 'approval' | 'credential',
    ) => {
      const proof = saved.proof;
      const actual = await source.host.getInteraction({
        expectedStoreId: source.sourceScope.storeId,
        sessionId: proof.sessionId,
        interactionId: proof.interactionId,
      });
      const request = object(actual?.request),
        server = object(request.server),
        answer = object(actual?.answer);
      if (
        !actual ||
        actual.originStoreId !== source.sourceScope.storeId ||
        actual.sessionId !== proof.sessionId ||
        actual.kind !== 'question' ||
        actual.state !== 'answered' ||
        actual.acceptedDecisionRevision !== proof.acceptedRevision ||
        actual.subjectId !== proof.subjectId ||
        actual.definitionVersion !== '1' ||
        actual.definitionId !==
          `${mcpSourcesExtensionId}/${kind === 'approval' ? 'mcp.source.approve' : 'mcp.credential.bind'}` ||
        proof.decisionId !== `${actual.id}@${proof.acceptedRevision}` ||
        hash(actual.request) !== proof.requestDigest ||
        request.executionId !== actual.executionId ||
        request.originalStoreId !== actual.originStoreId ||
        request.sessionId !== actual.sessionId ||
        server.id !== entry.server.id ||
        server.rawEntryDigest !== entry.server.rawEntryDigest ||
        server.transportDigest !== entry.server.transportDigest ||
        hash(server.source) !== saved.sourceDigest ||
        answer.kind !== 'question' ||
        object(answer.answers).decision !==
          (kind === 'approval'
            ? (saved as McpSourceApproval).decision
            : (saved as McpSourceCredentialBinding).revoked
              ? 'revoke'
              : 'bind')
      )
        throw new McpAdapterError('mcp_source_decision_invalid');
      if (
        kind === 'credential' &&
        (request.authProfileDigest !== hash((saved as McpSourceCredentialBinding).authProfile) ||
          request.credentialReferenceDigest !==
            hash((saved as McpSourceCredentialBinding).vaultRef) ||
          request.expiresAt !== (saved as McpSourceCredentialBinding).expiresAt)
      )
        throw new McpAdapterError('mcp_source_decision_invalid');
    };
    if (entry.server.source.kind === 'workspace') {
      const saved = object(state.approvals.value?.records)[
        hash(entry.binding)
      ] as unknown as McpSourceApproval;
      if (!saved) throw new McpAdapterError('mcp_source_decision_invalid');
      await verify(saved, 'approval');
    }
    if (entry.credentialBinding) await verify(entry.credentialBinding, 'credential');
  }
  function select(capture: McpSourceCapture, input: McpSourceSelectionInput) {
    const available = new Map(capture.servers.map((server) => [server.id, server]));
    const chosen = new Map<string, McpSourceCapture['servers'][number]>();
    if (!input.present) {
      for (const server of capture.servers)
        if (server.enabled && server.admitted) chosen.set(server.id, server);
    } else
      for (const item of input.configurations) {
        if (!available.has(item.id)) continue; // programmatic registrations are selected by their original owner
        if (
          Object.keys(item).some(
            (key) => !['id', 'enabled', 'configDigest', 'definitionVersion'].includes(key),
          )
        )
          throw new AgentError('mcp_configuration_not_host_selected');
        if (item.enabled === false) continue;
        const server = available.get(item.id)!;
        if (!server.admitted || !server.enabled) continue; // a named selector cannot grant source admission
        if (
          (item.configDigest !== undefined && item.configDigest !== server.configDigest) ||
          (item.definitionVersion !== undefined && item.definitionVersion !== server.configDigest)
        )
          throw new AgentError('mcp_definition_version_unavailable');
        chosen.set(server.id, server);
      }
    const servers = [...chosen.values()].sort((a, b) => a.id.localeCompare(b.id));
    const snapshot: McpSelectedSourceSnapshot = seal({
      version: 1,
      scope: structuredClone(capture.scope),
      scopeDigest: capture.scopeDigest,
      selection: { present: input.present, serverIds: servers.map((server) => server.id) },
      servers,
      readSet: servers.length ? capture.readSet : null,
    });
    const sources: ContextSources = {
      async capture(request) {
        if (
          !servers.length ||
          request.sessionId !== capture.scope.sessionId ||
          request.workspaceId !== capture.scope.workspaceId
        )
          return [];
        const payload = {
          source: 'local_mcp_metadata',
          scopeDigest: capture.scopeDigest,
          items: servers.slice(0, 20),
          total: servers.length,
          nextAfterId: servers.length > 20 ? servers[19]!.id : null,
          directoryTool: mcpSourcesDirectoryToolId,
          authority: 'Metadata does not grant connection, Tool or credential permission.',
        };
        return [
          {
            id: `${mcpSourcesExtensionId}:selected`,
            kind: 'mcp_metadata',
            scope: String(capture.scope.workspaceId),
            digest: hash(payload),
            content: JSON.stringify(payload),
            role: 'user',
          },
        ];
      },
    };
    return {
      snapshot,
      servers,
      directoryToolId: mcpSourcesDirectoryToolId,
      sources,
      admissionError(request: AuthorizationRequest) {
        const raw = object(request.input),
          binding = object(raw.binding);
        const id =
          typeof raw.serverId === 'string'
            ? raw.serverId
            : typeof binding.serverId === 'string'
              ? binding.serverId
              : null;
        if (!id || !available.has(id)) return null;
        const server = chosen.get(id);
        if (!server) return 'mcp_server_not_selected';
        const supplied = raw.configDigest ?? binding.configDigest;
        if (
          supplied !== undefined &&
          supplied !== server.configDigest &&
          !replacementAdmission(request)
        )
          return 'mcp_definition_version_unavailable';
        return null;
      },
    };
  }
  async function capture(input: {
    command: CommandRecord;
    session: SessionRecord;
    workspace: WorkspaceRecord;
  }) {
    const source = await scope(input.session.id);
    if (
      input.command.originStoreId !== source.sourceScope.storeId ||
      input.command.sessionId !== source.session.id ||
      input.workspace.id !== source.workspace.id ||
      input.session.workspaceId !== source.workspace.id
    )
      throw new AgentError('mcp_source_scope_invalid');
    const observed = observe(source);
    const servers = await Promise.all(
      observed.capture.servers.map(async (server) => {
        if (!server.admitted) return server;
        try {
          await acceptedMetadata(
            source,
            observed.state,
            observed.state.entries.find((entry) => entry.server.id === server.id)!,
          );
          return server;
        } catch {
          return { ...server, admitted: false, reason: 'mcp_source_decision_invalid' };
        }
      }),
    );
    return seal({
      ...observed.capture,
      servers,
      registryRevision:
        mcpCanonical(servers) === mcpCanonical(observed.capture.servers)
          ? observed.capture.registryRevision
          : hash({ revision: observed.capture.registryRevision, servers }),
    });
  }
  async function deriveChildSelection(
    input: McpChildSourceInput,
    narrowing: McpSourceSelectionInput,
  ) {
    if (!input.parentRun)
      return {
        ...unboundSelection({
          command: input.command,
          session: input.parentSession,
          workspace: input.workspace,
        }),
        async assertExecutionScope(_request: AuthorizationRequest) {},
      };
    const parent = await scope(input.parentSession.id);
    const actualRun = await parent.host.getRun(input.parentRun.id);
    const actualExecution = await parent.host.getExecution(input.parentExecution.id);
    if (
      !actualRun ||
      !actualExecution ||
      !(await belongsToRun(parent.host, actualExecution, actualRun)) ||
      actualExecution.sessionId !== parent.session.id ||
      actualRun.sessionId !== parent.session.id ||
      actualExecution.originStoreId !== parent.sourceScope.storeId ||
      actualRun.originStoreId !== parent.sourceScope.storeId ||
      input.command.sessionId !== parent.session.id ||
      input.command.originStoreId !== parent.sourceScope.storeId ||
      actualExecution.originCommandId !== input.command.id ||
      input.workspace.id !== parent.workspace.id ||
      hash(actualRun.configuration) !== hash(input.parentRun.configuration) ||
      hash(actualExecution.input) !== hash(input.parentExecution.input) ||
      actualExecution.rootWorkCommandId !== input.command.rootWorkCommandId ||
      actualExecution.rootWorkSeq !== input.command.rootWorkSeq
    )
      throw new McpAdapterError('mcp_source_scope_invalid');
    const saved = selectedSourceSnapshot(actualRun.configuration);
    if (!saved)
      return {
        ...unboundSelection({
          command: input.command,
          session: input.parentSession,
          workspace: input.workspace,
        }),
        async assertExecutionScope(_request: AuthorizationRequest) {},
      };
    if (
      saved.version !== 1 ||
      !Array.isArray(saved.servers) ||
      !Array.isArray(saved.selection?.serverIds)
    )
      throw new McpAdapterError('mcp_source_capture_unavailable');
    const state = await original(parent, actualExecution, actualRun);
    for (const id of state.snapshot.selection.serverIds)
      assertSnapshot(
        parent,
        state.snapshot,
        id,
        new AbortController().signal,
        'derivations' in state ? state.derivations : [],
      );
    const picked = select({ ...state.capture, servers: state.snapshot.servers }, narrowing);
    if (!picked.servers.length)
      return { ...picked, async assertExecutionScope(_request: AuthorizationRequest) {} };
    const snapshot: McpSelectedSourceSnapshot = seal({
      ...picked.snapshot,
      scope: saved.scope,
      scopeDigest: saved.scopeDigest,
      readSet: saved.readSet,
      inheritance: {
        version: 1,
        parentExecutionId: actualExecution.id,
        parentExecutionDigest: hash(actualExecution.input),
        parentRunId: actualRun.id,
        parentSessionId: parent.session.id,
        rootSessionId: parent.session.rootSessionId,
        rootWorkCommandId: actualExecution.rootWorkCommandId,
        rootWorkSeq: actualExecution.rootWorkSeq,
        parentSnapshotDigest: hash(saved),
        parentSnapshot: structuredClone(saved),
      },
    });
    const validate = async (sessionId: string, runId?: string, descendant = false) => {
      if (!snapshot.servers.length) return null;
      const [child, knownRun] = await Promise.all([
        scope(sessionId),
        runId ? parent.host.getRun(runId) : null,
      ]);
      const view = runId ? null : await child.host.getView(sessionId);
      const active = runId ?? view!.runs.find((run) => run.isActive)?.id;
      const run = knownRun ?? (active ? await child.host.getRun(active) : null);
      const candidate = run ? selectedSourceSnapshot(run.configuration) : undefined;
      let exact = !!candidate && hash(candidate) === hash(snapshot);
      let ancestor = candidate;
      if (descendant)
        for (let depth = 0; !exact && ancestor?.inheritance && depth < 32; depth++) {
          ancestor = ancestor.inheritance.parentSnapshot;
          exact = hash(ancestor) === hash(snapshot);
        }
      if (
        !run ||
        !candidate ||
        !exact ||
        candidate.selection.serverIds.some((id) => !snapshot.selection.serverIds.includes(id))
      )
        throw new McpAdapterError('mcp_source_scope_invalid');
      return inherited(child, run, candidate);
    };
    return {
      ...picked,
      snapshot,
      async assertExecutionScope(request: AuthorizationRequest) {
        const [own] = await Promise.all([
          parent.host.getExecution(request.executionId),
          validate(request.sessionId, request.runId ?? undefined, true),
        ]);
        if (
          !own ||
          own.sessionId !== request.sessionId ||
          own.runId !== request.runId ||
          own.originStoreId !== parent.sourceScope.storeId
        )
          throw new McpAdapterError('mcp_source_scope_invalid');
      },
      sources: {
        async capture(request: Parameters<ContextSources['capture']>[0]) {
          if (!snapshot.servers.length) return [];
          const state = await validate(request.sessionId);
          if (!state || request.workspaceId !== state.capture.scope.workspaceId)
            throw new McpAdapterError('mcp_source_scope_invalid');
          return select(
            { ...state.capture, servers: snapshot.servers },
            { present: true, configurations: snapshot.servers.map(({ id }) => ({ id })) },
          ).sources.capture(request);
        },
      },
    };
  }
  async function original(
    source: Awaited<ReturnType<typeof scope>>,
    own: Awaited<ReturnType<Host['getExecution']>>,
    nearestRun?: RunRecord,
  ) {
    const current = observe(source);
    const selected = select(current.capture, selection(source.sourceScope, source.root)).snapshot;
    if (!own?.runId && !nearestRun) return { ...current, snapshot: selected };
    const run = nearestRun ?? (own?.runId ? await source.host.getRun(own.runId) : null);
    if (
      !run ||
      run.originStoreId !== source.sourceScope.storeId ||
      run.sessionId !== source.session.id
    )
      throw new McpAdapterError('mcp_source_scope_invalid');
    const saved = selectedSourceSnapshot(run.configuration);
    if (saved?.inheritance) return inherited(source, run, saved);
    if (
      !saved ||
      saved.version !== 1 ||
      saved.scopeDigest !== current.capture.scopeDigest ||
      !Array.isArray(saved.servers) ||
      !Array.isArray(saved.selection?.serverIds)
    )
      throw new McpAdapterError('mcp_source_capture_unavailable');
    return { ...current, snapshot: seal(structuredClone(saved)) };
  }
  type Derivation = {
    parent: McpSourceOptions;
    readSet: McpSourceReadSet;
    child: McpSourceOptions;
  };
  async function belongsToRun(host: Host, execution: ExecutionRecord, run: RunRecord) {
    let ancestor: ExecutionRecord | null = execution;
    const seen = new Set<string>();
    while (ancestor && seen.size < 64) {
      if (
        seen.has(ancestor.id) ||
        ancestor.sessionId !== run.sessionId ||
        ancestor.originStoreId !== run.originStoreId ||
        ancestor.rootWorkCommandId !== run.rootWorkCommandId ||
        ancestor.rootWorkSeq !== run.rootWorkSeq
      )
        return false;
      seen.add(ancestor.id);
      if (ancestor.runId) return ancestor.runId === run.id;
      ancestor = ancestor.parentExecutionId
        ? await host.getExecution(ancestor.parentExecutionId)
        : null;
    }
    return false;
  }
  async function inherited(
    source: Awaited<ReturnType<typeof scope>>,
    run: RunRecord,
    saved: McpSelectedSourceSnapshot,
    depth = 0,
  ): Promise<
    ReturnType<typeof observe> & { snapshot: McpSelectedSourceSnapshot; derivations: Derivation[] }
  > {
    const proof = saved.inheritance;
    if (
      !proof ||
      depth >= 32 ||
      proof.version !== 1 ||
      saved.version !== 1 ||
      !Array.isArray(saved.servers) ||
      !Array.isArray(saved.selection?.serverIds) ||
      !proof.parentSnapshot ||
      proof.parentSnapshot.version !== 1 ||
      !Array.isArray(proof.parentSnapshot.selection?.serverIds) ||
      hash(proof.parentSnapshot) !== proof.parentSnapshotDigest
    )
      throw new McpAdapterError('mcp_source_capture_unavailable');
    const [parent, origin, parentRun, parentExecution] = await Promise.all([
      scope(proof.parentSessionId),
      source.host.getCommand(run.originCommandId),
      source.host.getRun(proof.parentRunId),
      source.host.getExecution(proof.parentExecutionId),
    ]);
    // The persisted child-start Command names its original carrier. Read that actual
    // record directly; a full parent View includes unrelated growing Model history.
    const originRequest = object(origin?.request);
    const carrierId =
      origin?.kind === 'child.start' &&
      originRequest.kind === 'child.start' &&
      typeof originRequest.parentExecutionId === 'string'
        ? originRequest.parentExecutionId
        : null;
    const [parentCommand, carrier] = await Promise.all([
      parentExecution ? source.host.getCommand(parentExecution.originCommandId) : null,
      carrierId ? parent.host.getExecution(carrierId) : null,
    ]);
    const role = object(object(run.configuration).snapshot);
    if (
      !origin ||
      !parentRun ||
      !parentExecution ||
      !parentCommand ||
      !carrier ||
      run.originCommandId !== `child-start-${carrier.id}` ||
      source.session.parentSessionId !== parent.session.id ||
      source.session.rootSessionId !== proof.rootSessionId ||
      parent.session.rootSessionId !== proof.rootSessionId ||
      source.workspace.id !== parent.workspace.id ||
      source.identity !== parent.identity ||
      run.sessionId !== source.session.id ||
      run.originStoreId !== source.sourceScope.storeId ||
      origin.sessionId !== source.session.id ||
      origin.originStoreId !== run.originStoreId ||
      origin.subjectId !== parentCommand.subjectId ||
      parentCommand.originStoreId !== run.originStoreId ||
      parentCommand.sessionId !== parent.session.id ||
      parentRun.sessionId !== parent.session.id ||
      parentRun.originStoreId !== run.originStoreId ||
      parentExecution.sessionId !== parent.session.id ||
      parentExecution.originStoreId !== run.originStoreId ||
      !(await belongsToRun(parent.host, parentExecution, parentRun)) ||
      hash(parentExecution.input) !== proof.parentExecutionDigest ||
      carrier.kind !== 'job' ||
      carrier.sessionId !== parent.session.id ||
      carrier.originStoreId !== run.originStoreId ||
      carrier.childSessionId !== source.session.id ||
      carrier.parentExecutionId !== parentExecution.id ||
      !carrier.childConfiguration ||
      (role.roleId !== undefined &&
        (carrier.childConfiguration.id !== role.roleId ||
          carrier.childConfiguration.version !== role.roleVersion)) ||
      hash(carrier.childConfiguration.snapshot) !== hash(run.configuration) ||
      [run, origin, parentRun, parentExecution, carrier, parentCommand].some(
        (fact) =>
          fact.rootWorkCommandId !== proof.rootWorkCommandId ||
          fact.rootWorkSeq !== proof.rootWorkSeq,
      ) ||
      hash(selectedSourceSnapshot(parentRun.configuration)) !== proof.parentSnapshotDigest
    )
      throw new McpAdapterError('mcp_source_scope_invalid');
    const boundParent = proof.parentSnapshot.inheritance
      ? await inherited(parent, parentRun, proof.parentSnapshot, depth + 1)
      : { ...observe(parent), snapshot: proof.parentSnapshot, derivations: [] as Derivation[] };
    if (
      !boundParent.snapshot.readSet ||
      boundParent.snapshot.scopeDigest !== observe(parent).capture.scopeDigest
    )
      throw new McpAdapterError('mcp_source_capture_unavailable');
    const derivation = {
      parent: parent.sourceOptions,
      readSet: boundParent.snapshot.readSet,
      child: source.sourceOptions,
    };
    deriveMcpSourceReadSet(derivation.parent, derivation.readSet, derivation.child);
    const now = observe(source);
    for (const server of saved.servers) {
      if (
        !proof.parentSnapshot.selection.serverIds.includes(server.id) ||
        mcpCanonical(now.capture.servers.find((value) => value.id === server.id)) !==
          mcpCanonical(server)
      )
        throw new McpAdapterError('mcp_source_stale');
    }
    return {
      ...now,
      snapshot: seal({
        version: 1,
        scope: now.capture.scope,
        scopeDigest: now.capture.scopeDigest,
        selection: saved.selection,
        servers: saved.servers,
        readSet: now.capture.readSet,
      }),
      derivations: [...boundParent.derivations, derivation],
    };
  }
  function assertSnapshot(
    source: Awaited<ReturnType<typeof scope>>,
    expected: McpSelectedSourceSnapshot,
    serverId: string,
    signal: AbortSignal,
    derivations: readonly Derivation[] = [],
  ) {
    signal.throwIfAborted();
    for (const value of derivations)
      deriveMcpSourceReadSet(value.parent, value.readSet, value.child);
    const now = observe(source);
    if (
      !expected.selection.serverIds.includes(serverId) ||
      mcpCanonical(now.capture.readSet) !== mcpCanonical(expected.readSet)
    )
      throw new McpAdapterError('mcp_source_stale');
    const server = now.capture.servers.find((server) => server.id === serverId),
      prior = expected.servers.find((server) => server.id === serverId);
    if (
      !server?.admitted ||
      !prior ||
      mcpCanonical(server) !== mcpCanonical(prior) ||
      !select(
        now.capture,
        selection(source.sourceScope, source.root),
      ).snapshot.selection.serverIds.includes(serverId)
    )
      throw new McpAdapterError('mcp_source_stale');
    return now;
  }
  type Replacement = { expectedConfigDigest: string; expectedReadSet: McpSourceReadSet };
  const closedKeys = (value: unknown, keys: readonly string[]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const actual = Object.keys(value);
    return actual.length === keys.length && actual.every((key) => keys.includes(key));
  };
  async function verifyReplacementParent(
    source: Awaited<ReturnType<typeof scope>>,
    own: ExecutionRecord,
    input: { serverId: string; sessionId: string; executionId: string },
    replacement: Replacement,
  ) {
    const value = object(own.input),
      next = object(value.replacement),
      target = object(value.target),
      ref = object(target.operationRef);
    const validId = (v: unknown, max = 128) =>
      typeof v === 'string' && new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`).test(v);
    const validDigest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
    const refKey = typeof ref.key === 'string' ? ref.key : '';
    const refSuffix = refKey.slice(`connection/${input.serverId}/`.length);
    const command = own.originCommandId ? await source.host.getCommand(own.originCommandId) : null;
    const request = object(command?.request);
    if (
      !options.observerSubjectId ||
      !command ||
      command.id !== own.originCommandId ||
      command.kind !== 'extension.invoke' ||
      command.originStoreId !== source.sourceScope.storeId ||
      command.sessionId !== source.session.id ||
      command.subjectId !== options.observerSubjectId ||
      command.cancelRequestedAt !== null ||
      own.cancelRequestedAt !== null ||
      !['dispatching', 'running'].includes(own.status) ||
      command.rootWorkCommandId !== own.rootWorkCommandId ||
      command.rootWorkSeq !== own.rootWorkSeq ||
      !closedKeys(request, ['kind', 'extensionId', 'actionId', 'definitionVersion', 'input']) ||
      request.kind !== 'extension.invoke' ||
      request.extensionId !== 'builtin.mcp' ||
      request.actionId !== 'mcp.reconnect' ||
      request.definitionVersion !== '1' ||
      hash(command.request) !== command.requestDigest ||
      hash(request.input) !== hash(own.input) ||
      mcpCanonical(request.input) !== mcpCanonical(own.input) ||
      own.id !== input.executionId ||
      own.kind !== 'job' ||
      own.definitionId !== 'builtin.mcp/mcp.reconnect' ||
      own.definitionVersion !== '1' ||
      own.originStoreId !== source.sourceScope.storeId ||
      own.sessionId !== input.sessionId ||
      input.sessionId !== source.session.id ||
      !closedKeys(value, ['serverId', 'key', 'target', 'replacement']) ||
      value.serverId !== input.serverId ||
      !validId(value.serverId) ||
      !validId(value.key, 64) ||
      !validId(target.carrierExecutionId) ||
      !validId(target.carrierKey, 64) ||
      !validId(target.connectionExecutionId) ||
      !validDigest(target.configDigest) ||
      !Number.isSafeInteger(target.currentGeneration) ||
      Number(target.currentGeneration) < 1 ||
      !validId(ref.commandId) ||
      !validId(ref.executionId) ||
      ref.extensionId !== 'builtin.mcp' ||
      ref.originStoreId !== source.sourceScope.storeId ||
      ref.sessionId !== source.session.id ||
      ref.executionId !== target.connectionExecutionId ||
      !refKey.startsWith(`connection/${input.serverId}/`) ||
      !validId(refSuffix, 64) ||
      value.key === target.carrierKey ||
      value.key === refSuffix ||
      ref.commandId === command.id ||
      !validDigest(next.expectedConfigDigest) ||
      !closedKeys(target, [
        'carrierExecutionId',
        'carrierKey',
        'operationRef',
        'connectionExecutionId',
        'configDigest',
        'currentGeneration',
      ]) ||
      !closedKeys(target.operationRef, [
        'commandId',
        'sessionId',
        'originStoreId',
        'extensionId',
        'key',
        'executionId',
      ]) ||
      !closedKeys(next, ['kind', 'expectedConfigDigest', 'expectedReadSet']) ||
      next.kind !== 'source' ||
      next.expectedConfigDigest !== replacement.expectedConfigDigest ||
      mcpCanonical(next.expectedReadSet) !== mcpCanonical(replacement.expectedReadSet)
    )
      throw new McpAdapterError('operation_unverifiable');
  }
  async function resolveSource(
    input: { serverId: string; sessionId: string; executionId: string },
    { signal }: { signal: AbortSignal },
    replacement?: Replacement,
  ): Promise<McpScopedSourceResolution> {
    const source = await scope(input.sessionId);
    const own = await source.host.getExecution(input.executionId);
    if (
      !own ||
      own.originStoreId !== source.sourceScope.storeId ||
      own.sessionId !== source.session.id ||
      own.definitionVersion !== '1' ||
      !(replacement
        ? own.kind === 'job' && own.definitionId === 'builtin.mcp/mcp.reconnect'
        : ['mcp.connect', 'builtin.mcp/mcp.connect'].includes(own.definitionId))
    )
      throw new McpAdapterError('operation_unverifiable');
    const current = replacement ? observe(source) : null;
    const state: ReturnType<typeof observe> & {
      snapshot: McpSelectedSourceSnapshot;
      derivations?: readonly Derivation[];
    } = current
      ? {
          ...current,
          snapshot: select(current.capture, selection(source.sourceScope, source.root)).snapshot,
        }
      : await original(source, own);
    const expected = state.snapshot;
    if (replacement) await verifyReplacementParent(source, own, input, replacement);

    const fresh = ({ signal }: { signal: AbortSignal }) => {
      assertSnapshot(source, expected, input.serverId, signal, state.derivations ?? []);
    };
    const now = assertSnapshot(source, expected, input.serverId, signal, state.derivations ?? []);
    const entry = now.state.entries.find((entry) => entry.server.id === input.serverId)!;
    const transport = configuration(entry, source.root)!;
    const configDigest = createMcpAdapter({ id: input.serverId, transport }).getCatalogue()
      .configDigest;
    if (
      replacement &&
      (configDigest !== replacement.expectedConfigDigest ||
        mcpCanonical(expected.readSet) !== mcpCanonical(replacement.expectedReadSet))
    )
      throw new McpAdapterError('mcp_source_stale');
    await acceptedMetadata(source, now.state, entry);
    fresh({ signal });
    const snapshotDigest = hash({ snapshot: expected, serverId: input.serverId });
    const captureDigest = replacement
      ? hash({ snapshot: expected, serverId: input.serverId, parentInputDigest: hash(own.input) })
      : snapshotDigest;
    const admit = async (
      binding: Parameters<McpLifecycleTransportPort['open']>[0],
      { signal }: { signal: AbortSignal },
    ) => {
      signal.throwIfAborted();
      const job = await source.host.getExecution(binding.executionId);
      if (
        !job ||
        job.kind !== 'job' ||
        job.definitionId !== mcpSourceConnectionJobId ||
        job.definitionVersion !== '1' ||
        job.originStoreId !== source.sourceScope.storeId ||
        job.sessionId !== source.session.id ||
        !['dispatching', 'running'].includes(job.status) ||
        binding.originalStoreId !== job.originStoreId ||
        binding.sessionId !== job.sessionId ||
        binding.serverId !== input.serverId ||
        binding.configDigest !== configDigest ||
        object(job.input).parentExecutionId !== own.id ||
        object(job.input).parentInputDigest !== hash(own.input) ||
        object(job.input).captureDigest !== captureDigest ||
        object(job.input).configDigest !== configDigest ||
        object(job.input).originStoreId !== job.originStoreId ||
        !object(job.input).bootstrapId
      )
        throw new McpAdapterError('operation_unverifiable');
      if (replacement) {
        if (
          job.parentExecutionId !== own.id ||
          job.runId !== own.runId ||
          job.rootWorkCommandId !== own.rootWorkCommandId ||
          job.rootWorkSeq !== own.rootWorkSeq ||
          !closedKeys(job.input, [
            'serverId',
            'configDigest',
            'originStoreId',
            'key',
            'bootstrapId',
            'captureDigest',
            'parentExecutionId',
            'parentInputDigest',
          ]) ||
          typeof object(job.input).bootstrapId !== 'string' ||
          typeof object(job.input).key !== 'string' ||
          object(job.input).serverId !== input.serverId
        )
          throw new McpAdapterError('operation_unverifiable');
        const currentParent = await source.host.getExecution(own.id);
        if (!currentParent || hash(currentParent.input) !== hash(own.input))
          throw new McpAdapterError('operation_unverifiable');
        await verifyReplacementParent(source, currentParent, input, replacement);
      }
      fresh({ signal });
      const current = observe(source);
      await acceptedMetadata(
        source,
        current.state,
        current.state.entries.find((entry) => entry.server.id === input.serverId)!,
      );
      fresh({ signal });
    };
    let port: McpLifecycleTransportPort;
    if (transport.type === 'http') {
      const savedBinding = entry.credentialBinding;
      port = createMcpHttpTransportPort({
        ...options.http,
        servers: [
          {
            id: input.serverId,
            url: transport.url,
            ...(savedBinding
              ? {
                  credential: {
                    broker,
                    async bind(binding, { signal }) {
                      await admit(binding, { signal });
                      fresh({ signal });
                      const identity: McpCredentialIdentity = {
                        profileId: profile.profileAccessKey,
                        originalStoreId: source.sourceScope.storeId,
                        workspaceId: source.workspace.id,
                        workspaceIdentity: source.identity,
                        sessionId: source.session.id,
                        connectionExecutionId: binding.executionId,
                        source: {
                          kind: entry.server.source.kind,
                          id: entry.server.source.pathDigest,
                          revision: entry.server.rawEntryDigest,
                        },
                        serverId: input.serverId,
                        configDigest,
                        authProfileId: savedBinding.authProfile,
                        policyRevision: hash(savedBinding),
                      };
                      const issued = broker.issue({
                        identity,
                        purpose: 'mcp.http',
                        credentialRef: savedBinding.vaultRef,
                        expiresAt: savedBinding.expiresAt,
                        revocationRevision: 0,
                      });
                      fresh({ signal });
                      return { ref: issued, identity, revocationRevision: 0 };
                    },
                  },
                }
              : {}),
          },
        ],
        admit,
        assertFresh: (_binding, { signal }) => fresh({ signal }),
      });
    } else {
      if (!options.stdio) throw new McpAdapterError('mcp_stdio_asset_unavailable');
      port = createMcpStdioTransportPort({
        ...options.stdio,
        servers: [
          {
            id: input.serverId,
            configuration: { ...transport, args: [...transport.args], env: { ...transport.env } },
          },
        ],
        allowedEnvNames: Object.keys(transport.env),
        admit,
        assertFresh: (_binding, { signal }) => fresh({ signal }),
      });
    }
    if (replacement) {
      fresh({ signal });
      const binding = {
        sessionId: source.session.id,
        originStoreId: own.originStoreId,
        serverId: input.serverId,
        configDigest,
        parentInputDigest: hash(own.input),
        captureDigest,
      };
      const prior = replacements.get(own.id);
      if (
        (prior && mcpCanonical(prior) !== mcpCanonical(binding)) ||
        (!prior && replacements.size >= 512)
      )
        throw new McpAdapterError('mcp_scope_limit');
      replacements.set(own.id, Object.freeze(binding));
    }
    return Object.freeze({
      server: seal({
        id: input.serverId,
        transport,
        ...(typeof entry.transport?.timeout === 'number'
          ? { limits: { timeoutMs: entry.transport.timeout } }
          : {}),
      }),
      captureDigest,
      snapshotDigest,
      transportPort: port,
      assertFresh: fresh,
    });
  }
  const sourcePort: McpScopedSourcePort = {
    resolve: (input, options) => resolveSource(input, options),
    resolveReplacement: (input, options) => resolveSource(input, options, input),
  };
  function page(servers: McpSourceCapture['servers'], input: Json) {
    const request = object(input),
      limit = Number(request.limit ?? 100);
    const remaining = [...servers]
      .sort((a, b) => a.id.localeCompare(b.id))
      .filter((server) => !request.afterId || server.id > String(request.afterId));
    const items = remaining.slice(0, limit);
    return { items, nextAfterId: remaining.length > limit ? items.at(-1)!.id : null };
  }
  async function directory(input: Json, context: ActionContext): Promise<ToolResult> {
    try {
      const source = await scope(context.sessionId),
        own = await source.host.getExecution(context.executionId);
      if (
        !own ||
        own.originStoreId !== source.sourceScope.storeId ||
        own.sessionId !== context.sessionId ||
        own.definitionId !== mcpSourcesDirectoryToolId ||
        own.definitionVersion !== '1'
      )
        throw new McpAdapterError('operation_unverifiable');
      const state = await original(source, own);
      for (const id of state.snapshot.selection.serverIds)
        assertSnapshot(
          source,
          state.snapshot,
          id,
          context.signal,
          'derivations' in state ? state.derivations : [],
        );
      return {
        outcome: 'succeeded',
        content: JSON.stringify({
          source: 'local_mcp_metadata',
          ...page(state.snapshot.servers, input),
          scopeDigest: state.snapshot.scopeDigest,
        }),
        details: { connectionAttempted: false, credentialLookupAttempted: false },
      };
    } catch (error) {
      return {
        outcome: context.signal.aborted ? 'cancelled' : 'failed',
        content:
          error instanceof AgentError ||
          error instanceof McpAdapterError ||
          error instanceof ConfigurationError
            ? error.message
            : 'mcp_source_unavailable',
        details: { connectionAttempted: false, credentialLookupAttempted: false },
      };
    }
  }
  async function saveMetadata(
    kind: 'approval' | 'credential',
    input: Json,
    context: ActionContext,
  ): Promise<ToolResult> {
    let mutation:
      | { commandId: string; expectedStoreId: string; subjectId: string; requestDigest: string }
      | undefined;
    let published = false;
    const failure = (code: string): ToolResult => ({
      outcome: context.signal.aborted ? 'cancelled' : 'failed',
      content: code,
      details: { effectAttempted: false },
    });
    try {
      const request = object(input),
        source = await scope(context.sessionId),
        host = source.host;
      const own = await host.getExecution(context.executionId);
      const command = own?.originCommandId ? await host.getCommand(own.originCommandId) : null;
      const actionId = kind === 'approval' ? 'mcp.source.approve' : 'mcp.credential.bind';
      if (
        !own ||
        !command ||
        own.originStoreId !== source.sourceScope.storeId ||
        own.sessionId !== context.sessionId ||
        own.definitionId !== `${mcpSourcesExtensionId}/${actionId}` ||
        own.definitionVersion !== '1' ||
        command.originStoreId !== source.sourceScope.storeId ||
        command.sessionId !== context.sessionId
      )
        return failure('operation_unverifiable');
      const observed = observe(source),
        entry = observed.state.entries.find((entry) => entry.server.id === request.serverId);
      if (
        !entry?.binding ||
        !entry.transport ||
        mcpCanonical(observed.capture.readSet) !== mcpCanonical(request.expectedReadSet)
      )
        return failure('mcp_source_conflict');
      if (kind === 'approval' && entry.server.source.kind !== 'workspace')
        return failure('mcp_source_approval_not_required');
      const auth = object(entry.transport.auth);
      if (kind === 'credential' && auth.type !== 'credential')
        return failure('mcp_auth_unavailable');
      if (!context.requestInteractionWithReceipt) return failure('mcp_source_decision_unavailable');
      context.signal.throwIfAborted();
      const question: Json = {
        kind: kind === 'approval' ? 'mcp_source_approval' : 'mcp_credential_binding',
        executionId: own.id,
        originalStoreId: source.sourceScope.storeId,
        sessionId: context.sessionId,
        server: entry.server as unknown as Json,
        readSet: observed.capture.readSet as unknown as Json,
        ...(kind === 'credential'
          ? {
              authProfileDigest: hash(auth.profile),
              credentialReferenceDigest: hash(auth.credentialRef),
              expiresAt: request.expiresAt!,
              choices: ['bind', 'revoke', 'cancel'],
            }
          : {
              choices: ['approved', 'rejected', 'cancel'],
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['decision'],
                properties: {
                  decision: { type: 'string', enum: ['approved', 'rejected', 'cancel'] },
                },
              },
            }),
        instruction:
          'Decide this exact private configured source fingerprint. This does not connect or grant any Tool permission.',
      };
      const accepted = await context.requestInteractionWithReceipt({
        kind: 'question',
        request: question,
      });
      context.signal.throwIfAborted();
      const actual = await host.getInteraction({
        expectedStoreId: source.sourceScope.storeId,
        sessionId: context.sessionId,
        interactionId: accepted.interactionId,
      });
      if (
        !actual ||
        actual.kind !== 'question' ||
        actual.state !== 'answered' ||
        actual.originStoreId !== source.sourceScope.storeId ||
        actual.sessionId !== context.sessionId ||
        actual.executionId !== own.id ||
        actual.runId !== own.runId ||
        actual.subjectId !== command.subjectId ||
        actual.definitionId !== own.definitionId ||
        actual.definitionVersion !== '1' ||
        actual.acceptedDecisionRevision !== accepted.decisionRevision ||
        accepted.originStoreId !== actual.originStoreId ||
        accepted.sessionId !== actual.sessionId ||
        accepted.runId !== actual.runId ||
        accepted.executionId !== actual.executionId ||
        mcpCanonical(actual.request) !== mcpCanonical(question) ||
        mcpCanonical(accepted.request) !== mcpCanonical(question) ||
        mcpCanonical(actual.answer) !== mcpCanonical(accepted.answer) ||
        accepted.answer.kind !== 'question'
      )
        return failure('mcp_source_decision_invalid');
      const decision = String(object(accepted.answer.answers).decision ?? '');
      const proof = {
        decisionId: `${actual.id}@${accepted.decisionRevision}`,
        storeId: actual.originStoreId,
        sessionId: actual.sessionId,
        interactionId: actual.id,
        acceptedRevision: accepted.decisionRevision,
        subjectId: actual.subjectId,
        requestDigest: hash(question),
        recordedAt: Date.now(),
      };
      if (decision === 'cancel')
        return {
          outcome: 'cancelled',
          content: 'mcp_source_decision_cancelled',
          details: {
            effectAttempted: false,
            ...(kind === 'approval' ? { decision: 'cancel', proof: proof as unknown as Json } : {}),
          },
        };
      if (
        !(kind === 'approval' ? ['approved', 'rejected'] : ['bind', 'revoke']).includes(
          String(decision),
        )
      )
        return failure('mcp_source_decision_invalid');
      const value: McpSourceApproval | McpSourceCredentialBinding =
        kind === 'approval'
          ? {
              ...entry.binding,
              kind: 'mcp_source_approval',
              decision: decision as 'approved' | 'rejected',
              proof,
            }
          : {
              ...entry.binding,
              kind: 'mcp_credential_binding',
              authProfile: String(auth.profile),
              purpose: 'mcp.http',
              vaultRef: String(auth.credentialRef),
              expiresAt: Number(request.expiresAt),
              revoked: decision === 'revoke',
              proof,
            };
      mutation = {
        commandId: `mcp-source-${own.id}`,
        expectedStoreId: source.sourceScope.storeId,
        subjectId: command.subjectId,
        requestDigest: hash({ executionId: own.id, inputDigest: hash(own.input), value }),
      };
      const target = kind === 'approval' ? observed.state.approvals : observed.state.bindings;
      const begun = await host.beginHostMutation({
        ...mutation,
        kind: 'config.user.write',
        scope: 'user',
        safeRequest: { scope: 'user', ifMatch: target.etag!, operationCount: 1 },
      });
      if (!begun.created)
        return {
          outcome:
            begun.record.state === 'applied'
              ? 'succeeded'
              : begun.record.state === 'failed'
                ? 'failed'
                : 'outcome_unknown',
          content: `mcp_source_mutation_${begun.record.state}`,
          details: { mutation: begun.record as unknown as Json },
        };
      context.signal.throwIfAborted();
      const receipt = writeMcpSourceMetadata({
        ...source.sourceOptions,
        variables: options.variables?.() ?? {},
        expectedReadSet: request.expectedReadSet as unknown as McpSourceReadSet,
        value,
        validateDecision: (saved, binding) => {
          context.signal.throwIfAborted();
          return (
            mcpCanonical(saved) === mcpCanonical(proof) &&
            mcpCanonical(binding) === mcpCanonical(entry.binding)
          );
        },
        afterPublication: () => {
          published = true;
        },
      });
      try {
        const record = await host.finishHostMutation({
          ...mutation,
          state: 'applied',
          receipt: { status: 'applied', etag: receipt.etag },
        });
        return {
          outcome: 'succeeded',
          content:
            kind === 'approval'
              ? 'Exact MCP source decision saved; no connection or Tool grant created'
              : 'Exact credential binding metadata saved; no vault lookup or connection created',
          details: {
            mutation: record as unknown as Json,
            recordKey: receipt.recordKey,
            decision,
            proof: proof as unknown as Json,
            connectionAttempted: false,
            credentialLookupAttempted: false,
          },
        };
      } catch {
        return {
          outcome: 'outcome_unknown',
          content: 'mutation_outcome_unknown',
          details: { mutationId: mutation.commandId },
        };
      }
    } catch (error) {
      const code =
        error instanceof AgentError ||
        error instanceof McpAdapterError ||
        error instanceof ConfigurationError
          ? error.message
          : 'mcp_source_unavailable';
      if (mutation) {
        const uncertain = published || code === 'mcp_source_publication_unknown';
        try {
          await runtime().finishHostMutation({
            ...mutation,
            state: uncertain ? 'outcome_unknown' : 'failed',
            receipt: { status: uncertain ? 'outcome_unknown' : 'failed', code },
          });
        } catch {
          return {
            outcome: 'outcome_unknown',
            content: 'mutation_outcome_unknown',
            details: { mutationId: mutation.commandId },
          };
        }
        if (uncertain)
          return {
            outcome: 'outcome_unknown',
            content: code,
            details: { mutationId: mutation.commandId },
          };
      }
      return failure(code);
    }
  }
  const extension: Extension = {
    id: mcpSourcesExtensionId,
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: mcpSourcesDirectoryToolId,
        version: '1',
        description:
          'Read selected safe MCP IDs and names without connecting; metadata grants no permission',
        inputSchema: pageSchema,
        execute: directory,
      },
    ],
    queries: [
      createMcpSourceResultQuery({
        runtime,
        profileAccessKey: options.profile.profileAccessKey,
        observerSubjectId: options.observerSubjectId,
      }),
      {
        id: 'mcp.sources',
        version: '1',
        description: 'Read current safe source metadata without connecting or vault lookup',
        inputSchema: pageSchema,
        outputSchema: { type: 'array' },
        async execute(input, context) {
          let payload: Json;
          try {
            const source = await scope(context.sessionId),
              current = observe(source);
            payload = {
              ...page(current.capture.servers, input),
              readSet: current.capture.readSet,
              registryRevision: current.capture.registryRevision,
              errors: current.state.registry.errors,
            } as unknown as Json;
          } catch (error) {
            const code =
              error instanceof AgentError || error instanceof ConfigurationError
                ? error.code
                : 'mcp_source_unavailable';
            // A unavailable source remains observable local metadata, never a reconnect/retry signal.
            payload = {
              items: [],
              nextAfterId: null,
              readSet: null,
              registryRevision: null,
              errors: [code],
            };
          }
          return [
            {
              extensionId: mcpSourcesExtensionId,
              contentType: 'builtin.mcp.sources',
              contentVersion: 1,
              summary: 'Local MCP source metadata; source admission is not execution permission',
              payload,
              artifactRefs: [],
              actions: [],
            },
          ];
        },
      },
    ],
    actions: [
      {
        id: 'mcp.source.approve',
        version: '1',
        description:
          'Ask the user to approve or reject the exact project source; no connection or Tool grant',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['serverId', 'expectedReadSet'],
          properties: {
            serverId: { type: 'string', pattern: '^mcp-[a-f0-9]{64}$' },
            expectedReadSet: readSetSchema,
          },
        },
        prepare: async (input: Json, _context: ReadContext) => structuredClone(input),
        execute: (input, context) => saveMetadata('approval', input, context),
      },
      {
        id: 'mcp.credential.bind',
        version: '1',
        description:
          'Ask the user to bind or revoke the exact configured opaque Bearer reference; metadata only',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['serverId', 'expectedReadSet', 'expiresAt'],
          properties: {
            serverId: { type: 'string', pattern: '^mcp-[a-f0-9]{64}$' },
            expectedReadSet: readSetSchema,
            expiresAt: { type: 'integer', minimum: 1 },
          },
        },
        prepare: async (input: Json, _context: ReadContext) => structuredClone(input),
        execute: (input, context) => saveMetadata('credential', input, context),
      },
    ],
  };
  const describe = (request: AuthorizationRequest): CapabilityDescription | null => {
    if (
      request.kind === 'tool' &&
      request.definitionId === mcpSourcesDirectoryToolId &&
      request.definitionVersion === '1'
    )
      return {
        kind: 'tool',
        definitionId: request.definitionId,
        definitionVersion: '1',
        revision: 'builtin.mcp.sources:1',
        effects: ['read'],
        hardAllowed: true,
        safeRead: true,
      };
    if (
      request.kind === 'job' &&
      request.definitionId === mcpSourceConnectionJobId &&
      request.definitionVersion === '1'
    )
      return {
        kind: 'job',
        definitionId: request.definitionId,
        definitionVersion: '1',
        revision: 'builtin.mcp.sources:1',
        effects: ['unknown'],
        hardAllowed: true,
        safeRead: false,
      };
    if (
      request.kind === 'job' &&
      [
        `${mcpSourcesExtensionId}/mcp.source.approve`,
        `${mcpSourcesExtensionId}/mcp.credential.bind`,
      ].includes(request.definitionId) &&
      request.definitionVersion === '1'
    )
      return {
        kind: 'job',
        definitionId: request.definitionId,
        definitionVersion: '1',
        revision: 'builtin.mcp.sources:1',
        effects: ['workspace_write'],
        hardAllowed: true,
        safeRead: false,
      };
    return null;
  };
  function unboundSelection(
    input: {
      command: Pick<CommandRecord, 'originStoreId' | 'sessionId'>;
      session: Pick<SessionRecord, 'id' | 'workspaceId'>;
      workspace: Pick<WorkspaceRecord, 'id'>;
    },
    choice: McpSourceSelectionInput = { present: false, configurations: [] },
  ) {
    if (
      input.command.sessionId !== input.session.id ||
      input.session.workspaceId !== input.workspace.id
    )
      throw new AgentError('mcp_source_scope_invalid');
    const scope: McpSourceScope = {
      profileId: profile.profileAccessKey,
      storeId: input.command.originStoreId,
      sessionId: input.session.id,
      workspaceId: input.workspace.id,
    };
    const snapshot: McpSelectedSourceSnapshot = seal({
      version: 1,
      scope,
      scopeDigest: hash({ scope, host: 'unbound' }),
      selection: { present: choice.present, serverIds: [] },
      servers: [],
      readSet: null,
    });
    return {
      snapshot,
      servers: snapshot.servers,
      directoryToolId: mcpSourcesDirectoryToolId,
      sources: {
        async capture() {
          return [];
        },
      } satisfies ContextSources,
      admissionError(request: AuthorizationRequest) {
        const value = object(request.input),
          binding = object(value.binding);
        const serverId = value.serverId ?? binding.serverId;
        return request.definitionId === mcpSourceConnectionJobId ||
          (typeof serverId === 'string' &&
            /^mcp-[a-f0-9]{64}$/.test(serverId) &&
            !programmatic.has(serverId))
          ? 'mcp_source_host_unbound'
          : null;
      },
    };
  }
  return {
    deriveChildSelection,
    sourcePort,
    extension,
    capture,
    select,
    unboundSelection,
    describe,
    registry(sourceScope: {
      storeId: string;
      sessionId: string;
      workspaceId: string;
      workspacePath: string;
    }) {
      const sourceOptions: McpSourceOptions = {
        profilePath: profile.profilePath,
        workspacePath: sourceScope.workspacePath,
        scope: {
          profileId: profile.profileAccessKey,
          storeId: sourceScope.storeId,
          sessionId: sourceScope.sessionId,
          workspaceId: sourceScope.workspaceId,
        },
        variables: options.variables?.() ?? {},
      };
      const current = observe({
        root: sourceScope.workspacePath,
        sourceScope: sourceOptions.scope,
        sourceOptions,
      });
      return {
        revision: current.capture.registryRevision,
        servers: current.capture.servers
          .filter((server) => server.configDigest !== null)
          .map((server) => ({
            id: server.id,
            configDigest: server.configDigest!,
            transport: server.transport!,
            source: {
              kind: server.source.kind,
              id: server.source.pathDigest,
              revision: server.rawEntryDigest,
            },
            admitted: server.admitted,
          })),
      };
    },
    listCapabilities() {
      return [
        describe({
          kind: 'tool',
          definitionId: mcpSourcesDirectoryToolId,
          definitionVersion: '1',
        } as AuthorizationRequest)!,
        describe({
          kind: 'job',
          definitionId: mcpSourceConnectionJobId,
          definitionVersion: '1',
        } as AuthorizationRequest)!,
        ...extension.actions!.map(
          (action) =>
            describe({
              kind: 'job',
              definitionId: `${extension.id}/${action.id}`,
              definitionVersion: action.version,
            } as AuthorizationRequest)!,
        ),
      ];
    },
  };
}
