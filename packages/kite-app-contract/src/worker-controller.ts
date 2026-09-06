import {
  booleanValue,
  type ExactJsonCodec,
  enumValue,
  exactCodec,
  exactObject,
  integerValue,
  invalid,
  type JsonObject,
  optional,
  required,
  safeIdentifier,
  stringValue,
} from './validation';

/**
 * Native-only Worker Controller contract. This file is intentionally not exported from the
 * browser-safe package root or `./web`; consumers must opt into this subpath explicitly.
 */
export const WORKER_CONTROLLER_PATH_ = '/_kite/controller' as const;
export const WORKER_CONTROLLER_REQUEST_SCHEMA_ = 'kite.app.worker-controller.request.v1' as const;
export const WORKER_CONTROLLER_RESPONSE_SCHEMA_ = 'kite.app.worker-controller.response.v1' as const;
export const WORKER_CONTROLLER_RECEIPT_SCHEMA_ = 'kite.app.worker-controller.receipt.v1' as const;

export const WORKER_CONTROLLER_MAX_SECRET_LENGTH = 43;
export const WORKER_CONTROLLER_MAX_ABSENCE_DIGEST_LENGTH = 64;

export type WorkerControllerOperation =
  | 'read_controller'
  | 'create_session'
  | 'request_control'
  | 'release_control'
  | 'detach_controller'
  | 'issue_resume_capability'
  | 'resume_controller'
  | 'mint_detached_recovery_capability'
  | 'abandon_detached_controller'
  | 'validate_resume_capability';

export type WorkerControllerMutationOperation = Exclude<
  WorkerControllerOperation,
  'read_controller' | 'validate_resume_capability'
>;

/** Durable Store 7 Controller receipts retain request_control as their operation identity. */
export type WorkerControllerDurableOperation = Exclude<
  WorkerControllerMutationOperation,
  'create_session'
>;

export interface WorkerControllerReadRequest {
  readonly schema: typeof WORKER_CONTROLLER_REQUEST_SCHEMA_;
  readonly operation: 'read_controller';
  readonly sessionId: string;
}

export interface WorkerControllerRequestControlRequest {
  readonly schema: typeof WORKER_CONTROLLER_REQUEST_SCHEMA_;
  readonly operation: 'request_control';
  readonly sessionId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly resumeSecret: string;
  readonly resumeExpiresAtMs: number;
}

/** Native-only atomic Runtime-session + initial Controller creation request. */
export interface WorkerControllerCreateSessionRequest {
  readonly schema: typeof WORKER_CONTROLLER_REQUEST_SCHEMA_;
  readonly operation: 'create_session';
  readonly sessionId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly resumeSecret: string;
  readonly resumeExpiresAtMs: number;
}

export interface WorkerControllerReleaseControlRequest {
  readonly schema: typeof WORKER_CONTROLLER_REQUEST_SCHEMA_;
  readonly operation: 'release_control';
  readonly sessionId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly controllerGeneration: number;
}

export interface WorkerControllerDetachRequest {
  readonly schema: typeof WORKER_CONTROLLER_REQUEST_SCHEMA_;
  readonly operation: 'detach_controller';
  readonly sessionId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly controllerGeneration: number;
  readonly interactionGeneration: number;
}

export interface WorkerControllerIssueResumeCapabilityRequest {
  readonly schema: typeof WORKER_CONTROLLER_REQUEST_SCHEMA_;
  readonly operation: 'issue_resume_capability';
  readonly sessionId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly controllerGeneration: number;
  readonly secret: string;
  readonly expiresAtMs: number;
}

export interface WorkerControllerResumeRequest {
  readonly schema: typeof WORKER_CONTROLLER_REQUEST_SCHEMA_;
  readonly operation: 'resume_controller';
  readonly sessionId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly controllerGeneration: number;
  readonly currentSecret: string;
  readonly nextSecret: string;
  readonly expiresAtMs: number;
}

export interface WorkerControllerMintDetachedRecoveryRequest {
  readonly schema: typeof WORKER_CONTROLLER_REQUEST_SCHEMA_;
  readonly operation: 'mint_detached_recovery_capability';
  readonly sessionId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly expectedControllerGeneration: number;
  readonly expectedInteractionGeneration: number;
  readonly expiresAtMs: number;
  readonly connectionConfirmedAbsent: boolean;
  readonly absenceEvidenceDigest: string;
  readonly secret: string;
}

export interface WorkerControllerAbandonDetachedRequest {
  readonly schema: typeof WORKER_CONTROLLER_REQUEST_SCHEMA_;
  readonly operation: 'abandon_detached_controller';
  readonly sessionId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly expectedControllerGeneration: number;
  readonly expectedInteractionGeneration: number;
  readonly connectionConfirmedAbsent: boolean;
  readonly secret: string;
}

export interface WorkerControllerValidateResumeRequest {
  readonly schema: typeof WORKER_CONTROLLER_REQUEST_SCHEMA_;
  readonly operation: 'validate_resume_capability';
  readonly sessionId: string;
  readonly controllerGeneration: number;
  readonly secret: string;
}

export type WorkerControllerRequest =
  | WorkerControllerReadRequest
  | WorkerControllerCreateSessionRequest
  | WorkerControllerRequestControlRequest
  | WorkerControllerReleaseControlRequest
  | WorkerControllerDetachRequest
  | WorkerControllerIssueResumeCapabilityRequest
  | WorkerControllerResumeRequest
  | WorkerControllerMintDetachedRecoveryRequest
  | WorkerControllerAbandonDetachedRequest
  | WorkerControllerValidateResumeRequest;

export type WorkerControllerReceiptStatus = 'applied' | 'rejected';
export type WorkerControllerOperationStatus = 'applied' | 'replay' | 'rejected';
export type WorkerControllerLeaseStatus = 'active' | 'detached';
export type WorkerControllerStateStatus = 'idle' | WorkerControllerLeaseStatus;

export type WorkerControllerReceiptCode =
  | 'acquired'
  | 'released'
  | 'detached'
  | 'resume_capability_issued'
  | 'resumed'
  | 'detached_recovery_capability_issued'
  | 'abandoned'
  | 'controller_busy'
  | 'detached_requires_recovery'
  | 'stale_lease'
  | 'capability_invalid'
  | 'capability_expired'
  | 'capability_consumed'
  | 'recovery_generation_mismatch';

export interface WorkerControllerReceipt {
  readonly schema: typeof WORKER_CONTROLLER_RECEIPT_SCHEMA_;
  readonly sessionId: string;
  readonly requestId: string;
  readonly requestDigest: string;
  readonly operation: WorkerControllerDurableOperation;
  readonly status: WorkerControllerReceiptStatus;
  readonly code: WorkerControllerReceiptCode;
  readonly controllerGeneration: number;
  readonly connectionGeneration: number;
  readonly interactionGeneration: number;
  readonly clientId: string | null;
  readonly workerInstanceId: string | null;
  readonly completedAt: number;
}

export interface WorkerControllerLease {
  readonly sessionId: string;
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly controllerGeneration: number;
  readonly workerInstanceId: string;
  readonly status: WorkerControllerLeaseStatus;
}

export interface WorkerControllerMutationResponse {
  readonly schema: typeof WORKER_CONTROLLER_RESPONSE_SCHEMA_;
  readonly operation: WorkerControllerDurableOperation;
  readonly status: WorkerControllerOperationStatus;
  readonly receipt: WorkerControllerReceipt;
  readonly lease?: WorkerControllerLease;
}

/**
 * The wire operation is create_session while the durable Controller receipt remains the
 * Store-owned request_control receipt produced by the atomic creation port.
 */
export interface WorkerControllerCreateSessionResponse {
  readonly schema: typeof WORKER_CONTROLLER_RESPONSE_SCHEMA_;
  readonly operation: 'create_session';
  readonly status: WorkerControllerOperationStatus;
  /** The committed Runtime session revision, present for applied/replay results. */
  readonly sessionRevision?: number;
  readonly receipt: WorkerControllerReceipt;
  readonly lease?: WorkerControllerLease;
}

export type WorkerControllerOperationResponse =
  | WorkerControllerMutationResponse
  | WorkerControllerCreateSessionResponse;

export interface WorkerControllerState {
  readonly sessionId: string;
  readonly status: WorkerControllerStateStatus;
  readonly controllerGeneration: number;
  readonly connectionGeneration: number;
  readonly clientId: string | null;
  readonly workerInstanceId: string | null;
  readonly interactionGeneration: number;
  readonly resumeCapabilityExpiresAtMs: number | null;
}

export interface WorkerControllerReadResponse {
  readonly schema: typeof WORKER_CONTROLLER_RESPONSE_SCHEMA_;
  readonly operation: 'read_controller';
  readonly state: WorkerControllerState;
}

export interface WorkerControllerResumeCapabilityResponse {
  readonly schema: typeof WORKER_CONTROLLER_RESPONSE_SCHEMA_;
  readonly operation: 'validate_resume_capability';
  readonly status: 'valid' | 'invalid' | 'expired' | 'generation_mismatch' | 'missing';
  readonly connectionGeneration?: number;
}

export type WorkerControllerResponse =
  | WorkerControllerOperationResponse
  | WorkerControllerReadResponse
  | WorkerControllerResumeCapabilityResponse;

/** Narrow native client surface; no generic call or Web/Observer implementation is exposed. */
export interface WorkerControllerClient {
  createSession(
    request: WorkerControllerCreateSessionRequest,
  ): Promise<WorkerControllerCreateSessionResponse>;
  read(request: WorkerControllerReadRequest): Promise<WorkerControllerReadResponse>;
  requestControl(
    request: WorkerControllerRequestControlRequest,
  ): Promise<WorkerControllerOperationResponse>;
  releaseControl(
    request: WorkerControllerReleaseControlRequest,
  ): Promise<WorkerControllerOperationResponse>;
  detach(request: WorkerControllerDetachRequest): Promise<WorkerControllerOperationResponse>;
  issueResumeCapability(
    request: WorkerControllerIssueResumeCapabilityRequest,
  ): Promise<WorkerControllerOperationResponse>;
  resume(request: WorkerControllerResumeRequest): Promise<WorkerControllerOperationResponse>;
  mintDetachedRecoveryCapability(
    request: WorkerControllerMintDetachedRecoveryRequest,
  ): Promise<WorkerControllerOperationResponse>;
  abandonDetachedController(
    request: WorkerControllerAbandonDetachedRequest,
  ): Promise<WorkerControllerOperationResponse>;
  validateResumeCapability(
    request: WorkerControllerValidateResumeRequest,
  ): Promise<WorkerControllerResumeCapabilityResponse>;
}

export const workerControllerRequestCodec: ExactJsonCodec<WorkerControllerRequest> = exactCodec({
  schema: WORKER_CONTROLLER_REQUEST_SCHEMA_,
  decode: decodeWorkerControllerRequest,
  encode: encodeWorkerControllerRequest,
});

export const workerControllerResponseCodec: ExactJsonCodec<WorkerControllerResponse> = exactCodec({
  schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
  decode: decodeWorkerControllerResponse,
  encode: encodeWorkerControllerResponse,
});

function decodeWorkerControllerRequest(input: unknown): WorkerControllerRequest {
  const base = exactObject(
    input,
    [
      'absenceEvidenceDigest',
      'connectionConfirmedAbsent',
      'controllerGeneration',
      'currentSecret',
      'expectedControllerGeneration',
      'expectedInteractionGeneration',
      'expiresAtMs',
      'interactionGeneration',
      'nextSecret',
      'operation',
      'requestDigest',
      'requestId',
      'schema',
      'secret',
      'sessionId',
      'resumeExpiresAtMs',
      'resumeSecret',
    ],
    'WorkerControllerRequest',
  );
  assertSchema(base, WORKER_CONTROLLER_REQUEST_SCHEMA_, 'WorkerControllerRequest');
  const operation = enumValue(
    required(base, 'operation', 'WorkerControllerRequest'),
    'WorkerControllerRequest.operation',
    [
      'read_controller',
      'create_session',
      'request_control',
      'release_control',
      'detach_controller',
      'issue_resume_capability',
      'resume_controller',
      'mint_detached_recovery_capability',
      'abandon_detached_controller',
      'validate_resume_capability',
    ] as const,
  );
  const sessionId = safeIdentifier(
    required(base, 'sessionId', 'WorkerControllerRequest'),
    'WorkerControllerRequest.sessionId',
    512,
  );
  if (operation === 'read_controller') {
    exactObject(input, ['operation', 'schema', 'sessionId'], 'WorkerControllerReadRequest');
    return { schema: WORKER_CONTROLLER_REQUEST_SCHEMA_, operation, sessionId };
  }
  if (operation === 'create_session') {
    const value = exactObject(
      input,
      [
        'operation',
        'requestDigest',
        'requestId',
        'resumeExpiresAtMs',
        'resumeSecret',
        'schema',
        'sessionId',
      ],
      'WorkerControllerCreateSessionRequest',
    );
    return {
      schema: WORKER_CONTROLLER_REQUEST_SCHEMA_,
      operation,
      sessionId,
      requestId: safeIdentifier(
        required(value, 'requestId', 'WorkerControllerCreateSessionRequest'),
        'WorkerControllerCreateSessionRequest.requestId',
        512,
      ),
      requestDigest: digestValue(
        required(value, 'requestDigest', 'WorkerControllerCreateSessionRequest'),
        'WorkerControllerCreateSessionRequest.requestDigest',
      ),
      resumeSecret: secretValue(required(value, 'resumeSecret', 'WorkerControllerRequest')),
      resumeExpiresAtMs: futureTimestamp(value, 'resumeExpiresAtMs'),
    };
  }
  if (operation === 'validate_resume_capability') {
    exactObject(
      input,
      ['controllerGeneration', 'operation', 'schema', 'secret', 'sessionId'],
      'WorkerControllerValidateResumeRequest',
    );
    return {
      schema: WORKER_CONTROLLER_REQUEST_SCHEMA_,
      operation,
      sessionId,
      controllerGeneration: nonNegativeGeneration(base, 'controllerGeneration'),
      secret: secretValue(required(base, 'secret', 'WorkerControllerRequest')),
    };
  }
  const common = {
    schema: WORKER_CONTROLLER_REQUEST_SCHEMA_ as typeof WORKER_CONTROLLER_REQUEST_SCHEMA_,
    operation,
    sessionId,
    requestId: safeIdentifier(
      required(base, 'requestId', 'WorkerControllerRequest'),
      'WorkerControllerRequest.requestId',
      512,
    ),
    requestDigest: digestValue(
      required(base, 'requestDigest', 'WorkerControllerRequest'),
      'WorkerControllerRequest.requestDigest',
    ),
  } as const;
  switch (operation) {
    case 'request_control': {
      const value = exactObject(
        input,
        [
          'operation',
          'requestDigest',
          'requestId',
          'resumeExpiresAtMs',
          'resumeSecret',
          'schema',
          'sessionId',
        ],
        'WorkerControllerRequestControlRequest',
      );
      return {
        ...common,
        operation,
        resumeSecret: secretValue(required(value, 'resumeSecret', 'WorkerControllerRequest')),
        resumeExpiresAtMs: futureTimestamp(value, 'resumeExpiresAtMs'),
      };
    }
    case 'release_control': {
      const value = exactObject(
        input,
        ['controllerGeneration', 'operation', 'requestDigest', 'requestId', 'schema', 'sessionId'],
        'WorkerControllerReleaseControlRequest',
      );
      return {
        ...common,
        operation,
        controllerGeneration: nonNegativeGeneration(value, 'controllerGeneration'),
      };
    }
    case 'detach_controller': {
      const value = exactObject(
        input,
        [
          'controllerGeneration',
          'interactionGeneration',
          'operation',
          'requestDigest',
          'requestId',
          'schema',
          'sessionId',
        ],
        'WorkerControllerDetachRequest',
      );
      return {
        ...common,
        operation,
        controllerGeneration: nonNegativeGeneration(value, 'controllerGeneration'),
        interactionGeneration: nonNegativeGeneration(value, 'interactionGeneration'),
      };
    }
    case 'issue_resume_capability': {
      const value = exactObject(
        input,
        [
          'controllerGeneration',
          'expiresAtMs',
          'operation',
          'requestDigest',
          'requestId',
          'schema',
          'secret',
          'sessionId',
        ],
        'WorkerControllerIssueResumeCapabilityRequest',
      );
      return {
        ...common,
        operation,
        controllerGeneration: nonNegativeGeneration(value, 'controllerGeneration'),
        secret: secretValue(required(value, 'secret', 'WorkerControllerRequest')),
        expiresAtMs: futureTimestamp(value, 'expiresAtMs'),
      };
    }
    case 'resume_controller': {
      const value = exactObject(
        input,
        [
          'controllerGeneration',
          'currentSecret',
          'expiresAtMs',
          'nextSecret',
          'operation',
          'requestDigest',
          'requestId',
          'schema',
          'sessionId',
        ],
        'WorkerControllerResumeRequest',
      );
      return {
        ...common,
        operation,
        controllerGeneration: nonNegativeGeneration(value, 'controllerGeneration'),
        currentSecret: secretValue(required(value, 'currentSecret', 'WorkerControllerRequest')),
        nextSecret: secretValue(required(value, 'nextSecret', 'WorkerControllerRequest')),
        expiresAtMs: futureTimestamp(value, 'expiresAtMs'),
      };
    }
    case 'mint_detached_recovery_capability': {
      const value = exactObject(
        input,
        [
          'absenceEvidenceDigest',
          'connectionConfirmedAbsent',
          'expectedControllerGeneration',
          'expectedInteractionGeneration',
          'expiresAtMs',
          'operation',
          'requestDigest',
          'requestId',
          'schema',
          'secret',
          'sessionId',
        ],
        'WorkerControllerMintDetachedRecoveryRequest',
      );
      return {
        ...common,
        operation,
        expectedControllerGeneration: nonNegativeGeneration(value, 'expectedControllerGeneration'),
        expectedInteractionGeneration: nonNegativeGeneration(
          value,
          'expectedInteractionGeneration',
        ),
        expiresAtMs: futureTimestamp(value, 'expiresAtMs'),
        connectionConfirmedAbsent: booleanValue(
          required(value, 'connectionConfirmedAbsent', 'WorkerControllerRequest'),
          'WorkerControllerRequest.connectionConfirmedAbsent',
        ),
        absenceEvidenceDigest: digestValue(
          required(value, 'absenceEvidenceDigest', 'WorkerControllerRequest'),
          'WorkerControllerRequest.absenceEvidenceDigest',
        ),
        secret: secretValue(required(value, 'secret', 'WorkerControllerRequest')),
      };
    }
    case 'abandon_detached_controller': {
      const value = exactObject(
        input,
        [
          'connectionConfirmedAbsent',
          'expectedControllerGeneration',
          'expectedInteractionGeneration',
          'operation',
          'requestDigest',
          'requestId',
          'schema',
          'secret',
          'sessionId',
        ],
        'WorkerControllerAbandonDetachedRequest',
      );
      return {
        ...common,
        operation,
        expectedControllerGeneration: nonNegativeGeneration(value, 'expectedControllerGeneration'),
        expectedInteractionGeneration: nonNegativeGeneration(
          value,
          'expectedInteractionGeneration',
        ),
        connectionConfirmedAbsent: booleanValue(
          required(value, 'connectionConfirmedAbsent', 'WorkerControllerRequest'),
          'WorkerControllerRequest.connectionConfirmedAbsent',
        ),
        secret: secretValue(required(value, 'secret', 'WorkerControllerRequest')),
      };
    }
  }
}

function encodeWorkerControllerRequest(value: WorkerControllerRequest): JsonObject {
  if (value.operation === 'read_controller') {
    return { schema: value.schema, operation: value.operation, sessionId: value.sessionId };
  }
  if (value.operation === 'create_session') {
    return {
      schema: value.schema,
      operation: value.operation,
      sessionId: value.sessionId,
      requestId: value.requestId,
      requestDigest: value.requestDigest,
      resumeSecret: value.resumeSecret,
      resumeExpiresAtMs: value.resumeExpiresAtMs,
    };
  }
  if (value.operation === 'validate_resume_capability') {
    return {
      schema: value.schema,
      operation: value.operation,
      sessionId: value.sessionId,
      controllerGeneration: value.controllerGeneration,
      secret: value.secret,
    };
  }
  const base = {
    schema: value.schema,
    operation: value.operation,
    sessionId: value.sessionId,
    requestId: value.requestId,
    requestDigest: value.requestDigest,
  };
  switch (value.operation) {
    case 'request_control':
      return {
        ...base,
        resumeSecret: value.resumeSecret,
        resumeExpiresAtMs: value.resumeExpiresAtMs,
      };
    case 'release_control':
      return { ...base, controllerGeneration: value.controllerGeneration };
    case 'detach_controller':
      return {
        ...base,
        controllerGeneration: value.controllerGeneration,
        interactionGeneration: value.interactionGeneration,
      };
    case 'issue_resume_capability':
      return {
        ...base,
        controllerGeneration: value.controllerGeneration,
        secret: value.secret,
        expiresAtMs: value.expiresAtMs,
      };
    case 'resume_controller':
      return {
        ...base,
        controllerGeneration: value.controllerGeneration,
        currentSecret: value.currentSecret,
        nextSecret: value.nextSecret,
        expiresAtMs: value.expiresAtMs,
      };
    case 'mint_detached_recovery_capability':
      return {
        ...base,
        expectedControllerGeneration: value.expectedControllerGeneration,
        expectedInteractionGeneration: value.expectedInteractionGeneration,
        expiresAtMs: value.expiresAtMs,
        connectionConfirmedAbsent: value.connectionConfirmedAbsent,
        absenceEvidenceDigest: value.absenceEvidenceDigest,
        secret: value.secret,
      };
    case 'abandon_detached_controller':
      return {
        ...base,
        expectedControllerGeneration: value.expectedControllerGeneration,
        expectedInteractionGeneration: value.expectedInteractionGeneration,
        connectionConfirmedAbsent: value.connectionConfirmedAbsent,
        secret: value.secret,
      };
  }
}

function decodeWorkerControllerResponse(input: unknown): WorkerControllerResponse {
  const base = exactObject(
    input,
    [
      'connectionGeneration',
      'controllerGeneration',
      'interactionGeneration',
      'lease',
      'sessionRevision',
      'operation',
      'receipt',
      'schema',
      'state',
      'status',
    ],
    'WorkerControllerResponse',
  );
  assertSchema(base, WORKER_CONTROLLER_RESPONSE_SCHEMA_, 'WorkerControllerResponse');
  const operation = enumValue(
    required(base, 'operation', 'WorkerControllerResponse'),
    'WorkerControllerResponse.operation',
    [
      'read_controller',
      'create_session',
      'request_control',
      'release_control',
      'detach_controller',
      'issue_resume_capability',
      'resume_controller',
      'mint_detached_recovery_capability',
      'abandon_detached_controller',
      'validate_resume_capability',
    ] as const,
  );
  if (operation === 'read_controller') {
    const value = exactObject(
      input,
      ['operation', 'schema', 'state'],
      'WorkerControllerReadResponse',
    );
    return {
      schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
      operation,
      state: decodeState(required(value, 'state', 'WorkerControllerReadResponse')),
    };
  }
  if (operation === 'create_session') {
    const value = exactObject(
      input,
      ['lease', 'operation', 'receipt', 'schema', 'sessionRevision', 'status'],
      'WorkerControllerCreateSessionResponse',
    );
    const status = enumValue(
      required(value, 'status', 'WorkerControllerCreateSessionResponse'),
      'WorkerControllerCreateSessionResponse.status',
      ['applied', 'replay', 'rejected'] as const,
    );
    const receipt = decodeReceipt(
      required(value, 'receipt', 'WorkerControllerCreateSessionResponse'),
    );
    if (receipt.operation !== 'request_control') {
      invalid('WorkerControllerCreateSessionResponse.receipt.operation must be request_control.');
    }
    const lease = optional(value, 'lease');
    const sessionRevision = optional(value, 'sessionRevision');
    if (status === 'applied' || status === 'replay') {
      if (lease === undefined || sessionRevision === undefined) {
        invalid(
          'WorkerControllerCreateSessionResponse applied/replay requires lease and sessionRevision.',
        );
      }
    }
    return {
      schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
      operation,
      status,
      ...(sessionRevision === undefined
        ? {}
        : {
            sessionRevision: nonNegativeInteger(
              sessionRevision,
              'WorkerControllerCreateSessionResponse.sessionRevision',
            ),
          }),
      receipt,
      ...(lease === undefined ? {} : { lease: decodeLease(lease) }),
    };
  }
  if (operation === 'validate_resume_capability') {
    const value = exactObject(
      input,
      ['connectionGeneration', 'operation', 'schema', 'status'],
      'WorkerControllerResumeCapabilityResponse',
    );
    const status = enumValue(
      required(value, 'status', 'WorkerControllerResumeCapabilityResponse'),
      'WorkerControllerResumeCapabilityResponse.status',
      ['valid', 'invalid', 'expired', 'generation_mismatch', 'missing'] as const,
    );
    const connectionGeneration = optional(value, 'connectionGeneration');
    return {
      schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
      operation,
      status,
      ...(connectionGeneration === undefined
        ? {}
        : {
            connectionGeneration: integerValue(
              connectionGeneration,
              'WorkerControllerResumeCapabilityResponse.connectionGeneration',
              { min: 1 },
            ),
          }),
    };
  }
  const value = exactObject(
    input,
    ['lease', 'operation', 'receipt', 'schema', 'status'],
    'WorkerControllerOperationResponse',
  );
  const status = enumValue(
    required(value, 'status', 'WorkerControllerOperationResponse'),
    'WorkerControllerOperationResponse.status',
    ['applied', 'replay', 'rejected'] as const,
  );
  const lease = optional(value, 'lease');
  const receipt = decodeReceipt(required(value, 'receipt', 'WorkerControllerOperationResponse'));
  if (receipt.operation !== operation) {
    invalid('WorkerControllerOperationResponse.receipt.operation must match operation.');
  }
  return {
    schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
    operation,
    status,
    receipt,
    ...(lease === undefined ? {} : { lease: decodeLease(lease) }),
  };
}

function encodeWorkerControllerResponse(value: WorkerControllerResponse): JsonObject {
  if (value.operation === 'read_controller') {
    return { schema: value.schema, operation: value.operation, state: encodeState(value.state) };
  }
  if (value.operation === 'create_session') {
    return {
      schema: value.schema,
      operation: value.operation,
      status: value.status,
      receipt: encodeReceipt(value.receipt),
      ...(value.sessionRevision === undefined ? {} : { sessionRevision: value.sessionRevision }),
      ...(value.lease === undefined ? {} : { lease: encodeLease(value.lease) }),
    };
  }
  if (value.operation === 'validate_resume_capability') {
    return {
      schema: value.schema,
      operation: value.operation,
      status: value.status,
      ...(value.connectionGeneration === undefined
        ? {}
        : { connectionGeneration: value.connectionGeneration }),
    };
  }
  return {
    schema: value.schema,
    operation: value.operation,
    status: value.status,
    receipt: encodeReceipt(value.receipt),
    ...(value.lease === undefined ? {} : { lease: encodeLease(value.lease) }),
  };
}

function decodeReceipt(input: unknown): WorkerControllerReceipt {
  const value = exactObject(
    input,
    [
      'clientId',
      'code',
      'completedAt',
      'connectionGeneration',
      'controllerGeneration',
      'interactionGeneration',
      'operation',
      'requestDigest',
      'requestId',
      'schema',
      'sessionId',
      'status',
      'workerInstanceId',
    ],
    'WorkerControllerReceipt',
  );
  assertSchema(value, WORKER_CONTROLLER_RECEIPT_SCHEMA_, 'WorkerControllerReceipt');
  return {
    schema: WORKER_CONTROLLER_RECEIPT_SCHEMA_,
    sessionId: safeIdentifier(
      required(value, 'sessionId', 'WorkerControllerReceipt'),
      'sessionId',
      512,
    ),
    requestId: safeIdentifier(
      required(value, 'requestId', 'WorkerControllerReceipt'),
      'requestId',
      512,
    ),
    requestDigest: digestValue(
      required(value, 'requestDigest', 'WorkerControllerReceipt'),
      'requestDigest',
    ),
    operation: enumValue(
      required(value, 'operation', 'WorkerControllerReceipt'),
      'WorkerControllerReceipt.operation',
      [
        'request_control',
        'release_control',
        'detach_controller',
        'issue_resume_capability',
        'resume_controller',
        'mint_detached_recovery_capability',
        'abandon_detached_controller',
      ] as const,
    ),
    status: enumValue(
      required(value, 'status', 'WorkerControllerReceipt'),
      'WorkerControllerReceipt.status',
      ['applied', 'rejected'] as const,
    ),
    code: enumValue(
      required(value, 'code', 'WorkerControllerReceipt'),
      'WorkerControllerReceipt.code',
      [
        'acquired',
        'released',
        'detached',
        'resume_capability_issued',
        'resumed',
        'detached_recovery_capability_issued',
        'abandoned',
        'controller_busy',
        'detached_requires_recovery',
        'stale_lease',
        'capability_invalid',
        'capability_expired',
        'capability_consumed',
        'recovery_generation_mismatch',
      ] as const,
    ),
    controllerGeneration: nonNegativeInteger(
      required(value, 'controllerGeneration', 'WorkerControllerReceipt'),
      'WorkerControllerReceipt.controllerGeneration',
    ),
    connectionGeneration: nonNegativeInteger(
      required(value, 'connectionGeneration', 'WorkerControllerReceipt'),
      'WorkerControllerReceipt.connectionGeneration',
    ),
    interactionGeneration: nonNegativeInteger(
      required(value, 'interactionGeneration', 'WorkerControllerReceipt'),
      'WorkerControllerReceipt.interactionGeneration',
    ),
    clientId: nullableIdentifier(value.clientId, 'WorkerControllerReceipt.clientId'),
    workerInstanceId: nullableIdentifier(
      value.workerInstanceId,
      'WorkerControllerReceipt.workerInstanceId',
    ),
    completedAt: nonNegativeInteger(
      required(value, 'completedAt', 'WorkerControllerReceipt'),
      'WorkerControllerReceipt.completedAt',
    ),
  };
}

function encodeReceipt(value: WorkerControllerReceipt): JsonObject {
  return {
    schema: value.schema,
    sessionId: value.sessionId,
    requestId: value.requestId,
    requestDigest: value.requestDigest,
    operation: value.operation,
    status: value.status,
    code: value.code,
    controllerGeneration: value.controllerGeneration,
    connectionGeneration: value.connectionGeneration,
    interactionGeneration: value.interactionGeneration,
    clientId: value.clientId,
    workerInstanceId: value.workerInstanceId,
    completedAt: value.completedAt,
  };
}

function decodeLease(input: unknown): WorkerControllerLease {
  const value = exactObject(
    input,
    [
      'clientId',
      'connectionGeneration',
      'controllerGeneration',
      'sessionId',
      'status',
      'workerInstanceId',
    ],
    'WorkerControllerLease',
  );
  return {
    sessionId: safeIdentifier(
      required(value, 'sessionId', 'WorkerControllerLease'),
      'sessionId',
      512,
    ),
    clientId: safeIdentifier(required(value, 'clientId', 'WorkerControllerLease'), 'clientId', 512),
    connectionGeneration: positiveInteger(
      required(value, 'connectionGeneration', 'WorkerControllerLease'),
      'WorkerControllerLease.connectionGeneration',
    ),
    controllerGeneration: nonNegativeInteger(
      required(value, 'controllerGeneration', 'WorkerControllerLease'),
      'WorkerControllerLease.controllerGeneration',
    ),
    workerInstanceId: safeIdentifier(
      required(value, 'workerInstanceId', 'WorkerControllerLease'),
      'workerInstanceId',
      512,
    ),
    status: enumValue(required(value, 'status', 'WorkerControllerLease'), 'status', [
      'active',
      'detached',
    ] as const),
  };
}

function encodeLease(value: WorkerControllerLease): JsonObject {
  return {
    sessionId: value.sessionId,
    clientId: value.clientId,
    connectionGeneration: value.connectionGeneration,
    controllerGeneration: value.controllerGeneration,
    workerInstanceId: value.workerInstanceId,
    status: value.status,
  };
}

function decodeState(input: unknown): WorkerControllerState {
  const value = exactObject(
    input,
    [
      'clientId',
      'connectionGeneration',
      'controllerGeneration',
      'interactionGeneration',
      'resumeCapabilityExpiresAtMs',
      'sessionId',
      'status',
      'workerInstanceId',
    ],
    'WorkerControllerState',
  );
  const expiry = optional(value, 'resumeCapabilityExpiresAtMs');
  return {
    sessionId: safeIdentifier(
      required(value, 'sessionId', 'WorkerControllerState'),
      'sessionId',
      512,
    ),
    status: enumValue(required(value, 'status', 'WorkerControllerState'), 'status', [
      'idle',
      'active',
      'detached',
    ] as const),
    controllerGeneration: nonNegativeInteger(
      required(value, 'controllerGeneration', 'WorkerControllerState'),
      'WorkerControllerState.controllerGeneration',
    ),
    connectionGeneration: nonNegativeInteger(
      required(value, 'connectionGeneration', 'WorkerControllerState'),
      'WorkerControllerState.connectionGeneration',
    ),
    clientId: nullableIdentifier(value.clientId, 'WorkerControllerState.clientId'),
    workerInstanceId: nullableIdentifier(
      value.workerInstanceId,
      'WorkerControllerState.workerInstanceId',
    ),
    interactionGeneration: nonNegativeInteger(
      required(value, 'interactionGeneration', 'WorkerControllerState'),
      'WorkerControllerState.interactionGeneration',
    ),
    resumeCapabilityExpiresAtMs:
      expiry === null
        ? null
        : nonNegativeInteger(expiry, 'WorkerControllerState.resumeCapabilityExpiresAtMs'),
  };
}

function encodeState(value: WorkerControllerState): JsonObject {
  return {
    sessionId: value.sessionId,
    status: value.status,
    controllerGeneration: value.controllerGeneration,
    connectionGeneration: value.connectionGeneration,
    clientId: value.clientId,
    workerInstanceId: value.workerInstanceId,
    interactionGeneration: value.interactionGeneration,
    resumeCapabilityExpiresAtMs: value.resumeCapabilityExpiresAtMs,
  };
}

function assertSchema(value: JsonObject, expected: string, label: string): void {
  if (value.schema !== expected) invalid(`${label}.schema is invalid.`);
}

function digestValue(value: unknown, label: string): string {
  const result = stringValue(value, label, { min: 64, max: 64 });
  if (!/^[a-f0-9]{64}$/u.test(result)) invalid(`${label} must be a lowercase SHA-256 digest.`);
  return result;
}

function secretValue(value: unknown): string {
  const result = stringValue(value, 'WorkerControllerRequest.secret', {
    min: WORKER_CONTROLLER_MAX_SECRET_LENGTH,
    max: WORKER_CONTROLLER_MAX_SECRET_LENGTH,
  });
  if (!/^[A-Za-z0-9_-]{43}$/u.test(result)) invalid('WorkerControllerRequest secret is invalid.');
  return result;
}

function futureTimestamp(value: JsonObject, key: string): number {
  return positiveInteger(
    required(value, key, 'WorkerControllerRequest'),
    `WorkerControllerRequest.${key}`,
  );
}

function nonNegativeGeneration(value: JsonObject, key: string): number {
  return nonNegativeInteger(
    required(value, key, 'WorkerControllerRequest'),
    `WorkerControllerRequest.${key}`,
  );
}

function positiveInteger(value: unknown, label: string): number {
  return integerValue(value, label, { min: 1 });
}

function nonNegativeInteger(value: unknown, label: string): number {
  return integerValue(value, label, { min: 0 });
}

function nullableIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : safeIdentifier(value, label, 512);
}
