import { createHash } from 'node:crypto';
import type {
  McpConfigStatus,
  McpControlSnapshot,
  McpRuntimeProvider,
  McpServerControlState,
  McpSupervisor,
  McpToolControlState,
} from '@kite-ai/builtin-runtime/mcp';
import {
  type AppMcpAction,
  type AppMcpActionRequest,
  type AppMcpActionResponse,
  type AppMcpApproval,
  type AppMcpAuthStatus,
  type AppMcpConfigStatus,
  type AppMcpHealth,
  type AppMcpServer,
  type AppMcpServerConfiguration,
  type AppMcpSnapshot,
  type AppMcpSnapshotRequest,
  type AppMcpTool,
  type AppMcpTransport,
  type KiteWorkspaceIdentity,
  MCP_ACTION_RESPONSE_SCHEMA_,
  MCP_SNAPSHOT_RESPONSE_SCHEMA_,
  mcpActionRequestCodec,
  mcpActionResponseCodec,
  mcpSnapshotRequestCodec,
  mcpSnapshotResponseCodec,
} from '@kite-ai/kite-app-contract';
import { decideProjectMcpServer } from '#kite-cli/config/mcp-project-approvals';
import { assertSameWorkspace, type McpHandlerPort } from '../ports';

export interface McpOwnerOptions {
  /** The already-admitted canonical Workspace used for Supervisor.start and all routes. */
  readonly workspace: KiteWorkspaceIdentity;
  /** MCP Supervisor is composed by the Runtime Workspace owner; this wrapper never constructs it. */
  readonly supervisor: McpSupervisor;
}

export interface McpOwner extends McpHandlerPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  getRuntimeProvider(): McpRuntimeProvider;
}

function commandOnly(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const input = value.trim();
  if (!input) return undefined;
  if (input[0] === '"' || input[0] === "'") {
    const quote = input[0];
    const end = input.indexOf(quote, 1);
    return end > 1 ? input.slice(1, end) : undefined;
  }
  return input.split(/\s+/u, 1)[0];
}

function endpointOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') return undefined;
    return endpoint.origin;
  } catch {
    return undefined;
  }
}

function appConfigStatus(value: McpConfigStatus): AppMcpConfigStatus {
  switch (value) {
    case 'configured':
    case 'approved':
      return 'ready';
    case 'pending_approval':
      return 'pending_approval';
    case 'rejected':
      return 'rejected';
    case 'disabled':
    case 'shadowed':
      return 'disabled';
    case 'invalid':
      return 'invalid';
    case 'store_corrupt':
      return 'store_corrupt';
    case 'store_unavailable':
      return 'store_unavailable';
  }
}

function appHealth(value: McpServerControlState['health']): AppMcpHealth {
  switch (value) {
    case 'disconnected':
    case 'discovering':
    case 'connecting':
    case 'ready':
    case 'degraded':
    case 'half_open':
    case 'circuit_open':
    case 'quarantined':
      return value;
    default:
      return 'failed';
  }
}

function appAuthStatus(value: McpServerControlState['authStatus']): AppMcpAuthStatus {
  return value === 'revoked' ? 'error' : value;
}

function safeDigest(value: string): `sha256:${string}` {
  if (/^sha256:[a-f0-9]{64}$/u.test(value)) return value as `sha256:${string}`;
  if (/^[a-f0-9]{64}$/u.test(value)) return `sha256:${value}`;
  return `sha256:${createHash('sha256')
    .update('kite.app.mcp.config-digest.v1\0')
    .update(value)
    .digest('hex')}`;
}

function projectConfiguration(
  value: Readonly<McpServerControlState['configuration']>,
): AppMcpServerConfiguration {
  return {
    ...(commandOnly(value.command) ? { command: commandOnly(value.command) } : {}),
    ...(value.argumentCount === undefined ? {} : { argumentCount: value.argumentCount }),
    ...(endpointOrigin(value.endpoint) ? { endpoint: endpointOrigin(value.endpoint) } : {}),
  };
}

function projectTool(value: Readonly<McpToolControlState>): AppMcpTool {
  return {
    name: value.name,
    ...(value.description === undefined ? {} : { description: value.description }),
    parameters: value.parameters.map((parameter) => ({
      name: parameter.name,
      type: parameter.type,
      required: parameter.required,
      ...(parameter.description === undefined ? {} : { description: parameter.description }),
    })),
    discovered: value.discovered,
  };
}

function projectApproval(
  value: NonNullable<McpServerControlState['approval']>,
  status: AppMcpApproval['status'],
): AppMcpApproval {
  return {
    status,
    configDigest: safeDigest(value.configDigest),
    review: projectConfiguration(value.review),
  };
}

function projectServer(value: Readonly<McpServerControlState>): AppMcpServer {
  const approvalStatus =
    value.configStatus === 'pending_approval'
      ? ('pending' as const)
      : value.configStatus === 'rejected'
        ? ('rejected' as const)
        : value.configStatus === 'configured' || value.configStatus === 'approved'
          ? ('approved' as const)
          : undefined;
  const server: AppMcpServer = {
    key: { name: value.key.name, source: value.key.source },
    effective: value.effective,
    ...(value.fallbackSource === undefined ? {} : { fallbackSource: value.fallbackSource }),
    sourcePath: value.sourcePath,
    transport: value.transport as AppMcpTransport,
    enabled: value.enabled,
    required: value.required,
    configStatus: appConfigStatus(value.configStatus),
    health: appHealth(value.health),
    authStatus: appAuthStatus(value.authStatus),
    ...(value.authFlowId === undefined ? {} : { authFlowId: value.authFlowId }),
    ...(value.authErrorCode === undefined ? {} : { authErrorCode: value.authErrorCode }),
    configuration: projectConfiguration(value.configuration),
    revision: value.revision || 'unavailable',
    toolCount: value.toolCount,
    resourceCount: value.resourceCount,
    promptCount: value.promptCount,
    tools: value.tools.map(projectTool),
    prompts: value.prompts.map((prompt) => ({
      name: prompt.name,
      ...(prompt.description === undefined ? {} : { description: prompt.description }),
      ...(prompt.arguments === undefined
        ? {}
        : {
            arguments: prompt.arguments.map((argument) => ({
              name: argument.name,
              ...(argument.description === undefined ? {} : { description: argument.description }),
              ...(argument.required === undefined ? {} : { required: argument.required }),
            })),
          }),
    })),
    ...(value.approval === undefined || approvalStatus === undefined
      ? {}
      : {
          approval: projectApproval(value.approval, approvalStatus),
        }),
    ...(value.diagnostic === undefined
      ? {}
      : {
          diagnostic: {
            code: value.diagnostic.code,
            retryable: value.diagnostic.retryable,
          },
        }),
  };
  return server;
}

function projectSnapshot(
  workspace: KiteWorkspaceIdentity,
  control: McpControlSnapshot,
): AppMcpSnapshot {
  const snapshot: AppMcpSnapshot = {
    schema: MCP_SNAPSHOT_RESPONSE_SCHEMA_,
    workspace,
    revision: control.revision || 'unavailable',
    sourceRevisions: {
      project: control.sourceRevisions.project || 'unavailable',
      user: control.sourceRevisions.user || 'unavailable',
    },
    servers: control.servers.map(projectServer),
  };
  return mcpSnapshotResponseCodec.decode(mcpSnapshotResponseCodec.encode(snapshot));
}

function appErrorOutcome(error: unknown): AppMcpActionResponse['outcome'] {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (code === 'config_conflict' || code === 'config_changed') return 'conflict';
  if (code === 'outcome_unknown') return 'outcome_unknown';
  return 'outcome_unknown';
}

function findServer(
  control: McpControlSnapshot,
  key: { readonly name: string; readonly source: string },
): Readonly<McpServerControlState> | undefined {
  return control.servers.find(
    (server) => server.key.name === key.name && server.key.source === key.source,
  );
}

function actionNeedsServer(
  action: Exclude<AppMcpAction, { type: 'add' }>,
  server: Readonly<McpServerControlState> | undefined,
): server is Readonly<McpServerControlState> {
  return server !== undefined && server.revision === action.expectedRevision;
}

export function createMcpOwner(input: McpOwnerOptions): McpOwner {
  const workspace = Object.freeze({ ...input.workspace });
  let started = false;
  let startPromise: Promise<void> | undefined;

  const currentSnapshot = (): AppMcpSnapshot =>
    projectSnapshot(workspace, input.supervisor.getSnapshot());

  const start = (): Promise<void> => {
    if (started) return Promise.resolve();
    startPromise ??= (async () => {
      await input.supervisor.start(workspace.canonicalPath);
      started = true;
    })();
    const pending = startPromise;
    void pending.then(
      () => {
        if (startPromise === pending) startPromise = undefined;
      },
      () => {
        if (startPromise === pending) startPromise = undefined;
      },
    );
    return pending;
  };

  const stop = async (): Promise<void> => {
    await startPromise?.catch(() => undefined);
    await input.supervisor.stop();
    started = false;
  };

  const apply = async (request: AppMcpActionRequest): Promise<AppMcpActionResponse> => {
    const checked = mcpActionRequestCodec.decode(mcpActionRequestCodec.encode(request));
    assertSameWorkspace(workspace, checked.workspace, 'MCP request');
    const control = input.supervisor.getSnapshot();
    const before = projectSnapshot(workspace, control);
    if (!started) {
      return response('unavailable', before);
    }

    const action = checked.action;
    if (action.type === 'add') {
      if (control.sourceRevisions[action.source] !== action.expectedRevision) {
        return response('conflict', before);
      }
      try {
        await input.supervisor.mutate({
          type: 'add',
          scope: action.source,
          name: action.name,
          config:
            action.transport === 'http'
              ? { type: 'http', url: action.value }
              : { type: 'stdio', command: action.value },
          expectedRevision: action.expectedRevision,
        });
        return response('applied', currentSnapshot());
      } catch (error) {
        return response(appErrorOutcome(error), currentSnapshot());
      }
    }

    const server = findServer(control, action.key);
    if (!actionNeedsServer(action, server)) {
      return response(server ? 'conflict' : 'rejected', before);
    }

    try {
      switch (action.type) {
        case 'approve':
        case 'reject': {
          if (server.key.source !== 'project' || !server.approval) {
            return response('rejected', before);
          }
          const result = decideProjectMcpServer({
            workspace: workspace.canonicalPath,
            serverName: server.key.name,
            sourceKind: 'project',
            sourcePath: server.sourcePath,
            expectedConfigDigest: server.approval.configDigest,
            decision: action.type === 'approve' ? 'approved' : 'rejected',
          });
          if (result.status === 'config_changed') return response('conflict', currentSnapshot());
          if (result.status !== 'recorded') return response('unavailable', currentSnapshot());
          await input.supervisor.reload();
          return response('applied', currentSnapshot());
        }
        case 'login':
          await input.supervisor.login(action.key);
          return response('applied', currentSnapshot());
        case 'retry':
        case 'reconnect':
          await input.supervisor.retry(action.key);
          return response('applied', currentSnapshot());
        case 'cancel_auth':
          if (!server.authFlowId) return response('rejected', before);
          await input.supervisor.cancelAuth(server.authFlowId);
          return response('applied', currentSnapshot());
        case 'set_enabled':
          await input.supervisor.mutate({
            type: 'set_enabled',
            key: action.key,
            enabled: action.enabled,
            expectedRevision: action.expectedRevision,
          });
          return response('applied', currentSnapshot());
        case 'remove':
          await input.supervisor.remove(action.key, action.expectedRevision);
          return response('applied', currentSnapshot());
      }
    } catch (error) {
      return response(appErrorOutcome(error), currentSnapshot());
    }
  };

  return Object.freeze({
    start,
    stop,
    getRuntimeProvider: (): McpRuntimeProvider => input.supervisor.getRuntimeProvider(),
    async snapshot(request: AppMcpSnapshotRequest): Promise<AppMcpSnapshot> {
      const checked = mcpSnapshotRequestCodec.decode(mcpSnapshotRequestCodec.encode(request));
      assertSameWorkspace(workspace, checked.workspace, 'MCP request');
      return currentSnapshot();
    },
    apply,
  });
}

function response(
  outcome: AppMcpActionResponse['outcome'],
  snapshot: AppMcpSnapshot,
): AppMcpActionResponse {
  return mcpActionResponseCodec.decode(
    mcpActionResponseCodec.encode({
      schema: MCP_ACTION_RESPONSE_SCHEMA_,
      outcome,
      snapshot,
    }),
  );
}
