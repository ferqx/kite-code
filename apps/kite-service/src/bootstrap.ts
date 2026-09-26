import { AsyncResource } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  type BuiltinToolCatalogProjection,
  createBuiltinContextCompilerPort,
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjection,
} from '@kite-ai/builtin-runtime';
import { canonicalModelJson, ModelArtifactStore } from '@kite-ai/builtin-runtime/model';
import {
  createSkillCapabilityResolver,
  refreshSkillCatalog,
} from '@kite-ai/builtin-runtime/skills';
import type { KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import {
  ensureKiteProfileHome,
  secureWindowsStatePath,
  verifyWindowsStatePath,
} from '@kite-ai/kite-local-runtime/service';
import {
  RuntimeClient,
  type RuntimeClientTransport,
  type RuntimeHistoryClient,
} from '@kite-ai/runtime-client';
import {
  assertListRuntimeLogEventsRequest,
  assertListRuntimeLogSessionsRequest,
  getAgentPhase,
  type ListRuntimeLogEventsRequest,
  type ListRuntimeLogSessionsRequest,
  RUNTIME_CONTRACT_BOUNDARY_,
  RUNTIME_NOTIFICATION_SCHEMA_,
  RUNTIME_PROJECTION_SCHEMA_,
  type RuntimeAccess,
  type RuntimeCommand,
  type RuntimeCommandContext,
  type RuntimeNotification,
  type RuntimeQuery,
  type RuntimeQueryResult,
  type RuntimeSessionProjection,
  type RuntimeSubscription,
} from '@kite-ai/runtime-contract';
import {
  createRuntimeHost,
  createRuntimeHostBoundary,
  createRuntimeHostStateStorageBinding,
  isRuntimeHostStateSettledForMigration,
  RUNTIME_HOST_EXECUTION_ADAPTER_ID_,
  type RuntimeHost,
  type RuntimeHostBoundary,
  type RuntimeHostCommandInspection,
  type RuntimeHostExecutionAdapterContext,
  type RuntimeHostExecutionBridge,
  type RuntimeHostExecutionServices,
  resolveProjectIdentity,
  runtimeHostCurrentStateEventTypes,
} from '@kite-ai/runtime-host';
import {
  createRuntimeHostStateSession,
  runtimeHostStateActivePlanning,
} from '@kite-ai/runtime-host/kernel-adapter';
import type {
  RuntimeLogEventReadPage,
  RuntimeLogQueryPort,
  RuntimeLogSessionReadPage,
  RuntimeRunStorePort,
  RuntimeStorage,
  RuntimeStoredRun,
} from '@kite-ai/runtime-host/storage';
import { createRuntimeStoredCommandReceipt } from '@kite-ai/runtime-host/storage';
import {
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeProtocolMessage,
  type RuntimeSubscriptionSpec as RuntimeProtocolSubscriptionSpec,
} from '@kite-ai/runtime-protocol';
import {
  createRuntimeServerInProcessHub,
  type RuntimeServer,
  type RuntimeServerAdmissionInput,
  type RuntimeServerAdmissionPort,
  type RuntimeServerInProcessOpenOptions,
  type RuntimeServerInProcessPair,
} from '@kite-ai/runtime-server';
import { defineRuntimeModule, type RuntimeModule } from '@kite-ai/runtime-spi';
import {
  assertSqliteRuntimeRunStoreActive,
  childApprovalProxyId,
  createSqliteRuntimeCompatibilityWriter,
  createSqliteRuntimeLogQueryPort,
  createSqliteRuntimeStorage,
  createSqliteRuntimeStorageBoundary,
  discoverSqliteRuntimeCompatibilitySource,
  type KiteHomeArtifactStore,
  type KiteHomeDirectoryQueryPort,
  KiteHomeWriteError,
  KiteSessionExecutionAuthorityError,
  KiteSessionMutationError,
  KiteSessionRuntimeStorageError,
  KiteSessionStoreOpenError,
  openKiteSessionRuntimeStorage,
  prepareKiteSessionStore,
  resolveSqliteRuntimeLayoutPaths,
  resolveSqliteWorkspaceStorePath,
  SQLITE_RUNTIME_COMPATIBILITY_SOURCE_PROFILES,
  SQLITE_RUNTIME_FORMAT_EPOCH,
  SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
  SQLITE_RUNTIME_RUN_STORE_SCHEMA_VERSION,
  SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
  SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
  type SqliteRuntimeCompatibilityImportResult,
  type SqliteRuntimeLayoutPaths,
  SqliteRuntimeStorageOpenError,
  type SqliteRuntimeStorageOptions,
  type SqliteRuntimeWorkspaceBinding,
  type SqliteWorkspaceAuthority,
  type SqliteWorkspaceSessionCreationPort,
  sqliteCurrentRuntimeStorePath,
  sqliteRuntimeStorePath,
  sqliteRuntimeStorePathForEpoch,
} from '@kite-ai/runtime-storage-sqlite';
import type {
  AgentApiModelContextReadPort,
  AgentApiModelContextSourcePart,
  AgentApiReadContext,
} from './agent-api';
import type { KiteInProcessAppControlComposition } from './app-control';
import { createKiteHomeBuiltinArtifactBackends } from './bootstrap/kite-home-artifact-backends';
import {
  createKiteSessionAppServerStorage,
  KiteAppServerSessionError,
  type KiteSessionAppServerStorageOwner,
} from './bootstrap/kite-session-app-server-storage';
import { createKiteModelOperationExecutionPort } from './bootstrap/model-operation-execution';
import { createInstalledKiteRuntimeCompositionFactory } from './bootstrap/model-runtime-composition';
import {
  type CliRuntimeBridgeInput,
  type CliRuntimeInteractionResolution,
  type ConfigurableCliRuntimeBridge,
  createCliRuntimeBridge,
  readBackgroundExecutionSnapshot,
} from './bootstrap/runtime/CliRuntimeBridge';
import { commitInteractionModeCommand } from './bootstrap/runtime/command-control-decision';
import { createCrossSessionAgentMailBinding } from './bootstrap/runtime/cross-session-agent-mail-composition';
import { previewFilesToCheckpoint } from './bootstrap/runtime/file-checkpoints';
import { KITE_RUNTIME_OPERATION_IDS_ } from './bootstrap/runtime/KiteRuntimeExecutionModule';
import { createRuntimeSessionCoordinatorBinding } from './bootstrap/runtime/RuntimeSessionCoordinator';
import type {
  RuntimeEvent,
  RuntimeState,
  StateRuntimeStorage,
} from './bootstrap/runtime/state-runtime';
import { createKiteRuntimeCompatibilityMigrator } from './bootstrap/runtime/state-store-compatibility';
import { projectStoredChildApprovals } from './bootstrap/runtime/subagent/child-approval-proxy';
import { projectIndependentChildExecutions } from './bootstrap/runtime/subagent/child-session-background-projection';
import { createChildSessionOrchestrator } from './bootstrap/runtime/subagent/child-session-orchestrator';
import { createAppToolPipelineComposition } from './bootstrap/runtime/tool-pipeline-composition';
import type { AgentConfig } from './config';
import { getFeatureFlags } from './config/features';
import { persistedWorkspaceIdentity } from './config/persisted-workspace-identity';
import {
  type AdmittedWorkspace,
  createInProcessKiteRuntimeApplication,
  createRuntimeExecutionBridgeRouter,
  createRuntimeInteractionBroker,
  createRuntimeWorkspaceAdmission,
  createRuntimeWorkspaceContextFactory,
  type RuntimeOperationGate,
} from './runtime-application';
import { createKiteRuntimeHistoryClient } from './runtime-client/history-adapter';
import { projectRuntimeClientInteractionQueue } from './runtime-client/interaction-projector';
import { projectRuntimeClientText } from './runtime-client/safe-text';
import { appSandboxBackendAvailable } from './sandbox/types';

const STATE_STORAGE_BINDING_ = createRuntimeHostStateStorageBinding();

/**
 * Rebuild the Client-facing currentRun from Store 8 even when no Run is
 * active.  A restarted TUI must retain the last settled Run for history
 * rendering and late-ephemeral fencing; getActive() alone loses that
 * authoritative identity as soon as the Run reaches a terminal state.
 */
function resolveStoredSessionRun(
  runs: RuntimeRunStorePort | undefined,
  sessionId: string,
): RuntimeStoredRun | undefined {
  if (!runs) return undefined;
  const active = runs.getActive(sessionId);
  if (active) return active;

  // The Store orders pages by (createdRevision, runId). Walk all pages so a
  // long-lived Session does not hydrate an older Run. Historical unknown
  // outcomes must not replace a later settled Run at the same State revision.
  let latestSettled: RuntimeStoredRun | undefined;
  const unknown: RuntimeStoredRun[] = [];
  let cursor: { readonly createdRevision: number; readonly runId: string } | undefined;
  do {
    const page = runs.list({
      sessionId,
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const candidate of page.entries) {
      if (isSettledStoredRun(candidate)) latestSettled = candidate;
      if (candidate.status === 'unknown') unknown.push(candidate);
    }
    cursor = page.hasMore ? page.nextCursor : undefined;
  } while (cursor !== undefined);
  // Only unknown Runs newer than the latest settled Run can describe the
  // current recovery candidate. Multiple such Runs remain ambiguous.
  const unresolved = unknown.filter(
    (candidate) => candidate.createdRevision > (latestSettled?.createdRevision ?? -1),
  );
  if (unresolved.length > 1) return undefined;
  return unresolved[0] ?? latestSettled;
}

function isSettledStoredRun(run: RuntimeStoredRun): boolean {
  return run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
}

export function createKiteAppServerAgentApiReadContext(input: {
  readonly directory: KiteHomeDirectoryQueryPort;
  readonly runtime: RuntimeAccess;
  readonly history: RuntimeHistoryClient;
  readonly storage: RuntimeStorage<RuntimeEvent, RuntimeState>;
  readonly artifactStore: KiteHomeArtifactStore;
  readonly checkpoints: Pick<
    RuntimeStorage<RuntimeEvent, RuntimeState>['checkpoints'],
    'getNamedSnapshotEntry' | 'listNamedSnapshots'
  >;
}): AgentApiReadContext {
  const modelArtifacts = new ModelArtifactStore({
    backend: createKiteHomeBuiltinArtifactBackends(input.artifactStore).model,
  });
  const modelContexts = createAppServerModelContextReadPort(input.storage, modelArtifacts);
  const checkpoints: AgentApiReadContext['checkpoints'] = Object.freeze({
    list(request: Parameters<AgentApiReadContext['checkpoints']['list']>[0]) {
      const entries = input.checkpoints
        .listNamedSnapshots(request.sessionId)
        .map((entry) => ({
          checkpointId: entry.snapshotId,
          sessionId: request.sessionId,
          revision: entry.eventPosition,
          eventPosition: entry.eventPosition,
          createdAt: entry.createdAt,
          affectedFileCount: entry.affectedFileCount ?? 0,
        }))
        .sort(
          (left, right) =>
            left.revision - right.revision || left.checkpointId.localeCompare(right.checkpointId),
        );
      const remaining = request.cursor
        ? entries.filter(
            (entry) =>
              entry.revision > request.cursor!.revision ||
              (entry.revision === request.cursor!.revision &&
                entry.checkpointId > request.cursor!.checkpointId),
          )
        : entries;
      const selected = remaining.slice(0, request.limit);
      const hasMore = selected.length < remaining.length;
      const last = selected.at(-1);
      return {
        entries: selected,
        hasMore,
        ...(hasMore && last
          ? { nextCursor: { revision: last.revision, checkpointId: last.checkpointId } }
          : {}),
      };
    },
    get(sessionId: string, checkpointId: string) {
      const entry = input.checkpoints.getNamedSnapshotEntry(sessionId, checkpointId);
      return entry
        ? {
            checkpointId: entry.snapshotId,
            sessionId,
            revision: entry.eventPosition,
            eventPosition: entry.eventPosition,
            createdAt: entry.createdAt,
            affectedFileCount: entry.affectedFileCount ?? 0,
          }
        : undefined;
    },
  });
  return Object.freeze({
    query: (query: RuntimeQuery) => input.runtime.query(query),
    history: input.history,
    checkpoints,
    modelContexts,
    directory: input.directory,
    close: async () => undefined,
    [Symbol.asyncDispose]: async () => undefined,
  });
}

function createAppServerModelContextReadPort(
  storage: RuntimeStorage<RuntimeEvent, RuntimeState>,
  artifacts: Pick<ModelArtifactStore, 'readSurface'>,
): AgentApiModelContextReadPort {
  return Object.freeze({
    get(sessionId: string, invocationId: string) {
      const record = storage.sessions
        .loadEventsStrict(sessionId)
        .find(
          (candidate) =>
            candidate.event.type === 'model.invocation_prepared' &&
            candidate.event.invocationId === invocationId,
        );
      if (record?.event.type !== 'model.invocation_prepared') return undefined;
      const event = record.event;
      const surface = artifacts.readSurface(event.surfaceArtifact);
      if (
        event.surfaceArtifact.integrityIdentifier !== event.surfaceIntegrityIdentifier ||
        surface.route.routeFingerprint !== event.routeFingerprint ||
        surface.purpose !== event.purpose
      ) {
        throw new Error('Model Context evidence binding is invalid.');
      }
      return {
        sessionId,
        invocationId,
        sequence: record.id,
        purpose: surface.purpose,
        provider: surface.route.providerKind,
        model: surface.route.modelName,
        systemPrompt: surface.request.system,
        messages: surface.request.messages.map((message) => ({
          role: message.role,
          parts: message.content.map(projectModelContextSourcePart),
        })),
        tools: surface.request.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchemaJson: canonicalModelJson(tool.inputSchema),
        })),
        settings: {
          transport: surface.request.transport,
          temperature: surface.request.temperature,
          maxOutputTokens: surface.request.maxOutputTokens,
          stopPolicy: surface.request.stopPolicy,
        },
      };
    },
  });
}

function projectModelContextSourcePart(
  part:
    | import('@kite-ai/runtime-spi').CanonicalModelMessage['content'][number]
    | import('@kite-ai/runtime-spi').CanonicalModelToolResultPart,
): AgentApiModelContextSourcePart {
  if (part.type === 'text' || part.type === 'reasoning') {
    return { type: part.type, text: part.text };
  }
  if (part.type === 'tool_call') {
    return {
      type: 'tool_call',
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      inputJson: canonicalModelJson(part.input),
    };
  }
  return {
    type: 'tool_result',
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    output: part.output.value,
  };
}

interface KiteRuntimeClientAccess extends RuntimeAccess {
  readonly history?: RuntimeHistoryClient;
  /** Explicit App owner shutdown; client disconnect never calls this implicitly. */
  shutdownOwner(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface KiteCliRuntimeServerOwner extends AsyncDisposable {
  readonly server: RuntimeServer;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface KiteMultiWorkspaceRuntimeServerOwner extends AsyncDisposable {
  readonly server: RuntimeServer;
  /** The single concrete Host owned by this Service composition. */
  readonly host: RuntimeHost<RuntimeEvent, RuntimeState>;
  /** Runtime access used by the Service Application; no alternate backend is created. */
  readonly runtime: RuntimeAccess;
  readonly storage: RuntimeStorage<RuntimeEvent, RuntimeState>;
  readonly cancelAllSessions: (reason: string) => Promise<void>;
  /** Replays durable source outboxes after the Host starts; failures remain pending. */
  readonly recoverPendingAgentMail: () => Promise<void>;
  /** Bindings used by native carriers; disconnect only releases this client identity. */
  readonly bindConnection: (connectionId: string, workspace: AdmittedWorkspace) => void;
  readonly releaseConnection: (connectionId: string) => void;
  /** Update the desired model configuration used by subsequently admitted Runs. */
  readonly applySelectedConfig: (workspace: AdmittedWorkspace, config: AgentConfig) => void;
  open(options?: RuntimeServerInProcessOpenOptions): RuntimeServerInProcessPair;
}

export interface KiteMultiWorkspaceRuntimeServerInput {
  readonly checkpointPath: string;
  /** Service process identity shared with descriptor/carrier handshake. */
  readonly serverInstanceId?: string;
  readonly serverVersion?: string;
  /** Only the parent-owned App Server carrier may advertise App-owned protocol methods. */
  readonly appServerProtocol?: boolean;
  /** Advertise child History only when the composition supplies its scoped reader. */
  readonly childHistoryMethods?: boolean;
  /** Explicit daemon lifecycle methods; absent from parent-owned stdio children. */
  readonly appServerDaemonProtocol?: boolean;
  /** Optional shared gate for Runtime and App Control mutations. */
  readonly operationGate?: RuntimeOperationGate;
  /**
   * Optional already-open Store owner. Worker composition supplies this exact Store 8 owner so
   * this Host cannot open a second SQLite writer or route a read through compatibility import.
   */
  readonly storageOwner?: KiteRuntimeStorageOwner;
  readonly workspaces?: readonly Omit<
    CliRuntimeBridgeInput,
    'checkpointPath' | 'projectIdentity' | 'sessionId'
  >[];
  /** Lazy Service workspace composition; invoked only after canonical admission. */
  readonly workspaceTemplateFor?: (
    admission: AdmittedWorkspace,
  ) =>
    | Omit<CliRuntimeBridgeInput, 'checkpointPath' | 'projectIdentity' | 'sessionId'>
    | Promise<Omit<CliRuntimeBridgeInput, 'checkpointPath' | 'projectIdentity' | 'sessionId'>>;
}

interface KiteRuntimeServerComposition extends KiteCliRuntimeServerOwner {
  open(): RuntimeServerInProcessPair;
}

function createKiteRuntimeServerComposition(input: {
  readonly host: RuntimeHost<RuntimeEvent, RuntimeState>;
  readonly workspace: string;
  readonly ownsSession: (sessionId: string) => boolean;
}): KiteRuntimeServerComposition {
  const admission: RuntimeServerAdmissionPort = Object.freeze({
    authorize: async (request: RuntimeServerAdmissionInput) => {
      const sessionId = admissionSessionId(request);
      if (sessionId !== undefined && !input.ownsSession(sessionId)) {
        return { allowed: false as const, reason: 'unauthorized' as const };
      }
      return { allowed: true as const, workspace: input.workspace };
    },
  });
  const hub = createRuntimeServerInProcessHub(
    { runtime: input.host, admission },
    {
      serverInfo: {
        version: `protocol-${RUNTIME_PROTOCOL_VERSION}`,
        instanceId: `server_${randomBytes(16).toString('hex')}`,
      },
    },
  );
  let disposePromise: Promise<void> | undefined;
  return Object.freeze({
    server: hub.server,
    open: () => hub.open(),
    [Symbol.asyncDispose]: () => {
      disposePromise ??= (async () => {
        try {
          await hub.server.beginDraining();
        } finally {
          await input.host[Symbol.asyncDispose]();
        }
      })();
      return disposePromise;
    },
  });
}

/**
 * App-owned InProcess composition. The Host remains the only Runtime owner;
 * Server and Client communicate through the same Protocol used by external
 * carriers, while admission fixes one trusted Workspace before dispatch.
 */
function createKiteInProcessRuntimeAccess(input: {
  readonly host: RuntimeHost<RuntimeEvent, RuntimeState>;
  readonly workspace: string;
  readonly ownsSession: (sessionId: string) => boolean;
  readonly clientName: 'kite-cli' | 'kite-tui';
  readonly history?: RuntimeHistoryClient;
  readonly appControl?: KiteInProcessAppControlComposition<RuntimeOperationGate>;
}): KiteRuntimeClientAccess {
  const composition = input.appControl
    ? (() => {
        if (!input.history) {
          throw new Error('Runtime Application history is unavailable.');
        }
        const canonicalPath = realpathSync.native(input.workspace);
        const project = resolveProjectIdentity(canonicalPath);
        const workspace = {
          canonicalPath,
          projectId: project.projectId,
          workspaceDigest: project.workspaceDigest,
        } as const;
        const admission: RuntimeServerAdmissionPort = Object.freeze({
          authorize: async (request: RuntimeServerAdmissionInput) => {
            const sessionId = admissionSessionId(request);
            if (sessionId !== undefined && !input.ownsSession(sessionId)) {
              return {
                allowed: false as const,
                reason: 'unauthorized' as const,
              };
            }
            return { allowed: true as const, workspace: canonicalPath };
          },
        });
        return createInProcessKiteRuntimeApplication({
          runtimeOwner: input.host,
          history: input.history,
          defaultAdmission: admission,
          defaultWorkspace: workspace,
          operationGate: input.appControl.operationGate,
          appControl: {
            defaultClient: input.appControl.gateway.forWorkspace(workspace),
            forWorkspace: (identity) => input.appControl!.gateway.forWorkspace(identity),
          },
          server: {
            serverInfo: {
              version: `protocol-${RUNTIME_PROTOCOL_VERSION}`,
              instanceId: `server_${randomBytes(16).toString('hex')}`,
            },
          },
          cancelAll: async (reason) => input.host.cancelAllSessions(reason),
          dispose: async () => {
            try {
              await input.host[Symbol.asyncDispose]();
            } finally {
              await input.appControl![Symbol.asyncDispose]();
            }
          },
        });
      })()
    : createKiteRuntimeServerComposition(input);
  const transport: RuntimeClientTransport = Object.freeze({
    connect: async () => {
      const pair = composition.open();
      return Object.freeze({
        send: (message: RuntimeProtocolMessage) => pair.client.send(message),
        messages: () => pair.client.messages(),
        close: (reason?: string) => pair.client.close(reason),
      });
    },
  });
  const client = new RuntimeClient({
    transport,
    clientInfo: {
      name: input.clientName,
      version: `protocol-${RUNTIME_PROTOCOL_VERSION}`,
      instanceId: `client_${randomBytes(16).toString('hex')}`,
    },
    ...(input.history ? { history: input.history } : {}),
  });
  let disposePromise: Promise<void> | undefined;
  let ownerShutdownPromise: Promise<void> | undefined;
  return Object.freeze({
    command: (command: RuntimeCommand) => client.command(command),
    query: (query: RuntimeQuery) => client.query(query),
    subscribe: (subscription: RuntimeSubscription) => client.subscribe(subscription),
    ...(client.history ? { history: client.history } : {}),
    shutdownOwner: () =>
      (ownerShutdownPromise ??= Promise.resolve(composition[Symbol.asyncDispose]())),
    [Symbol.asyncDispose]: () => {
      disposePromise ??= client.close();
      return disposePromise;
    },
  });
}

function admissionSessionId(input: RuntimeServerAdmissionInput): string | undefined {
  if (input.operation === 'runtime/command') {
    const command = input.command as Pick<RuntimeCommand, 'type'> & {
      readonly sessionId?: string;
      readonly sourceSessionId?: string;
      readonly bootstrapSessionId?: string;
    };
    if (command.type === 'create_session') return command.bootstrapSessionId;
    return command.sessionId ?? command.sourceSessionId;
  }
  if (input.operation === 'runtime/query') {
    return (input.query as { readonly sessionId?: string }).sessionId;
  }
  if (input.operation === 'runtime/subscribe') {
    const subscription = input.subscription as RuntimeProtocolSubscriptionSpec;
    return subscription.scope === 'session'
      ? subscription.sessionId
      : subscription.scope === 'child_session'
        ? subscription.parentSessionId
        : undefined;
  }
  return undefined;
}

export function createKiteRuntimeExecutionModule<TContext>(input: {
  readonly executionAdapterId: string;
  readonly createBridge: (context: TContext) => RuntimeHostExecutionBridge;
}): RuntimeModule {
  return defineRuntimeModule({
    moduleId: 'kite-runtime-execution',
    providerId: 'kite-runtime-execution',
    revision: 'app-runtime-current',
    operationIds: KITE_RUNTIME_OPERATION_IDS_,
    register: (registry) => {
      registry.registerExecutionAdapter({
        adapterId: input.executionAdapterId,
        revision: 'app-runtime-current',
        create: input.createBridge,
      });
    },
  });
}

function createKiteRuntimeStorage(
  checkpointPath: string,
): RuntimeStorage<RuntimeEvent, RuntimeState> {
  const databasePath = sqliteCurrentRuntimeStorePath(checkpointPath);
  const stateBinding = STATE_STORAGE_BINDING_;
  return createSqliteRuntimeStorage<RuntimeEvent, RuntimeState>({
    databasePath,
    codec: stateBinding.codec,
  });
}

export const WORKSPACE_WORKER_STORE_PROFILE_ = SQLITE_RUNTIME_RUN_FORMAT_EPOCH;
export const WORKSPACE_WORKER_STORE_SCHEMA_VERSION_ = SQLITE_RUNTIME_RUN_STORE_SCHEMA_VERSION;
export const WORKSPACE_WORKER_STATE_SCHEMA_VERSION_ = SQLITE_RUNTIME_STATE_SCHEMA_VERSION;

export interface WorkspaceWorkerStoreProfile {
  readonly stateSchemaVersion: typeof WORKSPACE_WORKER_STATE_SCHEMA_VERSION_;
  readonly storeSchemaVersion: typeof WORKSPACE_WORKER_STORE_SCHEMA_VERSION_;
  readonly formatEpoch: typeof WORKSPACE_WORKER_STORE_PROFILE_;
}

export const WORKSPACE_WORKER_STORE_PROFILE: WorkspaceWorkerStoreProfile = Object.freeze({
  stateSchemaVersion: WORKSPACE_WORKER_STATE_SCHEMA_VERSION_,
  storeSchemaVersion: WORKSPACE_WORKER_STORE_SCHEMA_VERSION_,
  formatEpoch: WORKSPACE_WORKER_STORE_PROFILE_,
});

export interface WorkspaceWorkerStoreContext {
  readonly home: import('@kite-ai/kite-local-runtime/service').KiteHomeIdentity;
  readonly layout: SqliteRuntimeLayoutPaths;
  readonly binding: SqliteRuntimeWorkspaceBinding;
  readonly databasePath: string;
  readonly profile: WorkspaceWorkerStoreProfile;
}

export interface WorkspaceWorkerStoreOwner extends RuntimeStorage<RuntimeEvent, RuntimeState> {
  readonly workspaceAuthority: SqliteWorkspaceAuthority;
  readonly runs: NonNullable<RuntimeStorage<RuntimeEvent, RuntimeState>['runs']>;
  /** Store 8 atomic Runtime-session + initial Controller creation owner. */
  readonly workspaceSessionCreation: SqliteWorkspaceSessionCreationPort<RuntimeEvent, RuntimeState>;
}

export type WorkspaceWorkerStoreAuthority = SqliteWorkspaceAuthority;
export type WorkspaceWorkerStoreStorageOptions = SqliteRuntimeStorageOptions;
export type WorkspaceWorkerStoreCodec = (typeof STATE_STORAGE_BINDING_)['codec'];

export function workspaceIdentityDigest(workspace: KiteWorkspaceIdentity): string {
  const material = JSON.stringify({
    canonicalPath: workspace.canonicalPath,
    projectId: workspace.projectId,
    workspaceDigest: workspace.workspaceDigest,
  });
  return `sha256:${createHash('sha256').update(`kite.workspace-identity.v1\0${material}`).digest('hex')}`;
}

export function canonicalWorkspaceIdentity(
  workspace: KiteWorkspaceIdentity,
): KiteWorkspaceIdentity {
  if (!workspace.canonicalPath || !isAbsolute(workspace.canonicalPath)) {
    throw new TypeError('Workspace canonical path must be absolute.');
  }
  const canonicalPath = realpathSync.native(resolve(workspace.canonicalPath));
  const expectedDigest = `sha256:${createHash('sha256').update(canonicalPath).digest('hex')}`;
  const expectedProjectId = `project_${expectedDigest.slice('sha256:'.length)}`;
  if (
    canonicalPath !== workspace.canonicalPath ||
    workspace.workspaceDigest !== expectedDigest ||
    workspace.projectId !== expectedProjectId
  ) {
    throw new TypeError('Workspace identity is not the exact canonical project identity.');
  }
  return Object.freeze({
    canonicalPath,
    projectId: workspace.projectId,
    workspaceDigest: workspace.workspaceDigest,
  });
}

export function createWorkspaceWorkerStoreContext(input: {
  readonly home: import('@kite-ai/kite-local-runtime/service').KiteHomeIdentity;
  readonly workspace: KiteWorkspaceIdentity;
  readonly workerScopeId: string;
  readonly layoutGeneration: string;
}): WorkspaceWorkerStoreContext {
  assertWorkspaceWorkerStoreProfile(WORKSPACE_WORKER_STORE_PROFILE);
  const home = ensureKiteProfileHome(input.home);
  const canonicalWorkspace = canonicalWorkspaceIdentity(input.workspace);
  assertSafeWorkspaceWorkerIdentity(input.workerScopeId, 'Worker scope');
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(input.layoutGeneration)) {
    throw new TypeError('Workspace Worker layout generation is invalid.');
  }
  const layout = resolveSqliteRuntimeLayoutPaths(home.root);
  const binding: SqliteRuntimeWorkspaceBinding = Object.freeze({
    layoutGeneration: input.layoutGeneration,
    workerScopeId: input.workerScopeId,
    workspaceIdentityDigest: workspaceIdentityDigest(canonicalWorkspace),
  });
  const databasePath = resolveSqliteWorkspaceStorePath(
    layout,
    binding.layoutGeneration,
    binding.workerScopeId,
  );
  assertSqliteRuntimeRunStoreActive(layout, binding, databasePath);
  return Object.freeze({
    home,
    layout,
    binding,
    databasePath,
    profile: WORKSPACE_WORKER_STORE_PROFILE,
  });
}

export function openWorkspaceWorkerStore(
  context: WorkspaceWorkerStoreContext,
  options: {
    readonly codec?: WorkspaceWorkerStoreCodec;
    readonly storageOptions?: WorkspaceWorkerStoreStorageOptions;
  } = {},
): WorkspaceWorkerStoreOwner {
  assertSqliteRuntimeRunStoreActive(context.layout, context.binding, context.databasePath);
  const storage = createSqliteRuntimeStorage<RuntimeEvent, RuntimeState>({
    databasePath: context.databasePath,
    codec: options.codec ?? STATE_STORAGE_BINDING_.codec,
    workspaceBinding: context.binding,
    workspaceLayout: context.layout,
    targetStore: 'run',
    ...(options.storageOptions ? { options: options.storageOptions } : {}),
  });
  if (!storage.workspaceAuthority || !storage.workspaceSessionCreation || !storage.runs) {
    storage.close();
    throw new Error('Workspace Worker Store 8 authority/session creation is unavailable.');
  }
  return storage as WorkspaceWorkerStoreOwner;
}

export function assertWorkspaceWorkerStoreProfile(value: WorkspaceWorkerStoreProfile): void {
  if (
    value.stateSchemaVersion !== SQLITE_RUNTIME_STATE_SCHEMA_VERSION ||
    value.storeSchemaVersion !== SQLITE_RUNTIME_RUN_STORE_SCHEMA_VERSION ||
    value.formatEpoch !== SQLITE_RUNTIME_RUN_FORMAT_EPOCH
  ) {
    throw new TypeError('Workspace Worker Store profile is incompatible.');
  }
}

function assertSafeWorkspaceWorkerIdentity(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\0') ||
    [...value].some((character) => /\p{Cc}/u.test(character))
  ) {
    throw new TypeError(`${label} identity is invalid.`);
  }
}

export function compatibilitySourcePaths(checkpointPath: string): readonly string[] {
  if (checkpointPath === ':memory:') return [];
  const currentPath = sqliteCurrentRuntimeStorePath(checkpointPath);
  return [
    sqliteRuntimeStorePath(checkpointPath),
    ...SQLITE_RUNTIME_COMPATIBILITY_SOURCE_PROFILES.map((profile) =>
      sqliteRuntimeStorePathForEpoch(checkpointPath, profile.formatEpoch),
    ),
  ].filter((path, index, all) => path !== currentPath && all.indexOf(path) === index);
}

export type KiteRuntimeSessionImportResult =
  | SqliteRuntimeCompatibilityImportResult
  | { readonly status: 'not_found'; readonly sessionId: string };

export function importCompatibleKiteSession(
  checkpointPath: string,
  threadId: string,
): KiteRuntimeSessionImportResult {
  const notFound = (): KiteRuntimeSessionImportResult => ({
    status: 'not_found',
    sessionId: threadId,
  });
  if (!threadId) return notFound();
  const sources = compatibilitySourcePaths(checkpointPath)
    .map((path) => discoverSqliteRuntimeCompatibilitySource(path))
    .filter((source) => source !== null);
  if (sources.length === 0) return notFound();
  const writer = createSqliteRuntimeCompatibilityWriter({
    databasePath: sqliteCurrentRuntimeStorePath(checkpointPath),
  });
  try {
    if (!writer.available) {
      return {
        status: 'failed',
        sessionId: threadId,
        error: new Error('Current Runtime Store is unavailable.'),
      };
    }
    const selected = sources
      .flatMap((source) =>
        source
          .listSessions()
          .filter((session) => session.sessionId === threadId)
          .map((session) => ({ source, session })),
      )
      .sort(
        (left, right) =>
          right.session.updatedAt - left.session.updatedAt ||
          right.session.revision - left.session.revision,
      )[0];
    if (!selected) return notFound();
    return writer.importSession(
      selected.source,
      threadId,
      createKiteRuntimeCompatibilityMigrator(STATE_STORAGE_BINDING_.codec),
    );
  } finally {
    writer.close();
    for (const source of sources) source.close();
  }
}

export type KiteRuntimeSessionResumePreparation = 'ready' | 'not_found' | 'failed';

/** Exact-session admission used by the headless CLI before create_session. */
export function prepareKiteRuntimeSessionResume(
  checkpointPath: string,
  sessionId: string,
): KiteRuntimeSessionResumePreparation {
  let current: RuntimeStorage<RuntimeEvent, RuntimeState> | undefined;
  try {
    current = createKiteRuntimeStorage(checkpointPath);
    if (current.sessions.loadSnapshotRecord(sessionId)) return 'ready';
  } catch {
    return 'failed';
  } finally {
    current?.close();
  }
  const imported = importCompatibleKiteSession(checkpointPath, sessionId);
  if (imported.status === 'imported' || imported.status === 'already_imported') return 'ready';
  return imported.status === 'not_found' || imported.status === 'ignored' ? 'not_found' : 'failed';
}

export function compatibleSessionList(checkpointPath: string) {
  const sources = compatibilitySourcePaths(checkpointPath)
    .map((path) => discoverSqliteRuntimeCompatibilitySource(path))
    .filter((source) => source !== null);
  if (sources.length === 0) return [];
  const writer = createSqliteRuntimeCompatibilityWriter({
    databasePath: sqliteCurrentRuntimeStorePath(checkpointPath),
  });
  try {
    const sessions = new Map<
      string,
      {
        threadId: string;
        name: string;
        updatedAt: number;
        needsSmartName: boolean;
        revision: number;
      }
    >();
    for (const source of sources) {
      for (const session of source.listSessions()) {
        if (writer.isSessionSuppressed(source, session.sessionId)) continue;
        const prior = sessions.get(session.sessionId);
        if (
          prior &&
          (prior.updatedAt > session.updatedAt ||
            (prior.updatedAt === session.updatedAt && prior.revision >= session.revision))
        )
          continue;
        sessions.set(session.sessionId, {
          threadId: session.sessionId,
          name: session.name || session.sessionId,
          updatedAt: session.updatedAt,
          needsSmartName: session.name.length === 0,
          revision: session.revision,
        });
      }
    }
    return [...sessions.values()].map(({ revision: _revision, ...session }) => session);
  } finally {
    writer.close();
    for (const source of sources) source.close();
  }
}

export function suppressCompatibleKiteSession(checkpointPath: string, sessionId: string): boolean {
  if (!sessionId) return false;
  const writer = createSqliteRuntimeCompatibilityWriter({
    databasePath: sqliteCurrentRuntimeStorePath(checkpointPath),
  });
  let suppressed = false;
  try {
    for (const path of compatibilitySourcePaths(checkpointPath)) {
      suppressed = writer.suppressSession(path, sessionId) || suppressed;
    }
  } finally {
    writer.close();
  }
  return suppressed;
}

export interface KiteRuntimeStorageOwner {
  readonly directory?: import('@kite-ai/runtime-storage-sqlite').KiteHomeDirectoryQueryPort;
  readonly openHistoryLogs?: (
    currentEventTypes: readonly string[],
  ) => RuntimeLogQueryPort<RuntimeEvent>;
  /** Present on the Session Store owner; old Store profiles contain roots only. */
  readonly readSessionLineage?: (
    sessionId: string,
  ) => Readonly<{ parentSessionId: string | null }> | null;
  readonly listChildSessions?: KiteSessionAppServerStorageOwner['listChildSessions'];
  readonly readChildSession?: KiteSessionAppServerStorageOwner['readChildSession'];
  readonly openChildSessionHistoryLogs?: KiteSessionAppServerStorageOwner['openChildSessionHistoryLogs'];
  readonly listPendingCrossSessionQueueMailSources?: KiteSessionAppServerStorageOwner['listPendingCrossSessionQueueMailSources'];
  readonly listPendingCrossSessionTerminalReplyMailSources?: KiteSessionAppServerStorageOwner['listPendingCrossSessionTerminalReplyMailSources'];
  readonly listUnrepliedSettledFollowupTerminalSources?: KiteSessionAppServerStorageOwner['listUnrepliedSettledFollowupTerminalSources'];
  readonly listUnnotifiedAcceptedFollowupReleases?: KiteSessionAppServerStorageOwner['listUnnotifiedAcceptedFollowupReleases'];
  readonly listPendingCrossSessionFollowupSources?: KiteSessionAppServerStorageOwner['listPendingCrossSessionFollowupSources'];
  readonly listPendingCrossSessionInterruptTargets?: KiteSessionAppServerStorageOwner['listPendingCrossSessionInterruptTargets'];
  readonly createChildSession?: KiteSessionAppServerStorageOwner['createChildSession'];
  readonly readChildSessionIntent?: KiteSessionAppServerStorageOwner['readChildSessionIntent'];
  readonly readChildApprovalProxy?: KiteSessionAppServerStorageOwner['readChildApprovalProxy'];
  readonly listPendingChildApprovalProxies?: KiteSessionAppServerStorageOwner['listPendingChildApprovalProxies'];
  readonly listPendingChildSessionIntents?: KiteSessionAppServerStorageOwner['listPendingChildSessionIntents'];
  readonly readChildSealedGrant?: KiteSessionAppServerStorageOwner['readChildSealedGrant'];
  readonly storage: RuntimeStorage<RuntimeEvent, RuntimeState> & {
    readonly agentMailbox?: import('@kite-ai/runtime-storage-sqlite').KiteSessionAgentMailboxPort;
    readonly agentMailInput?: import('@kite-ai/runtime-storage-sqlite').KiteSessionAgentMailInputPort;
    readonly crossSessionQueueMail?: import('@kite-ai/runtime-storage-sqlite').KiteCrossSessionQueueMailPort;
    readonly currentExecutionGeneration?: (sessionId: string) => string;
  };
  /** Store 9-only dedicated Artifact tables; legacy owners omit this port. */
  readonly artifactStore?: KiteHomeArtifactStore;
  /** Store 9 durable Controller/effect/resource authority for one admitted Workspace. */
  readonly authorityForWorkspace?: (
    workspace: AdmittedWorkspace,
  ) => import('@kite-ai/runtime-storage-sqlite').SqliteWorkspaceAuthority;
  /** Store 9 owner admits canonical Workspace identity before a new Session transaction. */
  readonly admitWorkspace?: (workspace: AdmittedWorkspace) => void;
  /** Current-format index path; unlike `storage.sessions`, it never imports a legacy session. */
  listCurrentSessions(
    query?: string,
    limit?: number,
  ): ReturnType<RuntimeStorage<RuntimeEvent, RuntimeState>['sessions']['listSessions']>;
  /** Store-only projection reads used during neutral Host hydration. */
  loadCurrentSnapshot(sessionId: string): RuntimeState | null;
  getCurrentSessionModelRoute(
    sessionId: string,
  ): ReturnType<RuntimeStorage<RuntimeEvent, RuntimeState>['sessions']['getSessionModelRoute']>;
  /** KASD App Server Session generation scope. */
  readonly runWithSessionExecution?: <Result>(sessionId: string, operation: () => Result) => Result;
  readonly reconcileInterruptedSession?: KiteSessionAppServerStorageOwner['reconcileInterruptedSession'];
  readonly commitUnownedInteractionMode?: KiteSessionAppServerStorageOwner['commitUnownedInteractionMode'];
  readonly readSnapshot?: <Result>(operation: () => Result) => Result;
  readonly ownsSessionExecution?: (sessionId: string) => boolean;
  readonly setExecutionLossHandler?: (handler: (sessionId: string) => Promise<void>) => void;
  readonly commitRecoveryDecision?: KiteSessionAppServerStorageOwner['commitRecoveryDecision'];
  readonly ownedSessionIds?: () => readonly string[];
  readonly recovery?: KiteSessionAppServerStorageOwner['recovery'];
  readonly releaseSessionExecution?: KiteSessionAppServerStorageOwner['releaseSessionExecution'];
  readonly releaseExecutions?: (cleanupConfirmed: boolean) => void;
  readonly disposeStorage?: () => void;
}

export type KiteStoreWriterAdmission = Parameters<
  typeof prepareKiteSessionStore
>[0]['assertRetiredWritersStopped'];

export type KiteStoreStartupProgress = NonNullable<
  Parameters<typeof prepareKiteSessionStore>[0]['onProgress']
>;

/** KASD exact multi-connection Store owner; it never opens kite.sqlite or a Workspace lock. */
type KiteSessionStorageCompositionInput = {
  readonly assertRetiredStoreWritersStopped?: KiteStoreWriterAdmission;
  readonly onStoreStartupProgress?: KiteStoreStartupProgress;
  readonly shouldStopStartup?: () => boolean;
  readonly beforeStorePublication?: () => Promise<'commit' | 'cancel'>;
  readonly databasePath: string;
  readonly hostInstanceId: string;
  readonly clientId?: string;
  readonly connectionGeneration?: number;
  readonly executionLeaseMs?: number;
  readonly renewIntervalMs?: number;
  readonly now?: () => number;
};

export async function createKiteSessionAppServerStorageComposition(
  input: KiteSessionStorageCompositionInput,
): Promise<KiteSessionAppServerStorageOwner> {
  let deadline: number | undefined;
  let published = false;
  let lastBusy: KiteSessionStoreOpenError | undefined;
  let startupStage: Parameters<KiteStoreStartupProgress>[0] = 'inspecting';
  const report = (stage: Parameters<KiteStoreStartupProgress>[0]): void => {
    startupStage = stage;
    try {
      const result = input.onStoreStartupProgress?.(stage);
      if (result) void Promise.resolve(result).catch(() => undefined);
    } catch {
      // Startup progress is observational; it cannot change Store admission.
    }
  };
  const assertNotStopped = (): void => {
    if (input.shouldStopStartup?.()) {
      if (published) {
        if (lastBusy) throw lastBusy;
        return;
      }
      throw new KiteSessionStoreOpenError(
        'store_preparation_cancelled',
        'Store startup was cancelled before opening.',
        { stage: startupStage },
      );
    }
  };
  for (;;) {
    assertNotStopped();
    try {
      const preparation = await prepareKiteSessionStore({
        databasePath: input.databasePath,
        codec: STATE_STORAGE_BINDING_.codec,
        onProgress: (stage) => {
          if (stage !== 'ready') report(stage);
        },
        ...(input.beforeStorePublication
          ? { beforePublication: input.beforeStorePublication }
          : {}),
        isSettledState: isRuntimeHostStateSettledForMigration,
        assertRetiredWritersStopped:
          input.assertRetiredStoreWritersStopped ??
          (() => {
            throw new Error('This entrypoint has not established retired Store writer admission.');
          }),
        ...(input.now ? { nowMs: input.now() } : {}),
      });
      lastBusy = undefined;
      if (preparation.status !== 'current') published = true;
      assertNotStopped();
      const owner = openCurrentKiteSessionAppServerStorageComposition(input);
      report('ready');
      return owner;
    } catch (error) {
      if (!(error instanceof KiteSessionStoreOpenError) || error.code !== 'store_busy') throw error;
      lastBusy = error;
      deadline ??= performance.now() + 10_000;
      assertNotStopped();
      report('waiting_for_store');
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new KiteSessionStoreOpenError('store_busy', error.message, {
          cause: error,
          stage: 'waiting_for_store',
          ...(error.compatibility ? { compatibility: error.compatibility } : {}),
        });
      }
      await Bun.sleep(Math.min(250, remaining));
    }
  }
}

/** Strict current/fresh Store opening for already-admitted owners and legacy in-process paths. */
function openCurrentKiteSessionAppServerStorageComposition(
  input: KiteSessionStorageCompositionInput,
): KiteSessionAppServerStorageOwner {
  const target = openKiteSessionRuntimeStorage<RuntimeEvent, RuntimeState>({
    databasePath: input.databasePath,
    windowsPathSecurity: {
      verifyDirectory: (path) => verifyWindowsStatePath(path, 'directory'),
      secureFile: (path) => secureWindowsStatePath(path, 'file'),
      verifyFile: (path) => verifyWindowsStatePath(path, 'file'),
    },
    codec: STATE_STORAGE_BINDING_.codec,
    stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
    ...(input.now ? { now: input.now } : {}),
  });
  try {
    return createKiteSessionAppServerStorage({
      ...input,
      target,
      childApprovalProxyId,
    });
  } catch (error) {
    target.close();
    throw error;
  }
}

/**
 * Service-owned durable History composition. The SQLite reader and the raw-event projector live
 * in this application boundary; callers receive only the existing safe History client surface.
 */
export function createKiteRuntimeHistory(checkpointPath: string): RuntimeHistoryClient {
  return createKiteRuntimeHistoryClient(
    () =>
      createSqliteRuntimeLogQueryPort<RuntimeEvent, RuntimeState>({
        databasePath: sqliteCurrentRuntimeStorePath(checkpointPath),
        codec: STATE_STORAGE_BINDING_.codec,
        currentEventTypes: runtimeHostCurrentStateEventTypes(),
      }),
    {
      listSessions: () => compatibleSessionList(checkpointPath),
      importSession: (sessionId) => importCompatibleKiteSession(checkpointPath, sessionId),
    },
  );
}

const MAX_INJECTED_STORE_SESSION_SCAN = 100_000;

/**
 * Query-only History over an already-open Runtime Store.
 *
 * The Worker owns the Store connection, so opening a SQLite log reader here would create a
 * second connection with an independently resolved path.  This adapter only consumes the
 * injected SessionStore read methods and therefore cannot discover or import a legacy Session.
 */
export function createKiteRuntimeObserverHistoryFromStorage(
  storage: RuntimeStorage<RuntimeEvent, RuntimeState>,
): RuntimeHistoryClient {
  return createKiteRuntimeHistoryClient(() => createInjectedStoreLogQueryPort(storage));
}

function createInjectedStoreLogQueryPort(
  storage: RuntimeStorage<RuntimeEvent, RuntimeState>,
): RuntimeLogQueryPort<RuntimeEvent> {
  let closed = false;
  const currentEventTypes = new Set(runtimeHostCurrentStateEventTypes());
  const assertOpen = (): void => {
    if (closed) throw new Error('Runtime observer Store query is closed.');
  };
  const readSessionRows = (query: string): ReturnType<typeof storage.sessions.listSessions> => {
    const rows = storage.sessions.listSessions(query, MAX_INJECTED_STORE_SESSION_SCAN);
    if (rows.length >= MAX_INJECTED_STORE_SESSION_SCAN) {
      throw new Error('Runtime observer Session directory exceeds its bounded query limit.');
    }
    return rows;
  };
  const sessionExists = (sessionId: string): boolean => {
    // This fallback is used by older injected Stores. Its bounded directory is
    // the only public Session scope; a direct snapshot lookup must not turn an
    // internal child ID into an observer History read.
    return readSessionRows('').some((entry) => entry.threadId === sessionId);
  };

  return Object.freeze({
    listSessions(request: ListRuntimeLogSessionsRequest): RuntimeLogSessionReadPage {
      assertOpen();
      assertListRuntimeLogSessionsRequest(request);
      if (request.workspaceDigest)
        throw Object.assign(new Error('Workspace filtering requires an indexed Store reader.'), {
          code: 'invalid_request',
        });
      const candidates = readSessionRows(request.query ?? '')
        .map((entry) => {
          const model = storage.sessions.getSessionModelRoute(entry.threadId);
          return {
            sessionId: entry.threadId,
            name: entry.name,
            updatedAt: entry.updatedAt,
            lastSequence: storage.sessions.getLastEventPosition(entry.threadId),
            ...(model === null ? {} : { model }),
          };
        })
        .filter(
          (entry) =>
            request.cursor === undefined ||
            entry.updatedAt < request.cursor.updatedAt ||
            (entry.updatedAt === request.cursor.updatedAt &&
              entry.sessionId.localeCompare(request.cursor.sessionId) < 0),
        )
        .sort(
          (left, right) =>
            right.updatedAt - left.updatedAt || right.sessionId.localeCompare(left.sessionId),
        );
      const selected = candidates.slice(0, request.limit);
      const hasMore = candidates.length > selected.length;
      const last = selected.at(-1);
      return {
        entries: selected,
        hasMore,
        ...(hasMore && last
          ? {
              nextCursor: {
                updatedAt: last.updatedAt,
                sessionId: last.sessionId,
              },
            }
          : {}),
      };
    },

    listEvents(request: ListRuntimeLogEventsRequest): RuntimeLogEventReadPage<RuntimeEvent> {
      assertOpen();
      assertListRuntimeLogEventsRequest(request);
      if (!sessionExists(request.sessionId)) {
        throw new Error(`Runtime session was not found: ${request.sessionId}`);
      }
      const requestedTypes = request.eventTypes ? new Set(request.eventTypes) : undefined;
      if (requestedTypes && [...requestedTypes].some((type) => !currentEventTypes.has(type))) {
        throw new Error('Runtime observer event filter contains an unknown current event type.');
      }
      const stored = storage.sessions.loadEventsStrict(request.sessionId);
      const candidates = stored
        .map((record) => ({
          sessionId: request.sessionId,
          sequence: record.id,
          eventId: record.event_id ?? `${request.sessionId}:${record.id}`,
          ...(record.causation_id === undefined ? {} : { causationId: record.causation_id }),
          ...(record.occurred_at === undefined ? {} : { occurredAt: record.occurred_at }),
          createdAt: record.created_at,
          event: record.event,
        }))
        .filter(
          (record) =>
            (request.afterSequence === undefined || record.sequence > request.afterSequence) &&
            (request.beforeSequence === undefined || record.sequence < request.beforeSequence) &&
            (requestedTypes === undefined || requestedTypes.has(record.event.type)),
        )
        .sort((left, right) => left.sequence - right.sequence);
      const hasMore = candidates.length > request.limit;
      const selected =
        request.direction === 'backward'
          ? candidates.slice(Math.max(0, candidates.length - request.limit))
          : candidates.slice(0, request.limit);
      const cursor =
        request.direction === 'backward' ? selected.at(0)?.sequence : selected.at(-1)?.sequence;
      return {
        entries: selected,
        hasMore,
        ...(hasMore && cursor !== undefined ? { nextCursor: cursor } : {}),
        observedLastSequence: storage.sessions.getLastEventPosition(request.sessionId),
      };
    },

    close(): void {
      closed = true;
    },
  });
}

export function createKiteRuntimeStorageOwner(checkpointPath: string): KiteRuntimeStorageOwner {
  let underlying: RuntimeStorage<RuntimeEvent, RuntimeState> | undefined;
  let closeRequested = false;
  let closed = false;
  const resolve = (): RuntimeStorage<RuntimeEvent, RuntimeState> => {
    if (closeRequested) throw new Error('Runtime Host storage is closing');
    underlying ??= createKiteRuntimeStorage(checkpointPath);
    return underlying;
  };
  const ensureImported = (sessionId: string): void => {
    if (!sessionId) return;
    const current = resolve().sessions.loadSnapshot(sessionId);
    if (current !== null) return;
    importCompatibleKiteSession(checkpointPath, sessionId);
  };
  const sessionPort = new Proxy({} as RuntimeStorage<RuntimeEvent, RuntimeState>['sessions'], {
    get: (_target, property) => {
      if (property === 'listSessions') {
        return (query = '', limit = 50) => {
          const currentPort = resolve().sessions;
          const current = currentPort.listSessions(query, limit);
          const seen = new Set(current.map((session) => session.threadId));
          const normalizedQuery = String(query).trim().toLocaleLowerCase();
          const legacy = compatibleSessionList(checkpointPath).filter((session) => {
            if (seen.has(session.threadId)) return false;
            try {
              if (currentPort.loadSnapshot(session.threadId) !== null) return false;
            } catch {
              // A corrupt current row still owns its identity; do not replace
              // it with an older compatibility source carrying the same id.
              return false;
            }
            return (
              !normalizedQuery ||
              session.name.toLocaleLowerCase().includes(normalizedQuery) ||
              session.threadId.toLocaleLowerCase().includes(normalizedQuery)
            );
          });
          return [...current, ...legacy]
            .sort(
              (left, right) =>
                right.updatedAt - left.updatedAt || left.threadId.localeCompare(right.threadId),
            )
            .slice(0, limit);
        };
      }
      const port = resolve().sessions;
      const value = Reflect.get(port, property, port) as unknown;
      if (typeof value !== 'function') return value;
      if (
        [
          'loadEventsStrict',
          'loadSnapshot',
          'loadSnapshotRecord',
          'getLastEventPosition',
          'getSessionModelRoute',
          'setSessionName',
          'setSessionModelRoute',
        ].includes(String(property))
      ) {
        return (sessionId: string, ...args: unknown[]) => {
          ensureImported(sessionId);
          return Reflect.apply(value, port, [sessionId, ...args]);
        };
      }
      if (property === 'deleteSession') {
        return (sessionId: string, ...args: unknown[]) => {
          if (!suppressCompatibleKiteSession(checkpointPath, sessionId)) {
            throw new Error('Runtime session deletion could not record compatibility state.');
          }
          const result = Reflect.apply(value, port, [sessionId, ...args]);
          return result;
        };
      }
      return value.bind(port);
    },
  });
  const closeWhenIdle = (): void => {
    if (!closeRequested || closed) return;
    closed = true;
    underlying?.close();
  };
  const storage: RuntimeStorage<RuntimeEvent, RuntimeState> = Object.freeze({
    adapterId: 'sqlite',
    stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    storeSchemaVersion: SQLITE_RUNTIME_STORE_SCHEMA_VERSION,
    formatEpoch: SQLITE_RUNTIME_FORMAT_EPOCH,
    sessions: sessionPort,
    transactions: createLazyPort(() => resolve().transactions),
    effects: createLazyPort(() => resolve().effects),
    checkpoints: createLazyPort(() => resolve().checkpoints),
    artifacts: createLazyPort(() => resolve().artifacts),
    recoveryIdentities: createLazyPort(() => resolve().recoveryIdentities),
    commandReceipts: createLazyPort(() => resolve().commandReceipts),
    close: () => {
      closeRequested = true;
      closeWhenIdle();
    },
  });
  return {
    storage,
    listCurrentSessions: (query = '', limit = 50) => resolve().sessions.listSessions(query, limit),
    loadCurrentSnapshot: (sessionId: string) =>
      resolve().sessions.loadSnapshot<RuntimeState>(sessionId),
    getCurrentSessionModelRoute: (sessionId: string) =>
      resolve().sessions.getSessionModelRoute(sessionId),
  };
}

function createLazyPort<Port extends object>(resolve: () => Port): Port {
  return new Proxy({} as Port, {
    get: (_target, property) => {
      const port = resolve();
      const value = Reflect.get(port, property, port) as unknown;
      return typeof value === 'function' ? value.bind(port) : value;
    },
  });
}

function resolveKiteRecoveryIdentity(
  services: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>,
  sessionId: string,
): string {
  const recoveryIdentity = STATE_STORAGE_BINDING_.codec.recoveryIdentity;
  if (!recoveryIdentity) {
    throw new Error('Runtime Host State recovery identity projection is unavailable');
  }
  return services.recoveryIdentities.getOrCreate(sessionId, () => {
    const snapshot = services.sessions.loadSnapshot<RuntimeState>(sessionId);
    return snapshot === null ? allocateKiteRecoveryIdentity() : recoveryIdentity(snapshot);
  });
}

function allocateKiteRecoveryIdentity(): string {
  return randomBytes(32).toString('hex');
}

function createKiteRuntimeHost(
  storage: RuntimeStorage<RuntimeEvent, RuntimeState>,
  createBridge: (
    context: RuntimeHostExecutionAdapterContext<RuntimeEvent, RuntimeState>,
    builtinToolCatalog: BuiltinToolCatalogProjection,
  ) => RuntimeHostExecutionBridge,
  ownsSessionExecution?: (sessionId: string) => boolean,
  runWithSessionExecution?: <Result>(sessionId: string, operation: () => Result) => Result,
  setExecutionLossHandler?: (handler: (sessionId: string) => Promise<void>) => void,
  releaseSessionExecution?: (sessionId: string) => Promise<boolean>,
): RuntimeHost<RuntimeEvent, RuntimeState> {
  const host = createRuntimeHost({
    storage,
    modules: createKiteRuntimeModules((context) =>
      createBridge(context, createBuiltinToolCatalogProjection(context.capabilityRegistrySnapshot)),
    ),
    contextCompiler: createBuiltinContextCompilerPort(),
    ...(ownsSessionExecution ? { ownsSessionExecution } : {}),
    ...(runWithSessionExecution ? { runWithSessionExecution } : {}),
    ...(releaseSessionExecution ? { releaseSessionExecution } : {}),
  });
  setExecutionLossHandler?.(async (sessionId) => {
    await host.cancelSession(sessionId, 'Session execution ownership lost.');
    await releaseSessionExecution?.(sessionId);
  });
  return host;
}

function createKiteRuntimeModules(
  createBridge: (
    context: RuntimeHostExecutionAdapterContext<RuntimeEvent, RuntimeState>,
  ) => RuntimeHostExecutionBridge,
): readonly RuntimeModule[] {
  return Object.freeze([
    createKiteRuntimeExecutionModule({
      executionAdapterId: RUNTIME_HOST_EXECUTION_ADAPTER_ID_,
      createBridge,
    }),
    ...createBuiltinRuntimeModules(),
  ]);
}

/** Non-owning nested access to the Host-owned storage ports. */
function createRuntimeStorageAccess(
  services: RuntimeHostExecutionServices<RuntimeEvent, RuntimeState>,
  storage: KiteRuntimeStorageOwner['storage'],
): StateRuntimeStorage {
  return Object.freeze({
    sessions: services.sessions,
    transactions: services.transactions,
    effects: services.leases,
    checkpoints: services.checkpoints,
    recoveryIdentities: services.recoveryIdentities,
    commandReceipts: storage.commandReceipts,
    ...(storage.agentMailbox ? { agentMailbox: storage.agentMailbox } : {}),
    ...(storage.agentMailInput ? { agentMailInput: storage.agentMailInput } : {}),
    ...(storage.currentExecutionGeneration
      ? { currentExecutionGeneration: storage.currentExecutionGeneration }
      : {}),
    close: () => undefined,
  });
}

export function createKiteRuntimeBoundary(): RuntimeHostBoundary {
  if (RUNTIME_CONTRACT_BOUNDARY_.transport !== 'in-process') {
    throw new Error('Kite RM boundary must remain in-process');
  }
  return createRuntimeHostBoundary({
    storage: createSqliteRuntimeStorageBoundary(),
    modules: createKiteRuntimeModules(() => {
      throw new Error('Kite boundary inspection cannot create a runtime execution adapter');
    }),
  });
}

function projectParentInteractionQueue(
  owner: KiteRuntimeStorageOwner,
  snapshot: Readonly<RuntimeState>,
  rootInteractionQueue: ReturnType<typeof projectRuntimeClientInteractionQueue>,
): ReturnType<typeof projectRuntimeClientInteractionQueue> {
  const childApprovals = owner.listPendingChildApprovalProxies
    ? projectStoredChildApprovals({
        parentState: snapshot,
        listPending: owner.listPendingChildApprovalProxies,
        readChildState: (childThreadId) => owner.loadCurrentSnapshot(childThreadId),
      })
    : [];
  const present = new Set(rootInteractionQueue.interactions.map((entry) => entry.interactionId));
  const added = childApprovals.filter((entry) => !present.has(entry.interactionId));
  if (added.length === 0) return rootInteractionQueue;
  return Object.freeze({
    revision: rootInteractionQueue.revision,
    activeInteractionId: rootInteractionQueue.activeInteractionId ?? added[0]!.interactionId,
    interactions: Object.freeze([...rootInteractionQueue.interactions, ...added]),
  });
}

function projectStoredSession(
  owner: KiteRuntimeStorageOwner,
  threadId: string,
  snapshot = owner.loadCurrentSnapshot(threadId),
): RuntimeSessionProjection | undefined {
  if (!snapshot || snapshot.session.threadId !== threadId) return undefined;
  const model = owner.getCurrentSessionModelRoute(threadId);
  const interactionQueue = projectParentInteractionQueue(
    owner,
    snapshot,
    projectRuntimeClientInteractionQueue(snapshot, { sessionRevision: snapshot.revision }),
  );
  const activeInteraction =
    interactionQueue.activeInteractionId === undefined
      ? undefined
      : interactionQueue.interactions.find(
          (interaction) => interaction.interactionId === interactionQueue.activeInteractionId,
        );
  const activeTask = snapshot.activeTaskId ? snapshot.tasks[snapshot.activeTaskId] : undefined;
  const storedRun = resolveStoredSessionRun(owner.storage.runs, threadId);
  const ownsExecution = owner.ownsSessionExecution?.(threadId) === true;
  const executionAuthority = owner.recovery?.inspect(threadId).authority;
  const liveOwner =
    executionAuthority &&
    (executionAuthority.status === 'active' || executionAuthority.status === 'detached') &&
    executionAuthority.leaseUntilMs !== null &&
    executionAuthority.leaseUntilMs > Date.now();
  const preserveRunStatus =
    ownsExecution || liveOwner || (storedRun !== undefined && isSettledStoredRun(storedRun));
  return Object.freeze({
    schema: RUNTIME_PROJECTION_SCHEMA_,
    sessionId: threadId,
    revision: snapshot.revision,
    workspace: snapshot.session.workspace,
    ...(snapshot.session.canonicalWorkspaceDigest === undefined
      ? {}
      : {
          workspaceDigest: snapshot.session.canonicalWorkspaceDigest,
        }),
    lifecycle: 'open' as const,
    interactionQueue,
    ...(activeTask === undefined
      ? {}
      : {
          activeTask: {
            taskId: activeTask.taskId,
            phase:
              activeTask.planning.kind === 'executing'
                ? ('building' as const)
                : ('planning' as const),
          },
        }),
    ...(storedRun === null || storedRun === undefined
      ? {}
      : {
          currentRun: {
            runId: storedRun.runId,
            initialTurnId: storedRun.runId,
            activeTurnId: snapshot.turn.turnId,
            ...(activeTask === undefined ? {} : { taskId: activeTask.taskId }),
            status: preserveRunStatus
              ? storedRun.status === 'unknown'
                ? ('recovery_required' as const)
                : storedRun.status
              : ('recovery_required' as const),
            revision: storedRun.lastRevision,
            ...(preserveRunStatus &&
            storedRun.status === 'waiting' &&
            snapshot.completionGuard.waitingReason?.kind === 'required_background'
              ? {
                  waitingReason: {
                    kind: 'required_background' as const,
                    taskIds: [...snapshot.completionGuard.waitingReason.taskIds],
                  },
                }
              : {}),
            ...(activeInteraction === undefined
              ? {}
              : { activeInteractionId: activeInteraction.interactionId }),
            ...(preserveRunStatus
              ? storedRun.terminal === undefined
                ? {}
                : { outcome: { ...storedRun.terminal } }
              : {
                  outcome: {
                    reasonCode:
                      storedRun.status === 'unknown'
                        ? (storedRun.terminal?.reasonCode ?? 'unknown')
                        : 'recovery_required',
                    safeRetry: false,
                    recoveryEntry: 'reconcile' as const,
                  },
                }),
          },
        }),
    ...(model === null ? {} : { model: { provider: model.provider, name: model.name } }),
  });
}

function createKiteCliRuntimeHost(
  input: Omit<CliRuntimeBridgeInput, 'projectIdentity'>,
): RuntimeHost<RuntimeEvent, RuntimeState> {
  const owner = openCurrentKiteSessionAppServerStorageComposition({
    databasePath: join(dirname(input.checkpointPath), 'kite-session.sqlite'),
    hostInstanceId: `cli_${randomBytes(16).toString('hex')}`,
  });
  const storage: RuntimeStorage<RuntimeEvent, RuntimeState> = Object.freeze({
    ...owner.storage,
    close: () => {
      owner.storage.close();
      owner.releaseExecutions(true);
      owner.disposeStorage();
    },
  });
  const projectIdentity = resolveProjectIdentity(input.workspace);
  const runtimeCoordinatorBinding = createRuntimeSessionCoordinatorBinding();
  let host!: RuntimeHost<RuntimeEvent, RuntimeState>;
  host = createKiteRuntimeHost(
    storage,
    (context, builtinToolCatalog) => {
      const { services, capabilities, capabilityRegistrySnapshot } = context;
      const toolPipelineComposition = createAppToolPipelineComposition(builtinToolCatalog);
      const modelOperationExecution = createKiteModelOperationExecutionPort(
        capabilities,
        builtinToolCatalog,
      );
      const modelRuntime = createInstalledKiteRuntimeCompositionFactory(
        modelOperationExecution,
        undefined,
        {
          resolveAfterTurnOriginRun: (sessionId, activeTurnId) =>
            host.resolveAfterTurnOriginRun(sessionId, activeTurnId),
          scheduleAfterTurnWake: (wake) => host.scheduleAfterTurnWake(wake),
        },
      );
      const modelInvocationRuntimeFactory = (workspace: string) => ({
        ...modelRuntime(workspace),
        builtinToolCatalog,
        toolPipelineComposition,
      });
      const runtimeStorageView = createRuntimeStorageAccess(services, owner.storage);
      runtimeCoordinatorBinding.bind({
        services,
        capabilities,
        capabilityRegistrySnapshot,
        builtinToolCatalog,
        toolPipelineComposition,
        modelRuntimeFactory: modelRuntime,
        store: runtimeStorageView,
      });
      return createCliRuntimeBridge(
        {
          ...input,
          enqueueSessionWork: context.enqueueSessionWork,
          projectIdentity,
          storedProjection: () =>
            owner.readSnapshot(() => projectStoredSession(owner, input.sessionId)),
        },
        capabilities,
        modelInvocationRuntimeFactory,
        (sessionId) => resolveKiteRecoveryIdentity(services, sessionId),
        runtimeCoordinatorBinding.access(),
      );
    },
    owner.ownsSessionExecution,
    owner.runWithSessionExecution,
    owner.setExecutionLossHandler,
    owner.releaseSessionExecution
      ? (sessionId) =>
          owner.releaseSessionExecution!(sessionId, () =>
            runtimeCoordinatorBinding.access().release(sessionId),
          )
      : undefined,
  );
  return host;
}

/**
 * Transitional app-local multi-Workspace owner. It uses one concrete Host/Store while the
 * execution router creates one dependency context for each admitted canonical Workspace.
 * No listener, process manager, fallback Host, or second Store is created here.
 */
export function createKiteMultiWorkspaceRuntimeServer(
  input: KiteMultiWorkspaceRuntimeServerInput,
): KiteMultiWorkspaceRuntimeServerOwner {
  if ((!input.workspaces || input.workspaces.length === 0) && !input.workspaceTemplateFor) {
    throw new TypeError('Multi-Workspace Runtime requires a Workspace template factory.');
  }
  const independentChildDetachedScope = new AsyncResource('KiteIndependentChildSession');
  const mailDetachedScope = new AsyncResource('KiteCrossSessionMailDelivery');
  const bySession = new Map<string, AdmittedWorkspace>();
  const byWorkspace = new Map<
    string,
    Readonly<{
      admission: AdmittedWorkspace;
      input: Omit<CliRuntimeBridgeInput, 'projectIdentity' | 'sessionId'>;
    }>
  >();
  for (const workspaceInput of input.workspaces ?? []) {
    const canonicalPath = realpathSync.native(workspaceInput.workspace);
    const projectIdentity = resolveProjectIdentity(canonicalPath);
    const admission: AdmittedWorkspace = Object.freeze({
      canonicalPath,
      projectId: projectIdentity.projectId,
      workspaceDigest: projectIdentity.workspaceDigest,
    });
    input.storageOwner?.admitWorkspace?.(admission);
    const key = `${admission.workspaceDigest}\0${admission.projectId}\0${admission.canonicalPath}`;
    if (byWorkspace.has(key)) {
      throw new TypeError(`Duplicate Runtime Workspace identity: ${canonicalPath}`);
    }
    byWorkspace.set(
      key,
      Object.freeze({
        admission,
        input: {
          ...workspaceInput,
          workspace: canonicalPath,
          checkpointPath: input.checkpointPath,
        },
      }),
    );
  }

  // Worker composition injects the already-admitted Store 8 owner here.  The legacy Service path
  // remains lazy only when no owner is supplied; no compatibility wrapper is ever introduced for
  // an injected Store.
  const owner =
    input.storageOwner ??
    openCurrentKiteSessionAppServerStorageComposition({
      databasePath: join(dirname(input.checkpointPath), 'kite-session.sqlite'),
      hostInstanceId: `service_${randomBytes(16).toString('hex')}`,
    });
  const artifactBackends = owner.artifactStore
    ? createKiteHomeBuiltinArtifactBackends(owner.artifactStore)
    : undefined;
  const runtimeCoordinatorBinding = createRuntimeSessionCoordinatorBinding();
  const interactionBroker = createRuntimeInteractionBroker<CliRuntimeInteractionResolution>();
  const connectionWorkspaces = new Map<string, AdmittedWorkspace>();
  const sameAdmission = (left: AdmittedWorkspace, right: AdmittedWorkspace): boolean =>
    left.canonicalPath === right.canonicalPath &&
    left.projectId === right.projectId &&
    left.workspaceDigest === right.workspaceDigest;
  const readPersistedAdmissionForSession = (sessionId: string): AdmittedWorkspace | undefined => {
    if (owner.readSessionLineage?.(sessionId)?.parentSessionId != null) return undefined;
    const snapshot = owner.storage.sessions.loadSnapshot<RuntimeState>(sessionId);
    if (!snapshot) return undefined;
    const projectId = snapshot.session.projectId;
    const workspaceDigest = snapshot.session.canonicalWorkspaceDigest;
    if (!projectId || !workspaceDigest) return undefined;
    const canonicalPath = snapshot.session.workspace;
    const identity = persistedWorkspaceIdentity(canonicalPath);
    if (
      identity === undefined ||
      projectId !== identity.projectId ||
      workspaceDigest !== identity.workspaceDigest
    ) {
      return undefined;
    }
    const key = `${workspaceDigest}\0${projectId}\0${canonicalPath}`;
    const registered = byWorkspace.get(key);
    if (registered) return registered.admission;
    if (input.workspaceTemplateFor) {
      const admission: AdmittedWorkspace = Object.freeze({
        canonicalPath,
        projectId,
        workspaceDigest: identity.workspaceDigest,
      });
      return admission;
    }
    return undefined;
  };
  const persistedAdmissionForSession = (sessionId: string): AdmittedWorkspace | undefined => {
    const admission = readPersistedAdmissionForSession(sessionId);
    if (admission) bySession.set(sessionId, admission);
    else bySession.delete(sessionId);
    return admission;
  };
  const projectStoredSessionForOwner = (threadId: string, snapshot?: RuntimeState | null) =>
    projectStoredSession(owner, threadId, snapshot);
  const projectStoredSessionForList = (threadId: string): RuntimeSessionProjection | undefined => {
    try {
      return projectStoredSessionForOwner(threadId);
    } catch (error) {
      // A legacy snapshot that cannot satisfy the current State contract is local to that
      // Session. Keep it untouched in the Store, but do not let neutral bulk hydration make
      // every other persisted Session (or creation of a new one) unavailable.
      if (error instanceof SqliteRuntimeStorageOpenError && error.code === 'invalid_configuration')
        return undefined;
      throw error;
    }
  };
  const bridges = new Map<string, ConfigurableCliRuntimeBridge>();
  const ensureFollowupRecoveryForWorkspace = new Map<
    string,
    (sourceSessionId: string) => Promise<void>
  >();
  const ensureInterruptRecoveryForWorkspace = new Map<
    string,
    (sourceSessionId: string, targetSessionId: string) => Promise<void>
  >();
  const desiredConfigs = new Map<string, AgentConfig>();
  const recoveryGenerations = new Map<
    string,
    {
      kind: 'fenced_previous_execution';
      controllerGeneration: number;
      assertCurrent: () => boolean;
    }
  >();
  let recoverInterruptedSession:
    | ((sessionId: string, generation: number, assertCurrent: () => boolean) => Promise<void>)
    | undefined;
  let readUnownedBackgroundQuery:
    | ((
        query: Extract<
          RuntimeQuery,
          { readonly type: 'list_background_executions' | 'get_background_execution' }
        >,
      ) => RuntimeQueryResult)
    | undefined;
  let scanPendingAgentMail: (() => Promise<void>) | undefined;
  let scanPendingTerminalReplies: (() => Promise<void>) | undefined;
  let scanPendingFollowups: (() => Promise<void>) | undefined;
  let scanPendingInterrupts: (() => Promise<void>) | undefined;
  let host!: RuntimeHost<RuntimeEvent, RuntimeState>;
  host = createKiteRuntimeHost(
    owner.storage,
    (context, builtinToolCatalog) => {
      const { services, capabilities, capabilityRegistrySnapshot } = context;
      const toolPipelineComposition = createAppToolPipelineComposition(builtinToolCatalog);
      const modelOperationExecution = createKiteModelOperationExecutionPort(
        capabilities,
        builtinToolCatalog,
      );
      const modelRuntime = createInstalledKiteRuntimeCompositionFactory(
        modelOperationExecution,
        artifactBackends,
        {
          resolveAfterTurnOriginRun: (sessionId, activeTurnId) =>
            host.resolveAfterTurnOriginRun(sessionId, activeTurnId),
          scheduleAfterTurnWake: (wake) => host.scheduleAfterTurnWake(wake),
        },
      );
      const modelInvocationRuntimeFactory = (workspace: string) => ({
        ...modelRuntime(workspace),
        builtinToolCatalog,
        toolPipelineComposition,
      });
      readUnownedBackgroundQuery = (query) => {
        const state = owner.loadCurrentSnapshot(query.sessionId);
        const admission = readPersistedAdmissionForSession(query.sessionId);
        if (!state) {
          return {
            status: 'not_found',
            queryType: query.type,
            code: 'session_not_found',
          };
        }
        if (!admission) {
          return {
            status: 'unavailable',
            queryType: query.type,
            code: 'session_unavailable',
          };
        }
        const recoveryIdentityKey = services.recoveryIdentities.read(query.sessionId);
        if (!recoveryIdentityKey) {
          return {
            status: 'unavailable',
            queryType: query.type,
            code: 'session_unavailable',
          };
        }
        const independentChildSnapshot =
          'readChildExecutionAuthority' in owner && owner.readChildSessionIntent
            ? projectIndependentChildExecutions({
                parentState: state,
                readIntent: owner.readChildSessionIntent,
                readChildState: (id) => owner.storage.sessions.loadSnapshot<RuntimeState>(id),
                readAuthority: owner.readChildExecutionAuthority,
                nowMs: Date.now(),
              })
            : undefined;
        const snapshot = readBackgroundExecutionSnapshot({
          sessionId: query.sessionId,
          sessionRevision: state.revision,
          workspace: admission.canonicalPath,
          modelInvocationRuntimeFactory,
          recoveryIdentityKey,
          ...(independentChildSnapshot ? { independentChildSnapshot } : {}),
        });
        if (query.type === 'list_background_executions') {
          return {
            status: 'ok',
            queryType: query.type,
            backgroundSnapshot: snapshot,
          };
        }
        const execution = snapshot.executions.find(
          (candidate) => candidate.executionId === query.executionId,
        );
        return execution
          ? { status: 'ok', queryType: query.type, backgroundExecution: execution }
          : { status: 'not_found', queryType: query.type, code: 'run_not_found' };
      };
      runtimeCoordinatorBinding.bind({
        services,
        capabilities,
        capabilityRegistrySnapshot,
        builtinToolCatalog,
        toolPipelineComposition,
        modelRuntimeFactory: modelRuntime,
        store: createRuntimeStorageAccess(services, owner.storage),
      });
      const mailBindings = new Map<string, ReturnType<typeof createCrossSessionAgentMailBinding>>();
      const contexts = createRuntimeWorkspaceContextFactory({
        create: async (admission) => {
          input.storageOwner?.admitWorkspace?.(admission);
          const key = `${admission.workspaceDigest}\0${admission.projectId}\0${admission.canonicalPath}`;
          const registered =
            byWorkspace.get(key) ??
            (input.workspaceTemplateFor
              ? Object.freeze({
                  admission,
                  input: {
                    ...(await input.workspaceTemplateFor(admission)),
                    workspace: admission.canonicalPath,
                    checkpointPath: input.checkpointPath,
                  },
                })
              : undefined);
          if (!registered) throw new Error('Runtime Workspace is not registered for execution.');
          byWorkspace.set(key, registered);
          const sessionBridges = new Map<string, ConfigurableCliRuntimeBridge>();
          const pendingSessionBridges = new Map<string, Promise<ConfigurableCliRuntimeBridge>>();
          const childRecoveryOrchestrators = new Set<
            ReturnType<typeof createChildSessionOrchestrator>
          >();
          const followupRecoveryOrchestrators = new Map<
            string,
            ReturnType<typeof createChildSessionOrchestrator>
          >();
          const pendingChildRecoveryScans = new Set<Promise<void>>();
          const pendingFollowupRecoveryScans = new Set<Promise<void>>();
          const pendingInterruptRecoveryScans = new Set<Promise<void>>();
          const pendingMailDeliveries = new Set<Promise<void>>();
          let contextClosing = false;
          const scheduleInterruptRecovery = (
            sourceSessionId: string,
            targetSessionId: string,
          ): void => {
            if (contextClosing) return;
            const orchestrator = followupRecoveryOrchestrators.get(sourceSessionId);
            if (!orchestrator) throw new Error('Interrupt source Session runtime is unavailable.');
            const page = orchestrator.schedulePendingInterruptRecovery(targetSessionId);
            if (page.scheduled === 0) return;
            const completion = page.completion
              .then((result) => {
                if (result.recoveryRequired.length > 0)
                  console.error('Independent child interrupt recovery requires attention.', {
                    targetSessionId,
                    intents: result.recoveryRequired,
                  });
                if (!contextClosing && result.observed === 64 && result.processed > 0)
                  scheduleInterruptRecovery(sourceSessionId, targetSessionId);
              })
              .catch((error) =>
                console.error('Independent child interrupt recovery scan failed.', {
                  targetSessionId,
                  errorName: error instanceof Error ? error.name : 'UnknownError',
                }),
              );
            pendingInterruptRecoveryScans.add(completion);
            void completion.finally(() => pendingInterruptRecoveryScans.delete(completion));
          };
          const scheduleFollowupRecovery = (sourceSessionId: string, cursor?: string): void => {
            if (contextClosing) return;
            const orchestrator = followupRecoveryOrchestrators.get(sourceSessionId);
            if (!orchestrator) throw new Error('Followup source Session runtime is unavailable.');
            const page = orchestrator.schedulePendingFollowupRecovery(cursor);
            const completion = page.completion
              .then((result) => {
                if (result.recoveryRequired.length > 0)
                  console.error('Independent child followup recovery requires attention.', {
                    sessionId: sourceSessionId,
                    followups: result.recoveryRequired,
                  });
                if (!contextClosing && result.nextCursor)
                  scheduleFollowupRecovery(sourceSessionId, result.nextCursor);
              })
              .catch((error) =>
                console.error('Independent child followup recovery scan failed.', {
                  sessionId: sourceSessionId,
                  errorName: error instanceof Error ? error.name : 'UnknownError',
                }),
              );
            pendingFollowupRecoveryScans.add(completion);
            void completion.finally(() => pendingFollowupRecoveryScans.delete(completion));
          };
          const crossSessionMailOwner =
            owner.runWithSessionExecution &&
            owner.listPendingCrossSessionQueueMailSources &&
            owner.storage.crossSessionQueueMail &&
            owner.readSessionLineage &&
            owner.readChildSealedGrant &&
            'readChildExecutionAuthority' in owner
              ? (owner as KiteSessionAppServerStorageOwner)
              : undefined;
          let mailBinding: ReturnType<typeof createCrossSessionAgentMailBinding> | undefined;
          const dispatchedChildProofsFor = (sourceSessionId: string) => {
            const mailOwner = crossSessionMailOwner;
            if (!mailOwner) return [];
            if (!mailOwner.storage.sessions.loadSnapshot<RuntimeState>(sourceSessionId)) return [];
            return mailOwner.runWithSessionExecution(sourceSessionId, () => {
              const pending = new Set<string>();
              let cursor: string | undefined;
              do {
                const page = mailOwner.listPendingChildSessionIntents(sourceSessionId, 100, cursor);
                for (const intent of page.entries)
                  if (
                    intent.parentSessionId === sourceSessionId &&
                    !intent.failureReceiptDigest &&
                    !intent.parentClaimSettledEventId
                  )
                    pending.add(intent.childThreadId);
                cursor = page.nextCursor;
              } while (cursor);
              const proofs = mailOwner.storage.sessions
                .loadEventsStrict(sourceSessionId)
                .flatMap(({ event }) => {
                  if (
                    event.type !== 'agent.mail_accepted' ||
                    event.mode !== 'trigger_turn' ||
                    event.senderAgentId !== sourceSessionId ||
                    !event.submissionId ||
                    !pending.has(event.targetAgentId)
                  )
                    return [];
                  const proof =
                    mailOwner.storage.crossSessionQueueMail.readCurrentTurnDispatchedChildProofForSource(
                      sourceSessionId,
                      event.targetAgentId,
                      event.submissionId,
                    ) ??
                    mailOwner.storage.crossSessionQueueMail.readCurrentTurnRoutedNoAttemptChildProofForSource(
                      sourceSessionId,
                      event.targetAgentId,
                      event.submissionId,
                    );
                  return proof ? [proof] : [];
                });
              return proofs;
            });
          };
          const pendingFollowupFundingFor = (sourceSessionId: string) => {
            const mailOwner = crossSessionMailOwner;
            if (!mailOwner) return [];
            if (!mailOwner.storage.sessions.loadSnapshot<RuntimeState>(sourceSessionId)) return [];
            return mailOwner.runWithSessionExecution(sourceSessionId, () => {
              const pending = mailOwner.storage.crossSessionQueueMail.listPendingFollowupFunding(
                sourceSessionId,
                100,
              );
              if (pending.length === 100)
                throw new Error('Followup restart funding index is incomplete.');
              return pending.map((entry) => {
                const targetProof =
                  entry.stage === 'activated' &&
                  entry.targetRunId &&
                  entry.modelInvocationId &&
                  mailOwner.storage.sessions.loadSnapshot<RuntimeState>(entry.targetSessionId)
                    ? mailOwner.storage.crossSessionQueueMail.readActivatedNoAttemptTargetProofForSource(
                        sourceSessionId,
                        entry.targetSessionId,
                        entry.submissionId,
                      )
                    : null;
                return {
                  fundingRunId: entry.fundingRunId,
                  submissionId: entry.submissionId,
                  stage: entry.stage,
                  backupReservationId: entry.backupReservationId,
                  turnReservationId: entry.turnReservationId,
                  modelReservationId: entry.modelReservationId,
                  modelInvocationId: entry.modelInvocationId,
                  ...(targetProof &&
                  targetProof.submissionId === entry.submissionId &&
                  targetProof.targetRunId === entry.targetRunId &&
                  targetProof.invocationId === entry.modelInvocationId
                    ? { targetPreparedNoAttempt: targetProof }
                    : {}),
                };
              });
            });
          };
          const preparedFollowupProofsFor = (targetSessionId: string) => {
            const mailOwner = crossSessionMailOwner;
            if (!mailOwner) return [];
            if (!mailOwner.storage.sessions.loadSnapshot<RuntimeState>(targetSessionId)) return [];
            return mailOwner.runWithSessionExecution(targetSessionId, () => {
              const state = mailOwner.storage.sessions.loadSnapshot<RuntimeState>(targetSessionId);
              const active = state?.activeFollowupTurn;
              if (!active) return [];
              const proof =
                mailOwner.storage.crossSessionQueueMail.readPreparedFollowupRecoveryProof(
                  targetSessionId,
                  active.sourceSessionId,
                  active.submissionId,
                );
              return proof && proof.targetRunId === active.targetRunId ? [proof] : [];
            });
          };
          const preparedCurrentTurnProofsFor = (targetSessionId: string) => {
            const mailOwner = crossSessionMailOwner;
            if (!mailOwner) return [];
            const state = mailOwner.storage.sessions.loadSnapshot<RuntimeState>(targetSessionId);
            const sourceSessionId = state?.childSessionOrigin?.parentSessionId;
            if (!state || !sourceSessionId) return [];
            return mailOwner.runWithSessionExecution(targetSessionId, () => {
              const routed = mailOwner.storage.sessions
                .loadEventsStrict(targetSessionId)
                .filter(
                  ({ event }) =>
                    event.type === 'agent.followup_routed' &&
                    event.route === 'current_turn' &&
                    event.targetAgentId === targetSessionId,
                );
              const proofs = routed.flatMap(({ event }) => {
                if (event.type !== 'agent.followup_routed') return [];
                const proof =
                  mailOwner.storage.crossSessionQueueMail.readCurrentTurnPreparedNoAttemptProof(
                    targetSessionId,
                    sourceSessionId,
                    event.submissionId,
                  );
                return proof && proof.invocationId === event.invocationId ? [proof] : [];
              });
              if (proofs.length > 1)
                throw new Error('Prepared current-turn recovery proof is ambiguous.');
              return proofs;
            });
          };
          if (crossSessionMailOwner) {
            const ensureTargetCoordinator = (targetSessionId: string) => {
              const state = owner.storage.sessions.loadSnapshot<RuntimeState>(targetSessionId);
              if (
                !state ||
                state.session.threadId !== targetSessionId ||
                state.session.workspace !== admission.canonicalPath ||
                state.session.projectId !== admission.projectId ||
                state.session.canonicalWorkspaceDigest !== admission.workspaceDigest ||
                !/^sha256:[a-f0-9]{64}$/u.test(state.session.canonicalWorkspaceDigest)
              )
                throw new Error('Cross-Session mail target Workspace identity is unavailable.');
              const runtime = modelInvocationRuntimeFactory(admission.canonicalPath);
              return runtimeCoordinatorBinding.access().ensure({
                sessionId: targetSessionId,
                userId: state.session.userId,
                workspace: state.session.workspace,
                projectId: state.session.projectId,
                canonicalWorkspaceDigest: state.session
                  .canonicalWorkspaceDigest as `sha256:${string}`,
                interactionMode: state.mode,
                recoveryIdentityKey: state.toolRecovery.identityKey,
                sandboxAvailable: appSandboxBackendAvailable(registered.input.sandboxBackend),
                modelArtifactEvidence: runtime.evidence,
                capabilityArtifactEvidence: runtime.capabilityArtifacts,
                preservePendingFollowupFunding: pendingFollowupFundingFor(targetSessionId),
                preservePreparedFollowupModels: preparedFollowupProofsFor(targetSessionId),
                preservePreparedCurrentTurnModels: preparedCurrentTurnProofsFor(targetSessionId),
              });
            };
            mailBinding = createCrossSessionAgentMailBinding({
              owner: crossSessionMailOwner,
              runTargetDelivery: (targetSessionId, operation) =>
                context.enqueueSessionWork(targetSessionId, async () => {
                  if (contextClosing)
                    throw new Error('Cross-Session mail target delivery owner is closing.');
                  await operation();
                }),
              receiveTarget: async ({ targetSessionId, event, mutation }) => {
                crossSessionMailOwner.runWithSessionExecution(targetSessionId, () => {
                  ensureTargetCoordinator(targetSessionId).commitCrossSessionQueueMailReceive(
                    event,
                    mutation,
                  );
                });
              },
              scheduleDelivery: (sourceSessionId, messageId) => {
                if (contextClosing) return;
                const delivery = mailDetachedScope
                  .runInAsyncScope(() => mailBinding!.recoverPending(sourceSessionId))
                  .then(
                    () => undefined,
                    (error) => {
                      console.error('Cross-Session mail delivery remains pending.', {
                        sourceSessionId,
                        messageId,
                        errorName: error instanceof Error ? error.name : 'UnknownError',
                      });
                    },
                  );
                pendingMailDeliveries.add(delivery);
                void delivery.finally(() => pendingMailDeliveries.delete(delivery));
                return delivery;
              },
              scheduleFollowup: (sourceSessionId) => {
                if (!contextClosing) scheduleFollowupRecovery(sourceSessionId);
              },
              scheduleInterrupt: (targetSessionId, sourceSessionId) => {
                if (!contextClosing) scheduleInterruptRecovery(sourceSessionId, targetSessionId);
              },
            });
            mailBindings.set(key, mailBinding);
          }
          const bridgeForSession = async (
            sessionId: string,
            requestedModel?: { readonly provider: string; readonly name: string },
          ): Promise<ConfigurableCliRuntimeBridge> => {
            const current = sessionBridges.get(sessionId);
            if (current) return current;
            const pending = pendingSessionBridges.get(sessionId);
            if (pending) return pending;
            const creation = (async (): Promise<ConfigurableCliRuntimeBridge> => {
              const persisted = persistedAdmissionForSession(sessionId);
              if (persisted && !sameAdmission(persisted, admission)) {
                throw new Error('Runtime Session belongs to a different Workspace.');
              }
              bySession.set(sessionId, admission);
              const persistedModel = owner.storage.sessions.getSessionModelRoute(sessionId);
              const selectedModel = requestedModel ?? persistedModel ?? undefined;
              const defaultConfig = desiredConfigs.get(key) ?? registered.input.config;
              const sessionConfig = selectedModel
                ? (registered.input.resolveModelConfig?.(selectedModel) ??
                  (selectedModel.provider === defaultConfig.providerName &&
                  selectedModel.name === defaultConfig.modelName
                    ? defaultConfig
                    : (() => {
                        throw new Error(
                          `Model route '${selectedModel.provider}/${selectedModel.name}' is unavailable.`,
                        );
                      })()))
                : defaultConfig;
              const bridgeIdentity = persistedWorkspaceIdentity(admission.canonicalPath);
              if (
                !bridgeIdentity ||
                bridgeIdentity.projectId !== admission.projectId ||
                bridgeIdentity.workspaceDigest !== admission.workspaceDigest
              ) {
                throw new Error('Runtime Session Workspace identity changed.');
              }
              const bridgeInput = {
                ...registered.input,
                config: sessionConfig,
                sessionId,
                followupPolicyForPreparedTool: (
                  {
                    state,
                    scope,
                    targetSessionId,
                    preparedPolicyDigest,
                  }: Parameters<
                    NonNullable<CliRuntimeBridgeInput['followupPolicyForPreparedTool']>
                  >[0],
                  activeRunConfig: Readonly<AgentConfig>,
                ) => {
                  const route = owner.storage.sessions.getSessionModelRoute(sessionId);
                  const caps = activeRunConfig.modelCapabilities;
                  const running = Object.values(state.capabilities.invocations).filter(
                    (invocation) =>
                      invocation.toolCallId === scope.toolCallId && invocation.status === 'running',
                  );
                  const invocation = running[0];
                  const call = state.tools.calls[scope.toolCallId];
                  if (
                    !mailBinding ||
                    !targetSessionId ||
                    targetSessionId === sessionId ||
                    state.session.threadId !== sessionId ||
                    scope.sessionId !== sessionId ||
                    scope.sourceAgentId !== sessionId ||
                    route?.provider !== activeRunConfig.providerName ||
                    route.name !== activeRunConfig.modelName ||
                    state.turn.status !== 'active' ||
                    call?.name !== 'followup_task' ||
                    call.createdAtTurnId !== scope.turnId ||
                    call.modelInvocationId !== scope.modelInvocationId ||
                    running.length !== 1 ||
                    !invocation?.admissionDigest ||
                    !Number.isSafeInteger(invocation.attemptsStarted) ||
                    `${invocation.invocationId}:attempt:${invocation.attemptsStarted}` !==
                      scope.effectAttemptId ||
                    !preparedPolicyDigest ||
                    !/^sha256:[a-f0-9]{64}$/u.test(state.session.canonicalWorkspaceDigest ?? '') ||
                    !state.capabilities.catalogRevision ||
                    !Number.isSafeInteger(caps?.contextWindowTokens) ||
                    !Number.isSafeInteger(caps?.maxOutputTokens) ||
                    (caps?.contextWindowTokens ?? 0) <= (caps?.maxOutputTokens ?? 0) ||
                    (caps?.maxOutputTokens ?? 0) < 1
                  )
                    return null;
                  return {
                    phaseCeiling: getAgentPhase(runtimeHostStateActivePlanning(state)),
                    authorizationDigest: invocation.authorizationDigest,
                    admissionDigest: invocation.admissionDigest,
                    effectiveEffectsDigest: invocation.effectiveEffectsDigest,
                    capabilityDigest: state.capabilities.catalogRevision,
                    policyRevision: preparedPolicyDigest,
                    workspaceDigest: state.session.canonicalWorkspaceDigest!,
                    interactionModeRevision: state.interactionModeRevision,
                    contextWindowTokens: caps!.contextWindowTokens!,
                    maxOutputTokens: caps!.maxOutputTokens!,
                    firstAttemptTimeoutMs: 60_000,
                    boundedContext: true as const,
                  };
                },
                ...(mailBinding ? { crossSessionQueueMail: mailBinding } : {}),
                ...(crossSessionMailOwner
                  ? {
                      dispatchedChildRecoveryProofs: () => dispatchedChildProofsFor(sessionId),
                      pendingFollowupFunding: () => pendingFollowupFundingFor(sessionId),
                      preparedFollowupRecoveryProofs: () => preparedFollowupProofsFor(sessionId),
                      preparedCurrentTurnRecoveryProofs: () =>
                        preparedCurrentTurnProofsFor(sessionId),
                    }
                  : {}),
                restartRecoveryOwnership: () => recoveryGenerations.get(sessionId),
                enqueueSessionWork: context.enqueueSessionWork,
                projectIdentity: bridgeIdentity,
              };
              const independentChildren =
                'readChildExecutionAuthority' in owner
                  ? createChildSessionOrchestrator({
                      detachedScope: independentChildDetachedScope,
                      owner,
                      effectLeases: services.leases,
                      parentSessionId: sessionId,
                      bridgeInput,
                      coordinators: runtimeCoordinatorBinding.access(),
                      modelRuntimeFactory: modelInvocationRuntimeFactory,
                      capabilityExecution: capabilities,
                      enqueueSessionWork: context.enqueueSessionWork,
                      projectChildSession: (childSessionId, state) =>
                        projectStoredSessionForOwner(childSessionId, state),
                      publishChildNotification: (notification) => {
                        if (!owner.readChildSession?.(sessionId, notification.sessionId))
                          throw new Error('Child notification has no parent ownership proof.');
                        host.publishExternalNotification(notification);
                      },
                      ...(mailBinding
                        ? {
                            scheduleTerminalReplyDelivery: (
                              childSessionId: string,
                              messageId: string,
                            ) => {
                              if (contextClosing) return;
                              const delivery = mailDetachedScope
                                .runInAsyncScope(() =>
                                  mailBinding!.recoverPendingReplies(childSessionId),
                                )
                                .then(
                                  () => undefined,
                                  (error) => {
                                    console.error('Terminal Agent reply remains pending.', {
                                      childSessionId,
                                      messageId,
                                      errorName:
                                        error instanceof Error ? error.name : 'UnknownError',
                                    });
                                  },
                                );
                              pendingMailDeliveries.add(delivery);
                              void delivery.finally(() => pendingMailDeliveries.delete(delivery));
                              return delivery;
                            },
                          }
                        : {}),
                      readCurrentSourceFollowupContext: ({ sourceState }) => {
                        if (sourceState.session.threadId !== sessionId) return null;
                        const manager = registered.input.mcpManager;
                        let mcpSnapshot: ReturnType<
                          NonNullable<typeof manager>['getCapabilitySnapshot']
                        > | null;
                        try {
                          mcpSnapshot = manager ? manager.getCapabilitySnapshot() : null;
                        } catch {
                          return null;
                        }
                        if (manager && !mcpSnapshot) return null;
                        let skillCatalog = null;
                        const flags = getFeatureFlags(sessionConfig);
                        if (flags.skillWorkflow && flags.skillActivation) {
                          try {
                            skillCatalog = refreshSkillCatalog(registered.input.skillOptions, {
                              resolveCapability: createSkillCapabilityResolver(manager),
                            });
                          } catch {
                            return null;
                          }
                        }
                        return {
                          mcpSnapshot,
                          skillCatalog,
                          agentMailboxPortAvailable: Boolean(mailBinding),
                          agentMailboxQueueOnlyAvailable: false,
                          interactionModeOverride: null,
                        };
                      },
                      readCurrentTargetPolicyContext: ({ targetState }) => {
                        const targetRoute = owner.storage.sessions.getSessionModelRoute(
                          targetState.session.threadId,
                        );
                        if (!targetRoute) return null;
                        const targetConfig =
                          registered.input.resolveModelConfig?.(targetRoute) ??
                          (targetRoute.provider === sessionConfig.providerName &&
                          targetRoute.name === sessionConfig.modelName
                            ? sessionConfig
                            : null);
                        if (!targetConfig) return null;
                        const manager = registered.input.mcpManager;
                        let mcpSnapshot: ReturnType<
                          NonNullable<typeof manager>['getCapabilitySnapshot']
                        > | null;
                        try {
                          mcpSnapshot = manager ? manager.getCapabilitySnapshot() : null;
                        } catch {
                          return null;
                        }
                        if (manager && !mcpSnapshot) return null;
                        let skillCatalog = null;
                        const flags = getFeatureFlags(targetConfig);
                        if (flags.skillWorkflow && flags.skillActivation) {
                          try {
                            skillCatalog = refreshSkillCatalog(registered.input.skillOptions, {
                              resolveCapability: createSkillCapabilityResolver(manager),
                            });
                          } catch {
                            return null;
                          }
                        }
                        return {
                          observedTargetRevision: targetState.revision,
                          mcpSnapshot,
                          skillCatalog,
                        };
                      },
                    })
                  : undefined;
              const bridge = createCliRuntimeBridge(
                {
                  ...bridgeInput,
                  ...(independentChildren ? { childSessionAcceptance: independentChildren } : {}),
                  onCommittedCancel: () => {
                    if (mailRecoveryClosing || !scanPendingTerminalReplies) return;
                    void Promise.resolve()
                      .then(() =>
                        mailDetachedScope.runInAsyncScope(() => scanPendingTerminalReplies!()),
                      )
                      .catch((error) => {
                        console.error('Cancelled followup notice remains pending.', {
                          errorName: error instanceof Error ? error.name : 'UnknownError',
                        });
                      });
                  },
                },
                capabilities,
                modelInvocationRuntimeFactory,
                (resolvedSessionId) => resolveKiteRecoveryIdentity(services, resolvedSessionId),
                runtimeCoordinatorBinding.access(),
                interactionBroker,
                (resolvedSessionId) => {
                  const resolved = persistedAdmissionForSession(resolvedSessionId);
                  if (!resolved) return [];
                  return [...connectionWorkspaces.entries()]
                    .filter(([, workspace]) => sameAdmission(workspace, resolved))
                    .map(([connectionId]) => connectionId);
                },
              );
              if (independentChildren)
                independentChildren.bindParentApprovalWake((event) =>
                  bridge.publishChildApprovalWake(event),
                );
              if (independentChildren) {
                childRecoveryOrchestrators.add(independentChildren);
                followupRecoveryOrchestrators.set(sessionId, independentChildren);
              }
              if (owner.storage.sessions.loadSnapshot<RuntimeState>(sessionId)) {
                await bridge.recoverSession(sessionId, () => undefined);
                if (independentChildren) {
                  const schedulePage = async (cursor?: string): Promise<void> => {
                    if (contextClosing) return;
                    const page = await independentChildren.schedulePendingRecovery(cursor);
                    const completion = page.completion
                      .then(async (result) => {
                        if (result.recoveryRequired.length > 0)
                          console.error('Independent child Session recovery requires attention.', {
                            sessionId,
                            children: result.recoveryRequired,
                          });
                        if (!contextClosing && result.nextCursor)
                          await schedulePage(result.nextCursor);
                      })
                      .catch((error) =>
                        console.error('Independent child Session recovery scan failed.', {
                          sessionId,
                          error,
                        }),
                      );
                    pendingChildRecoveryScans.add(completion);
                    void completion.finally(() => pendingChildRecoveryScans.delete(completion));
                  };
                  await schedulePage();
                  scheduleFollowupRecovery(sessionId);
                }
              }
              sessionBridges.set(sessionId, bridge);
              // A cold scan may have observed this source while its previous
              // execution still required reconciliation. Once the source bridge
              // exists, revisit durable Stop rows without replaying the Tool.
              if (!contextClosing && owner.listPendingCrossSessionInterruptTargets) {
                const scan = mailDetachedScope
                  .runInAsyncScope(() => scanPendingInterrupts?.() ?? Promise.resolve())
                  .catch((error) =>
                    console.error('Independent child interrupt retry scan failed.', {
                      sessionId,
                      errorName: error instanceof Error ? error.name : 'UnknownError',
                    }),
                  );
                pendingInterruptRecoveryScans.add(scan);
                void scan.finally(() => pendingInterruptRecoveryScans.delete(scan));
              }
              return bridge;
            })();
            pendingSessionBridges.set(sessionId, creation);
            try {
              return await creation;
            } finally {
              if (pendingSessionBridges.get(sessionId) === creation) {
                pendingSessionBridges.delete(sessionId);
              }
            }
          };
          ensureFollowupRecoveryForWorkspace.set(key, async (sourceSessionId) => {
            await bridgeForSession(sourceSessionId);
          });
          ensureInterruptRecoveryForWorkspace.set(key, async (sourceSessionId, targetSessionId) => {
            await bridgeForSession(sourceSessionId);
            scheduleInterruptRecovery(sourceSessionId, targetSessionId);
          });
          const bridge: ConfigurableCliRuntimeBridge = Object.freeze({
            publishChildApprovalWake: () => {
              throw new Error('Child approval wake requires one parent Session bridge.');
            },
            applySelectedConfig: (config: AgentConfig) => {
              desiredConfigs.set(key, config);
              for (const [sessionId, sessionBridge] of sessionBridges) {
                const route = owner.storage.sessions.getSessionModelRoute(sessionId);
                try {
                  sessionBridge.applySelectedConfig(
                    route && registered.input.resolveModelConfig
                      ? registered.input.resolveModelConfig(route)
                      : config,
                  );
                } catch {
                  // A removed Session route keeps its last resolved config until the user
                  // chooses a valid replacement; changing the Workspace default cannot retarget it.
                }
              }
              for (const [sessionId, pendingBridge] of pendingSessionBridges) {
                void pendingBridge.then((sessionBridge) => {
                  const route = owner.storage.sessions.getSessionModelRoute(sessionId);
                  try {
                    sessionBridge.applySelectedConfig(
                      route && registered.input.resolveModelConfig
                        ? registered.input.resolveModelConfig(route)
                        : config,
                    );
                  } catch {
                    // See the settled-bridge path above.
                  }
                });
              }
            },
            recoverSession: async (
              sessionId: string,
              publish: Parameters<RuntimeHostExecutionBridge['recoverSession']>[1],
            ) => (await bridgeForSession(sessionId)).recoverSession(sessionId, publish),
            recoverCommittedResume: async (
              command: Extract<RuntimeCommand, { readonly type: 'resume_session' }>,
              committedRevision: number,
              publish: (notification: RuntimeNotification) => void,
              commandContext?: Readonly<RuntimeCommandContext>,
            ) =>
              (await bridgeForSession(command.sessionId)).recoverCommittedResume(
                command,
                committedRevision,
                publish,
                commandContext,
              ),
            inspectCommand: async (
              command: RuntimeCommand,
              context: Parameters<RuntimeHostExecutionBridge['inspectCommand']>[1],
            ) =>
              (
                await bridgeForSession(
                  command.type === 'fork_session'
                    ? command.sourceSessionId
                    : context.targetSessionId,
                  command.type === 'create_session' ? command.model : undefined,
                )
              ).inspectCommand(command, context),
            query: async (query: RuntimeQuery): Promise<RuntimeQueryResult> => {
              if (query.type === 'list_sessions') {
                const results = await Promise.all(
                  [...sessionBridges.values()].map((sessionBridge) => sessionBridge.query(query)),
                );
                return {
                  status: 'ok' as const,
                  queryType: 'list_sessions' as const,
                  sessions: results.flatMap((result) =>
                    result.status === 'ok' ? (result.sessions ?? []) : [],
                  ),
                };
              }
              return (await bridgeForSession(query.sessionId)).query(query);
            },
            shutdownSession: async (
              sessionId: string,
              reason: string,
              publish: Parameters<RuntimeHostExecutionBridge['shutdownSession']>[2],
            ) => (await bridgeForSession(sessionId)).shutdownSession(sessionId, reason, publish),
            close: async () => {
              contextClosing = true;
              await Promise.allSettled(pendingSessionBridges.values());
              pendingSessionBridges.clear();
              await Promise.all(
                [...childRecoveryOrchestrators].map((orchestrator) =>
                  orchestrator.stopPendingRecovery(),
                ),
              );
              await Promise.all(pendingChildRecoveryScans);
              await Promise.all(pendingFollowupRecoveryScans);
              await Promise.all(pendingInterruptRecoveryScans);
              await Promise.all(pendingMailDeliveries);
              childRecoveryOrchestrators.clear();
              followupRecoveryOrchestrators.clear();
              pendingChildRecoveryScans.clear();
              pendingFollowupRecoveryScans.clear();
              pendingInterruptRecoveryScans.clear();
              pendingMailDeliveries.clear();
              sessionBridges.clear();
            },
          });
          bridges.set(key, bridge);
          return {
            admission,
            bridge,
            close: async () => {
              try {
                await bridge.close();
              } finally {
                mailBindings.delete(key);
                ensureFollowupRecoveryForWorkspace.delete(key);
                ensureInterruptRecoveryForWorkspace.delete(key);
                bridges.delete(key);
              }
            },
          };
        },
        resolveWorkspaceForSession: async (sessionId) => persistedAdmissionForSession(sessionId),
      });
      scanPendingAgentMail = async () => {
        if (!owner.listPendingCrossSessionQueueMailSources) return;
        let cursor: string | undefined;
        do {
          if (mailRecoveryClosing) return;
          const sources = owner.listPendingCrossSessionQueueMailSources(100, cursor);
          for (const sourceSessionId of sources) {
            if (mailRecoveryClosing) return;
            try {
              const lineage = owner.readSessionLineage?.(sourceSessionId);
              if (!lineage) throw new Error('Cross-Session mail source lineage is unavailable.');
              const rootSessionId = lineage.parentSessionId ?? sourceSessionId;
              const sourceAdmission = persistedAdmissionForSession(rootSessionId);
              if (!sourceAdmission)
                throw new Error('Cross-Session mail source Workspace is not admitted.');
              await contexts.create(sourceAdmission);
              const key = `${sourceAdmission.workspaceDigest}\0${sourceAdmission.projectId}\0${sourceAdmission.canonicalPath}`;
              const binding = mailBindings.get(key);
              if (!binding) throw new Error('Cross-Session mail Store owner is unavailable.');
              let messageCursor: string | undefined;
              do {
                if (mailRecoveryClosing) return;
                const page = await binding.recoverPending(sourceSessionId, 100, messageCursor);
                messageCursor = page.nextCursor;
              } while (messageCursor);
            } catch (error) {
              // The source outbox is still durable; another admitted owner may retry it.
              console.error('Cross-Session mail recovery requires attention.', {
                sourceSessionId,
                error,
              });
            }
          }
          cursor = sources.length === 100 ? sources.at(-1) : undefined;
        } while (cursor);
      };
      scanPendingTerminalReplies = async () => {
        const replyMail = owner.storage.crossSessionQueueMail;
        const runWithSessionExecution = owner.runWithSessionExecution;
        const listMissingFollowup = owner.listUnrepliedSettledFollowupTerminalSources;
        const listUnnotifiedRelease = owner.listUnnotifiedAcceptedFollowupReleases;
        const listPending = owner.listPendingCrossSessionTerminalReplyMailSources;
        if (!replyMail || !runWithSessionExecution || !listPending) return;
        const recoverSource = async (
          childSessionId: string,
          parentSessionId: string,
        ): Promise<void> => {
          const admission = persistedAdmissionForSession(parentSessionId);
          if (!admission) throw new Error('Terminal reply parent Workspace is not admitted.');
          await contexts.create(admission);
          const key = `${admission.workspaceDigest}\0${admission.projectId}\0${admission.canonicalPath}`;
          const binding = mailBindings.get(key);
          if (!binding) throw new Error('Terminal reply Store owner is unavailable.');
          let messageCursor: string | undefined;
          do {
            if (mailRecoveryClosing) return;
            const page = await binding.recoverPendingReplies(childSessionId, 100, messageCursor);
            messageCursor = page.nextCursor;
          } while (messageCursor);
        };
        let followupCursor: { childSessionId: string; submissionId: string } | undefined;
        do {
          if (mailRecoveryClosing || !listMissingFollowup) break;
          const missing = listMissingFollowup(100, followupCursor);
          for (const row of missing) {
            if (mailRecoveryClosing) return;
            try {
              const admission = persistedAdmissionForSession(row.parentSessionId);
              if (!admission) throw new Error('Followup reply parent Workspace is not admitted.');
              await contexts.create(admission);
              runWithSessionExecution(row.childSessionId, () =>
                replyMail.acceptFollowupTerminalReply(
                  row.childSessionId,
                  row.parentSessionId,
                  row.submissionId,
                  Date.now(),
                ),
              );
              await recoverSource(row.childSessionId, row.parentSessionId);
            } catch (error) {
              console.error('Followup terminal reply recovery requires attention.', {
                childSessionId: row.childSessionId,
                submissionId: row.submissionId,
                errorName: error instanceof Error ? error.name : 'UnknownError',
              });
            }
          }
          followupCursor =
            missing.length === 100
              ? {
                  childSessionId: missing[missing.length - 1]!.childSessionId,
                  submissionId: missing[missing.length - 1]!.submissionId,
                }
              : undefined;
        } while (followupCursor);
        let releaseCursor: { childSessionId: string; submissionId: string } | undefined;
        do {
          if (mailRecoveryClosing || !listUnnotifiedRelease) break;
          const missing = listUnnotifiedRelease(100, releaseCursor);
          for (const row of missing) {
            if (mailRecoveryClosing) return;
            try {
              const admission = persistedAdmissionForSession(row.parentSessionId);
              if (!admission)
                throw new Error('Accepted release notice parent Workspace is not admitted.');
              await contexts.create(admission);
              runWithSessionExecution(row.childSessionId, () =>
                replyMail.acceptAcceptedReleaseNotice(
                  row.childSessionId,
                  row.parentSessionId,
                  row.submissionId,
                  Date.now(),
                ),
              );
              await recoverSource(row.childSessionId, row.parentSessionId);
            } catch (error) {
              console.error('Accepted followup release notice recovery requires attention.', {
                childSessionId: row.childSessionId,
                submissionId: row.submissionId,
                errorName: error instanceof Error ? error.name : 'UnknownError',
              });
            }
          }
          releaseCursor =
            missing.length === 100
              ? {
                  childSessionId: missing[missing.length - 1]!.childSessionId,
                  submissionId: missing[missing.length - 1]!.submissionId,
                }
              : undefined;
        } while (releaseCursor);
        let pendingCursor: string | undefined;
        do {
          if (mailRecoveryClosing) return;
          const sources = listPending(100, pendingCursor);
          for (const childSessionId of sources) {
            if (mailRecoveryClosing) return;
            try {
              const parentSessionId = owner.readSessionLineage?.(childSessionId)?.parentSessionId;
              if (!parentSessionId) throw new Error('Terminal reply source has no parent Session.');
              await recoverSource(childSessionId, parentSessionId);
            } catch (error) {
              console.error('Terminal Agent reply delivery requires attention.', {
                childSessionId,
                errorName: error instanceof Error ? error.name : 'UnknownError',
              });
            }
          }
          pendingCursor = sources.length === 100 ? sources.at(-1) : undefined;
        } while (pendingCursor);
      };
      scanPendingFollowups = async () => {
        if (!owner.listPendingCrossSessionFollowupSources) return;
        let cursor: string | undefined;
        do {
          if (mailRecoveryClosing) return;
          const sources = owner.listPendingCrossSessionFollowupSources(100, cursor);
          for (const sourceSessionId of sources) {
            if (mailRecoveryClosing) return;
            try {
              const lineage = owner.readSessionLineage?.(sourceSessionId);
              if (!lineage) throw new Error('Followup source lineage is unavailable.');
              const rootSessionId = lineage.parentSessionId ?? sourceSessionId;
              const sourceAdmission = persistedAdmissionForSession(rootSessionId);
              if (!sourceAdmission) throw new Error('Followup source Workspace is not admitted.');
              await contexts.create(sourceAdmission);
              const key = `${sourceAdmission.workspaceDigest}\0${sourceAdmission.projectId}\0${sourceAdmission.canonicalPath}`;
              const ensure = ensureFollowupRecoveryForWorkspace.get(key);
              if (!ensure) throw new Error('Followup source runtime is unavailable.');
              // The source bridge schedules bounded target recovery without awaiting Provider work.
              await ensure(sourceSessionId);
            } catch (error) {
              console.error('Independent child followup startup recovery requires attention.', {
                sourceSessionId,
                errorName: error instanceof Error ? error.name : 'UnknownError',
              });
            }
          }
          cursor = sources.length === 100 ? sources.at(-1) : undefined;
        } while (cursor);
      };
      scanPendingInterrupts = async () => {
        if (!owner.listPendingCrossSessionInterruptTargets) return;
        let cursor: string | undefined;
        do {
          if (mailRecoveryClosing) return;
          const targets = owner.listPendingCrossSessionInterruptTargets(100, cursor);
          for (const targetSessionId of targets) {
            if (mailRecoveryClosing) return;
            try {
              const sourceSessionId = owner.readSessionLineage?.(targetSessionId)?.parentSessionId;
              if (!sourceSessionId)
                throw new Error('Interrupt target has no direct parent Session.');
              const sourceAdmission = persistedAdmissionForSession(sourceSessionId);
              if (!sourceAdmission) throw new Error('Interrupt source Workspace is not admitted.');
              await contexts.create(sourceAdmission);
              const key = `${sourceAdmission.workspaceDigest}\0${sourceAdmission.projectId}\0${sourceAdmission.canonicalPath}`;
              const ensure = ensureInterruptRecoveryForWorkspace.get(key);
              if (!ensure) throw new Error('Interrupt target runtime is unavailable.');
              // After SIGKILL the old source owner can still hold an unexpired lease.
              // Wait for that lease to become fenceable; never seize a live owner.
              const retryUntil = Date.now() + 35_000;
              for (;;) {
                try {
                  await ensure(sourceSessionId, targetSessionId);
                  break;
                } catch (error) {
                  if (
                    !(error instanceof KiteAppServerSessionError) ||
                    error.code !== 'session_busy' ||
                    Date.now() >= retryUntil
                  )
                    throw error;
                  await new Promise<void>((resolve) => setTimeout(resolve, 500));
                  if (mailRecoveryClosing) return;
                }
              }
            } catch (error) {
              console.error('Independent child interrupt startup recovery requires attention.', {
                targetSessionId,
                errorName: error instanceof Error ? error.name : 'UnknownError',
              });
            }
          }
          cursor = targets.length === 100 ? targets.at(-1) : undefined;
        } while (cursor);
      };
      const admission = createRuntimeWorkspaceAdmission({
        admitForCreate: async (workspace) => {
          const registered = [...byWorkspace.values()].find(
            (candidate) => candidate.admission.canonicalPath === workspace,
          );
          if (registered) return registered.admission;
          if (input.workspaceTemplateFor) {
            const canonicalPath = realpathSync.native(workspace);
            const project = resolveProjectIdentity(canonicalPath);
            return Object.freeze({
              canonicalPath,
              projectId: project.projectId,
              workspaceDigest: project.workspaceDigest,
            });
          }
          throw new Error('Runtime Workspace is not admitted for creation.');
        },
        resolveForSession: async (sessionId) => persistedAdmissionForSession(sessionId),
      });
      const router = createRuntimeExecutionBridgeRouter({
        contexts,
        admission,
        queryWithoutSession: async (query): Promise<RuntimeQueryResult> => {
          if (query.type !== 'list_sessions') {
            return {
              status: 'rejected',
              queryType: query.type,
              code: 'unsupported',
            };
          }
          // The process-wide index is Store authority. Reading it must never
          // instantiate a Workspace context (which can load project config,
          // start MCP, or scan Skills for a Workspace the caller did not admit).
          const projections = owner
            .listCurrentSessions('', 1_000)
            .map(({ threadId }) => projectStoredSessionForList(threadId));
          return {
            status: 'ok',
            queryType: 'list_sessions',
            sessions: projections.filter((projection) => projection !== undefined),
          };
        },
      });
      recoverInterruptedSession = async (sessionId, generation, assertCurrent) => {
        recoveryGenerations.set(sessionId, {
          kind: 'fenced_previous_execution',
          controllerGeneration: generation,
          assertCurrent,
        });
        try {
          await router.recoverSession(sessionId, () => undefined);
        } finally {
          recoveryGenerations.delete(sessionId);
        }
      };
      return Object.freeze({
        recoverSession: router.recoverSession.bind(router),
        recoverCommittedResume: (
          command: Extract<RuntimeCommand, { readonly type: 'resume_session' }>,
          committedRevision: number,
          publish: (notification: RuntimeNotification) => void,
          commandContext?: Readonly<RuntimeCommandContext>,
        ) => router.recoverCommittedResume(command, committedRevision, publish, commandContext),
        inspectCommand: async (
          command: RuntimeCommand,
          commandContext: Parameters<RuntimeHostExecutionBridge['inspectCommand']>[1],
        ): Promise<RuntimeHostCommandInspection> => {
          if (command.type === 'recover_session') {
            const state = owner.loadCurrentSnapshot(command.sessionId);
            if (!state || !owner.recovery || !owner.commitRecoveryDecision)
              return {
                kind: 'terminal',
                receipt: {
                  status: 'rejected',
                  commandId: command.commandId,
                  code: state ? 'unsupported' : 'session_not_found',
                },
              };
            const facts = owner.recovery.inspect(command.sessionId);
            const code =
              facts.authority.revision !== command.expectedAuthorityRevision
                ? 'revision_conflict'
                : facts.authority.status !== 'recovery_required'
                  ? 'runtime_busy'
                  : !facts.authority.cleanupConfirmed
                    ? 'session_cleanup_pending'
                    : facts.pendingEffects.length > 0 || facts.unknownEffects.length > 0
                      ? 'external_outcome_unknown'
                      : undefined;
            if (code)
              return {
                kind: 'terminal',
                receipt: {
                  status: code === 'revision_conflict' ? 'conflict' : 'rejected',
                  commandId: command.commandId,
                  code,
                },
              };
            return {
              kind: 'accepted',
              decision: {
                targetSessionId: command.sessionId,
                commit: async (evidence) => {
                  const receipt = createRuntimeStoredCommandReceipt(evidence, state.revision);
                  owner.commitRecoveryDecision!(
                    {
                      sessionId: command.sessionId,
                      snapshot: state,
                      events: [],
                      commandReceipt: receipt,
                    },
                    command.expectedRevision,
                    command.expectedAuthorityRevision,
                  );
                  return {
                    receipt: {
                      status: 'applied',
                      commandId: command.commandId,
                      sessionId: command.sessionId,
                      revision: state.revision,
                    },
                  };
                },
              },
            };
          }
          if (
            command.type === 'set_interaction_mode' &&
            runtimeCoordinatorBinding.access().get(command.sessionId) &&
            owner.ownsSessionExecution?.(command.sessionId) === false
          ) {
            return {
              kind: 'terminal',
              receipt: {
                status: 'rejected',
                commandId: command.commandId,
                code: 'session_cleanup_pending',
              },
            };
          }
          // Settings do not instantiate Workspace configuration, models, or an execution Runtime.
          // A live coordinator remains the sole State owner and uses its existing fenced commit.
          if (
            command.type !== 'set_interaction_mode' ||
            !owner.commitUnownedInteractionMode ||
            runtimeCoordinatorBinding.access().get(command.sessionId)
          ) {
            return router.inspectCommand(command, commandContext);
          }
          const state = owner.loadCurrentSnapshot(command.sessionId);
          if (!state)
            return {
              kind: 'terminal',
              receipt: {
                status: 'not_found',
                commandId: command.commandId,
                code: 'session_not_found',
              },
            };
          if (state.revision !== command.expectedRevision)
            return {
              kind: 'terminal',
              receipt: {
                status: 'conflict',
                commandId: command.commandId,
                code: 'revision_conflict',
                currentRevision: state.revision,
              },
            };
          return {
            kind: 'accepted',
            decision: {
              targetSessionId: command.sessionId,
              commit: async (evidence) => {
                let projection: RuntimeSessionProjection | undefined;
                const { runs: _runs, ...policyServices } = services;
                const session = createRuntimeHostStateSession({
                  state,
                  services: {
                    ...policyServices,
                    transactions: {
                      ...services.transactions,
                      commitCommandDecision: (transaction) => {
                        projection = projectStoredSessionForOwner(
                          command.sessionId,
                          transaction.snapshot,
                        );
                        owner.commitUnownedInteractionMode!(transaction, state.revision);
                      },
                    },
                  },
                  clock: () => new Date(evidence.committedAt).toISOString(),
                  id: () => crypto.randomUUID(),
                });
                const { receipt, events } = commitInteractionModeCommand(
                  session,
                  command,
                  evidence,
                );
                const committedProjection = projection;
                if (!committedProjection)
                  throw new Error('Committed policy projection is unavailable.');
                return {
                  receipt: {
                    status: 'applied',
                    commandId: receipt.commandId,
                    sessionId: receipt.targetSessionId,
                    revision: receipt.committedRevision,
                  },
                  activation: async (publish) => {
                    if (events.length === 0) return;
                    publish({
                      schema: RUNTIME_NOTIFICATION_SCHEMA_,
                      durability: 'durable',
                      sessionId: command.sessionId,
                      revision: receipt.committedRevision,
                      projection: {
                        kind: 'session',
                        session: committedProjection,
                        event: { type: 'interaction_mode.changed', mode: command.mode },
                      },
                    });
                  },
                };
              },
            },
          };
        },
        query: (query: RuntimeQuery) =>
          owner.readSnapshot && query.type === 'get_session_projection'
            ? Promise.resolve(owner.readSnapshot(() => queryStoredProjection(query.sessionId)))
            : router.query(query),
        shutdownSession: router.shutdownSession.bind(router),
        close: async () => {
          interactionBroker.close('Runtime owner closed.');
          try {
            await router.close();
          } finally {
            await runtimeCoordinatorBinding.access().close();
          }
        },
      } satisfies RuntimeHostExecutionBridge &
        Required<Pick<RuntimeHostExecutionBridge, 'recoverCommittedResume'>>);
    },
    owner.ownsSessionExecution,
    owner.runWithSessionExecution,
    owner.setExecutionLossHandler,
    owner.releaseSessionExecution
      ? (sessionId) =>
          owner.releaseSessionExecution!(sessionId, () =>
            runtimeCoordinatorBinding.access().release(sessionId),
          )
      : undefined,
  );
  const denyByDefault: RuntimeServerAdmissionPort = Object.freeze({
    authorize: async () => ({
      allowed: false as const,
      reason: 'unauthorized' as const,
    }),
  });
  const reconcileSession = async (sessionId: string): Promise<void> => {
    if (!owner.reconcileInterruptedSession) return;
    await host.start();
    await owner.reconcileInterruptedSession(sessionId, async (generation, assertCurrent) => {
      if (!recoverInterruptedSession) throw new Error('Session recovery adapter is unavailable.');
      await recoverInterruptedSession(sessionId, generation, assertCurrent);
      return undefined;
    });
  };
  const runHostCommand = async (
    command: RuntimeCommand,
    context?: Readonly<RuntimeCommandContext>,
  ) => {
    try {
      if (
        'sessionId' in command &&
        command.type !== 'set_interaction_mode' &&
        command.type !== 'recover_session' &&
        command.type !== 'delete_session'
      )
        await reconcileSession(command.sessionId);
      return Promise.resolve(host.command(command, context)).catch((error) =>
        appServerCommandFailure(command, error, owner),
      );
    } catch (error) {
      return Promise.resolve(appServerCommandFailure(command, error, owner));
    }
  };
  function queryStoredProjection(sessionId: string): RuntimeQueryResult {
    const projection = projectStoredSessionForOwner(sessionId);
    return projection
      ? {
          status: 'ok',
          queryType: 'get_session_projection',
          revision: projection.revision,
          session: projection,
        }
      : { status: 'not_found', queryType: 'get_session_projection', code: 'session_not_found' };
  }
  const runHostQuery = async (query: RuntimeQuery): Promise<RuntimeQueryResult> => {
    // The protocol admission already rejects internal child IDs. Keep the
    // implementation boundary closed for direct RuntimeAccess callers too.
    if (
      'sessionId' in query &&
      owner.readSessionLineage?.(query.sessionId)?.parentSessionId != null
    ) {
      return { status: 'not_found', queryType: query.type, code: 'session_not_found' };
    }
    if (query.type === 'list_child_sessions' || query.type === 'get_child_session_projection') {
      const listChildSessions = owner.listChildSessions;
      const readChildSession = owner.readChildSession;
      if (!listChildSessions || !readChildSession)
        return { status: 'unavailable', queryType: query.type, code: 'unsupported' };
      if (!owner.loadCurrentSnapshot(query.sessionId))
        return { status: 'not_found', queryType: query.type, code: 'session_not_found' };
      if (query.type === 'get_child_session_projection') {
        const child = readChildSession(query.sessionId, query.childSessionId);
        if (!child)
          return { status: 'not_found', queryType: query.type, code: 'session_not_found' };
        const projection = projectStoredSessionForOwner(child.sessionId, child.state);
        return projection
          ? {
              status: 'ok',
              queryType: query.type,
              revision: projection.revision,
              session: projection,
            }
          : { status: 'unavailable', queryType: query.type, code: 'session_unavailable' };
      }
      const page = listChildSessions(
        query.sessionId,
        query.limit,
        query.cursor
          ? { updatedAt: query.cursor.updatedAtMs, sessionId: query.cursor.sessionId }
          : undefined,
      );
      const children = page.entries.map((entry) => {
        const child = readChildSession(query.sessionId, entry.sessionId);
        const origin = child?.state.childSessionOrigin;
        if (
          !child ||
          !origin ||
          origin.parentSessionId !== query.sessionId ||
          child.state.session.threadId !== entry.sessionId
        )
          return null;
        return {
          sessionId: entry.sessionId,
          parentSessionId: query.sessionId,
          agentId: origin.childInvocationId,
          taskId: origin.childInvocationId,
          revision: child.state.revision,
          updatedAtMs: entry.updatedAt,
          displayName: projectRuntimeClientText(entry.name || entry.sessionId, 256),
        };
      });
      if (children.some((child) => child === null))
        return { status: 'unavailable', queryType: query.type, code: 'session_unavailable' };
      return {
        status: 'ok',
        queryType: query.type,
        childSessions: children.filter((child) => child !== null),
        ...(page.nextCursor
          ? {
              nextChildCursor: {
                updatedAtMs: page.nextCursor.updatedAt,
                sessionId: page.nextCursor.sessionId,
              },
            }
          : {}),
      };
    }
    if (query.type === 'get_session_projection' && owner.readSnapshot) {
      const result = await host.query(query);
      if (result.status !== 'ok' || !result.session) return result;
      const interactionQueue = owner.readSnapshot(() => {
        const state = owner.loadCurrentSnapshot(query.sessionId);
        return state && state.revision === result.session!.revision
          ? projectParentInteractionQueue(owner, state, result.session!.interactionQueue)
          : result.session!.interactionQueue;
      });
      return interactionQueue === result.session.interactionQueue
        ? result
        : {
            ...result,
            session: {
              ...result.session,
              interactionQueue,
              ...(result.session.currentRun
                ? {
                    currentRun: {
                      ...result.session.currentRun,
                      ...(interactionQueue.activeInteractionId
                        ? { activeInteractionId: interactionQueue.activeInteractionId }
                        : {}),
                    },
                  }
                : {}),
            },
          };
    }
    // Projection queries refresh the Host subscriber registry from the Store.
    // Recovery and resource cleanup are admitted only by execution commands.
    if (!owner.readSnapshot || query.type === 'get_session_projection') return host.query(query);
    if (
      (query.type === 'list_background_executions' || query.type === 'get_background_execution') &&
      owner.ownsSessionExecution?.(query.sessionId) !== true
    ) {
      return (
        readUnownedBackgroundQuery?.(query) ?? {
          status: 'unavailable',
          queryType: query.type,
          code: 'session_unavailable',
        }
      );
    }
    const direct = owner.readSnapshot(() => {
      if (query.type === 'list_sessions') {
        return {
          status: 'ok' as const,
          queryType: query.type,
          sessions: owner
            .listCurrentSessions('', 1_000)
            .map(({ threadId, name }) => {
              const projection = projectStoredSessionForList(threadId);
              return projection
                ? { ...projection, displayName: projectRuntimeClientText(name || threadId, 256) }
                : undefined;
            })
            .filter((projection) => projection !== undefined),
        };
      }
      if (query.type === 'get_session_recovery') {
        if (!owner.recovery)
          return {
            status: 'unavailable' as const,
            queryType: query.type,
            code: 'unsupported' as const,
          };
        if (!owner.loadCurrentSnapshot(query.sessionId))
          return {
            status: 'not_found' as const,
            queryType: query.type,
            code: 'session_not_found' as const,
          };
        const { authority, pendingEffects, unknownEffects } = owner.recovery.inspect(
          query.sessionId,
        );
        return {
          status: 'ok' as const,
          queryType: query.type,
          recovery: {
            authorityRevision: authority.revision,
            status: authority.status,
            cleanupConfirmed: authority.cleanupConfirmed,
            pendingEffectCount: pendingEffects.length,
            unknownEffectCount: unknownEffects.length,
            effects: [...pendingEffects, ...unknownEffects].slice(0, 20).map((effect) => ({
              effectId: effect.effectId,
              state: effect.state === 'unknown' ? ('unknown' as const) : ('prepared' as const),
            })),
            action:
              authority.status === 'idle'
                ? ('continue' as const)
                : authority.status !== 'recovery_required'
                  ? ('wait' as const)
                  : authority.cleanupConfirmed &&
                      pendingEffects.length === 0 &&
                      unknownEffects.length === 0
                    ? ('recover' as const)
                    : ('inspect' as const),
          },
        };
      }
      if (query.type === 'list_checkpoints') {
        const snapshot = owner.loadCurrentSnapshot(query.sessionId);
        if (!snapshot) {
          return {
            status: 'not_found' as const,
            queryType: query.type,
            code: 'session_not_found' as const,
          };
        }
        return {
          status: 'ok' as const,
          queryType: query.type,
          revision: snapshot.revision,
          checkpoints: owner.storage.checkpoints
            .listNamedSnapshots(query.sessionId)
            .map((entry) => {
              const state = owner.storage.checkpoints.loadNamedSnapshot<RuntimeState>(
                query.sessionId,
                entry.snapshotId,
              );
              return {
                checkpointId: entry.snapshotId,
                sessionId: query.sessionId,
                revision: state?.revision ?? 0,
                eventPosition: entry.eventPosition,
                createdAt: entry.createdAt,
                ...(entry.targetMessage === undefined
                  ? {}
                  : { targetMessage: entry.targetMessage.slice(0, 8_192) }),
                ...(entry.targetMessageCreatedAt === undefined
                  ? {}
                  : { targetMessageCreatedAt: entry.targetMessageCreatedAt }),
                affectedFileCount: entry.affectedFileCount ?? 0,
              };
            }),
        };
      }
      if (query.type === 'get_rewind_preview') {
        const snapshot = owner.loadCurrentSnapshot(query.sessionId);
        if (!snapshot) {
          return {
            status: 'not_found' as const,
            queryType: query.type,
            code: 'session_not_found' as const,
          };
        }
        const admission = persistedAdmissionForSession(query.sessionId);
        if (!admission) {
          return {
            status: 'unavailable' as const,
            queryType: query.type,
            code: 'session_unavailable' as const,
          };
        }
        if (!owner.storage.checkpoints.getNamedSnapshotEntry(query.sessionId, query.checkpointId)) {
          return {
            status: 'not_found' as const,
            queryType: query.type,
            code: 'checkpoint_unavailable' as const,
          };
        }
        const preview = previewFilesToCheckpoint(
          owner.storage,
          query.sessionId,
          query.checkpointId,
          admission.canonicalPath,
        );
        return {
          status: 'ok' as const,
          queryType: query.type,
          revision: snapshot.revision,
          rewindPreview: {
            checkpointId: query.checkpointId,
            sessionId: query.sessionId,
            revision: snapshot.revision,
            files: preview.files.slice(0, 10_000),
            lineStatsAvailable: preview.lineStatsAvailable,
            addedLines: preview.addedLines,
            removedLines: preview.removedLines,
            conflictCount: preview.conflictCount,
            failureCount: preview.failureCount,
          },
        };
      }
      return undefined;
    });
    return direct === undefined ? host.query(query) : Promise.resolve(direct);
  };
  const cancelAllSessions = async (reason: string): Promise<void> => {
    if (!owner.runWithSessionExecution || !owner.ownedSessionIds) {
      await host.cancelAllSessions(reason);
      return;
    }
    await Promise.all(
      owner
        .ownedSessionIds()
        .filter(
          (sessionId) =>
            owner.readSessionLineage?.(sessionId)?.parentSessionId == null &&
            owner.storage.sessions.loadSnapshotRecord(sessionId) !== null,
        )
        .map((sessionId) =>
          owner.runWithSessionExecution!(sessionId, () => host.cancelSession(sessionId, reason)),
        ),
    );
  };
  const runtime: RuntimeAccess = input.operationGate
    ? Object.freeze({
        command: (command: RuntimeCommand, context?: Readonly<RuntimeCommandContext>) =>
          input.operationGate!.runMutation(() => runHostCommand(command, context)),
        query: runHostQuery,
        subscribe: (subscription: RuntimeSubscription) => host.subscribe(subscription),
      })
    : Object.freeze({
        command: runHostCommand,
        query: runHostQuery,
        subscribe: (subscription: RuntimeSubscription) => host.subscribe(subscription),
      });
  const hub = createRuntimeServerInProcessHub(
    { runtime, admission: denyByDefault },
    {
      serverInfo: {
        version: input.serverVersion ?? `protocol-${RUNTIME_PROTOCOL_VERSION}`,
        instanceId: input.serverInstanceId ?? `server_${randomBytes(16).toString('hex')}`,
      },
      ...(input.appServerProtocol
        ? {
            historyMethods: true,
            childHistoryMethods: input.childHistoryMethods === true,
            appMethods: true,
          }
        : {}),
      ...(input.appServerDaemonProtocol ? { serverControlMethods: true } : {}),
    },
  );
  let disposePromise: Promise<void> | undefined;
  let pendingMailRecovery: Promise<void> | undefined;
  let mailRecoveryClosing = false;
  return Object.freeze({
    server: hub.server,
    host,
    runtime,
    storage: owner.storage,
    cancelAllSessions,
    recoverPendingAgentMail: () => {
      if (mailRecoveryClosing) return Promise.resolve();
      pendingMailRecovery ??= mailDetachedScope
        .runInAsyncScope(async () => {
          await host.start();
          await scanPendingAgentMail?.();
          await scanPendingTerminalReplies?.();
          await scanPendingFollowups?.();
          await scanPendingInterrupts?.();
        })
        .finally(() => {
          pendingMailRecovery = undefined;
        });
      return pendingMailRecovery;
    },
    bindConnection: (connectionId: string, workspace: AdmittedWorkspace) => {
      connectionWorkspaces.set(connectionId, workspace);
    },
    releaseConnection: (connectionId: string) => {
      connectionWorkspaces.delete(connectionId);
      interactionBroker.disconnect(connectionId);
    },
    applySelectedConfig: (workspace: AdmittedWorkspace, config: AgentConfig) => {
      const key = `${workspace.workspaceDigest}\0${workspace.projectId}\0${workspace.canonicalPath}`;
      desiredConfigs.set(key, config);
      bridges.get(key)?.applySelectedConfig(config);
    },
    open: (options?: RuntimeServerInProcessOpenOptions) => {
      const requestedAdmission = options?.admission ?? denyByDefault;
      const scopedAdmission: RuntimeServerAdmissionPort = Object.freeze({
        authorize: async (request: RuntimeServerAdmissionInput) => {
          const decision = await requestedAdmission.authorize(request);
          if (!decision.allowed) return decision;
          const sessionId = admissionSessionId(request);
          if (sessionId && owner.readSessionLineage?.(sessionId)?.parentSessionId != null) {
            return { allowed: false as const, reason: 'unauthorized' as const };
          }
          if (request.operation === 'runtime/subscribe') {
            const subscription = request.subscription as RuntimeProtocolSubscriptionSpec;
            if (
              subscription.scope === 'child_session' &&
              !owner.readChildSession?.(subscription.parentSessionId, subscription.childSessionId)
            ) {
              return { allowed: false as const, reason: 'unauthorized' as const };
            }
          }
          const persisted =
            sessionId === undefined ? undefined : persistedAdmissionForSession(sessionId);
          const admitted =
            [...byWorkspace.values()].find(
              (candidate) => candidate.admission.canonicalPath === decision.workspace,
            )?.admission ??
            (persisted?.canonicalPath === decision.workspace ? persisted : undefined) ??
            (input.workspaceTemplateFor
              ? (() => {
                  try {
                    const canonicalPath = realpathSync.native(decision.workspace);
                    const project = resolveProjectIdentity(canonicalPath);
                    return Object.freeze({
                      canonicalPath,
                      projectId: project.projectId,
                      workspaceDigest: project.workspaceDigest,
                    });
                  } catch {
                    return undefined;
                  }
                })()
              : undefined);
          if (!admitted) return { allowed: false as const, reason: 'unauthorized' as const };
          if (sessionId !== undefined) {
            const command =
              request.operation === 'runtime/command' && request.command
                ? (request.command as { readonly type?: unknown })
                : undefined;
            const isFreshCreate = command?.type === 'create_session' && persisted === undefined;
            if (!isFreshCreate && (!persisted || !sameAdmission(persisted, admitted))) {
              return {
                allowed: false as const,
                reason: 'unauthorized' as const,
              };
            }
          }
          connectionWorkspaces.set(request.connectionId, admitted);
          return { allowed: true as const, workspace: admitted.canonicalPath };
        },
      });
      return hub.open({
        ...options,
        admission: scopedAdmission,
        onClose: (connectionId) => {
          connectionWorkspaces.delete(connectionId);
          interactionBroker.disconnect(connectionId);
          options?.onClose?.(connectionId);
        },
      });
    },
    [Symbol.asyncDispose]: () => {
      disposePromise ??= (async () => {
        mailRecoveryClosing = true;
        const failures: unknown[] = [];
        let cleanupConfirmed = true;
        try {
          await hub.server.beginDraining();
        } catch (error) {
          failures.push(error);
        }
        try {
          await cancelAllSessions('Runtime App Server disposed.');
        } catch (error) {
          cleanupConfirmed = false;
          failures.push(error);
        }
        try {
          await pendingMailRecovery;
        } catch (error) {
          failures.push(error);
        }
        try {
          await host[Symbol.asyncDispose]();
        } catch (error) {
          cleanupConfirmed = false;
          failures.push(error);
        }
        try {
          owner.releaseExecutions?.(cleanupConfirmed);
        } catch (error) {
          failures.push(error);
        } finally {
          try {
            owner.disposeStorage?.();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, 'Runtime Server owner disposal failed.');
        }
      })();
      return disposePromise;
    },
  });
}

function appServerCommandFailure(
  command: RuntimeCommand,
  error: unknown,
  owner: KiteRuntimeStorageOwner,
) {
  if (error instanceof KiteHomeWriteError && error.code === 'write_failed') error = error.cause;
  if (
    (command.type === 'set_interaction_mode' || command.type === 'recover_session') &&
    error instanceof KiteSessionExecutionAuthorityError &&
    error.code === 'session_not_found'
  ) {
    return {
      status: 'not_found' as const,
      commandId: command.commandId,
      code: 'session_not_found' as const,
    };
  }
  if (error instanceof KiteSessionRuntimeStorageError && error.code === 'session_busy') {
    return {
      status: 'rejected' as const,
      commandId: command.commandId,
      code: 'runtime_busy' as const,
    };
  }
  if (
    error instanceof KiteSessionMutationError &&
    error.code === 'revision_conflict' &&
    (command.type === 'set_interaction_mode' || command.type === 'recover_session')
  ) {
    const state = owner.loadCurrentSnapshot(command.sessionId);
    if (state)
      return {
        status: 'conflict' as const,
        commandId: command.commandId,
        code: 'revision_conflict' as const,
        currentRevision: state.revision,
      };
    return {
      status: 'not_found' as const,
      commandId: command.commandId,
      code: 'session_not_found' as const,
    };
  }
  if (!(error instanceof KiteAppServerSessionError)) throw error;
  return {
    status: 'rejected' as const,
    commandId: command.commandId,
    code:
      error.code === 'session_busy'
        ? ('runtime_busy' as const)
        : error.code === 'recovery_required'
          ? ('session_recovery_required' as const)
          : error.code === 'storage_closed'
            ? ('storage_unavailable' as const)
            : ('session_unavailable' as const),
  };
}

export function createKiteCliRuntimeServer(
  input: Omit<CliRuntimeBridgeInput, 'projectIdentity'>,
): KiteCliRuntimeServerOwner {
  return createKiteRuntimeServerComposition({
    host: createKiteCliRuntimeHost(input),
    workspace: input.workspace,
    ownsSession: (sessionId) => sessionId === input.sessionId,
  });
}

export function createKiteCliRuntimeAccess(
  input: Omit<CliRuntimeBridgeInput, 'projectIdentity'>,
): KiteRuntimeClientAccess {
  const access = createKiteInProcessRuntimeAccess({
    host: createKiteCliRuntimeHost(input),
    workspace: input.workspace,
    ownsSession: (sessionId) => sessionId === input.sessionId,
    clientName: 'kite-cli',
  });
  let disposePromise: Promise<void> | undefined;
  return Object.freeze({
    command: access.command.bind(access),
    query: access.query.bind(access),
    subscribe: access.subscribe.bind(access),
    ...(access.history ? { history: access.history } : {}),
    shutdownOwner: () => access.shutdownOwner(),
    [Symbol.asyncDispose]: () => {
      disposePromise ??= (async () => {
        try {
          await access[Symbol.asyncDispose]();
        } finally {
          await access.shutdownOwner();
        }
      })();
      return disposePromise;
    },
  });
}
