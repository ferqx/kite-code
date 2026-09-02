import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { discoverSandboxBackendCandidate } from '@kite-ai/builtin-runtime/sandbox';
import {
  type KiteAppControlClient,
  type KiteWorkspaceIdentity,
  WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
} from '@kite-ai/kite-app-contract';
import type { NativeProviderCredentialClient } from '@kite-ai/kite-local-runtime/client';
import type { RuntimeHistoryClient } from '@kite-ai/runtime-client';
import type { InteractionMode, RuntimeAccess } from '@kite-ai/runtime-contract';
import type { RuntimeServer, RuntimeServerAdmissionInput } from '@kite-ai/runtime-server';
import {
  createKiteInProcessAppControlComposition,
  type KiteInProcessAppControlComposition,
} from './app-control';
import {
  createKiteMultiWorkspaceRuntimeServer,
  createKiteRuntimeHistory,
  createKiteRuntimeObserverHistoryFromStorage,
  type KiteMultiWorkspaceRuntimeServerInput,
  type KiteMultiWorkspaceRuntimeServerOwner,
} from './bootstrap';
import { createSingleServiceControllerPort } from './bootstrap/single-service-controller';
import {
  createNativeKiteServiceInfrastructure,
  type NativeKiteServiceApplicationPort,
  type NativeKiteServiceInfrastructure,
  type NativeKiteServiceInfrastructureOptions,
} from './native-infrastructure';
import type { KiteServiceReadinessPort, KiteServiceSignalPort } from './ports';
import {
  createKiteRuntimeApplication,
  type KiteRuntimeApplication,
} from './runtime-application/application';
import {
  createRuntimeOperationGate,
  type RuntimeOperationGate,
} from './runtime-application/operation-gate';
import type { SandboxBackend } from './sandbox/types';

/** A Service-owned Runtime template. It contains no TUI, Store, or Host object. */
export type KiteServiceWorkspaceTemplate = NonNullable<
  KiteMultiWorkspaceRuntimeServerInput['workspaces']
>[number];

/** High-level workspace request; dependencies are resolved from the Service App Control owners. */
export interface KiteServiceWorkspaceSpec {
  readonly workspace: string;
  readonly userId?: string;
  readonly interactionMode?: InteractionMode;
  readonly sandboxBackend?: SandboxBackend;
  readonly initialSkillActivations?: readonly {
    readonly skillId: string;
    readonly input: Readonly<Record<string, unknown>>;
  }[];
}

export interface KiteServiceRuntimeCompositionOptions {
  /** One process identity shared by descriptor, carrier handshake, and Runtime initialize. */
  readonly instanceId?: string;
  readonly runtimeServerVersion?: string;
  /** The one explicit current Store path used by the Service owner. */
  readonly checkpointPath: string;
  /** Already-open Store 9 owner; when present no legacy Store or History connection is opened. */
  readonly storageOwner?: import('./bootstrap').KiteRuntimeStorageOwner;
  /** At least one admitted Workspace template is required for Runtime execution. */
  readonly workspaces?: readonly (KiteServiceWorkspaceTemplate | KiteServiceWorkspaceSpec)[];
  /** Lazy template resolver used after Trust/connection admission; it is never called at boot. */
  readonly workspaceTemplateFor?: (
    workspace: KiteWorkspaceIdentity,
  ) => KiteServiceWorkspaceTemplate | Promise<KiteServiceWorkspaceTemplate>;
  /** A caller-owned gate may be supplied when composing additional Service owners. */
  readonly operationGate?: RuntimeOperationGate;
  /** App Control is process-wide and is disposed with this composition. */
  readonly appControl?: KiteInProcessAppControlComposition<RuntimeOperationGate>;
  readonly userConfigPath?: string;
  readonly workspaceTrustStorePath?: string;
  readonly userMcpConfigPath?: string;
  readonly mcpApprovalPath?: string;
  readonly userKiteCodeSkillsDir?: string;
  readonly userAgentsSkillsDir?: string;
  readonly defaultWorkspace?: string;
}

export interface KiteServiceRuntimeComposition extends AsyncDisposable {
  readonly application: KiteRuntimeApplication;
  readonly carrierApplication: NativeKiteServiceApplicationPort;
  readonly appControl: KiteInProcessAppControlComposition<RuntimeOperationGate>;
  readonly runtime: RuntimeAccess;
  readonly server: RuntimeServer;
  readonly history: RuntimeHistoryClient;
  readonly storage: KiteMultiWorkspaceRuntimeServerOwner['storage'];
  readonly createInfrastructure: (
    options: Omit<NativeKiteServiceInfrastructureOptions, 'application'>,
  ) => NativeKiteServiceInfrastructure;
}

const CLAIMED_SERVICE_STORES = new Set<string>();

function claimServiceStore(path: string): { readonly release: () => void } {
  if (!isAbsolute(path)) throw new TypeError('Service checkpoint path must be absolute.');
  const resolved = resolve(path);
  const canonical = join(realpathSync.native(dirname(resolved)), basename(resolved));
  if (existsSync(resolved) && realpathSync.native(resolved) !== canonical) {
    throw new Error('Service checkpoint path may not alias another Store path.');
  }
  if (CLAIMED_SERVICE_STORES.has(canonical)) {
    throw new Error('Service checkpoint Store already has a process owner.');
  }
  CLAIMED_SERVICE_STORES.add(canonical);
  let released = false;
  return Object.freeze({
    release: () => {
      if (released) return;
      released = true;
      CLAIMED_SERVICE_STORES.delete(canonical);
    },
  });
}

function sameWorkspace(left: KiteWorkspaceIdentity, right: KiteWorkspaceIdentity): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.projectId === right.projectId &&
    left.workspaceDigest === right.workspaceDigest
  );
}

function sessionIdForRequest(input: {
  readonly operation: string;
  readonly command?: unknown;
  readonly query?: unknown;
  readonly subscription?: unknown;
}): string | undefined {
  if (input.operation === 'runtime/command') {
    const command = input.command as {
      readonly type?: unknown;
      readonly sessionId?: unknown;
      readonly sourceSessionId?: unknown;
      readonly bootstrapSessionId?: unknown;
    };
    if (command.type === 'create_session') {
      return typeof command.bootstrapSessionId === 'string'
        ? command.bootstrapSessionId
        : undefined;
    }
    if (typeof command.sessionId === 'string') return command.sessionId;
    return typeof command.sourceSessionId === 'string' ? command.sourceSessionId : undefined;
  }
  if (input.operation === 'runtime/query') {
    const query = input.query as { readonly sessionId?: unknown };
    return typeof query.sessionId === 'string' ? query.sessionId : undefined;
  }
  if (input.operation === 'runtime/subscribe') {
    const subscription = input.subscription as {
      readonly scope?: unknown;
      readonly sessionId?: unknown;
    };
    return subscription.scope === 'session' && typeof subscription.sessionId === 'string'
      ? subscription.sessionId
      : undefined;
  }
  return undefined;
}

/**
 * Compose the one concrete Service Runtime Application around the relocated Host/Store owner.
 * This is deliberately an internal application API: Native infrastructure remains the only
 * listener/state owner, and no CLI source or alternate backend is imported.
 */
export function createKiteServiceRuntimeComposition(
  input: KiteServiceRuntimeCompositionOptions,
): KiteServiceRuntimeComposition {
  const claim = claimServiceStore(input.checkpointPath);
  try {
    const composition = createKiteServiceRuntimeCompositionUnchecked(input);
    let disposePromise: Promise<void> | undefined;
    return Object.freeze({
      ...composition,
      [Symbol.asyncDispose]: () => {
        if (!disposePromise) {
          disposePromise = Promise.resolve(composition[Symbol.asyncDispose]()).finally(
            claim.release,
          );
        }
        return disposePromise;
      },
    });
  } catch (error) {
    claim.release();
    throw error;
  }
}

function createKiteServiceRuntimeCompositionUnchecked(
  input: KiteServiceRuntimeCompositionOptions,
): KiteServiceRuntimeComposition {
  const instanceId = input.instanceId ?? `service_${randomUUID()}`;
  const operationGate = input.operationGate ?? createRuntimeOperationGate();
  const appControl =
    input.appControl ??
    createKiteInProcessAppControlComposition(operationGate, {
      checkpointPath: input.checkpointPath,
      ...(input.userConfigPath === undefined ? {} : { userConfigPath: input.userConfigPath }),
      ...(input.workspaceTrustStorePath === undefined
        ? {}
        : { workspaceTrustStorePath: input.workspaceTrustStorePath }),
      ...(input.userMcpConfigPath === undefined
        ? {}
        : { userMcpConfigPath: input.userMcpConfigPath }),
      ...(input.mcpApprovalPath === undefined ? {} : { mcpApprovalPath: input.mcpApprovalPath }),
      ...(input.userKiteCodeSkillsDir === undefined
        ? {}
        : { userKiteCodeSkillsDir: input.userKiteCodeSkillsDir }),
      ...(input.userAgentsSkillsDir === undefined
        ? {}
        : { userAgentsSkillsDir: input.userAgentsSkillsDir }),
    });
  const explicitTemplates = (input.workspaces ?? []).filter(
    (workspace): workspace is KiteServiceWorkspaceTemplate => 'config' in workspace,
  );
  const workspaceSpecs = (input.workspaces ?? []).filter(
    (workspace): workspace is KiteServiceWorkspaceSpec => !('config' in workspace),
  );
  const templates: KiteServiceWorkspaceTemplate[] = explicitTemplates;
  const workspaces = templates.map((template) => appControl.admitWorkspace(template.workspace));
  const defaultWorkspace = input.defaultWorkspace
    ? workspaces.find((workspace) => workspace.canonicalPath === input.defaultWorkspace)
    : undefined;

  // The normal Service process is neutral at startup. A template is resolved only after a
  // connection has passed Workspace Trust and Runtime admission.
  const hasDynamicTemplate = true;
  const owner = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: input.checkpointPath,
    serverInstanceId: instanceId,
    ...(input.runtimeServerVersion ? { serverVersion: input.runtimeServerVersion } : {}),
    operationGate,
    ...(input.storageOwner ? { storageOwner: input.storageOwner } : {}),
    ...(templates.length === 0 ? {} : { workspaces: templates }),
    ...(hasDynamicTemplate
      ? {
          workspaceTemplateFor: async (workspace: KiteWorkspaceIdentity) => {
            const template = input.workspaceTemplateFor
              ? await input.workspaceTemplateFor(workspace)
              : await (async (): Promise<KiteServiceWorkspaceTemplate> => {
                  const requested = workspaceSpecs.find(
                    (spec) =>
                      appControl.admitWorkspace(spec.workspace).canonicalPath ===
                      workspace.canonicalPath,
                  );
                  const runtime = appControl.runtimeInputsFor(workspace);
                  await runtime.workspaceReady;
                  return {
                    userId: requested?.userId ?? 'kite-service',
                    workspace: workspace.canonicalPath,
                    config: runtime.config,
                    shellExecutor: runtime.shellExecutor,
                    interactionMode:
                      requested?.interactionMode ?? runtime.config.interactionMode ?? 'auto',
                    sandboxBackend: requested?.sandboxBackend ?? discoverSandboxBackendCandidate(),
                    mcpManager: runtime.mcpManager,
                    skillManifests: runtime.skillManifests,
                    skillOptions: runtime.skillOptions,
                    initialSkillActivations: requested?.initialSkillActivations ?? [],
                  };
                })();
            return template;
          },
        }
      : {}),
  });
  const rawHistory = input.storageOwner
    ? createKiteRuntimeObserverHistoryFromStorage(input.storageOwner.storage)
    : createKiteRuntimeHistory(input.checkpointPath);
  const history: RuntimeHistoryClient = input.storageOwner?.readSnapshot
    ? Object.freeze({
        listSessions: (request: Parameters<RuntimeHistoryClient['listSessions']>[0]) =>
          input.storageOwner!.readSnapshot!(() => rawHistory.listSessions(request)),
        listEvents: (request: Parameters<RuntimeHistoryClient['listEvents']>[0]) =>
          input.storageOwner!.readSnapshot!(() => rawHistory.listEvents(request)),
        loadSession: (sessionId: string) =>
          input.storageOwner!.readSnapshot!(() => rawHistory.loadSession(sessionId)),
      })
    : rawHistory;
  const persistedWorkspace = (sessionId: string): KiteWorkspaceIdentity | undefined => {
    const snapshot = owner.storage.sessions.loadSnapshot<{
      readonly session: {
        readonly workspace: string;
        readonly projectId?: string;
        readonly canonicalWorkspaceDigest?: string;
      };
    }>(sessionId);
    if (!snapshot) return undefined;
    const session = snapshot.session;
    if (!session.projectId || !session.canonicalWorkspaceDigest) return undefined;
    let canonicalPath: string;
    try {
      canonicalPath = realpathSync.native(session.workspace);
    } catch {
      return undefined;
    }
    const registered = workspaces.find(
      (workspace) =>
        workspace.canonicalPath === canonicalPath &&
        workspace.projectId === session.projectId &&
        workspace.workspaceDigest === session.canonicalWorkspaceDigest,
    );
    if (registered) return registered;
    if (hasDynamicTemplate) {
      const candidate = appControl.admitWorkspace(canonicalPath);
      if (
        candidate.projectId !== session.projectId ||
        candidate.workspaceDigest !== session.canonicalWorkspaceDigest
      ) {
        return undefined;
      }
      return candidate;
    }
    return undefined;
  };
  const workspaceForPath = (path: string): KiteWorkspaceIdentity | undefined => {
    let canonicalPath: string;
    try {
      canonicalPath = realpathSync.native(path);
    } catch {
      return undefined;
    }
    const registered = workspaces.find((workspace) => workspace.canonicalPath === canonicalPath);
    if (registered) return registered;
    if (!hasDynamicTemplate) return undefined;
    const project = appControl.admitWorkspace(canonicalPath);
    return project;
  };
  const workspaceAdmission = {
    async admitForConnect(requestedWorkspace: string) {
      const admitted = workspaceForPath(requestedWorkspace);
      if (!admitted) return { outcome: 'untrusted' as const };
      try {
        const trust = await appControl.gateway.discovery.queryWorkspaceTrust({
          schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
          workspace: admitted.canonicalPath,
        });
        return trust.status === 'trusted'
          ? { outcome: 'admitted' as const, workspace: admitted }
          : { outcome: 'untrusted' as const };
      } catch {
        return { outcome: 'unavailable' as const };
      }
    },
    async resolveIdentity(candidate: KiteWorkspaceIdentity) {
      const admitted = workspaceForPath(candidate.canonicalPath);
      if (!admitted || !sameWorkspace(admitted, candidate)) return undefined;
      const trust = await appControl.gateway.discovery.queryWorkspaceTrust({
        schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
        workspace: admitted.canonicalPath,
      });
      return trust.status === 'trusted' ? admitted : undefined;
    },
  };
  const authorityForWorkspace = input.storageOwner?.authorityForWorkspace
    ? (workspace: KiteWorkspaceIdentity) => {
        input.storageOwner!.admitWorkspace?.(workspace);
        return input.storageOwner!.authorityForWorkspace!(workspace);
      }
    : undefined;
  const runtimeAdmission = {
    create(
      workspace: KiteWorkspaceIdentity,
      connectionId: string,
      connectionKind?: 'native_client' | 'web_observer',
      binding?: import('./carrier/ports').ServiceRuntimeConnectionBinding,
    ) {
      return {
        async authorize(request: RuntimeServerAdmissionInput) {
          if (request.connectionId !== connectionId) {
            return { allowed: false as const, reason: 'unauthorized' as const };
          }
          const trust = await appControl.gateway.discovery.queryWorkspaceTrust({
            schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
            workspace: workspace.canonicalPath,
          });
          if (trust.status !== 'trusted') {
            return { allowed: false as const, reason: 'unauthorized' as const };
          }
          if (request.operation === 'runtime/command' && connectionKind !== 'native_client') {
            return { allowed: false as const, reason: 'unauthorized' as const };
          }
          const sessionId = sessionIdForRequest(request);
          if (sessionId !== undefined) {
            const persisted = persistedWorkspace(sessionId);
            const command = request.command as { readonly type?: unknown } | undefined;
            const freshCreate = command?.type === 'create_session' && persisted === undefined;
            if (!freshCreate && (!persisted || !sameWorkspace(persisted, workspace))) {
              return { allowed: false as const, reason: 'unauthorized' as const };
            }
          }
          if (
            request.operation === 'runtime/command' &&
            connectionKind === 'native_client' &&
            authorityForWorkspace
          ) {
            if (!sessionId || !binding || binding.workerInstanceId !== instanceId) {
              return { allowed: false as const, reason: 'unauthorized' as const };
            }
            const state = authorityForWorkspace(workspace).controller.read(sessionId);
            if (
              state.status !== 'active' ||
              state.clientId !== binding.clientId ||
              state.connectionGeneration !== binding.connectionGeneration ||
              state.workerInstanceId !== instanceId
            ) {
              return { allowed: false as const, reason: 'unauthorized' as const };
            }
            const bindingReference = `service-command-${createHash('sha256')
              .update('kite.single-service-command-binding.v1\0', 'utf8')
              .update(workspace.workspaceDigest, 'utf8')
              .update('\0', 'utf8')
              .update(request.connectionId, 'utf8')
              .update('\0', 'utf8')
              .update(request.requestId, 'utf8')
              .update('\0', 'utf8')
              .update(sessionId, 'utf8')
              .update('\0', 'utf8')
              .update(String(state.controllerGeneration), 'utf8')
              .digest('hex')}`;
            return {
              allowed: true as const,
              workspace: workspace.canonicalPath,
              bindingReference,
            };
          }
          return {
            allowed: true as const,
            workspace: workspace.canonicalPath,
          };
        },
      };
    },
  };
  const controller =
    authorityForWorkspace && input.storageOwner?.sessionCreation
      ? createSingleServiceControllerPort({
          serviceInstanceId: instanceId,
          runtime: owner.runtime,
          storage: owner.storage,
          sessionCreation: input.storageOwner.sessionCreation,
          workspaceAdmission,
          authorityForWorkspace,
          workspaceForSession: persistedWorkspace,
        })
      : undefined;
  let application!: KiteRuntimeApplication;
  const carrierApplication: NativeKiteServiceApplicationPort = {
    server: owner.server,
    history,
    workspaceAdmission,
    runtimeAdmission,
    appControl: appControl.gateway,
    credential: appControl.credentialClient,
    ...(controller ? { controller } : {}),
    onConnectionBound: (connectionId, workspace) => {
      const admitted = workspaceForPath(workspace.canonicalPath);
      if (admitted) owner.bindConnection(connectionId, admitted);
    },
    onConnectionClosed: (connectionId) => owner.releaseConnection(connectionId),
    start: () => application.start(),
    quiesceMutations: () => application.quiesceMutations(),
    cancelAll: (reason) => application.cancelAll(reason),
    [Symbol.asyncDispose]: () => application[Symbol.asyncDispose](),
  };
  application = createKiteRuntimeApplication({
    runtime: owner.runtime,
    server: owner.server,
    history,
    appControl: defaultWorkspace
      ? appControl.gateway.forWorkspace(defaultWorkspace)
      : appControl.gateway.discovery,
    operationGate,
    hasActiveOperations: () => owner.host.hasActiveSessionOperations(),
    cancelAll: owner.cancelAllSessions,
    dispose: async () => {
      try {
        await owner[Symbol.asyncDispose]();
      } finally {
        await appControl[Symbol.asyncDispose]();
      }
    },
  });
  let disposePromise: Promise<void> | undefined;
  const composition: KiteServiceRuntimeComposition = {
    application,
    carrierApplication,
    appControl,
    runtime: owner.runtime,
    server: owner.server,
    history,
    storage: owner.storage,
    createInfrastructure: (options) =>
      options.instanceId === instanceId
        ? createNativeKiteServiceInfrastructure({ ...options, application: carrierApplication })
        : (() => {
            throw new Error('Service infrastructure instance does not match Runtime identity.');
          })(),
    [Symbol.asyncDispose]: () => {
      if (!disposePromise) disposePromise = Promise.resolve(application[Symbol.asyncDispose]());
      return disposePromise;
    },
  };
  return Object.freeze(composition);
}

/** Explicit alias used by the internal executable composition. */
export const createKiteServiceApplicationComposition = createKiteServiceRuntimeComposition;

export type KiteServiceApplication = KiteServiceRuntimeComposition;

export type KiteServiceNativeInfrastructureInput = Omit<
  NativeKiteServiceInfrastructureOptions,
  'application'
> & {
  readonly readiness?: KiteServiceReadinessPort;
  readonly signals?: KiteServiceSignalPort;
};

export type KiteServiceAppControlClient = KiteAppControlClient;
export type KiteServiceCredentialClient = NativeProviderCredentialClient;
