import { closeSync, writeSync } from 'node:fs';
import {
  type AppMcpActionRequest,
  type AppMcpActionResponse,
  type AppMcpSnapshot,
  type AppMcpSnapshotRequest,
  EXECUTION_STATUS_RESPONSE_SCHEMA_,
  type ExecutionStatusRequest,
  type ExecutionStatusSnapshot,
  type KiteAppControlClient,
  type KiteWorkspaceIdentity,
  MCP_ACTION_RESPONSE_SCHEMA_,
  MCP_SNAPSHOT_RESPONSE_SCHEMA_,
  PROVIDER_MODEL_SELECT_RESPONSE_SCHEMA_,
  PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
  type ProviderModelSelectRequest,
  type ProviderModelSelectResponse,
  type ProviderModelSnapshot,
  type ProviderModelSnapshotRequest,
  RELEASE_STATUS_RESPONSE_SCHEMA_,
  type ReleaseStatusRequest,
  type ReleaseStatusSnapshot,
  SKILL_CATALOG_RESPONSE_SCHEMA_,
  type SkillCatalogRequest,
  type SkillCatalogSnapshot,
  WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
  WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
  type WorkspaceTrustDecisionRequest,
  type WorkspaceTrustDecisionResponse,
  type WorkspaceTrustQueryRequest,
  type WorkspaceTrustQueryResponse,
} from '@kite-ai/kite-app-contract';
import type {
  NativeProviderCredentialRequest,
  NativeProviderCredentialResult,
} from '@kite-ai/kite-local-runtime/client';
import {
  LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA_,
  type NativeProviderCredentialResult as NativeCredentialResult,
} from '@kite-ai/kite-local-runtime/client';
import { createKiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import {
  RUNTIME_PROJECTION_SCHEMA_,
  type RuntimeAccess,
  type RuntimeAccessNotification,
  type RuntimeCommand,
  type RuntimeCommandReceipt,
  type RuntimeHistorySessionTranscript,
  type RuntimeLogEventPage,
  type RuntimeLogSessionPage,
  type RuntimeSessionProjection,
  type RuntimeSubscription,
} from '@kite-ai/runtime-contract';
import { RuntimeServer } from '@kite-ai/runtime-server';
import {
  createNativeKiteServiceInfrastructure,
  type NativeKiteServiceApplicationPort,
} from '../native-infrastructure';
import type { KiteServiceReadinessEvent, KiteServiceReadinessPort } from '../ports';
import type { KiteServiceProcessHarnessChildConfig } from './ports';

type HarnessSession = Readonly<{
  sessionId: string;
  revision: number;
  displayName: string;
  updatedAt: string;
}>;

const EMPTY_ASYNC_ITERABLE: AsyncIterable<RuntimeAccessNotification> = {
  [Symbol.asyncIterator](): AsyncIterator<RuntimeAccessNotification> {
    let closed = false;
    let resolvePending: ((result: IteratorResult<RuntimeAccessNotification>) => void) | undefined;
    return {
      next: async () => {
        if (closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<RuntimeAccessNotification>>((resolve) => {
          resolvePending = resolve;
        });
      },
      return: async () => {
        closed = true;
        resolvePending?.({ done: true, value: undefined });
        resolvePending = undefined;
        return { done: true, value: undefined };
      },
    };
  },
};

function delayWithAbort(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (durationMs <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error('Service harness startup cancelled.'));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('Service harness startup cancelled.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function sameWorkspace(left: KiteWorkspaceIdentity, right: KiteWorkspaceIdentity): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.projectId === right.projectId &&
    left.workspaceDigest === right.workspaceDigest
  );
}

function sessionProjection(session: HarnessSession): RuntimeSessionProjection {
  return {
    schema: RUNTIME_PROJECTION_SCHEMA_,
    sessionId: session.sessionId,
    revision: session.revision,
    displayName: session.displayName,
    updatedAt: session.updatedAt,
    lifecycle: 'open',
    interactionQueue: { revision: session.revision, interactions: [] },
  };
}

function commandNotFound(commandId: string): RuntimeCommandReceipt {
  return { status: 'not_found', commandId, code: 'session_not_found' };
}

function unsupportedCommand(command: RuntimeCommand): RuntimeCommandReceipt {
  return { status: 'rejected', commandId: command.commandId, code: 'unsupported' };
}

function emptyHistorySession(session: HarnessSession): RuntimeHistorySessionTranscript {
  return {
    session: {
      sessionId: session.sessionId,
      displayName: session.displayName,
      needsSmartName: false,
      updatedAt: Date.parse(session.updatedAt),
      lastSequence: session.revision,
    },
    events: [],
    interactionMode: 'auto',
    recovery: 'normal',
  };
}

function createFakeApplication(config: KiteServiceProcessHarnessChildConfig): {
  readonly application: NativeKiteServiceApplicationPort;
  readonly credentialWrites: () => number;
} {
  const sessions = new Map<string, HarnessSession>();
  let nextSession = 0;
  let credentialPresent = false;
  let credentialWrites = 0;
  let dropCredentialResponse = config.faults.dropCredentialResponse === true;

  const runtime: RuntimeAccess = {
    async command(command) {
      if (command.type === 'create_session') {
        const sessionId = command.bootstrapSessionId ?? `harness-session-${++nextSession}`;
        const session: HarnessSession = {
          sessionId,
          revision: 1,
          displayName: `Harness ${sessionId}`,
          updatedAt: new Date().toISOString(),
        };
        sessions.set(sessionId, session);
        return {
          status: 'applied',
          commandId: command.commandId,
          sessionId,
          revision: session.revision,
        };
      }

      const sessionId = 'sessionId' in command ? command.sessionId : undefined;
      if (sessionId === undefined || !sessions.has(sessionId)) {
        if (command.type === 'fork_session') {
          const forkedSessionId = `harness-session-${++nextSession}`;
          const session: HarnessSession = {
            sessionId: forkedSessionId,
            revision: 1,
            displayName: `Harness ${forkedSessionId}`,
            updatedAt: new Date().toISOString(),
          };
          sessions.set(forkedSessionId, session);
          return {
            status: 'applied',
            commandId: command.commandId,
            sessionId: forkedSessionId,
            revision: session.revision,
          };
        }
        return commandNotFound(command.commandId);
      }

      const current = sessions.get(sessionId)!;
      if (
        'expectedRevision' in command &&
        command.expectedRevision !== undefined &&
        command.expectedRevision !== current.revision
      ) {
        return {
          status: 'conflict',
          commandId: command.commandId,
          code: 'revision_conflict',
          currentRevision: current.revision,
        };
      }
      if (command.type === 'delete_session') {
        sessions.delete(sessionId);
        return {
          status: 'applied',
          commandId: command.commandId,
          sessionId,
          revision: current.revision + 1,
        };
      }
      if (command.type === 'close_session') {
        sessions.set(sessionId, { ...current, revision: current.revision + 1 });
        return {
          status: 'applied',
          commandId: command.commandId,
          sessionId,
          revision: current.revision + 1,
        };
      }
      if (command.type === 'start_turn') {
        sessions.set(sessionId, { ...current, revision: current.revision + 1 });
        return {
          status: 'applied',
          commandId: command.commandId,
          sessionId,
          revision: current.revision + 1,
        };
      }
      if (command.type === 'resume_session') {
        return {
          status: 'applied',
          commandId: command.commandId,
          sessionId,
          revision: current.revision,
        };
      }
      if (
        command.type === 'cancel_turn' ||
        command.type === 'respond_interaction' ||
        command.type === 'set_interaction_mode' ||
        command.type === 'compact_session' ||
        command.type === 'rewind_session' ||
        command.type === 'clear_session_command_grants'
      ) {
        return {
          status: 'applied',
          commandId: command.commandId,
          sessionId,
          revision: current.revision,
        };
      }
      return unsupportedCommand(command);
    },

    async query(query) {
      if (query.type === 'list_sessions') {
        return {
          status: 'ok',
          queryType: query.type,
          revision: sessions.size,
          sessions: [...sessions.values()].map(sessionProjection),
        };
      }
      const session = 'sessionId' in query ? sessions.get(query.sessionId) : undefined;
      if (!session) {
        return { status: 'not_found', queryType: query.type, code: 'session_not_found' };
      }
      if (query.type === 'get_session_projection') {
        return {
          status: 'ok',
          queryType: query.type,
          revision: session.revision,
          session: sessionProjection(session),
        };
      }
      if (query.type === 'get_context_status') {
        return {
          status: 'ok',
          queryType: query.type,
          revision: session.revision,
          context: {
            sessionId: session.sessionId,
            revision: session.revision,
            compactionAvailable: true,
          },
        };
      }
      if (query.type === 'list_checkpoints') {
        return {
          status: 'ok',
          queryType: query.type,
          revision: session.revision,
          checkpoints: [],
        };
      }
      return {
        status: 'ok',
        queryType: query.type,
        revision: session.revision,
        rewindPreview: {
          checkpointId: query.checkpointId,
          sessionId: session.sessionId,
          revision: session.revision,
          files: [],
          lineStatsAvailable: true,
          addedLines: 0,
          removedLines: 0,
          conflictCount: 0,
          failureCount: 0,
        },
      };
    },

    subscribe(_subscription: RuntimeSubscription): AsyncIterable<RuntimeAccessNotification> {
      return EMPTY_ASYNC_ITERABLE;
    },
  };

  const server = new RuntimeServer(
    {
      runtime,
      admission: {
        async authorize() {
          return { allowed: true, workspace: config.workspace.canonicalPath };
        },
      },
    },
    {
      serverInfo: {
        version: config.serverVersion,
        instanceId: config.instanceId,
      },
    },
  );

  const providerSnapshot = (workspace: KiteWorkspaceIdentity): ProviderModelSnapshot => ({
    schema: PROVIDER_MODEL_SNAPSHOT_RESPONSE_SCHEMA_,
    workspace,
    revision: `harness-provider-${credentialPresent ? 'ready' : 'empty'}`,
    providers: [
      {
        provider: 'harness',
        type: 'openai-compatible',
        readiness: credentialPresent ? 'ready' : 'not_configured',
        models: [],
      },
    ],
  });

  const mcpSnapshot = (workspace: KiteWorkspaceIdentity): AppMcpSnapshot => ({
    schema: MCP_SNAPSHOT_RESPONSE_SCHEMA_,
    workspace,
    revision: 'harness-mcp-v1',
    sourceRevisions: { project: 'harness-project-v1', user: 'harness-user-v1' },
    servers: [],
  });

  const appControlForWorkspace = (
    admittedWorkspace: KiteWorkspaceIdentity,
  ): KiteAppControlClient => {
    const externalReadScope = {
      roots: [],
      digest: `sha256:${'0'.repeat(64)}` as const,
    };
    const trustQuery = async (
      _request: WorkspaceTrustQueryRequest,
    ): Promise<WorkspaceTrustQueryResponse> => ({
      schema: WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
      workspace: admittedWorkspace,
      status: 'trusted',
      revision: 'harness-trust-v1',
      canDecide: true,
      externalReadScope,
    });
    const trustDecision = async (
      request: WorkspaceTrustDecisionRequest,
    ): Promise<WorkspaceTrustDecisionResponse> => ({
      schema: WORKSPACE_TRUST_DECISION_RESPONSE_SCHEMA_,
      workspace: admittedWorkspace,
      status: request.decision === 'trust' ? 'trusted' : 'unknown',
      outcome: request.decision === 'trust' ? 'recorded' : 'declined',
      revision: 'harness-trust-v1',
      externalReadScope,
    });
    const getProvider = async (
      _request: ProviderModelSnapshotRequest,
    ): Promise<ProviderModelSnapshot> => providerSnapshot(admittedWorkspace);
    const selectProvider = async (
      _request: ProviderModelSelectRequest,
    ): Promise<ProviderModelSelectResponse> => ({
      schema: PROVIDER_MODEL_SELECT_RESPONSE_SCHEMA_,
      outcome: 'applied',
      snapshot: providerSnapshot(admittedWorkspace),
    });
    const getMcp = async (_request: AppMcpSnapshotRequest): Promise<AppMcpSnapshot> =>
      mcpSnapshot(admittedWorkspace);
    const applyMcp = async (_request: AppMcpActionRequest): Promise<AppMcpActionResponse> => ({
      schema: MCP_ACTION_RESPONSE_SCHEMA_,
      outcome: 'applied',
      snapshot: mcpSnapshot(admittedWorkspace),
    });
    const getSkills = async (_request: SkillCatalogRequest): Promise<SkillCatalogSnapshot> => ({
      schema: SKILL_CATALOG_RESPONSE_SCHEMA_,
      workspace: admittedWorkspace,
      revision: 'harness-skills-v1',
      skills: [],
    });
    const getExecution = async (
      _request: ExecutionStatusRequest,
    ): Promise<ExecutionStatusSnapshot> => ({
      schema: EXECUTION_STATUS_RESPONSE_SCHEMA_,
      workspace: admittedWorkspace,
      revision: 'harness-execution-v1',
      admitted: true,
      sandboxBackend: 'none',
      filesystemScope: 'none',
      networkMode: 'off',
      controllerWorktreeActive: false,
    });
    const getRelease = async (_request: ReleaseStatusRequest): Promise<ReleaseStatusSnapshot> => ({
      schema: RELEASE_STATUS_RESPONSE_SCHEMA_,
      revision: 'harness-release-v1',
      active: false,
      production: false,
      inactiveReason: 'process_harness',
      capabilities: [],
      execution: { admitted: true },
    });
    return {
      queryWorkspaceTrust: trustQuery,
      decideWorkspaceTrust: trustDecision,
      getProviderModelSnapshot: getProvider,
      selectProviderModel: selectProvider,
      getMcpSnapshot: getMcp,
      applyMcpAction: applyMcp,
      getSkillCatalog: getSkills,
      getExecutionStatus: getExecution,
      getReleaseStatus: getRelease,
    };
  };

  const history = {
    async listSessions(
      _request: Parameters<NativeKiteServiceApplicationPort['history']['listSessions']>[0],
    ): Promise<RuntimeLogSessionPage> {
      return {
        entries: [...sessions.values()].map((session) => ({
          sessionId: session.sessionId,
          displayName: session.displayName,
          needsSmartName: false,
          updatedAt: Date.parse(session.updatedAt),
          lastSequence: session.revision,
        })),
        hasMore: false,
      };
    },
    async listEvents(
      _request: Parameters<NativeKiteServiceApplicationPort['history']['listEvents']>[0],
    ): Promise<RuntimeLogEventPage> {
      return { entries: [], hasMore: false, observedLastSequence: 0 };
    },
    async loadSession(sessionId: string): Promise<RuntimeHistorySessionTranscript> {
      const session = sessions.get(sessionId);
      if (!session) throw new Error('harness session not found');
      return emptyHistorySession(session);
    },
  };

  const appControl: KiteAppControlClient = {
    ...appControlForWorkspace(config.workspace),
  };

  const application: NativeKiteServiceApplicationPort = {
    server,
    history,
    workspaceAdmission: {
      async admitForConnect(requestedWorkspace) {
        return requestedWorkspace === config.workspace.canonicalPath
          ? { outcome: 'admitted', workspace: config.workspace }
          : { outcome: 'untrusted' };
      },
      async resolveIdentity(candidate) {
        return sameWorkspace(candidate, config.workspace) ? config.workspace : undefined;
      },
    },
    runtimeAdmission: {
      create(workspace) {
        return {
          async authorize() {
            return { allowed: true, workspace: workspace.canonicalPath };
          },
        };
      },
    },
    appControl: {
      discovery: appControl,
      forWorkspace(workspace) {
        return sameWorkspace(workspace, config.workspace)
          ? appControlForWorkspace(config.workspace)
          : appControlForWorkspace(workspace);
      },
    },
    credential: {
      async writeProviderCredential(
        request: NativeProviderCredentialRequest,
      ): Promise<NativeProviderCredentialResult> {
        credentialPresent = true;
        credentialWrites += 1;
        const result: NativeCredentialResult = {
          schema: LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA_,
          mutationId: request.mutationId,
          operation: 'write_provider_api_key',
          outcome: 'applied',
          credentialPresent: true,
          revision: `harness-credential-${credentialWrites}`,
        };
        if (dropCredentialResponse) {
          dropCredentialResponse = false;
          throw new Error('harness intentionally dropped credential response');
        }
        return result;
      },
    },
    async start(startOptions) {
      await delayWithAbort(config.faults.startupDelayMs ?? 0, startOptions?.signal);
      if (config.faults.failStartup) throw new Error('harness application startup failed');
    },
    async quiesceMutations() {
      return {
        activeOperations: false,
        resume: () => undefined,
        commitDrain: async () => undefined,
      };
    },
    async cancelAll(_reason) {
      // The fixture has no active model/tool work. This is intentionally an explicit no-op at the
      // injected application boundary, not a shell fallback or a second owner.
    },
    async [Symbol.asyncDispose]() {
      await server.beginDraining();
    },
  };

  return { application, credentialWrites: () => credentialWrites };
}

function createReadinessPort(instanceId: string): KiteServiceReadinessPort {
  let announced = false;
  const rawFd = process.env.KITE_SERVICE_READINESS_FD;
  const fd = rawFd === undefined ? undefined : Number(rawFd);
  return {
    publish(event: KiteServiceReadinessEvent): void {
      if (announced || event.state !== 'ready') return;
      if (!Number.isSafeInteger(fd) || fd === undefined || fd < 0) {
        throw new Error('Service harness readiness fd is missing.');
      }
      // Bun's child spawn adapter passes fd 3 as a dedicated one-shot readiness channel.  It is
      // never stdout and carries only the exact instance identity handshake.
      const value = JSON.stringify({ instanceId });
      writeSync(fd, `${value}\n`);
      closeSync(fd);
      announced = true;
    },
  };
}

/** Internal child entry. It is reached only by the generated process-harness wrapper. */
export async function runKiteServiceProcessHarnessChild(
  config: KiteServiceProcessHarnessChildConfig,
): Promise<number> {
  let infrastructure: ReturnType<typeof createNativeKiteServiceInfrastructure> | undefined;
  try {
    const readiness = createReadinessPort(config.instanceId);
    const { application } = createFakeApplication(config);
    infrastructure = createNativeKiteServiceInfrastructure({
      home: createKiteHomeIdentity(config.homeRoot, 'explicit_argument'),
      application,
      instanceId: config.instanceId,
      serverVersion: config.serverVersion,
      buildId: config.buildId,
      readiness,
      startupTimeoutMs: config.startupTimeoutMs,
      shutdownTimeoutMs: config.shutdownTimeoutMs,
    });
    const started = await infrastructure.start();
    if (started.outcome !== 'applied') return 1;
    const stopped = await infrastructure.shell.waitForShutdown();
    return stopped.outcome === 'applied' ? 0 : 1;
  } catch {
    process.stderr.write('[kite-service-process-harness] child lifecycle failed\n');
    try {
      await infrastructure?.[Symbol.asyncDispose]();
    } catch {
      // Preserve the stable child failure marker; native state remains for manager diagnosis.
    }
    return 1;
  }
}
