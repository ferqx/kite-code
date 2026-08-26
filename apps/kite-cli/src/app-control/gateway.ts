import type { KiteAppControlClient, KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import { createInProcessKiteAppControlClient } from './in-process';
import type {
  AppControlOperationGate,
  ExecutionStatusHandlerPort,
  KiteAppControlHandlerPorts,
  McpHandlerPort,
  ProviderModelHandlerPort,
  ReleaseStatusHandlerPort,
  SkillCatalogHandlerPort,
  WorkspaceTrustHandlerPort,
} from './ports';
import { createKiteAppControlService } from './service';

export interface InProcessAppControlGateway {
  /** Process-wide discovery supports Trust query/decision and Release status only. */
  readonly discovery: KiteAppControlClient;
  forWorkspace(workspace: KiteWorkspaceIdentity): KiteAppControlClient;
}

export interface InProcessAppControlGatewayOptions {
  readonly operationGate: AppControlOperationGate;
  readonly workspaceTrust: WorkspaceTrustHandlerPort;
  readonly release: ReleaseStatusHandlerPort;
  readonly createWorkspaceHandlers: (
    workspace: KiteWorkspaceIdentity,
  ) => Pick<KiteAppControlHandlerPorts, 'providerModel' | 'mcp' | 'skills' | 'execution'>;
}

function unavailable(): Promise<never> {
  return Promise.reject(new Error('Workspace-scoped App Control requires admission.'));
}

const UNAVAILABLE_WORKSPACE_HANDLERS = Object.freeze({
  providerModel: Object.freeze({
    snapshot: unavailable,
    select: unavailable,
  }) satisfies ProviderModelHandlerPort,
  mcp: Object.freeze({ snapshot: unavailable, apply: unavailable }) satisfies McpHandlerPort,
  skills: Object.freeze({ snapshot: unavailable }) satisfies SkillCatalogHandlerPort,
  execution: Object.freeze({ snapshot: unavailable }) satisfies ExecutionStatusHandlerPort,
});

/**
 * Starts the process-wide App Control surface before Provider/project runtime composition exists,
 * then creates exact connection-scoped clients only after canonical Workspace admission.
 */
export function createInProcessAppControlGateway(
  input: InProcessAppControlGatewayOptions,
): InProcessAppControlGateway {
  const clients = new Map<string, KiteAppControlClient>();
  const service = (workspace?: KiteWorkspaceIdentity): KiteAppControlClient =>
    createInProcessKiteAppControlClient(
      createKiteAppControlService({
        ...(workspace === undefined ? {} : { workspace }),
        operationGate: input.operationGate,
        handlers: {
          workspaceTrust: input.workspaceTrust,
          release: input.release,
          ...(workspace === undefined
            ? UNAVAILABLE_WORKSPACE_HANDLERS
            : input.createWorkspaceHandlers(workspace)),
        },
      }),
    );
  const discovery = service();
  return Object.freeze({
    discovery,
    forWorkspace(workspace: KiteWorkspaceIdentity): KiteAppControlClient {
      const key = `${workspace.workspaceDigest}\0${workspace.projectId}\0${workspace.canonicalPath}`;
      const current = clients.get(key);
      if (current) return current;
      const client = service(workspace);
      clients.set(key, client);
      return client;
    },
  });
}
