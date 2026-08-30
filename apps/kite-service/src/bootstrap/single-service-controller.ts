import type { KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import type {
  WorkerControllerCreateSessionRequest,
  WorkerControllerCreateSessionResponse,
  WorkerControllerOperationResponse,
  WorkerControllerReadResponse,
  WorkerControllerResumeCapabilityResponse,
} from '@kite-ai/kite-app-contract/worker-controller';
import type { RuntimeAccess } from '@kite-ai/runtime-contract';
import type { RuntimeStorage } from '@kite-ai/runtime-host/storage';
import type { SqliteWorkspaceAuthority } from '@kite-ai/runtime-storage-sqlite';
import type {
  ServiceControllerPort,
  ServiceRuntimeConnectionBinding,
  ServiceWorkspaceAdmissionPort,
} from '../carrier/ports';
import { createWorkspaceWorkerControllerAdapter } from '../workspace-worker/controller-adapter';
import type { RuntimeEvent, RuntimeState } from './runtime/state-runtime';
import type { KiteSingleServiceSessionCreationCoordinator } from './single-service-session-creation';

/** Store 9 Controller routes for the one Service; no Worker process or second authority exists. */
export function createSingleServiceControllerPort(input: {
  readonly serviceInstanceId: string;
  readonly runtime: RuntimeAccess;
  readonly storage: RuntimeStorage<RuntimeEvent, RuntimeState>;
  readonly sessionCreation: KiteSingleServiceSessionCreationCoordinator;
  readonly workspaceAdmission: ServiceWorkspaceAdmissionPort;
  readonly authorityForWorkspace: (workspace: KiteWorkspaceIdentity) => SqliteWorkspaceAuthority;
  readonly workspaceForSession: (sessionId: string) => KiteWorkspaceIdentity | undefined;
}): ServiceControllerPort {
  const adapterForWorkspace = (workspace: KiteWorkspaceIdentity) =>
    createWorkspaceWorkerControllerAdapter({
      authority: input.authorityForWorkspace(workspace),
      workerInstanceId: input.serviceInstanceId,
    });
  const adapterForSession = (sessionId: string) => {
    const workspace = input.workspaceForSession(sessionId);
    if (!workspace) throw new Error('Controller Session Workspace is unavailable.');
    return adapterForWorkspace(workspace);
  };
  const bindingRequest = (binding: ServiceRuntimeConnectionBinding) => {
    if (
      binding.workerInstanceId !== input.serviceInstanceId ||
      !safeIdentity(binding.clientId) ||
      !positiveGeneration(binding.connectionGeneration)
    ) {
      throw new Error('Native Controller connection binding is invalid.');
    }
    return { clientId: binding.clientId, connectionGeneration: binding.connectionGeneration };
  };

  return Object.freeze({
    async createSession(
      request: WorkerControllerCreateSessionRequest,
      binding: ServiceRuntimeConnectionBinding,
    ): Promise<WorkerControllerCreateSessionResponse> {
      const connection = bindingRequest(binding);
      if (!binding.requestedWorkspace) {
        throw new Error('Controller create requires a Workspace admission request.');
      }
      const admitted = await input.workspaceAdmission.admitForConnect(binding.requestedWorkspace);
      if (admitted.outcome !== 'admitted') {
        throw new Error('Controller create Workspace is not admitted.');
      }
      const adapter = adapterForWorkspace(admitted.workspace);
      const snapshot = input.storage.sessions.loadSnapshotRecord<RuntimeState>(request.sessionId);
      const existing = snapshot
        ? adapter.observer.lookupOperation(request.sessionId, request.requestId)
        : null;
      if (existing && snapshot) {
        return createResponse(
          adapter.native.requestControl({
            ...request,
            clientId: connection.clientId,
            connectionGeneration: connection.connectionGeneration,
          }),
          snapshot.metadata.stateRevision,
        );
      }
      if (snapshot) throw new Error('Atomic Session creation target already exists.');
      const prepared = input.sessionCreation.prepare(
        request,
        {
          clientId: connection.clientId,
          connectionGeneration: connection.connectionGeneration,
          workerInstanceId: input.serviceInstanceId,
        },
        admitted.workspace,
      );
      try {
        const receipt = await input.runtime.command(prepared.command, prepared.context);
        if (receipt.status !== 'applied' && receipt.status !== 'idempotent_replay') {
          throw new Error(`Atomic Session creation was rejected: ${receipt.code}.`);
        }
        const compound = input.sessionCreation.finish(prepared.reference);
        const revision = receipt.status === 'applied' ? receipt.revision : receipt.originalRevision;
        return createResponse(compound.controller, revision);
      } finally {
        input.sessionCreation.discard(prepared.reference);
      }
    },
    async read(request, binding): Promise<WorkerControllerReadResponse> {
      bindingRequest(binding);
      const state = adapterForSession(request.sessionId).observer.read(request.sessionId);
      return {
        schema: 'kite.app.worker-controller.response.v1',
        operation: 'read_controller',
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
      };
    },
    async requestControl(request, binding) {
      const connection = bindingRequest(binding);
      return operation(
        request.operation,
        adapterForSession(request.sessionId).native.requestControl({
          ...request,
          ...connection,
        }),
      );
    },
    async releaseControl(request, binding) {
      const connection = bindingRequest(binding);
      return operation(
        request.operation,
        adapterForSession(request.sessionId).native.releaseControl({
          ...request,
          ...connection,
        }),
      );
    },
    async detach(request, binding) {
      const connection = bindingRequest(binding);
      return operation(
        request.operation,
        adapterForSession(request.sessionId).native.detachController({
          ...request,
          ...connection,
        }),
      );
    },
    async issueResumeCapability(request, binding) {
      const connection = bindingRequest(binding);
      return operation(
        request.operation,
        adapterForSession(request.sessionId).native.issueResumeCapability({
          ...request,
          ...connection,
        }),
      );
    },
    async resume(request, binding) {
      const connection = bindingRequest(binding);
      return operation(
        request.operation,
        adapterForSession(request.sessionId).native.resumeController({
          ...request,
          ...connection,
        }),
      );
    },
    async mintDetachedRecoveryCapability(request, binding) {
      const connection = bindingRequest(binding);
      return operation(
        request.operation,
        adapterForSession(request.sessionId).native.mintDetachedRecoveryCapability({
          ...request,
          ...connection,
        }),
      );
    },
    async abandonDetachedController(request, binding) {
      const connection = bindingRequest(binding);
      return operation(
        request.operation,
        adapterForSession(request.sessionId).native.abandonDetachedController({
          ...request,
          ...connection,
        }),
      );
    },
    async validateResumeCapability(
      request,
      binding,
    ): Promise<WorkerControllerResumeCapabilityResponse> {
      const connection = bindingRequest(binding);
      const result = adapterForSession(request.sessionId).native.validateResumeCapability({
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
  } satisfies ServiceControllerPort);
}

function createResponse(
  result: ReturnType<
    ReturnType<typeof createWorkspaceWorkerControllerAdapter>['native']['requestControl']
  >,
  sessionRevision: number,
): WorkerControllerCreateSessionResponse {
  const mapped = operation('request_control', result);
  if (
    (mapped.status !== 'applied' && mapped.status !== 'replay') ||
    mapped.lease?.status !== 'active' ||
    !Number.isSafeInteger(sessionRevision) ||
    sessionRevision < 0
  ) {
    throw new Error('Atomic Session creation did not return durable Controller authority.');
  }
  return { ...mapped, operation: 'create_session', sessionRevision };
}

function operation(
  operationName: WorkerControllerOperationResponse['operation'],
  result: ReturnType<
    ReturnType<typeof createWorkspaceWorkerControllerAdapter>['native']['requestControl']
  >,
): WorkerControllerOperationResponse {
  const lease = result.status === 'rejected' ? undefined : result.lease;
  return {
    schema: 'kite.app.worker-controller.response.v1',
    operation: operationName,
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
    ...(lease
      ? {
          lease: {
            sessionId: lease.sessionId,
            clientId: lease.clientId,
            connectionGeneration: lease.connectionGeneration,
            controllerGeneration: lease.controllerGeneration,
            workerInstanceId: lease.workerInstanceId,
            status: lease.status,
          },
        }
      : {}),
  };
}

function safeIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 512 && !/\p{Cc}/u.test(value)
  );
}

function positiveGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}
