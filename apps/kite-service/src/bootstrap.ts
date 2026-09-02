import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  type BuiltinToolCatalogProjection,
  createBuiltinContextCompilerPort,
  createBuiltinRuntimeModules,
  createBuiltinToolCatalogProjection,
} from '@kite-ai/builtin-runtime';
import { canonicalModelJson, ModelArtifactStore } from '@kite-ai/builtin-runtime/model';
import type { KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import { ensureKiteProfileHome } from '@kite-ai/kite-local-runtime/service';
import {
  RuntimeClient,
  type RuntimeClientTransport,
  type RuntimeHistoryClient,
} from '@kite-ai/runtime-client';
import {
  assertListRuntimeLogEventsRequest,
  assertListRuntimeLogSessionsRequest,
  type ListRuntimeLogEventsRequest,
  type ListRuntimeLogSessionsRequest,
  RUNTIME_CONTRACT_BOUNDARY_,
  RUNTIME_PROJECTION_SCHEMA_,
  type RuntimeAccess,
  type RuntimeCommand,
  type RuntimeCommandContext,
  type RuntimeQuery,
  type RuntimeQueryResult,
  type RuntimeSessionProjection,
  type RuntimeSubscription,
  type RuntimeSubscriptionSpec,
} from '@kite-ai/runtime-contract';
import {
  createRuntimeHost,
  createRuntimeHostBoundary,
  createRuntimeHostStateStorageBinding,
  RUNTIME_HOST_EXECUTION_ADAPTER_ID_,
  type RuntimeHost,
  type RuntimeHostBoundary,
  type RuntimeHostExecutionAdapterContext,
  type RuntimeHostExecutionBridge,
  type RuntimeHostExecutionServices,
  resolveProjectIdentity,
  runtimeHostCurrentStateEventTypes,
} from '@kite-ai/runtime-host';
import type {
  RuntimeLogEventReadPage,
  RuntimeLogQueryPort,
  RuntimeLogSessionReadPage,
  RuntimeStorage,
} from '@kite-ai/runtime-host/storage';
import { RUNTIME_PROTOCOL_VERSION, type RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
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
  createSqliteRuntimeCompatibilityWriter,
  createSqliteRuntimeLogQueryPort,
  createSqliteRuntimeStorage,
  createSqliteRuntimeStorageBoundary,
  discoverSqliteRuntimeCompatibilitySource,
  type KiteHomeArtifactStore,
  type KiteHomeDirectoryQueryPort,
  openKiteSessionRuntimeStorage,
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
  createCliRuntimeBridge,
} from './bootstrap/runtime/CliRuntimeBridge';
import { KITE_RUNTIME_OPERATION_IDS_ } from './bootstrap/runtime/KiteRuntimeExecutionModule';
import { createRuntimeSessionCoordinatorBinding } from './bootstrap/runtime/RuntimeSessionCoordinator';
import type {
  RuntimeEvent,
  RuntimeState,
  StateRuntimeStorage,
} from './bootstrap/runtime/state-runtime';
import { createKiteRuntimeCompatibilityMigrator } from './bootstrap/runtime/state-store-compatibility';
import { createAppToolPipelineComposition } from './bootstrap/runtime/tool-pipeline-composition';
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

const STATE_STORAGE_BINDING_ = createRuntimeHostStateStorageBinding();

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
      const start = request.cursor
        ? entries.findIndex(
            (entry) =>
              entry.revision === request.cursor!.revision &&
              entry.checkpointId === request.cursor!.checkpointId,
          ) + 1
        : 0;
      if (request.cursor && start === 0) {
        return { entries: [], hasMore: false };
      }
      const selected = entries.slice(start, start + request.limit);
      const hasMore = start + selected.length < entries.length;
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
  /** Bindings used by native carriers; disconnect only releases this client identity. */
  readonly bindConnection: (connectionId: string, workspace: AdmittedWorkspace) => void;
  readonly releaseConnection: (connectionId: string) => void;
  open(options?: RuntimeServerInProcessOpenOptions): RuntimeServerInProcessPair;
}

export interface KiteMultiWorkspaceRuntimeServerInput {
  readonly checkpointPath: string;
  /** Service process identity shared with descriptor/carrier handshake. */
  readonly serverInstanceId?: string;
  readonly serverVersion?: string;
  /** Only the parent-owned App Server carrier may advertise App-owned protocol methods. */
  readonly appServerProtocol?: boolean;
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
    const subscription = input.subscription as RuntimeSubscriptionSpec;
    return subscription.scope === 'session' ? subscription.sessionId : undefined;
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
  readonly storage: RuntimeStorage<RuntimeEvent, RuntimeState>;
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
  readonly readSnapshot?: <Result>(operation: () => Result) => Result;
  readonly ownsSessionExecution?: (sessionId: string) => boolean;
  readonly ownedSessionIds?: () => readonly string[];
  readonly releaseExecutions?: (cleanupConfirmed: boolean) => void;
  readonly disposeStorage?: () => void;
}

/** KASD exact multi-connection Store owner; it never opens kite.sqlite or a Workspace lock. */
export function createKiteSessionAppServerStorageComposition(input: {
  readonly databasePath: string;
  readonly hostInstanceId: string;
  readonly clientId?: string;
  readonly connectionGeneration?: number;
  readonly executionLeaseMs?: number;
  readonly renewIntervalMs?: number;
  readonly now?: () => number;
}): KiteSessionAppServerStorageOwner {
  const target = openKiteSessionRuntimeStorage<RuntimeEvent, RuntimeState>({
    databasePath: input.databasePath,
    codec: STATE_STORAGE_BINDING_.codec,
    stateSchemaVersion: SQLITE_RUNTIME_STATE_SCHEMA_VERSION,
    formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
    ...(input.now ? { now: input.now } : {}),
  });
  try {
    return createKiteSessionAppServerStorage({
      ...input,
      target,
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
    if (storage.sessions.loadSnapshotRecord(sessionId) !== null) return true;
    return readSessionRows('').some((entry) => entry.threadId === sessionId);
  };

  return Object.freeze({
    listSessions(request: ListRuntimeLogSessionsRequest): RuntimeLogSessionReadPage {
      assertOpen();
      assertListRuntimeLogSessionsRequest(request);
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
      const requestedTypes = request.eventTypes ? new Set(request.eventTypes) : undefined;
      if (requestedTypes && [...requestedTypes].some((type) => !currentEventTypes.has(type))) {
        throw new Error('Runtime observer event filter contains an unknown current event type.');
      }
      const stored = storage.sessions.loadEventsStrict(request.sessionId);
      if (stored.length === 0 && !sessionExists(request.sessionId)) {
        throw new Error(`Runtime session was not found: ${request.sessionId}`);
      }
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
): RuntimeHost<RuntimeEvent, RuntimeState> {
  return createRuntimeHost({
    storage,
    modules: createKiteRuntimeModules((context) =>
      createBridge(context, createBuiltinToolCatalogProjection(context.capabilityRegistrySnapshot)),
    ),
    contextCompiler: createBuiltinContextCompilerPort(),
    ...(ownsSessionExecution ? { ownsSessionExecution } : {}),
  });
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
): StateRuntimeStorage {
  return Object.freeze({
    sessions: services.sessions,
    transactions: services.transactions,
    effects: services.leases,
    checkpoints: services.checkpoints,
    recoveryIdentities: services.recoveryIdentities,
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

function createKiteCliRuntimeHost(
  input: Omit<CliRuntimeBridgeInput, 'projectIdentity'>,
): RuntimeHost<RuntimeEvent, RuntimeState> {
  const owner = createKiteRuntimeStorageOwner(input.checkpointPath);
  const projectIdentity = resolveProjectIdentity(input.workspace);
  const runtimeCoordinatorBinding = createRuntimeSessionCoordinatorBinding();
  const host = createKiteRuntimeHost(
    owner.storage,
    (context, builtinToolCatalog) => {
      const { services, capabilities, capabilityRegistrySnapshot } = context;
      const toolPipelineComposition = createAppToolPipelineComposition(builtinToolCatalog);
      const modelOperationExecution = createKiteModelOperationExecutionPort(
        capabilities,
        builtinToolCatalog,
      );
      const modelRuntime = createInstalledKiteRuntimeCompositionFactory(modelOperationExecution);
      const modelInvocationRuntimeFactory = (workspace: string) => ({
        ...modelRuntime(workspace),
        builtinToolCatalog,
        toolPipelineComposition,
      });
      const runtimeStorageView = createRuntimeStorageAccess(services);
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
        { ...input, projectIdentity },
        capabilities,
        modelInvocationRuntimeFactory,
        (sessionId) => resolveKiteRecoveryIdentity(services, sessionId),
        runtimeCoordinatorBinding.access(),
      );
    },
    owner.ownsSessionExecution,
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
  const owner = input.storageOwner ?? createKiteRuntimeStorageOwner(input.checkpointPath);
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
  const persistedAdmissionForSession = (sessionId: string): AdmittedWorkspace | undefined => {
    const snapshot = owner.storage.sessions.loadSnapshot<RuntimeState>(sessionId);
    if (!snapshot) {
      bySession.delete(sessionId);
      return undefined;
    }
    const projectId = snapshot.session.projectId;
    const workspaceDigest = snapshot.session.canonicalWorkspaceDigest;
    if (!projectId || !workspaceDigest) {
      bySession.delete(sessionId);
      return undefined;
    }
    let canonicalPath: string;
    try {
      canonicalPath = realpathSync.native(snapshot.session.workspace);
    } catch {
      bySession.delete(sessionId);
      return undefined;
    }
    const project = resolveProjectIdentity(canonicalPath);
    if (project.projectId !== projectId || project.workspaceDigest !== workspaceDigest) {
      bySession.delete(sessionId);
      return undefined;
    }
    const key = `${workspaceDigest}\0${projectId}\0${canonicalPath}`;
    const registered = byWorkspace.get(key);
    if (registered) {
      bySession.set(sessionId, registered.admission);
      return registered.admission;
    }
    if (input.workspaceTemplateFor) {
      const admission: AdmittedWorkspace = Object.freeze({
        canonicalPath,
        projectId,
        workspaceDigest,
      });
      bySession.set(sessionId, admission);
      return admission;
    }
    bySession.delete(sessionId);
    return undefined;
  };
  const projectStoredSession = (threadId: string): RuntimeSessionProjection | undefined => {
    const snapshot = owner.loadCurrentSnapshot(threadId);
    if (!snapshot || snapshot.session.threadId !== threadId) return undefined;
    const model = owner.getCurrentSessionModelRoute(threadId);
    const interactionQueue = projectRuntimeClientInteractionQueue(snapshot, {
      sessionRevision: snapshot.revision,
    });
    const activeInteraction =
      interactionQueue.activeInteractionId === undefined
        ? undefined
        : interactionQueue.interactions.find(
            (interaction) => interaction.interactionId === interactionQueue.activeInteractionId,
          );
    const activeTask = snapshot.activeTaskId ? snapshot.tasks[snapshot.activeTaskId] : undefined;
    return Object.freeze({
      schema: RUNTIME_PROJECTION_SCHEMA_,
      sessionId: threadId,
      revision: snapshot.revision,
      workspace: snapshot.session.workspace,
      lifecycle: 'open' as const,
      interactionQueue,
      ...(activeInteraction === undefined
        ? {}
        : {
            activeWork: {
              workId: activeTask?.taskId ?? snapshot.turn.turnId,
              phase:
                activeTask?.planning.kind === 'executing'
                  ? ('building' as const)
                  : ('planning' as const),
              status: 'waiting' as const,
              activeTurn: {
                turnId: snapshot.turn.turnId,
                status: 'waiting' as const,
                interaction: activeInteraction,
              },
            },
          }),
      ...(model === null ? {} : { model: { provider: model.provider, name: model.name } }),
    });
  };
  const bridges = new Map<string, RuntimeHostExecutionBridge>();
  const host = createKiteRuntimeHost(owner.storage, (context, builtinToolCatalog) => {
    const { services, capabilities, capabilityRegistrySnapshot } = context;
    const toolPipelineComposition = createAppToolPipelineComposition(builtinToolCatalog);
    const modelOperationExecution = createKiteModelOperationExecutionPort(
      capabilities,
      builtinToolCatalog,
    );
    const modelRuntime = createInstalledKiteRuntimeCompositionFactory(
      modelOperationExecution,
      artifactBackends,
    );
    const modelInvocationRuntimeFactory = (workspace: string) => ({
      ...modelRuntime(workspace),
      builtinToolCatalog,
      toolPipelineComposition,
    });
    runtimeCoordinatorBinding.bind({
      services,
      capabilities,
      capabilityRegistrySnapshot,
      builtinToolCatalog,
      toolPipelineComposition,
      modelRuntimeFactory: modelRuntime,
      store: createRuntimeStorageAccess(services),
    });
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
        const sessionBridges = new Map<string, RuntimeHostExecutionBridge>();
        const pendingSessionBridges = new Map<string, Promise<RuntimeHostExecutionBridge>>();
        const bridgeForSession = async (sessionId: string): Promise<RuntimeHostExecutionBridge> => {
          const current = sessionBridges.get(sessionId);
          if (current) return current;
          const pending = pendingSessionBridges.get(sessionId);
          if (pending) return pending;
          const creation = (async (): Promise<RuntimeHostExecutionBridge> => {
            const persisted = persistedAdmissionForSession(sessionId);
            if (persisted && !sameAdmission(persisted, admission)) {
              throw new Error('Runtime Session belongs to a different Workspace.');
            }
            bySession.set(sessionId, admission);
            const bridge = createCliRuntimeBridge(
              {
                ...registered.input,
                sessionId,
                projectIdentity: resolveProjectIdentity(admission.canonicalPath),
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
            if (owner.storage.sessions.loadSnapshot<RuntimeState>(sessionId)) {
              await bridge.recoverSession(sessionId, () => undefined);
            }
            sessionBridges.set(sessionId, bridge);
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
        const bridge: RuntimeHostExecutionBridge = Object.freeze({
          recoverSession: async (
            sessionId: string,
            publish: Parameters<RuntimeHostExecutionBridge['recoverSession']>[1],
          ) => (await bridgeForSession(sessionId)).recoverSession(sessionId, publish),
          inspectCommand: async (
            command: RuntimeCommand,
            context: Parameters<RuntimeHostExecutionBridge['inspectCommand']>[1],
          ) =>
            (
              await bridgeForSession(
                command.type === 'fork_session' ? command.sourceSessionId : context.targetSessionId,
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
            await Promise.allSettled(pendingSessionBridges.values());
            pendingSessionBridges.clear();
            sessionBridges.clear();
          },
        });
        bridges.set(key, bridge);
        return {
          admission,
          bridge,
          close: async () => {
            bridges.delete(key);
          },
        };
      },
      resolveWorkspaceForSession: async (sessionId) => persistedAdmissionForSession(sessionId),
    });
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
          .map(({ threadId }) => projectStoredSession(threadId));
        return {
          status: 'ok',
          queryType: 'list_sessions',
          sessions: projections.filter((projection) => projection !== undefined),
        };
      },
    });
    return Object.freeze({
      recoverSession: router.recoverSession.bind(router),
      inspectCommand: router.inspectCommand.bind(router),
      query: router.query.bind(router),
      shutdownSession: router.shutdownSession.bind(router),
      close: async () => {
        interactionBroker.close('Runtime owner closed.');
        try {
          await router.close();
        } finally {
          await runtimeCoordinatorBinding.access().close();
        }
      },
    });
  });
  const denyByDefault: RuntimeServerAdmissionPort = Object.freeze({
    authorize: async () => ({
      allowed: false as const,
      reason: 'unauthorized' as const,
    }),
  });
  const runHostCommand = (command: RuntimeCommand, context?: Readonly<RuntimeCommandContext>) => {
    try {
      const sessionId = appServerExecutionSessionId(command);
      const result =
        sessionId && owner.runWithSessionExecution
          ? owner.runWithSessionExecution(sessionId, () => host.command(command, context))
          : host.command(command, context);
      return Promise.resolve(result).catch((error) => appServerCommandFailure(command, error));
    } catch (error) {
      return Promise.resolve(appServerCommandFailure(command, error));
    }
  };
  const runHostQuery = (query: RuntimeQuery): Promise<RuntimeQueryResult> => {
    if (!owner.readSnapshot) return host.query(query);
    const direct = owner.readSnapshot(() => {
      if (query.type === 'list_sessions') {
        return {
          status: 'ok' as const,
          queryType: query.type,
          sessions: owner
            .listCurrentSessions('', 1_000)
            .map(({ threadId }) => projectStoredSession(threadId))
            .filter((projection) => projection !== undefined),
        };
      }
      if (query.type === 'get_session_projection') {
        const projection = projectStoredSession(query.sessionId);
        return projection
          ? {
              status: 'ok' as const,
              queryType: query.type,
              revision: projection.revision,
              session: projection,
            }
          : {
              status: 'not_found' as const,
              queryType: query.type,
              code: 'session_not_found' as const,
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
      ...(input.appServerProtocol ? { historyMethods: true, appMethods: true } : {}),
      ...(input.appServerDaemonProtocol ? { serverControlMethods: true } : {}),
    },
  );
  let disposePromise: Promise<void> | undefined;
  return Object.freeze({
    server: hub.server,
    host,
    runtime,
    storage: owner.storage,
    cancelAllSessions,
    bindConnection: (connectionId: string, workspace: AdmittedWorkspace) => {
      connectionWorkspaces.set(connectionId, workspace);
    },
    releaseConnection: (connectionId: string) => {
      connectionWorkspaces.delete(connectionId);
      interactionBroker.disconnect(connectionId);
    },
    open: (options?: RuntimeServerInProcessOpenOptions) => {
      const requestedAdmission = options?.admission ?? denyByDefault;
      const scopedAdmission: RuntimeServerAdmissionPort = Object.freeze({
        authorize: async (request: RuntimeServerAdmissionInput) => {
          const decision = await requestedAdmission.authorize(request);
          if (!decision.allowed) return decision;
          const admitted =
            [...byWorkspace.values()].find(
              (candidate) => candidate.admission.canonicalPath === decision.workspace,
            )?.admission ??
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
          const sessionId = admissionSessionId(request);
          if (sessionId !== undefined) {
            const persisted = persistedAdmissionForSession(sessionId);
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

function appServerExecutionSessionId(command: RuntimeCommand): string | undefined {
  if (command.type === 'create_session') return undefined;
  if (command.type === 'fork_session') return command.sourceSessionId;
  return command.sessionId;
}

function appServerCommandFailure(command: RuntimeCommand, error: unknown) {
  if (!(error instanceof KiteAppServerSessionError)) throw error;
  return {
    status: 'rejected' as const,
    commandId: command.commandId,
    code:
      error.code === 'session_busy' ? ('runtime_busy' as const) : ('session_unavailable' as const),
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
