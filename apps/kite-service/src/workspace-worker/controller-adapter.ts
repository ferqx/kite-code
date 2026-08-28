import type {
  SqliteWorkspaceAbandonDetachedControllerInput,
  SqliteWorkspaceAuthority,
  SqliteWorkspaceControllerLease,
  SqliteWorkspaceControllerOperationResult,
  SqliteWorkspaceControllerState,
  SqliteWorkspaceDetachControllerInput,
  SqliteWorkspaceIssueResumeCapabilityInput,
  SqliteWorkspaceMintDetachedRecoveryCapabilityInput,
  SqliteWorkspaceRecoveryState,
  SqliteWorkspaceReleaseControlInput,
  SqliteWorkspaceRequestControlInput,
  SqliteWorkspaceResumeCapabilityValidation,
  SqliteWorkspaceResumeCapabilityValidationInput,
  SqliteWorkspaceResumeControllerInput,
} from '@kite-ai/runtime-storage-sqlite';

/**
 * The application-facing view of the Store 7 controller.  It is deliberately split into an
 * observer surface and a native surface: a Web observer can be given the former without ever
 * receiving a request/release/resume/recovery or mutation-authorisation method.
 */
export interface WorkspaceWorkerControllerObserver {
  readonly read: (sessionId: string) => SqliteWorkspaceControllerState;
  readonly lease: (sessionId: string) => SqliteWorkspaceControllerLease | null;
  readonly readRecovery: (sessionId: string) => SqliteWorkspaceRecoveryState;
  readonly lookupOperation: SqliteWorkspaceAuthority['controller']['lookupOperation'];
}

/** A binding supplied by a native caller; no generation is inferred by this adapter. */
export interface WorkspaceWorkerControllerMutationBinding {
  readonly sessionId: string;
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly controllerGeneration: number;
  readonly workerInstanceId: string;
}

/**
 * Native Controller operations.  The adapter supplies only the immutable Worker instance
 * binding; client and generation facts remain explicit at every call site.
 */
export interface WorkspaceWorkerControllerNative {
  readonly requestControl: (
    input: WorkspaceWorkerRequestControlInput,
  ) => SqliteWorkspaceControllerOperationResult;
  readonly releaseControl: (
    input: WorkspaceWorkerReleaseControlInput,
  ) => SqliteWorkspaceControllerOperationResult;
  readonly detachController: (
    input: WorkspaceWorkerDetachControllerInput,
  ) => SqliteWorkspaceControllerOperationResult;
  readonly issueResumeCapability: (
    input: WorkspaceWorkerIssueResumeCapabilityInput,
  ) => SqliteWorkspaceControllerOperationResult;
  readonly resumeController: (
    input: WorkspaceWorkerResumeControllerInput,
  ) => SqliteWorkspaceControllerOperationResult;
  readonly mintDetachedRecoveryCapability: (
    input: WorkspaceWorkerMintDetachedRecoveryCapabilityInput,
  ) => SqliteWorkspaceControllerOperationResult;
  readonly abandonDetachedController: (
    input: WorkspaceWorkerAbandonDetachedControllerInput,
  ) => SqliteWorkspaceControllerOperationResult;
  readonly validateResumeCapability: (
    input: SqliteWorkspaceResumeCapabilityValidationInput,
  ) => SqliteWorkspaceResumeCapabilityValidation;
  readonly authorizeMutation: (input: WorkspaceWorkerControllerMutationBinding) => boolean;
}

/**
 * Store 7 Controller adapter owned by one foreground Worker.  This is not a second authority:
 * all calls delegate to the already-open `workspaceAuthority.controller` object and all results
 * are checked against this Worker's identity before crossing the application boundary.
 */
export interface WorkspaceWorkerControllerAdapter {
  readonly workerInstanceId: string;
  readonly observer: WorkspaceWorkerControllerObserver;
  readonly native: WorkspaceWorkerControllerNative;
}

export interface WorkspaceWorkerRequestControlInput
  extends Omit<SqliteWorkspaceRequestControlInput, 'workerInstanceId'> {}

export interface WorkspaceWorkerReleaseControlInput
  extends Omit<SqliteWorkspaceReleaseControlInput, 'workerInstanceId'> {}

export interface WorkspaceWorkerDetachControllerInput
  extends Omit<SqliteWorkspaceDetachControllerInput, 'workerInstanceId'> {}

export interface WorkspaceWorkerIssueResumeCapabilityInput
  extends Omit<SqliteWorkspaceIssueResumeCapabilityInput, 'workerInstanceId'> {}

export interface WorkspaceWorkerResumeControllerInput
  extends Omit<SqliteWorkspaceResumeControllerInput, 'workerInstanceId'> {}

export interface WorkspaceWorkerMintDetachedRecoveryCapabilityInput
  extends Omit<SqliteWorkspaceMintDetachedRecoveryCapabilityInput, 'workerInstanceId'> {}

export interface WorkspaceWorkerAbandonDetachedControllerInput
  extends Omit<SqliteWorkspaceAbandonDetachedControllerInput, 'workerInstanceId'> {}

export type WorkspaceWorkerControllerAdapterErrorCode =
  | 'invalid_binding'
  | 'observer_mutation'
  | 'authority_result_mismatch';

export class WorkspaceWorkerControllerAdapterError extends Error {
  readonly code: WorkspaceWorkerControllerAdapterErrorCode;

  constructor(code: WorkspaceWorkerControllerAdapterErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceWorkerControllerAdapterError';
    this.code = code;
  }
}

export interface WorkspaceWorkerControllerAdapterInput {
  /** The complete injected Store authority. Its controller member is the only authority used. */
  readonly authority: Pick<SqliteWorkspaceAuthority, 'controller'>;
  /** Immutable identity of the foreground Worker process. */
  readonly workerInstanceId: string;
}

export function createWorkspaceWorkerControllerAdapter(
  input: WorkspaceWorkerControllerAdapterInput,
): WorkspaceWorkerControllerAdapter {
  assertSafeIdentity(input.workerInstanceId, 'Worker instance identity');
  const controller = input.authority.controller;
  const workerInstanceId = input.workerInstanceId;

  const bound = <T extends object>(value: T): T & { readonly workerInstanceId: string } => {
    // Do not let a caller-provided worker identity silently replace the process identity.  This
    // also rejects a malicious `undefined` property instead of treating it as an omitted field.
    if (Object.hasOwn(value, 'workerInstanceId')) {
      throw new WorkspaceWorkerControllerAdapterError(
        'invalid_binding',
        'Controller operation must not provide a Worker identity.',
      );
    }
    return Object.freeze({ ...value, workerInstanceId });
  };

  const checkedResult = (
    result: SqliteWorkspaceControllerOperationResult,
    request: {
      readonly sessionId: string;
      readonly requestId: string;
      readonly requestDigest: string;
    },
  ): SqliteWorkspaceControllerOperationResult => {
    if (
      result.receipt.sessionId !== request.sessionId ||
      result.receipt.requestId !== request.requestId ||
      result.receipt.requestDigest !== request.requestDigest
    ) {
      throw new WorkspaceWorkerControllerAdapterError(
        'authority_result_mismatch',
        'Controller receipt does not match the durable request identity.',
      );
    }
    if (result.status === 'applied' || result.status === 'replay') {
      if (result.lease !== undefined && result.lease.workerInstanceId !== workerInstanceId) {
        throw new WorkspaceWorkerControllerAdapterError(
          'authority_result_mismatch',
          'Controller authority returned a different Worker identity.',
        );
      }
      if (
        result.receipt.workerInstanceId !== null &&
        result.receipt.workerInstanceId !== workerInstanceId
      ) {
        throw new WorkspaceWorkerControllerAdapterError(
          'authority_result_mismatch',
          'Controller receipt belongs to a different Worker identity.',
        );
      }
    } else if (
      result.receipt.workerInstanceId !== null &&
      result.receipt.workerInstanceId !== workerInstanceId
    ) {
      throw new WorkspaceWorkerControllerAdapterError(
        'authority_result_mismatch',
        'Controller receipt belongs to a different Worker identity.',
      );
    }
    return result;
  };

  const native: WorkspaceWorkerControllerNative = Object.freeze({
    requestControl: (request: WorkspaceWorkerRequestControlInput) => {
      assertOperationRequest(request, false);
      return checkedResult(
        controller.requestControl(bound(request) as SqliteWorkspaceRequestControlInput),
        request,
      );
    },
    releaseControl: (request: WorkspaceWorkerReleaseControlInput) => {
      assertOperationRequest(request, true);
      return checkedResult(
        controller.releaseControl(bound(request) as SqliteWorkspaceReleaseControlInput),
        request,
      );
    },
    detachController: (request: WorkspaceWorkerDetachControllerInput) => {
      assertOperationRequest(request, true);
      return checkedResult(
        controller.detachController(bound(request) as SqliteWorkspaceDetachControllerInput),
        request,
      );
    },
    issueResumeCapability: (request: WorkspaceWorkerIssueResumeCapabilityInput) => {
      assertOperationRequest(request, true);
      return checkedResult(
        controller.issueResumeCapability(
          bound(request) as SqliteWorkspaceIssueResumeCapabilityInput,
        ),
        request,
      );
    },
    resumeController: (request: WorkspaceWorkerResumeControllerInput) => {
      assertOperationRequest(request, true);
      return checkedResult(
        controller.resumeController(bound(request) as SqliteWorkspaceResumeControllerInput),
        request,
      );
    },
    mintDetachedRecoveryCapability: (
      request: WorkspaceWorkerMintDetachedRecoveryCapabilityInput,
    ) => {
      assertOperationRequest(request, true);
      return checkedResult(
        controller.mintDetachedRecoveryCapability(
          bound(request) as SqliteWorkspaceMintDetachedRecoveryCapabilityInput,
        ),
        request,
      );
    },
    abandonDetachedController: (request: WorkspaceWorkerAbandonDetachedControllerInput) => {
      assertOperationRequest(request, true);
      return checkedResult(
        controller.abandonDetachedController(
          bound(request) as SqliteWorkspaceAbandonDetachedControllerInput,
        ),
        request,
      );
    },
    validateResumeCapability: (request: SqliteWorkspaceResumeCapabilityValidationInput) =>
      controller.validateResumeCapability(request),
    authorizeMutation: (binding: WorkspaceWorkerControllerMutationBinding) => {
      assertMutationBinding(binding, workerInstanceId);
      // Store 7 currently exposes this as a synchronous read.  The adapter intentionally does
      // not turn it into an async or cached fact: Host commit callers must re-check the live
      // lease at their own commit boundary.
      const state = controller.read(binding.sessionId);
      return (
        state.status === 'active' &&
        state.clientId === binding.clientId &&
        state.connectionGeneration === binding.connectionGeneration &&
        state.controllerGeneration === binding.controllerGeneration &&
        state.workerInstanceId === workerInstanceId
      );
    },
  });

  const observer: WorkspaceWorkerControllerObserver = Object.freeze({
    read: controller.read,
    lease: controller.lease,
    readRecovery: controller.readRecovery,
    lookupOperation: controller.lookupOperation,
  });

  return Object.freeze({ workerInstanceId, observer, native });
}

function assertMutationBinding(
  value: WorkspaceWorkerControllerMutationBinding,
  workerInstanceId: string,
): void {
  if (
    !isSafeIdentity(value.sessionId) ||
    !isSafeIdentity(value.clientId) ||
    value.workerInstanceId !== workerInstanceId ||
    !isGeneration(value.connectionGeneration) ||
    !isGeneration(value.controllerGeneration)
  ) {
    throw new WorkspaceWorkerControllerAdapterError(
      'invalid_binding',
      'Controller mutation binding is invalid.',
    );
  }
}

function assertOperationRequest(
  value: {
    readonly sessionId: string;
    readonly requestId: string;
    readonly requestDigest: string;
    readonly clientId: string;
    readonly connectionGeneration: number;
    readonly controllerGeneration?: number;
  },
  needsControllerGeneration: boolean,
): void {
  if (
    !isSafeIdentity(value.sessionId) ||
    !isSafeIdentity(value.requestId) ||
    !/^[a-f0-9]{64}$/u.test(value.requestDigest) ||
    !isSafeIdentity(value.clientId) ||
    !isGeneration(value.connectionGeneration) ||
    (needsControllerGeneration && !isNonNegativeGeneration(value.controllerGeneration))
  ) {
    throw new WorkspaceWorkerControllerAdapterError(
      'invalid_binding',
      'Controller operation request is invalid.',
    );
  }
}

function assertSafeIdentity(value: string, label: string): void {
  if (!isSafeIdentity(value)) {
    throw new WorkspaceWorkerControllerAdapterError('invalid_binding', `${label} is invalid.`);
  }
}

function isSafeIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 512 && !/\p{Cc}/u.test(value)
  );
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isNonNegativeGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
