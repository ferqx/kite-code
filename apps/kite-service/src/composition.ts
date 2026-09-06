import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { discoverSandboxBackendCandidate } from '@kite-ai/builtin-runtime/sandbox';
import type { KiteAppControlClient, KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import type { NativeProviderCredentialClient } from '@kite-ai/kite-local-runtime/client';
import type { RuntimeHistoryClient } from '@kite-ai/runtime-client';
import type { InteractionMode, RuntimeAccess } from '@kite-ai/runtime-contract';
import type { RuntimeServer } from '@kite-ai/runtime-server';
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
  /** Enables only the parent-owned stdio App Server's History/App Control capability set. */
  readonly appServerProtocol?: boolean;
  readonly appServerDaemonProtocol?: boolean;
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
  readonly appControl: KiteInProcessAppControlComposition<RuntimeOperationGate>;
  readonly runtime: RuntimeAccess;
  readonly server: RuntimeServer;
  readonly history: RuntimeHistoryClient;
  readonly storage: KiteMultiWorkspaceRuntimeServerOwner['storage'];
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

/**
 * Compose one App Server Runtime Application around the durable Session Store owner.
 * Transport ownership remains with the parent stdio process or explicit daemon.
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
  const runtimeControlReleases = new Map<string, () => void>();
  let owner!: KiteMultiWorkspaceRuntimeServerOwner;
  const bindRuntimeModelControl = (workspace: KiteWorkspaceIdentity): void => {
    const key = `${workspace.workspaceDigest}\0${workspace.projectId}\0${workspace.canonicalPath}`;
    if (runtimeControlReleases.has(key)) return;
    runtimeControlReleases.set(
      key,
      appControl.bindRuntimeControl(workspace, {
        applySelectedConfig: (config) => owner.applySelectedConfig(workspace, config),
      }),
    );
  };
  owner = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: input.checkpointPath,
    serverInstanceId: instanceId,
    ...(input.runtimeServerVersion ? { serverVersion: input.runtimeServerVersion } : {}),
    ...(input.appServerProtocol ? { appServerProtocol: true } : {}),
    ...(input.appServerDaemonProtocol ? { appServerDaemonProtocol: true } : {}),
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
            bindRuntimeModelControl(workspace);
            return template;
          },
        }
      : {}),
  });
  for (const workspace of workspaces) bindRuntimeModelControl(workspace);
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
  let application!: KiteRuntimeApplication;
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
        for (const release of runtimeControlReleases.values()) release();
        runtimeControlReleases.clear();
        await appControl[Symbol.asyncDispose]();
      }
    },
  });
  let disposePromise: Promise<void> | undefined;
  const composition: KiteServiceRuntimeComposition = {
    application,
    appControl,
    runtime: owner.runtime,
    server: owner.server,
    history,
    storage: owner.storage,
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

export type KiteServiceAppControlClient = KiteAppControlClient;
export type KiteServiceCredentialClient = NativeProviderCredentialClient;
