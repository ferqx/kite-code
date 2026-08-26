import type { KiteAppControlClient, KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import type { RuntimeHistoryClient } from '@kite-ai/runtime-client';
import type {
  RuntimeAccess,
  RuntimeCommand,
  RuntimeQuery,
  RuntimeSubscription,
} from '@kite-ai/runtime-contract';
import {
  createRuntimeServerInProcessHub,
  type RuntimeServerAdmissionPort,
  type RuntimeServerInProcessOpenOptions,
  type RuntimeServerInProcessPair,
  type RuntimeServerOptions,
} from '@kite-ai/runtime-server';
import {
  createInProcessKiteAppControlClient,
  createKiteAppControlService,
  type KiteAppControlHandlerPorts,
} from '../app-control';
import { createKiteRuntimeApplication, type KiteRuntimeApplication } from './application';
import { createRuntimeOperationGate, type RuntimeOperationGate } from './operation-gate';

export interface InProcessKiteRuntimeApplication extends KiteRuntimeApplication {
  open(options?: RuntimeServerInProcessOpenOptions): RuntimeServerInProcessPair;
  appControlFor(workspace: KiteWorkspaceIdentity): KiteRuntimeApplication['appControl'];
}

export interface InProcessKiteRuntimeApplicationOptions {
  readonly runtimeOwner: RuntimeAccess;
  readonly history: RuntimeHistoryClient;
  readonly defaultAdmission: RuntimeServerAdmissionPort;
  readonly defaultWorkspace: KiteWorkspaceIdentity;
  readonly server: RuntimeServerOptions;
  readonly operationGate?: RuntimeOperationGate;
  readonly createAppControlHandlers?: (
    workspace: KiteWorkspaceIdentity,
  ) => KiteAppControlHandlerPorts;
  readonly appControl?: Readonly<{
    readonly defaultClient: KiteAppControlClient;
    forWorkspace(workspace: KiteWorkspaceIdentity): KiteAppControlClient;
  }>;
  readonly start?: () => Promise<void>;
  readonly cancelAll: (reason: string) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

/**
 * Current InProcess owner composition. Runtime and App Control mutations share one admission
 * gate; no listener, process manager, Store, Host, or fallback owner is created here.
 */
export function createInProcessKiteRuntimeApplication(
  input: InProcessKiteRuntimeApplicationOptions,
): InProcessKiteRuntimeApplication {
  const operationGate = input.operationGate ?? createRuntimeOperationGate();
  const runtime: RuntimeAccess = Object.freeze({
    command: (command: RuntimeCommand) =>
      operationGate.runMutation(() => input.runtimeOwner.command(command)),
    query: (query: RuntimeQuery) => input.runtimeOwner.query(query),
    subscribe: (subscription: RuntimeSubscription) => input.runtimeOwner.subscribe(subscription),
  });
  const hub = createRuntimeServerInProcessHub(
    { runtime, admission: input.defaultAdmission },
    input.server,
  );
  if (!input.appControl && !input.createAppControlHandlers) {
    throw new Error('Runtime Application requires an App Control owner.');
  }
  const clients = new Map<string, KiteRuntimeApplication['appControl']>();
  const appControlFor = (workspace: KiteWorkspaceIdentity) => {
    if (input.appControl) return input.appControl.forWorkspace(workspace);
    const key = `${workspace.workspaceDigest}\0${workspace.projectId}\0${workspace.canonicalPath}`;
    const current = clients.get(key);
    if (current) return current;
    const client = createInProcessKiteAppControlClient(
      createKiteAppControlService({
        workspace,
        operationGate,
        handlers: input.createAppControlHandlers!(workspace),
      }),
    );
    clients.set(key, client);
    return client;
  };
  const application = createKiteRuntimeApplication({
    runtime,
    server: hub.server,
    history: input.history,
    appControl: input.appControl?.defaultClient ?? appControlFor(input.defaultWorkspace),
    operationGate,
    ...(input.start === undefined ? {} : { start: input.start }),
    cancelAll: input.cancelAll,
    dispose: async () => {
      if (!input.appControl) clients.clear();
      try {
        await hub.server.beginDraining();
      } finally {
        await input.dispose();
      }
    },
  });
  return Object.freeze({
    ...application,
    open: (options?: RuntimeServerInProcessOpenOptions) => hub.open(options),
    appControlFor,
  });
}
