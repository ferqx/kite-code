import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentError, type AgentRuntime } from '@kite-ai/agent';
import {
  ConfigurationError,
  type JsonObject,
  type McpRegistry,
  type McpSelectionReadSet,
  mcpCanonical,
  readMcpSelection,
  updateMcpSelection,
} from '@kite-ai/agent/config';
import type {
  ActionContext,
  AuthorizationRequest,
  Extension,
  Json,
  ReadContext,
  ToolResult,
} from '@kite-ai/agent/extensions';
import type { ProfileSelection } from '@kite-ai/agent/profile';
import type { CapabilityDescription } from './permissions';

export const mcpManagementExtensionId = 'builtin.mcp.management';
const actionId = 'mcp.server.select';
export interface McpManagementScope {
  storeId: string;
  sessionId: string;
  workspaceId: string;
  workspaceIdentity: string;
  /** Canonical root read with this actual Store/Session/Workspace scope. */
  workspacePath: string;
}
type Host = Pick<
  AgentRuntime,
  | 'getMetadata'
  | 'getSession'
  | 'getWorkspace'
  | 'getExecution'
  | 'getCommand'
  | 'beginHostMutation'
  | 'finishHostMutation'
>;
/** Host composition only. Registry is trusted current source admission, never client policy. */
export function createMcpManagement(options: {
  runtime: Host | (() => Host);
  profile: ProfileSelection;
  explicit: () => JsonObject;
  registry: (scope: McpManagementScope) => McpRegistry;
}) {
  const host = () => (typeof options.runtime === 'function' ? options.runtime() : options.runtime);
  async function sources(context: ReadContext) {
    const runtime = host();
    const storeId = (await runtime.getMetadata()).storeId;
    const session = await runtime.getSession(context.sessionId);
    if (!session || session.deletedAt !== null) throw new AgentError('session_not_found');
    const workspace = await runtime.getWorkspace(session.workspaceId);
    if (!workspace) throw new AgentError('workspace_missing');
    const uri = new URL(workspace.rootUri);
    if (uri.protocol !== 'file:' || (uri.hostname && uri.hostname !== 'localhost'))
      throw new AgentError('workspace_configuration_unavailable');
    const lexical = fileURLToPath(uri),
      stat = lstatSync(lexical, { bigint: true }),
      root = realpathSync(lexical);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new AgentError('workspace_configuration_unavailable');
    const identity = mcpCanonical({ root, dev: String(stat.dev), ino: String(stat.ino) });
    const scope: McpManagementScope = {
      storeId,
      sessionId: session.id,
      workspaceId: workspace.id,
      workspaceIdentity: identity,
      workspacePath: root,
    };
    return {
      scope,
      userPath: join(options.profile.profilePath, 'config.jsonc'),
      workspacePath: join(root, 'kite-agent.jsonc'),
      sourceIdentity: mcpCanonical(scope),
      validateSource: () => {
        const current = lstatSync(lexical, { bigint: true });
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          mcpCanonical({
            root: realpathSync(lexical),
            dev: String(current.dev),
            ino: String(current.ino),
          }) !== identity
        )
          throw new AgentError('workspace_identity_changed');
      },
      explicit: options.explicit,
      registry: () => options.registry(Object.freeze({ ...scope })),
    };
  }
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['serverId', 'enabled', 'scope', 'expectedReadSet'],
    properties: {
      serverId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
      enabled: { type: 'boolean' },
      scope: { enum: ['user', 'workspace'] },
      expectedReadSet: {
        type: 'object',
        additionalProperties: false,
        required: [
          'userEtag',
          'workspaceEtag',
          'explicitDigest',
          'registryDigest',
          'registryRevision',
          'scopeDigest',
        ],
        properties: {
          userEtag: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          workspaceEtag: { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' },
          explicitDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          registryDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          registryRevision: { type: 'string', minLength: 1, maxLength: 4096 },
          scopeDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        },
      },
    },
  };
  async function select(input: Json, context: ActionContext): Promise<ToolResult> {
    const runtime = host();
    const request = structuredClone(input) as unknown as {
      serverId: string;
      enabled: boolean;
      scope: 'user' | 'workspace';
      expectedReadSet: McpSelectionReadSet;
    };
    const fail = (code: string): ToolResult => ({
      outcome: context.signal.aborted ? 'cancelled' : 'failed',
      content: code,
      details: { effectAttempted: false },
    });
    let accepted: Awaited<ReturnType<Host['beginHostMutation']>> | undefined;
    let identity:
      | { commandId: string; expectedStoreId: string; subjectId: string; requestDigest: string }
      | undefined;
    try {
      const source = await sources(context);
      const own = await runtime.getExecution(context.executionId);
      const command = own?.originCommandId ? await runtime.getCommand(own.originCommandId) : null;
      if (
        !own ||
        own.id !== context.executionId ||
        own.originStoreId !== source.scope.storeId ||
        own.sessionId !== context.sessionId ||
        own.definitionId !== `${mcpManagementExtensionId}/${actionId}` ||
        own.definitionVersion !== '1' ||
        !command ||
        command.sessionId !== context.sessionId ||
        command.originStoreId !== source.scope.storeId
      )
        return fail('operation_unverifiable');
      const observed = readMcpSelection(source);
      if (mcpCanonical(observed.readSet) !== mcpCanonical(request.expectedReadSet))
        return fail('configuration_read_set_conflict');
      if (
        !observed.registry.servers.some(
          (server) => server.id === request.serverId && server.admitted,
        )
      )
        return fail('mcp_server_not_admitted');
      context.signal.throwIfAborted();
      const requestDigest = createHash('sha256')
        .update(
          mcpCanonical({
            executionId: own.id,
            inputDigest: (await context.getExecution(own.id))?.inputDigest ?? null,
            ...request,
          }),
        )
        .digest('hex');
      identity = {
        commandId: `mcp-select-${own.id}`,
        expectedStoreId: source.scope.storeId,
        subjectId: command.subjectId,
        requestDigest,
      };
      accepted = await runtime.beginHostMutation({
        ...identity,
        kind: request.scope === 'user' ? 'config.user.write' : 'config.workspace.write',
        scope: request.scope === 'user' ? 'user' : source.scope.workspaceId,
        safeRequest: {
          scope: request.scope,
          ...(request.scope === 'workspace' ? { workspaceId: source.scope.workspaceId } : {}),
          ifMatch:
            request.scope === 'user'
              ? request.expectedReadSet.userEtag
              : request.expectedReadSet.workspaceEtag!,
          operationCount: 1,
        },
      });
      if (!accepted.created)
        return {
          outcome:
            accepted.record.state === 'applied'
              ? 'succeeded'
              : accepted.record.state === 'failed'
                ? 'failed'
                : 'outcome_unknown',
          content: `mcp_selection_${accepted.record.state}`,
          details: { mutation: accepted.record as unknown as Json },
        };
      context.signal.throwIfAborted();
      const document = updateMcpSelection({ ...source, ...request });
      let final: Awaited<ReturnType<Host['finishHostMutation']>>;
      try {
        final = await runtime.finishHostMutation({
          ...identity,
          state: 'applied',
          receipt: { status: 'applied', etag: document.etag },
        });
      } catch {
        return {
          outcome: 'outcome_unknown',
          content: 'mutation_outcome_unknown',
          details: { mutationId: identity.commandId },
        };
      }
      return {
        outcome: 'succeeded',
        content:
          'MCP server selection saved; current Run and connection retain their original configuration',
        details: {
          mutation: final as unknown as Json,
          binding: {
            executionId: own.id,
            originCommandId: command.id,
            originalStoreId: own.originStoreId,
            sessionId: own.sessionId,
            serverId: request.serverId,
            enabled: request.enabled,
            scope: request.scope,
          },
        },
      };
    } catch (error) {
      const code =
        error instanceof ConfigurationError || error instanceof AgentError
          ? error.code
          : context.signal.aborted
            ? 'mcp_selection_cancelled'
            : 'mcp_selection_failed';
      if (accepted?.created && identity) {
        const uncertain = code === 'configuration_publication_uncertain';
        try {
          await runtime.finishHostMutation({
            ...identity,
            state: uncertain ? 'outcome_unknown' : 'failed',
            receipt: { status: uncertain ? 'outcome_unknown' : 'failed', code },
          });
        } catch {
          return { outcome: 'outcome_unknown', content: 'mutation_outcome_unknown' };
        }
        if (uncertain) return { outcome: 'outcome_unknown', content: code };
      }
      return fail(code);
    }
  }
  const extension: Extension = {
    id: mcpManagementExtensionId,
    version: '1',
    apiMajor: 1,
    actions: [
      {
        id: actionId,
        version: '1',
        description: 'Select an admitted trusted MCP server through exact source CAS',
        inputSchema: schema,
        prepare: async (input) => structuredClone(input),
        execute: select,
      },
    ],
    queries: [
      {
        id: 'mcp.servers',
        version: '1',
        description: 'Read trusted registered server choices; never connect or resolve credentials',
        inputSchema: { type: 'object', additionalProperties: false },
        outputSchema: { type: 'array' },
        async execute(_input, context) {
          const source = await sources(context),
            state = readMcpSelection(source);
          return [
            {
              extensionId: mcpManagementExtensionId,
              contentType: 'builtin.mcp.servers',
              contentVersion: 1,
              summary: 'Trusted server registry and exact configuration sources',
              payload: {
                ...source.scope,
                registryRevision: state.registry.revision,
                readSet: state.readSet as unknown as Json,
                items: state.registry.servers.map((server) => {
                  const configured = (state.effective.mcp ?? []).find(
                    (item) => item.id === server.id,
                  );
                  const selected = !!configured && configured.enabled !== false;
                  const reason = !server.admitted
                    ? 'mcp_server_not_admitted'
                    : !selected
                      ? 'mcp_server_not_selected'
                      : Object.keys(configured!).some(
                            (key) =>
                              !['id', 'enabled', 'configDigest', 'definitionVersion'].includes(key),
                          )
                        ? 'mcp_configuration_not_host_selected'
                        : (configured!.configDigest !== undefined &&
                              configured!.configDigest !== server.configDigest) ||
                            (configured!.definitionVersion !== undefined &&
                              configured!.definitionVersion !== server.configDigest)
                          ? 'mcp_definition_version_unavailable'
                          : null;
                  return { ...server, selected, available: reason === null, reason };
                }),
              },
              actions: [],
              artifactRefs: [],
            },
          ];
        },
      },
    ],
  };
  const description: CapabilityDescription = {
    kind: 'job',
    definitionId: `${mcpManagementExtensionId}/${actionId}`,
    definitionVersion: '1',
    revision: 'builtin.mcp.management:1',
    effects: ['workspace_write'],
    hardAllowed: true,
    safeRead: false,
  };
  return {
    extension,
    describe(request: AuthorizationRequest) {
      return request.kind === description.kind &&
        request.definitionId === description.definitionId &&
        request.definitionVersion === description.definitionVersion
        ? description
        : null;
    },
    listCapabilities: () => [description],
  };
}
