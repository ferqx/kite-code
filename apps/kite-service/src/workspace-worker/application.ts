import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { discoverSandboxBackendCandidate } from '@kite-ai/builtin-runtime/sandbox';
import {
  type KiteWorkspaceIdentity,
  WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
} from '@kite-ai/kite-app-contract';
import type {
  WorkerControllerAbandonDetachedRequest,
  WorkerControllerCreateSessionRequest,
  WorkerControllerCreateSessionResponse,
  WorkerControllerDetachRequest,
  WorkerControllerIssueResumeCapabilityRequest,
  WorkerControllerMintDetachedRecoveryRequest,
  WorkerControllerMutationResponse,
  WorkerControllerOperationResponse,
  WorkerControllerReadRequest,
  WorkerControllerReadResponse,
  WorkerControllerReleaseControlRequest,
  WorkerControllerRequestControlRequest,
  WorkerControllerResumeCapabilityResponse,
  WorkerControllerResumeRequest,
  WorkerControllerValidateResumeRequest,
} from '@kite-ai/kite-app-contract/worker-controller';
import {
  type InteractionMode,
  RUNTIME_COMMAND_SCHEMA_,
  type RuntimeCommand,
  type RuntimeCommandContext,
} from '@kite-ai/runtime-contract';
import type { RuntimeServerAdmissionInput } from '@kite-ai/runtime-server';
import type { ClassifiedInvocation, PreparedToolInvocation } from '@kite-ai/runtime-spi';
import type {
  SqliteWorkspaceInitialControllerInput,
  SqliteWorkspaceSessionCreationResult,
} from '@kite-ai/runtime-storage-sqlite';
import {
  createKiteInProcessAppControlComposition,
  type KiteInProcessAppControlComposition,
  type KiteInProcessAppControlCompositionOptions,
} from '../app-control/composition';
import {
  createKiteMultiWorkspaceRuntimeServer,
  createKiteRuntimeObserverHistoryFromStorage,
  type KiteRuntimeStorageOwner,
  workspaceIdentityDigest,
} from '../bootstrap';
import type { KiteServiceApplicationPort } from '../carrier';
import type { ServiceControllerPort, ServiceRuntimeConnectionBinding } from '../carrier/ports';
import { createRuntimeOperationGate, type RuntimeOperationGate } from '../runtime-application';
import {
  createKiteRuntimeApplication,
  type KiteRuntimeApplication,
} from '../runtime-application/application';
import type { SandboxBackend } from '../sandbox/types';
import { createWorkspaceWorkerControllerAdapter } from './controller-adapter';
import {
  createWorkspaceEffectAttempt,
  createWorkspaceStoreEffectAdapter,
  type WorkspaceEffectAttemptContext,
  type WorkspaceEffectDispatchComposition,
  type WorkspaceStoreEffectAdapter,
} from './effect-adapter';
import { createNativeWorkspaceResourceLeasePort } from './resource-lease';
import type {
  WorkspaceWorkerApplicationFactoryInput,
  WorkspaceWorkerApplicationOwner,
} from './runtime-composition';

const MAX_PINNED_WORKER_COMMANDS = 4_096;
const WORKER_COMMAND_CONTEXT_TTL_MS = 60 * 60 * 1_000;

/** Optional per-Worker choices; all durable/runtime owners remain injected or Service-owned. */
export interface WorkspaceWorkerApplicationOptions {
  /** An existing App Control owner may be supplied by a production composition root. */
  readonly appControl?: KiteInProcessAppControlComposition<RuntimeOperationGate>;
  /** Used only when this factory creates the App Control owner itself. */
  readonly appControlOptions?: KiteInProcessAppControlCompositionOptions;
  readonly userId?: string;
  readonly interactionMode?: InteractionMode;
  readonly sandboxBackend?: SandboxBackend;
  readonly initialSkillActivations?: readonly {
    readonly skillId: string;
    readonly input: Readonly<Record<string, unknown>>;
  }[];
}

/**
 * Compose the real single-Workspace Worker application around the Store owner supplied by
 * `createWorkspaceWorkerRuntimeComposition`.
 *
 * This factory deliberately has no Store/SQLite constructor and no compatibility source.  The
 * Runtime Host and its query-only History both consume the exact injected Store 7 owner; the
 * App Control composition owns only Workspace configuration/providers and never opens Runtime
 * State storage.
 */
export async function createWorkspaceWorkerApplication(
  input: WorkspaceWorkerApplicationFactoryInput,
  options: WorkspaceWorkerApplicationOptions = {},
): Promise<WorkspaceWorkerApplicationOwner> {
  assertStoreIdentity(input);
  if (
    input.controller !== undefined &&
    input.controller.workerInstanceId !== input.workerIdentity.workerInstanceId
  ) {
    throw new Error('Workspace Worker Controller does not match the admitted Worker identity.');
  }
  const controller =
    input.controller ??
    createWorkspaceWorkerControllerAdapter({
      authority: input.authority,
      workerInstanceId: input.workerIdentity.workerInstanceId,
    });
  const operationGate = options.appControl?.operationGate ?? createRuntimeOperationGate();
  const commandContexts = createWorkerCommandContextRegistry({
    workspace: input.workspace,
    workspaceAuthorityDigest: normalizedStoreWorkspaceDigest(
      input.authority.binding.workspaceIdentityDigest,
    ),
    workerInstanceId: input.workerIdentity.workerInstanceId,
    workerScopeId: input.workerIdentity.workerScopeId,
    controller,
    effect: createWorkspaceStoreEffectAdapter({
      authority: input.authority,
      resourceLease: createNativeWorkspaceResourceLeasePort({
        coordinationHome: input.coordinationHome,
      }),
      authorizeController: (attempt) =>
        controller.native.authorizeMutation({
          sessionId: attempt.sessionId,
          clientId: attempt.clientId,
          connectionGeneration: attempt.connectionGeneration,
          controllerGeneration: attempt.controllerGeneration,
          workerInstanceId: attempt.workerInstanceId,
        }),
    }),
  });
  const appControl =
    options.appControl ??
    createKiteInProcessAppControlComposition(operationGate, {
      ...(options.appControlOptions ?? {}),
      // App Control uses this only as its explicit config/checkpoint root. Runtime state remains
      // the already-open Store passed by the Worker composition.
      checkpointPath: input.storeContext.databasePath,
    });
  const ownsAppControl = options.appControl === undefined;

  let runtimeOwner: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
  try {
    const admittedWorkspace = appControl.admitWorkspace(input.workspace.canonicalPath);
    assertSameWorkspace(admittedWorkspace, input.workspace);
    const runtimeInputs = appControl.runtimeInputsFor(admittedWorkspace);
    const template = {
      userId: options.userId ?? `workspace-worker:${input.workerIdentity.workerScopeId}`,
      workspace: admittedWorkspace.canonicalPath,
      config: runtimeInputs.config,
      shellExecutor: runtimeInputs.shellExecutor,
      interactionMode:
        options.interactionMode ?? runtimeInputs.config.interactionMode ?? ('auto' as const),
      sandboxBackend: options.sandboxBackend ?? discoverSandboxBackendCandidate(),
      mcpManager: runtimeInputs.mcpManager,
      skillManifests: runtimeInputs.skillManifests,
      skillOptions: runtimeInputs.skillOptions,
      initialSkillActivations: options.initialSkillActivations ?? [],
      workspaceEffectCompositionFactory: commandContexts.compositionFor,
    };
    const storageOwner: KiteRuntimeStorageOwner = Object.freeze({
      storage: commandContexts.bindStorage(input.storage),
      listCurrentSessions: (query = '', limit = 50) =>
        input.storage.sessions.listSessions(query, limit),
      loadCurrentSnapshot: (sessionId: string) =>
        input.storage.sessions.loadSnapshot<
          import('../bootstrap/runtime/state-runtime').RuntimeState
        >(sessionId),
      getCurrentSessionModelRoute: (sessionId: string) =>
        input.storage.sessions.getSessionModelRoute(sessionId),
    });
    runtimeOwner = createKiteMultiWorkspaceRuntimeServer({
      // CliRuntimeBridge retains this as a metadata input; all actual State I/O is through the
      // injected owner above. It is never used to open a second Runtime Store.
      checkpointPath: input.storeContext.databasePath,
      serverInstanceId: input.workerIdentity.workerInstanceId,
      operationGate,
      storageOwner,
      workspaces: [template],
    });
    const history = createKiteRuntimeObserverHistoryFromStorage(input.storage);
    const application = createKiteRuntimeApplication({
      runtime: runtimeOwner.runtime,
      server: runtimeOwner.server,
      history,
      appControl: appControl.gateway.forWorkspace(admittedWorkspace),
      operationGate,
      start: async () => {
        await runtimeInputs.workspaceReady;
        await runtimeOwner!.host.start();
      },
      cancelAll: runtimeOwner.cancelAllSessions,
      dispose: async () => {
        try {
          await runtimeOwner![Symbol.asyncDispose]();
        } finally {
          commandContexts.clear();
          if (ownsAppControl) await appControl[Symbol.asyncDispose]();
        }
      },
    });
    const carrierApplication = createCarrierApplication(
      application,
      runtimeOwner,
      history,
      appControl,
      admittedWorkspace,
      controller,
      commandContexts,
    );
    return Object.freeze({
      application: carrierApplication,
      controller,
      cancelAll: application.cancelAll,
      start: application.start,
      drain: async () => drainApplication(application, runtimeOwner!),
      [Symbol.asyncDispose]: application[Symbol.asyncDispose],
    });
  } catch (error) {
    commandContexts.clear();
    try {
      await runtimeOwner?.[Symbol.asyncDispose]();
    } finally {
      if (ownsAppControl) await appControl[Symbol.asyncDispose]();
    }
    throw error;
  }
}

interface PinnedWorkerCommand {
  readonly reference: string;
  readonly connectionId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly commandId: string;
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly controllerGeneration: number;
  readonly workerInstanceId: string;
  readonly expiresAtMs: number;
}

interface PendingWorkerSessionCreate {
  readonly record: PinnedWorkerCommand;
  readonly requestKey: string;
  readonly controller: SqliteWorkspaceInitialControllerInput;
  readonly command: Extract<RuntimeCommand, { readonly type: 'create_session' }>;
  readonly context: RuntimeCommandContext;
  result?: SqliteWorkspaceSessionCreationResult;
}

interface WorkerCommandContextRegistry {
  pin(
    request: RuntimeServerAdmissionInput,
    lease: Readonly<{
      sessionId: string;
      clientId: string;
      connectionGeneration: number;
      controllerGeneration: number;
      workerInstanceId: string;
      status: 'active' | 'detached';
    }>,
  ): string;
  prepareCreate(
    request: WorkerControllerCreateSessionRequest,
    binding: Readonly<{
      clientId: string;
      connectionGeneration: number;
      workerInstanceId: string;
    }>,
  ): Readonly<{
    command: Extract<RuntimeCommand, { readonly type: 'create_session' }>;
    context: RuntimeCommandContext;
    reference: string;
  }>;
  finishCreate(reference: string): SqliteWorkspaceSessionCreationResult;
  discardCreate(reference: string): void;
  bindStorage(
    storage: WorkspaceWorkerApplicationFactoryInput['storage'],
  ): WorkspaceWorkerApplicationFactoryInput['storage'];
  compositionFor(
    context: Readonly<RuntimeCommandContext>,
  ): Readonly<WorkspaceEffectDispatchComposition> & {
    readonly context: Readonly<WorkspaceEffectAttemptContext>;
  };
  releaseConnection(connectionId: string): void;
  clear(): void;
}

function createWorkerCommandContextRegistry(input: {
  readonly workspace: KiteWorkspaceIdentity;
  readonly workspaceAuthorityDigest: `sha256:${string}`;
  readonly workerScopeId: string;
  readonly workerInstanceId: string;
  readonly controller: ReturnType<typeof createWorkspaceWorkerControllerAdapter>;
  readonly effect: WorkspaceStoreEffectAdapter;
  readonly nowMs?: () => number;
}): WorkerCommandContextRegistry {
  const byReference = new Map<string, PinnedWorkerCommand>();
  const pendingCreates = new Map<string, PendingWorkerSessionCreate>();
  const pendingCreateRequests = new Map<string, PendingWorkerSessionCreate>();
  const now = input.nowMs ?? Date.now;
  const workspaceResourceId = hashedResourceId('workspace', [input.workspace.workspaceDigest]);

  const prune = (observedAt: number): void => {
    for (const [reference, record] of byReference) {
      if (record.expiresAtMs <= observedAt) {
        byReference.delete(reference);
        const pending = pendingCreates.get(reference);
        if (pending) {
          pendingCreates.delete(reference);
          pendingCreateRequests.delete(pending.requestKey);
        }
      }
    }
  };

  const exactContext = (context: Readonly<RuntimeCommandContext>): PinnedWorkerCommand => {
    if (context.bindingReference === null) {
      throw new Error('Workspace effect command context has no Worker binding.');
    }
    const observedAt = now();
    prune(observedAt);
    const record = byReference.get(context.bindingReference);
    if (
      !record ||
      record.expiresAtMs <= observedAt ||
      record.connectionId !== context.connectionId ||
      record.requestId !== context.requestId ||
      (context.clientInfo !== undefined && context.clientInfo.instanceId !== record.clientId)
    ) {
      throw new Error('Workspace effect command context is unavailable or stale.');
    }
    return record;
  };

  const registry: WorkerCommandContextRegistry = {
    pin(
      request: RuntimeServerAdmissionInput,
      lease: Readonly<{
        sessionId: string;
        clientId: string;
        connectionGeneration: number;
        controllerGeneration: number;
        workerInstanceId: string;
        status: 'active' | 'detached';
      }>,
    ) {
      const command = request.command as { readonly commandId?: unknown } | undefined;
      if (
        request.operation !== 'runtime/command' ||
        !safeIdentity(request.connectionId) ||
        !safeIdentity(request.requestId) ||
        !safeIdentity(command?.commandId) ||
        lease.status !== 'active' ||
        lease.workerInstanceId !== input.workerInstanceId ||
        (request.clientInfo !== undefined && request.clientInfo.instanceId !== lease.clientId)
      ) {
        throw new Error('Runtime command cannot be pinned to this Worker Controller.');
      }
      const observedAt = now();
      prune(observedAt);
      if (byReference.size >= MAX_PINNED_WORKER_COMMANDS) {
        throw new Error('Runtime command context registry is full.');
      }
      const reference = `worker-command-${randomUUID()}`;
      byReference.set(
        reference,
        Object.freeze({
          reference,
          connectionId: request.connectionId,
          requestId: request.requestId,
          sessionId: lease.sessionId,
          commandId: command.commandId,
          clientId: lease.clientId,
          connectionGeneration: lease.connectionGeneration,
          controllerGeneration: lease.controllerGeneration,
          workerInstanceId: lease.workerInstanceId,
          expiresAtMs: observedAt + WORKER_COMMAND_CONTEXT_TTL_MS,
        }),
      );
      return reference;
    },
    prepareCreate(request, binding) {
      if (
        !safeIdentity(request.sessionId) ||
        !safeIdentity(request.requestId) ||
        !/^[a-f0-9]{64}$/u.test(request.requestDigest) ||
        !safeIdentity(binding.clientId) ||
        !positiveGeneration(binding.connectionGeneration) ||
        binding.workerInstanceId !== input.workerInstanceId
      ) {
        throw new Error('Atomic Session creation binding is invalid.');
      }
      const observedAt = now();
      prune(observedAt);
      const requestKey = `${request.sessionId}\0${request.requestId}`;
      const existing = pendingCreateRequests.get(requestKey);
      if (existing) {
        if (
          existing.controller.requestDigest !== request.requestDigest ||
          existing.controller.clientId !== binding.clientId ||
          existing.controller.connectionGeneration !== binding.connectionGeneration ||
          existing.controller.resumeSecret !== request.resumeSecret ||
          existing.controller.resumeExpiresAtMs !== request.resumeExpiresAtMs
        ) {
          throw new Error('Atomic Session creation request identity changed.');
        }
        return Object.freeze({
          command: existing.command,
          context: existing.context,
          reference: existing.record.reference,
        });
      }
      if (byReference.size >= MAX_PINNED_WORKER_COMMANDS) {
        throw new Error('Runtime command context registry is full.');
      }
      const reference = `worker-create-${randomUUID()}`;
      const commandId = `worker-create-${createHash('sha256')
        .update(`${request.sessionId}\0${request.requestId}\0${request.requestDigest}`, 'utf8')
        .digest('hex')}`;
      const connectionId = `worker-create-${createHash('sha256')
        .update(`${binding.clientId}\0${binding.connectionGeneration}`, 'utf8')
        .digest('hex')}`;
      const record: PinnedWorkerCommand = Object.freeze({
        reference,
        connectionId,
        requestId: request.requestId,
        sessionId: request.sessionId,
        commandId,
        clientId: binding.clientId,
        connectionGeneration: binding.connectionGeneration,
        controllerGeneration: 1,
        workerInstanceId: binding.workerInstanceId,
        expiresAtMs: observedAt + WORKER_COMMAND_CONTEXT_TTL_MS,
      });
      const command = Object.freeze({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId,
        type: 'create_session' as const,
        workspace: input.workspace.canonicalPath,
        bootstrapSessionId: request.sessionId,
      });
      const context: RuntimeCommandContext = Object.freeze({
        schema: 'kite.runtime-command-context.v1',
        connectionId,
        requestId: request.requestId,
        bindingReference: reference,
      });
      const pending: PendingWorkerSessionCreate = {
        record,
        requestKey,
        controller: Object.freeze({
          sessionId: request.sessionId,
          requestId: request.requestId,
          requestDigest: request.requestDigest,
          clientId: binding.clientId,
          connectionGeneration: binding.connectionGeneration,
          workerInstanceId: binding.workerInstanceId,
          resumeSecret: request.resumeSecret,
          resumeExpiresAtMs: request.resumeExpiresAtMs,
        }),
        command,
        context,
      };
      byReference.set(reference, record);
      pendingCreates.set(reference, pending);
      pendingCreateRequests.set(requestKey, pending);
      return Object.freeze({ command, context, reference });
    },
    finishCreate(reference) {
      const pending = pendingCreates.get(reference);
      if (!pending?.result) throw new Error('Atomic Session creation did not commit.');
      pendingCreates.delete(reference);
      pendingCreateRequests.delete(pending.requestKey);
      byReference.delete(reference);
      return pending.result;
    },
    discardCreate(reference) {
      const pending = pendingCreates.get(reference);
      if (!pending) return;
      pendingCreates.delete(reference);
      pendingCreateRequests.delete(pending.requestKey);
      byReference.delete(reference);
    },
    bindStorage(storage) {
      const wrapped = Object.create(storage) as WorkspaceWorkerApplicationFactoryInput['storage'];
      Object.defineProperty(wrapped, 'close', {
        enumerable: true,
        configurable: false,
        writable: false,
        value: () => storage.close(),
      });
      Object.defineProperty(wrapped, 'transactions', {
        enumerable: true,
        configurable: false,
        writable: false,
        value: Object.freeze({
          ...storage.transactions,
          commitDecision: (
            transaction: Parameters<typeof storage.transactions.commitDecision>[0],
          ) => {
            const commandId = transaction.commandReceipt?.commandId;
            const pending =
              commandId === undefined
                ? undefined
                : [...pendingCreates.values()].find(
                    (candidate) => candidate.command.commandId === commandId,
                  );
            if (!pending) return storage.transactions.commitDecision(transaction);
            if (
              transaction.sessionId !== pending.record.sessionId ||
              transaction.commandReceipt?.targetSessionId !== pending.record.sessionId
            ) {
              throw new Error('Atomic Session creation transaction identity changed.');
            }
            pending.result = storage.workspaceSessionCreation.create({
              runtime: transaction,
              controller: pending.controller,
            });
          },
        }),
      });
      return Object.freeze(wrapped);
    },
    compositionFor(context: Readonly<RuntimeCommandContext>) {
      const record = exactContext(context);
      const baseContext: WorkspaceEffectAttemptContext = Object.freeze({
        sessionId: record.sessionId,
        commandId: record.commandId,
        clientId: record.clientId,
        connectionGeneration: record.connectionGeneration,
        controllerGeneration: record.controllerGeneration,
        workerInstanceId: record.workerInstanceId,
        ownerId: input.workerInstanceId,
        workerScopeId: input.workerScopeId,
        workspaceDigest: input.workspaceAuthorityDigest,
        resourceId: workspaceResourceId,
        kind: 'filesystem',
        expiresAtMs: record.expiresAtMs,
      });
      if (
        !input.controller.native.authorizeMutation({
          sessionId: baseContext.sessionId,
          clientId: baseContext.clientId,
          connectionGeneration: baseContext.connectionGeneration,
          controllerGeneration: baseContext.controllerGeneration,
          workerInstanceId: baseContext.workerInstanceId,
        })
      ) {
        throw new Error('Workspace effect command Controller is no longer current.');
      }
      return Object.freeze({
        gate: input.effect.gate,
        context: baseContext,
        createAttempt: ({
          context: attemptContext,
          prepared,
          classified,
        }: {
          readonly context: Readonly<WorkspaceEffectAttemptContext>;
          readonly prepared: Readonly<PreparedToolInvocation>;
          readonly classified: Readonly<ClassifiedInvocation>;
          readonly attempt: number;
        }) =>
          createWorkspaceEffectAttempt({
            context: {
              ...attemptContext,
              kind: mutationKind(classified),
              resourceId: effectResourceId(classified, prepared, input.workspace),
            },
            prepared,
          }),
      });
    },
    releaseConnection(connectionId: string) {
      for (const [reference, record] of byReference) {
        if (record.connectionId === connectionId) {
          byReference.delete(reference);
          const pending = pendingCreates.get(reference);
          if (pending) {
            pendingCreates.delete(reference);
            pendingCreateRequests.delete(pending.requestKey);
          }
        }
      }
    },
    clear() {
      byReference.clear();
      pendingCreates.clear();
      pendingCreateRequests.clear();
    },
  };
  return Object.freeze(registry);
}

function mutationKind(
  classified: Readonly<ClassifiedInvocation>,
): WorkspaceEffectAttemptContext['kind'] {
  const mechanism = classified.governance.invocation.executionMechanism;
  if (mechanism === 'git') return 'git';
  if (mechanism === 'shell') return 'shell';
  if (mechanism === 'mcp') return 'mcp_project';
  if (mechanism === 'filesystem') return 'filesystem';
  return classified.effectiveEffects.externalState === 'none'
    ? 'workspace_config'
    : 'sandbox_external';
}

function effectResourceId(
  classified: Readonly<ClassifiedInvocation>,
  prepared: Readonly<PreparedToolInvocation>,
  workspace: KiteWorkspaceIdentity,
): string {
  const traits = classified.executionTraits;
  const sharedFacts = [
    ...(traits?.resourceScopes ?? []).map((scope) => `${scope.kind}:${scope.key}`),
    ...(traits?.conflictKeys ?? []).map((key) => `conflict:${key}`),
  ].sort();
  if (sharedFacts.length > 0) return hashedResourceId('declared', sharedFacts);
  if (
    classified.effectClass === 'external_side_effect' ||
    classified.effectiveEffects.externalState === 'write' ||
    classified.effectiveEffects.externalState === 'destructive' ||
    classified.effectiveEffects.externalState === 'unknown'
  ) {
    return hashedResourceId('external', ['os-user-global']);
  }
  return hashedResourceId('workspace', [
    workspace.workspaceDigest,
    prepared.identity.canonicalCwd ?? workspace.canonicalPath,
  ]);
}

function hashedResourceId(kind: string, values: readonly string[]): string {
  return `resource-${kind}-${createHash('sha256').update(JSON.stringify(values), 'utf8').digest('hex')}`;
}

function normalizedStoreWorkspaceDigest(value: string): `sha256:${string}` {
  const normalized = value.startsWith('sha256:') ? value : `sha256:${value}`;
  if (!/^sha256:[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error('Workspace Store authority digest is invalid.');
  }
  return normalized as `sha256:${string}`;
}

function assertStoreIdentity(input: WorkspaceWorkerApplicationFactoryInput): void {
  if (input.storage.workspaceAuthority !== input.authority) {
    throw new Error('Workspace Worker application received a non-owner Store authority.');
  }
  const binding = input.authority.binding;
  if (
    input.workerIdentity.workerScopeId !== binding.workerScopeId ||
    input.workerIdentity.workspace.canonicalPath !== input.workspace.canonicalPath ||
    input.workerIdentity.workspace.projectId !== input.workspace.projectId ||
    input.workerIdentity.workspace.workspaceDigest !== input.workspace.workspaceDigest ||
    binding.workspaceIdentityDigest !== workspaceIdentityDigest(input.workspace) ||
    binding.layoutGeneration !== input.storeContext.binding.layoutGeneration ||
    binding.workerScopeId !== input.storeContext.binding.workerScopeId ||
    binding.workspaceIdentityDigest !== input.storeContext.binding.workspaceIdentityDigest
  ) {
    throw new Error('Workspace Worker Store authority does not match the admitted layout binding.');
  }
}

function assertSameWorkspace(left: KiteWorkspaceIdentity, right: KiteWorkspaceIdentity): void {
  if (
    left.canonicalPath !== right.canonicalPath ||
    left.projectId !== right.projectId ||
    left.workspaceDigest !== right.workspaceDigest
  ) {
    throw new Error('Workspace Worker App Control identity does not match the admitted Workspace.');
  }
}

function createCarrierApplication(
  application: KiteRuntimeApplication,
  runtimeOwner: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer>,
  history: KiteRuntimeApplication['history'],
  appControl: KiteInProcessAppControlComposition<RuntimeOperationGate>,
  workspace: KiteWorkspaceIdentity,
  controllerAdapter: ReturnType<typeof createWorkspaceWorkerControllerAdapter>,
  commandContexts: WorkerCommandContextRegistry,
): KiteServiceApplicationPort {
  const workspaceAdmission = {
    async admitForConnect(requestedWorkspace: string) {
      try {
        if (realpathSync.native(requestedWorkspace) !== workspace.canonicalPath) {
          return { outcome: 'untrusted' as const };
        }
      } catch {
        return { outcome: 'untrusted' as const };
      }
      try {
        const trust = await appControl.gateway.discovery.queryWorkspaceTrust({
          schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
          workspace: workspace.canonicalPath,
        });
        return trust.status === 'trusted'
          ? { outcome: 'admitted' as const, workspace }
          : { outcome: 'untrusted' as const };
      } catch {
        return { outcome: 'unavailable' as const };
      }
    },
    async resolveIdentity(candidate: KiteWorkspaceIdentity) {
      try {
        if (realpathSync.native(candidate.canonicalPath) !== workspace.canonicalPath) {
          return undefined;
        }
      } catch {
        return undefined;
      }
      try {
        assertSameWorkspace(candidate, workspace);
      } catch {
        return undefined;
      }
      try {
        const trust = await appControl.gateway.discovery.queryWorkspaceTrust({
          schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
          workspace: workspace.canonicalPath,
        });
        return trust.status === 'trusted' ? workspace : undefined;
      } catch {
        return undefined;
      }
    },
  };
  const runtimeAdmission = {
    create(
      admittedWorkspace: KiteWorkspaceIdentity,
      connectionId: string,
      connectionKind?: 'native_client' | 'web_observer',
      connectionBinding?: ServiceRuntimeConnectionBinding,
    ) {
      return {
        authorize: async (request: RuntimeServerAdmissionInput) => {
          if (request.connectionId !== connectionId) {
            return { allowed: false as const, reason: 'unauthorized' as const };
          }
          try {
            assertSameWorkspace(admittedWorkspace, workspace);
          } catch {
            return { allowed: false as const, reason: 'unauthorized' as const };
          }
          if (request.operation === 'runtime/command' && connectionKind !== 'native_client') {
            return { allowed: false as const, reason: 'unauthorized' as const };
          }
          const sessionId = sessionIdFromRequest(request);
          if (connectionKind === 'native_client' && request.operation === 'runtime/command') {
            const command = request.command as { readonly type?: unknown } | undefined;
            if (
              !connectionBinding ||
              command?.type === 'create_session' ||
              !safeIdentity(connectionBinding.clientId) ||
              !positiveGeneration(connectionBinding.connectionGeneration) ||
              sessionId === undefined
            ) {
              return { allowed: false as const, reason: 'unauthorized' as const };
            }
            try {
              const lease = controllerAdapter.observer.lease(sessionId);
              if (
                lease?.status !== 'active' ||
                lease.clientId !== connectionBinding.clientId ||
                lease.connectionGeneration !== connectionBinding.connectionGeneration ||
                lease.workerInstanceId !== connectionBinding.workerInstanceId ||
                !controllerAdapter.native.authorizeMutation(lease)
              ) {
                return { allowed: false as const, reason: 'unauthorized' as const };
              }
              const bindingReference = commandContexts.pin(request, lease);
              return {
                allowed: true as const,
                workspace: workspace.canonicalPath,
                bindingReference,
              };
            } catch {
              return { allowed: false as const, reason: 'unauthorized' as const };
            }
          }
          if (sessionId !== undefined) {
            const persisted = persistedWorkspace(runtimeOwner, sessionId, workspace);
            const command =
              request.operation === 'runtime/command' && request.command
                ? (request.command as { readonly type?: unknown })
                : undefined;
            const freshCreate = command?.type === 'create_session' && persisted === undefined;
            if (!freshCreate && persisted === undefined) {
              return { allowed: false as const, reason: 'unauthorized' as const };
            }
          }
          return { allowed: true as const, workspace: workspace.canonicalPath };
        },
      };
    },
  };
  const controller = createServiceControllerPort({
    adapter: controllerAdapter,
    runtimeOwner,
    commandContexts,
  });
  return Object.freeze({
    server: runtimeOwner.server,
    history,
    workspaceAdmission,
    runtimeAdmission,
    appControl: appControl.gateway,
    credential: appControl.credentialClient,
    controller,
    onConnectionBound: (connectionId: string, admitted: KiteWorkspaceIdentity) => {
      assertSameWorkspace(admitted, workspace);
      runtimeOwner.bindConnection(connectionId, workspace);
    },
    onConnectionClosed: (connectionId: string) => {
      commandContexts.releaseConnection(connectionId);
      runtimeOwner.releaseConnection(connectionId);
    },
    start: application.start,
    quiesceMutations: application.quiesceMutations,
    [Symbol.asyncDispose]: application[Symbol.asyncDispose],
  });
}

function createServiceControllerPort(input: {
  readonly adapter: ReturnType<typeof createWorkspaceWorkerControllerAdapter>;
  readonly runtimeOwner: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer>;
  readonly commandContexts: WorkerCommandContextRegistry;
}): ServiceControllerPort {
  const { adapter, runtimeOwner, commandContexts } = input;
  const assertBinding = (binding: ServiceRuntimeConnectionBinding): void => {
    if (
      binding.workerInstanceId !== adapter.workerInstanceId ||
      !safeIdentity(binding.clientId) ||
      !positiveGeneration(binding.connectionGeneration)
    ) {
      throw new Error('Native Controller connection binding is invalid.');
    }
  };
  const operation = (
    request: { readonly operation: WorkerControllerMutationResponse['operation'] },
    result: ReturnType<typeof adapter.native.requestControl>,
  ): WorkerControllerOperationResponse => {
    const lease = result.status === 'rejected' ? undefined : result.lease;
    return {
      schema: 'kite.app.worker-controller.response.v1',
      operation: request.operation,
      status: result.status,
      receipt: {
        schema: 'kite.app.worker-controller.receipt.v1',
        sessionId: result.receipt.sessionId,
        requestId: result.receipt.requestId,
        requestDigest: result.receipt.requestDigest,
        operation: result.receipt.operation,
        status: result.receipt.status,
        code: result.receipt.code,
        controllerGeneration: result.receipt.controllerGeneration,
        connectionGeneration: result.receipt.connectionGeneration,
        interactionGeneration: result.receipt.interactionGeneration,
        clientId: result.receipt.clientId,
        workerInstanceId: result.receipt.workerInstanceId,
        completedAt: result.receipt.completedAt,
      },
      ...(lease === undefined
        ? {}
        : {
            lease: {
              sessionId: lease.sessionId,
              clientId: lease.clientId,
              connectionGeneration: lease.connectionGeneration,
              controllerGeneration: lease.controllerGeneration,
              workerInstanceId: lease.workerInstanceId,
              status: lease.status,
            },
          }),
    };
  };
  const bindingRequest = (
    binding: ServiceRuntimeConnectionBinding,
  ): { readonly clientId: string; readonly connectionGeneration: number } => {
    assertBinding(binding);
    return { clientId: binding.clientId, connectionGeneration: binding.connectionGeneration };
  };
  const createResponse = (
    result: ReturnType<typeof adapter.native.requestControl>,
    sessionRevision: number,
  ): WorkerControllerCreateSessionResponse => {
    const mapped = operation({ operation: 'request_control' }, result);
    if (
      mapped.operation !== 'request_control' ||
      (mapped.status !== 'applied' && mapped.status !== 'replay') ||
      mapped.lease?.status !== 'active' ||
      !Number.isSafeInteger(sessionRevision) ||
      sessionRevision < 0
    ) {
      throw new Error('Atomic Session creation did not return durable Controller authority.');
    }
    return {
      ...mapped,
      operation: 'create_session',
      sessionRevision,
    };
  };

  const initialControllerRequest = (
    request: WorkerControllerCreateSessionRequest,
    binding: ServiceRuntimeConnectionBinding,
  ) => {
    const connection = bindingRequest(binding);
    return {
      sessionId: request.sessionId,
      requestId: request.requestId,
      requestDigest: request.requestDigest,
      resumeSecret: request.resumeSecret,
      resumeExpiresAtMs: request.resumeExpiresAtMs,
      clientId: connection.clientId,
      connectionGeneration: connection.connectionGeneration,
    };
  };

  return Object.freeze({
    async createSession(
      request: WorkerControllerCreateSessionRequest,
      binding: ServiceRuntimeConnectionBinding,
    ) {
      const controllerRequest = initialControllerRequest(request, binding);
      const existingSnapshot = runtimeOwner.storage.sessions.loadSnapshotRecord(request.sessionId);
      const existing = existingSnapshot
        ? adapter.observer.lookupOperation(request.sessionId, request.requestId)
        : null;
      if (existing && existingSnapshot) {
        const replay = adapter.native.requestControl(controllerRequest);
        return createResponse(replay, existingSnapshot.metadata.stateRevision);
      }
      if (existingSnapshot) {
        throw new Error('Atomic Session creation target already exists.');
      }
      const prepared = commandContexts.prepareCreate(request, {
        clientId: controllerRequest.clientId,
        connectionGeneration: controllerRequest.connectionGeneration,
        workerInstanceId: adapter.workerInstanceId,
      });
      try {
        const receipt = await runtimeOwner.runtime.command(prepared.command, prepared.context);
        if (receipt.status !== 'applied' && receipt.status !== 'idempotent_replay') {
          throw new Error(`Atomic Session creation was rejected: ${receipt.code}.`);
        }
        const compound = commandContexts.finishCreate(prepared.reference);
        const revision = receipt.status === 'applied' ? receipt.revision : receipt.originalRevision;
        return createResponse(compound.controller, revision);
      } finally {
        commandContexts.discardCreate(prepared.reference);
      }
    },
    async read(request: WorkerControllerReadRequest, binding: ServiceRuntimeConnectionBinding) {
      assertBinding(binding);
      const state = adapter.observer.read(request.sessionId);
      return {
        schema: 'kite.app.worker-controller.response.v1' as const,
        operation: 'read_controller' as const,
        state: {
          sessionId: state.sessionId,
          status: state.status,
          controllerGeneration: state.controllerGeneration,
          connectionGeneration: state.connectionGeneration,
          clientId: state.clientId,
          workerInstanceId: state.workerInstanceId,
          interactionGeneration: state.interactionGeneration,
          resumeCapabilityExpiresAtMs: state.resumeCapabilityExpiresAtMs,
        },
      } satisfies WorkerControllerReadResponse;
    },
    async requestControl(
      request: WorkerControllerRequestControlRequest,
      binding: ServiceRuntimeConnectionBinding,
    ) {
      const connection = bindingRequest(binding);
      return operation(
        request,
        adapter.native.requestControl({
          ...request,
          clientId: connection.clientId,
          connectionGeneration: connection.connectionGeneration,
        }),
      );
    },
    async releaseControl(
      request: WorkerControllerReleaseControlRequest,
      binding: ServiceRuntimeConnectionBinding,
    ) {
      const connection = bindingRequest(binding);
      return operation(
        request,
        adapter.native.releaseControl({
          ...request,
          clientId: connection.clientId,
          connectionGeneration: connection.connectionGeneration,
        }),
      );
    },
    async detach(request: WorkerControllerDetachRequest, binding: ServiceRuntimeConnectionBinding) {
      const connection = bindingRequest(binding);
      return operation(
        request,
        adapter.native.detachController({
          ...request,
          clientId: connection.clientId,
          connectionGeneration: connection.connectionGeneration,
        }),
      );
    },
    async issueResumeCapability(
      request: WorkerControllerIssueResumeCapabilityRequest,
      binding: ServiceRuntimeConnectionBinding,
    ) {
      const connection = bindingRequest(binding);
      return operation(
        request,
        adapter.native.issueResumeCapability({
          ...request,
          clientId: connection.clientId,
          connectionGeneration: connection.connectionGeneration,
        }),
      );
    },
    async resume(request: WorkerControllerResumeRequest, binding: ServiceRuntimeConnectionBinding) {
      const connection = bindingRequest(binding);
      return operation(
        request,
        adapter.native.resumeController({
          ...request,
          clientId: connection.clientId,
          connectionGeneration: connection.connectionGeneration,
        }),
      );
    },
    async mintDetachedRecoveryCapability(
      request: WorkerControllerMintDetachedRecoveryRequest,
      binding: ServiceRuntimeConnectionBinding,
    ) {
      const connection = bindingRequest(binding);
      return operation(
        request,
        adapter.native.mintDetachedRecoveryCapability({
          ...request,
          clientId: connection.clientId,
          connectionGeneration: connection.connectionGeneration,
        }),
      );
    },
    async abandonDetachedController(
      request: WorkerControllerAbandonDetachedRequest,
      binding: ServiceRuntimeConnectionBinding,
    ) {
      const connection = bindingRequest(binding);
      return operation(
        request,
        adapter.native.abandonDetachedController({
          ...request,
          clientId: connection.clientId,
          connectionGeneration: connection.connectionGeneration,
        }),
      );
    },
    async validateResumeCapability(
      request: WorkerControllerValidateResumeRequest,
      binding: ServiceRuntimeConnectionBinding,
    ): Promise<WorkerControllerResumeCapabilityResponse> {
      const connection = bindingRequest(binding);
      const result = adapter.native.validateResumeCapability({
        ...request,
        clientId: connection.clientId,
      });
      return {
        schema: 'kite.app.worker-controller.response.v1',
        operation: 'validate_resume_capability',
        status: result.status,
        ...(result.status === 'valid' ? { connectionGeneration: result.connectionGeneration } : {}),
      };
    },
  });
}

function safeIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 512 && !/\p{Cc}/u.test(value)
  );
}

function positiveGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

async function drainApplication(
  application: KiteRuntimeApplication,
  runtimeOwner: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer>,
): Promise<void> {
  const lease = await application.quiesceMutations();
  await lease.commitDrain();
  await runtimeOwner.server.beginDraining();
  const sessionIds = runtimeOwner.storage.sessions
    .listSessions('', 100_000)
    .map((session) => session.threadId);
  await Promise.all(sessionIds.map((sessionId) => runtimeOwner.host.waitForSessionIdle(sessionId)));
}

function persistedWorkspace(
  runtimeOwner: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer>,
  sessionId: string,
  workspace: KiteWorkspaceIdentity,
): boolean {
  const snapshot = runtimeOwner.storage.sessions.loadSnapshot<{
    readonly session?: {
      readonly workspace?: string;
      readonly projectId?: string;
      readonly canonicalWorkspaceDigest?: string;
    };
  }>(sessionId);
  const session = snapshot?.session;
  if (
    !session ||
    session.projectId !== workspace.projectId ||
    session.canonicalWorkspaceDigest !== workspace.workspaceDigest
  ) {
    return false;
  }
  try {
    return (
      session.workspace !== undefined &&
      realpathSync.native(session.workspace) === workspace.canonicalPath
    );
  } catch {
    return false;
  }
}

function sessionIdFromRequest(input: RuntimeServerAdmissionInput): string | undefined {
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
