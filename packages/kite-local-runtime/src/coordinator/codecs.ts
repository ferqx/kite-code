import { assertProtocolJsonValue } from '@kite-ai/runtime-protocol';
import { z } from 'zod';

/**
 * The Coordinator protocol is deliberately smaller than Runtime Protocol.  It
 * carries routing and lifecycle facts only; Runtime commands, events, model
 * output, tool output, interaction input, and credentials do not have a place
 * in these schemas.
 */
export const COORDINATOR_PROTOCOL_VERSION = 1 as const;
export const COORDINATOR_PROTOCOL_SCHEMA_ = 'kite.local-coordinator-frame.v1' as const;
export const COORDINATOR_HANDSHAKE_SCHEMA_ = 'kite.local-coordinator-handshake.v1' as const;
export const COORDINATOR_ENDPOINT_SCHEMA_ = 'kite.local-coordinator-endpoint.v1' as const;
export const COORDINATOR_PROTOCOL_REVISION_ = 'kite-local-coordinator-protocol-v3' as const;
export const COORDINATOR_CLIENT_CONTRACT_REVISION_ = 'kite-local-coordinator-client-v3' as const;

export const COORDINATOR_LIMITS = Object.freeze({
  maxFrameBytes: 64 * 1024,
  maxDepth: 12,
  maxIdentifierLength: 256,
  maxRequestIdLength: 128,
  maxIdempotencyKeyLength: 128,
  maxDeadlineMs: 120_000,
  maxPageSize: 200,
  maxDirectoryEntries: 200,
  maxCapabilityBytes: 1_024,
} as const);

export const COORDINATOR_METHODS = Object.freeze([
  'status',
  'resolveWorkspaceWorker',
  'ensureWorkspaceWorker',
  'resolveSessionWorkspace',
  'listSessionMetadata',
  'mintWorkerConnectionCapability',
  'ensureWebGateway',
  'discoverWebGateway',
  'stopWebGateway',
  'stopCoordinator',
  'subscribeDirectoryChanges',
] as const);

export type CoordinatorMethod = (typeof COORDINATOR_METHODS)[number];

export const COORDINATOR_WORKER_CAPABILITY_PURPOSES = Object.freeze([
  'native_client',
  'web_observer',
  'agent_api_observer',
  'agent_api_controller',
] as const);
export type CoordinatorWorkerCapabilityPurpose =
  (typeof COORDINATOR_WORKER_CAPABILITY_PURPOSES)[number];
const workerCapabilityPurpose = z.enum(COORDINATOR_WORKER_CAPABILITY_PURPOSES);

export class CoordinatorValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'CoordinatorValidationError';
  }
}

const requestId = z
  .string()
  .min(1)
  .max(COORDINATOR_LIMITS.maxRequestIdLength)
  .refine((value) => ![...value].some((character) => /\p{Cc}/u.test(character)), {
    message: 'Coordinator request ID contains a control character',
  });

const idempotencyKey = z
  .string()
  .min(1)
  .max(COORDINATOR_LIMITS.maxIdempotencyKeyLength)
  .refine((value) => ![...value].some((character) => /\p{Cc}/u.test(character)), {
    message: 'Coordinator idempotency key contains a control character',
  });

const deadlineMs = z.number().int().min(1).max(COORDINATOR_LIMITS.maxDeadlineMs);

const boundedText = z
  .string()
  .min(1)
  .max(COORDINATOR_LIMITS.maxIdentifierLength)
  .refine((value) => ![...value].some((character) => /\p{Cc}/u.test(character)), {
    message: 'Coordinator text contains a control character',
  });

const workspaceDigest = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u, 'expected a canonical Workspace SHA-256 digest');
const absolutePath = boundedText.refine(
  (value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value),
  'workspace path must be absolute',
);
const capability = z
  .string()
  .min(32)
  .max(COORDINATOR_LIMITS.maxCapabilityBytes)
  .regex(/^[A-Za-z0-9_-]+$/u, 'capability must use the bounded base64url alphabet');
const revision = boundedText;
const generation = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

const workspaceIdentitySchema = z
  .object({
    canonicalPath: absolutePath,
    projectId: boundedText,
    workspaceDigest,
  })
  .strict();
export type CoordinatorWorkspaceIdentity = z.infer<typeof workspaceIdentitySchema>;
export const COORDINATOR_WORKSPACE_IDENTITY_SCHEMA = workspaceIdentitySchema;

const osIdentitySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('posix_uid'),
      uid: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z
    .object({
      kind: z.literal('windows_sid'),
      sid: z
        .string()
        .min(3)
        .max(256)
        .regex(/^S-\d-(?:\d+-){1,15}\d+$/u, 'invalid Windows SID'),
    })
    .strict(),
]);
export type CoordinatorOsIdentity = z.infer<typeof osIdentitySchema>;
export const COORDINATOR_OS_IDENTITY_SCHEMA = osIdentitySchema;

const processIdentityBase = {
  instanceId: boundedText,
  buildId: boundedText,
  protocolVersion: z.literal(COORDINATOR_PROTOCOL_VERSION),
  protocolRevision: z.literal(COORDINATOR_PROTOCOL_REVISION_),
  clientContractRevision: z.literal(COORDINATOR_CLIENT_CONTRACT_REVISION_),
} as const;

const coordinatorIdentitySchema = z
  .object({
    role: z.literal('coordinator'),
    ...processIdentityBase,
  })
  .strict();
const workerIdentitySchema = z
  .object({
    role: z.literal('worker'),
    workerScopeId: boundedText,
    ...processIdentityBase,
  })
  .strict();
const webGatewayIdentitySchema = z
  .object({
    role: z.literal('web_gateway'),
    ...processIdentityBase,
  })
  .strict();
const clientIdentitySchema = z
  .object({
    role: z.literal('client'),
    ...processIdentityBase,
  })
  .strict();

const processIdentitySchema = z.discriminatedUnion('role', [
  coordinatorIdentitySchema,
  workerIdentitySchema,
  webGatewayIdentitySchema,
  clientIdentitySchema,
]);

export type CoordinatorIdentity = z.infer<typeof coordinatorIdentitySchema>;
export type CoordinatorWorkerIdentity = z.infer<typeof workerIdentitySchema>;
export type CoordinatorWebGatewayIdentity = z.infer<typeof webGatewayIdentitySchema>;
export type CoordinatorClientIdentity = z.infer<typeof clientIdentitySchema>;
export type CoordinatorProcessIdentity = z.infer<typeof processIdentitySchema>;
export const COORDINATOR_IDENTITY_SCHEMA = coordinatorIdentitySchema;
export const COORDINATOR_WORKER_IDENTITY_SCHEMA = workerIdentitySchema;
export const COORDINATOR_WEB_GATEWAY_IDENTITY_SCHEMA = webGatewayIdentitySchema;
export const COORDINATOR_CLIENT_IDENTITY_SCHEMA = clientIdentitySchema;
export const COORDINATOR_PROCESS_IDENTITY_SCHEMA = processIdentitySchema;

const peerIdentitySchema = z.discriminatedUnion('role', [
  clientIdentitySchema,
  workerIdentitySchema,
  webGatewayIdentitySchema,
]);
export type CoordinatorPeerIdentity = z.infer<typeof peerIdentitySchema>;
export const COORDINATOR_PEER_IDENTITY_SCHEMA = peerIdentitySchema;

const endpointDescriptorSchema = z.discriminatedUnion('transport', [
  z
    .object({
      schema: z.literal(COORDINATOR_ENDPOINT_SCHEMA_),
      transport: z.literal('unix_socket'),
      protection: z.literal('owner_only'),
      endpointId: boundedText,
      owner: z
        .object({
          kind: z.literal('posix_uid'),
          uid: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
        })
        .strict(),
      coordinator: coordinatorIdentitySchema,
    })
    .strict(),
  z
    .object({
      schema: z.literal(COORDINATOR_ENDPOINT_SCHEMA_),
      transport: z.literal('named_pipe'),
      protection: z.literal('current_user'),
      endpointId: boundedText,
      owner: z
        .object({
          kind: z.literal('windows_sid'),
          sid: z
            .string()
            .min(3)
            .max(256)
            .regex(/^S-\d-(?:\d+-){1,15}\d+$/u, 'invalid Windows SID'),
        })
        .strict(),
      coordinator: coordinatorIdentitySchema,
    })
    .strict(),
]);
export type CoordinatorEndpointDescriptor = z.infer<typeof endpointDescriptorSchema>;
export const COORDINATOR_ENDPOINT_DESCRIPTOR_SCHEMA = endpointDescriptorSchema;

const loopbackOrigin = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => /^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(value),
    'endpoint must be an IPv4 loopback HTTP origin',
  );
const loopbackWebSocket = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => /^ws:\/\/127\.0\.0\.1:\d{1,5}\/rpc$/u.test(value),
    'endpoint must be an IPv4 loopback /rpc WebSocket URL',
  );

const workerEndpointSchema = z
  .object({ origin: loopbackOrigin, websocketUrl: loopbackWebSocket })
  .strict();
export type CoordinatorWorkerEndpoint = z.infer<typeof workerEndpointSchema>;
export const COORDINATOR_WORKER_ENDPOINT_SCHEMA = workerEndpointSchema;

const webGatewayEndpointSchema = z.object({ origin: loopbackOrigin }).strict();
export type CoordinatorWebGatewayEndpoint = z.infer<typeof webGatewayEndpointSchema>;
export const COORDINATOR_WEB_GATEWAY_ENDPOINT_SCHEMA = webGatewayEndpointSchema;

const workerReferenceSchema = z
  .object({
    identity: workerIdentitySchema,
    workspace: workspaceIdentitySchema,
    endpoint: workerEndpointSchema,
  })
  .strict();
export type CoordinatorWorkerReference = z.infer<typeof workerReferenceSchema>;

const webGatewayReferenceSchema = z
  .object({
    identity: webGatewayIdentitySchema,
    endpoint: webGatewayEndpointSchema,
  })
  .strict();
export type CoordinatorWebGatewayReference = z.infer<typeof webGatewayReferenceSchema>;

const sessionMetadataSchema = z
  .object({
    sessionId: boundedText,
    workerScopeId: boundedText,
    directoryRevision: revision,
    updatedAt: z.iso.datetime({ offset: true }),
    tombstone: z.boolean(),
  })
  .strict();
export type CoordinatorSessionMetadata = z.infer<typeof sessionMetadataSchema>;
export const COORDINATOR_SESSION_METADATA_SCHEMA = sessionMetadataSchema;

const emptyParams = z.object({}).strict();
const statusParams = emptyParams;
const workspaceParams = z.object({ workspace: workspaceIdentitySchema }).strict();
const resolveSessionWorkspaceParams = z.object({ sessionId: boundedText }).strict();
const listSessionMetadataParams = z
  .object({
    workspace: workspaceIdentitySchema.optional(),
    cursor: boundedText.optional(),
    limit: z.number().int().min(1).max(COORDINATOR_LIMITS.maxPageSize).optional(),
  })
  .strict();
const mintWorkerConnectionCapabilityParams = z
  .object({
    workspace: workspaceIdentitySchema,
    workerScopeId: boundedText,
    clientId: boundedText,
    connectionGeneration: generation,
    purpose: workerCapabilityPurpose,
  })
  .strict();
const subscribeDirectoryChangesParams = z
  .object({
    workspace: workspaceIdentitySchema.optional(),
    cursor: boundedText.optional(),
  })
  .strict();

const coordinatorRequestFrameSchema = z.discriminatedUnion('method', [
  z
    .object({
      schema: z.literal(COORDINATOR_PROTOCOL_SCHEMA_),
      kind: z.literal('request'),
      protocolVersion: z.literal(COORDINATOR_PROTOCOL_VERSION),
      requestId,
      idempotencyKey,
      deadlineMs,
      method: z.literal('status'),
      params: statusParams,
    })
    .strict(),
  z
    .object({
      schema: z.literal(COORDINATOR_PROTOCOL_SCHEMA_),
      kind: z.literal('request'),
      protocolVersion: z.literal(COORDINATOR_PROTOCOL_VERSION),
      requestId,
      idempotencyKey,
      deadlineMs,
      method: z.literal('resolveWorkspaceWorker'),
      params: workspaceParams,
    })
    .strict(),
  z
    .object({
      schema: z.literal(COORDINATOR_PROTOCOL_SCHEMA_),
      kind: z.literal('request'),
      protocolVersion: z.literal(COORDINATOR_PROTOCOL_VERSION),
      requestId,
      idempotencyKey,
      deadlineMs,
      method: z.literal('ensureWorkspaceWorker'),
      params: workspaceParams,
    })
    .strict(),
  z
    .object({
      schema: z.literal(COORDINATOR_PROTOCOL_SCHEMA_),
      kind: z.literal('request'),
      protocolVersion: z.literal(COORDINATOR_PROTOCOL_VERSION),
      requestId,
      idempotencyKey,
      deadlineMs,
      method: z.literal('resolveSessionWorkspace'),
      params: resolveSessionWorkspaceParams,
    })
    .strict(),
  z
    .object({
      schema: z.literal(COORDINATOR_PROTOCOL_SCHEMA_),
      kind: z.literal('request'),
      protocolVersion: z.literal(COORDINATOR_PROTOCOL_VERSION),
      requestId,
      idempotencyKey,
      deadlineMs,
      method: z.literal('listSessionMetadata'),
      params: listSessionMetadataParams,
    })
    .strict(),
  z
    .object({
      schema: z.literal(COORDINATOR_PROTOCOL_SCHEMA_),
      kind: z.literal('request'),
      protocolVersion: z.literal(COORDINATOR_PROTOCOL_VERSION),
      requestId,
      idempotencyKey,
      deadlineMs,
      method: z.literal('mintWorkerConnectionCapability'),
      params: mintWorkerConnectionCapabilityParams,
    })
    .strict(),
  z
    .object({
      schema: z.literal(COORDINATOR_PROTOCOL_SCHEMA_),
      kind: z.literal('request'),
      protocolVersion: z.literal(COORDINATOR_PROTOCOL_VERSION),
      requestId,
      idempotencyKey,
      deadlineMs,
      method: z.literal('ensureWebGateway'),
      params: emptyParams,
    })
    .strict(),
  z
    .object({
      schema: z.literal(COORDINATOR_PROTOCOL_SCHEMA_),
      kind: z.literal('request'),
      protocolVersion: z.literal(COORDINATOR_PROTOCOL_VERSION),
      requestId,
      idempotencyKey,
      deadlineMs,
      method: z.literal('discoverWebGateway'),
      params: emptyParams,
    })
    .strict(),
  z
    .object({
      schema: z.literal(COORDINATOR_PROTOCOL_SCHEMA_),
      kind: z.literal('request'),
      protocolVersion: z.literal(COORDINATOR_PROTOCOL_VERSION),
      requestId,
      idempotencyKey,
      deadlineMs,
      method: z.literal('stopWebGateway'),
      params: emptyParams,
    })
    .strict(),
  z
    .object({
      schema: z.literal(COORDINATOR_PROTOCOL_SCHEMA_),
      kind: z.literal('request'),
      protocolVersion: z.literal(COORDINATOR_PROTOCOL_VERSION),
      requestId,
      idempotencyKey,
      deadlineMs,
      method: z.literal('stopCoordinator'),
      params: emptyParams,
    })
    .strict(),
  z
    .object({
      schema: z.literal(COORDINATOR_PROTOCOL_SCHEMA_),
      kind: z.literal('request'),
      protocolVersion: z.literal(COORDINATOR_PROTOCOL_VERSION),
      requestId,
      idempotencyKey,
      deadlineMs,
      method: z.literal('subscribeDirectoryChanges'),
      params: subscribeDirectoryChangesParams,
    })
    .strict(),
]);

export type CoordinatorStatusParams = z.infer<typeof statusParams>;
export type CoordinatorWorkspaceParams = z.infer<typeof workspaceParams>;
export type CoordinatorResolveSessionWorkspaceParams = z.infer<
  typeof resolveSessionWorkspaceParams
>;
export type CoordinatorListSessionMetadataParams = z.infer<typeof listSessionMetadataParams>;
export type CoordinatorMintWorkerConnectionCapabilityParams = z.infer<
  typeof mintWorkerConnectionCapabilityParams
>;
export type CoordinatorSubscribeDirectoryChangesParams = z.infer<
  typeof subscribeDirectoryChangesParams
>;
export type CoordinatorRequestFrame = z.infer<typeof coordinatorRequestFrameSchema>;
export const COORDINATOR_REQUEST_FRAME_SCHEMA = coordinatorRequestFrameSchema;

const coordinatorStatusResultSchema = z
  .object({
    state: z.enum(['starting', 'ready', 'reconciling', 'draining']),
    identity: coordinatorIdentitySchema,
    directoryRevision: revision.optional(),
  })
  .strict();
const workerResultSchema = z.object({ worker: workerReferenceSchema.nullable() }).strict();
const sessionWorkspaceResultSchema = z
  .object({
    workerScopeId: boundedText,
    workspace: workspaceIdentitySchema,
    worker: workerReferenceSchema.nullable(),
  })
  .strict();
const listSessionMetadataResultSchema = z
  .object({
    entries: z.array(sessionMetadataSchema).max(COORDINATOR_LIMITS.maxDirectoryEntries),
    nextCursor: boundedText.optional(),
  })
  .strict();
const mintWorkerConnectionCapabilityResultSchema = z
  .object({
    worker: workerReferenceSchema,
    clientId: boundedText,
    connectionGeneration: generation,
    purpose: workerCapabilityPurpose,
    workerConnectionCapability: capability,
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
const webLaunchUrl = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) => /^http:\/\/127\.0\.0\.1:\d{1,5}\/#[-_A-Za-z0-9]{43}$/u.test(value),
    'Web launch URL must carry one bounded fragment token',
  );
const webGatewayResultSchema = z
  .object({ gateway: webGatewayReferenceSchema.nullable(), launchUrl: webLaunchUrl.optional() })
  .strict()
  .superRefine((value, context) => {
    if ((value.gateway === null) === (value.launchUrl !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['launchUrl'],
        message: 'A live Web Gateway result must contain exactly one launch URL',
      });
    }
  });
const subscribeDirectoryChangesResultSchema = z
  .object({
    subscriptionId: boundedText,
    directoryRevision: revision,
  })
  .strict();
const coordinatorStopResultSchema = z.object({ state: z.literal('draining') }).strict();

export type CoordinatorStatusResult = z.infer<typeof coordinatorStatusResultSchema>;
export type CoordinatorWorkerResult = z.infer<typeof workerResultSchema>;
export type CoordinatorSessionWorkspaceResult = z.infer<typeof sessionWorkspaceResultSchema>;
export type CoordinatorListSessionMetadataResult = z.infer<typeof listSessionMetadataResultSchema>;
export type CoordinatorMintWorkerConnectionCapabilityResult = z.infer<
  typeof mintWorkerConnectionCapabilityResultSchema
>;
export type CoordinatorWebGatewayResult = z.infer<typeof webGatewayResultSchema>;
export type CoordinatorStopResult = z.infer<typeof coordinatorStopResultSchema>;
export type CoordinatorSubscribeDirectoryChangesResult = z.infer<
  typeof subscribeDirectoryChangesResultSchema
>;

const coordinatorResultSchemas = {
  status: coordinatorStatusResultSchema,
  resolveWorkspaceWorker: workerResultSchema,
  ensureWorkspaceWorker: workerResultSchema,
  resolveSessionWorkspace: sessionWorkspaceResultSchema,
  listSessionMetadata: listSessionMetadataResultSchema,
  mintWorkerConnectionCapability: mintWorkerConnectionCapabilityResultSchema,
  ensureWebGateway: webGatewayResultSchema,
  discoverWebGateway: webGatewayResultSchema,
  stopWebGateway: webGatewayResultSchema,
  stopCoordinator: coordinatorStopResultSchema,
  subscribeDirectoryChanges: subscribeDirectoryChangesResultSchema,
} as const;

const coordinatorErrorSchema = z
  .object({
    code: z.enum([
      'invalid_frame',
      'invalid_response',
      'deadline_exceeded',
      'unavailable',
      'outcome_unknown',
      'identity_mismatch',
      'protocol_incompatible',
      'peer_identity_mismatch',
      'handler_failed',
    ]),
    diagnostic: z
      .enum([
        'malformed',
        'unknown_method',
        'expired',
        'coordinator_unavailable',
        'handler_rejected',
        'wrong_instance',
        'wrong_build',
        'wrong_protocol',
        'wrong_peer',
        'web_assets_missing',
        'web_recovery_required',
        'web_identity_uncertain',
        'web_ready_mismatch',
        'web_build_mismatch',
        'web_unsupported',
        'web_timeout',
        'web_state_corrupt',
        'web_outcome_unknown',
        'web_not_running',
      ])
      .optional(),
  })
  .strict();
export type CoordinatorError = z.infer<typeof coordinatorErrorSchema>;

export type CoordinatorResponseFrame = {
  readonly [M in CoordinatorMethod]:
    | {
        readonly schema: typeof COORDINATOR_PROTOCOL_SCHEMA_;
        readonly kind: 'response';
        readonly protocolVersion: typeof COORDINATOR_PROTOCOL_VERSION;
        readonly requestId: string;
        readonly idempotencyKey: string;
        readonly deadlineMs: number;
        readonly method: M;
        readonly outcome: 'ok';
        readonly result: CoordinatorResultByMethod[M];
      }
    | {
        readonly schema: typeof COORDINATOR_PROTOCOL_SCHEMA_;
        readonly kind: 'response';
        readonly protocolVersion: typeof COORDINATOR_PROTOCOL_VERSION;
        readonly requestId: string;
        readonly idempotencyKey: string;
        readonly deadlineMs: number;
        readonly method: M;
        readonly outcome: 'error';
        readonly error: CoordinatorError;
      };
}[CoordinatorMethod];

const coordinatorResponseFrameSchema = z.union(
  COORDINATOR_METHODS.map((method) =>
    z.union([
      z
        .object({
          schema: z.literal(COORDINATOR_PROTOCOL_SCHEMA_),
          kind: z.literal('response'),
          protocolVersion: z.literal(COORDINATOR_PROTOCOL_VERSION),
          requestId,
          idempotencyKey,
          deadlineMs,
          method: z.literal(method),
          outcome: z.literal('ok'),
          result: coordinatorResultSchemas[method],
        })
        .strict(),
      z
        .object({
          schema: z.literal(COORDINATOR_PROTOCOL_SCHEMA_),
          kind: z.literal('response'),
          protocolVersion: z.literal(COORDINATOR_PROTOCOL_VERSION),
          requestId,
          idempotencyKey,
          deadlineMs,
          method: z.literal(method),
          outcome: z.literal('error'),
          error: coordinatorErrorSchema,
        })
        .strict(),
    ]),
  ) as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
) as unknown as z.ZodType<CoordinatorResponseFrame>;
export const COORDINATOR_RESPONSE_FRAME_SCHEMA = coordinatorResponseFrameSchema;

const coordinatorHandshakeRequestSchema = z
  .object({
    schema: z.literal(COORDINATOR_HANDSHAKE_SCHEMA_),
    kind: z.literal('handshake_request'),
    protocolVersion: z.literal(COORDINATOR_PROTOCOL_VERSION),
    requestId,
    idempotencyKey,
    deadlineMs,
    expectedCoordinator: coordinatorIdentitySchema,
    peer: peerIdentitySchema,
    peerOsIdentity: osIdentitySchema,
  })
  .strict();
export type CoordinatorHandshakeRequest = z.infer<typeof coordinatorHandshakeRequestSchema>;
export const COORDINATOR_HANDSHAKE_REQUEST_SCHEMA = coordinatorHandshakeRequestSchema;

const coordinatorHandshakeResponseSchema = z
  .object({
    schema: z.literal(COORDINATOR_HANDSHAKE_SCHEMA_),
    kind: z.literal('handshake_response'),
    protocolVersion: z.literal(COORDINATOR_PROTOCOL_VERSION),
    requestId,
    idempotencyKey,
    deadlineMs,
    accepted: z.boolean(),
    coordinator: coordinatorIdentitySchema,
    diagnostic: z
      .enum([
        'accepted',
        'wrong_instance',
        'wrong_build',
        'wrong_protocol',
        'wrong_peer',
        'expired',
      ])
      .optional(),
  })
  .strict();
export type CoordinatorHandshakeResponse = z.infer<typeof coordinatorHandshakeResponseSchema>;
export const COORDINATOR_HANDSHAKE_RESPONSE_SCHEMA = coordinatorHandshakeResponseSchema;

const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'approval',
  'artifact',
  'credential',
  'credentials',
  'event',
  'interaction',
  'model',
  'prompt',
  'providerresponse',
  'runtimeevent',
  'secret',
  'stderr',
  'stdout',
  'tool',
  'token',
]);

function assertCoordinatorPayloadShape(value: unknown): void {
  const seen = new Set<object>();
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > COORDINATOR_LIMITS.maxDepth) {
      throw new CoordinatorValidationError('Coordinator frame exceeds maximum depth');
    }
    if (candidate === null || typeof candidate !== 'object') return;
    if (seen.has(candidate)) {
      throw new CoordinatorValidationError('Coordinator frame contains a cycle');
    }
    seen.add(candidate);
    for (const key of Object.keys(candidate)) {
      if (FORBIDDEN_PAYLOAD_KEYS.has(key.toLowerCase())) {
        throw new CoordinatorValidationError('Coordinator frame contains a forbidden payload');
      }
      visit((candidate as Record<string, unknown>)[key], depth + 1);
    }
  };
  visit(value, 0);
}

/** Validate JSON shape and apply the stricter Coordinator frame limits. */
export function assertCoordinatorJsonValue(value: unknown): void {
  assertProtocolJsonValue(value);
  assertCoordinatorPayloadShape(value);
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new CoordinatorValidationError('Coordinator frame cannot be serialized');
  }
  if (new TextEncoder().encode(encoded).byteLength > COORDINATOR_LIMITS.maxFrameBytes) {
    throw new CoordinatorValidationError('Coordinator frame exceeds maximum message size');
  }
}

function parseStrict<T>(schema: z.ZodType<T>, value: unknown): T {
  assertCoordinatorJsonValue(value);
  return schema.parse(value);
}

export function decodeCoordinatorRequestFrame(value: unknown): CoordinatorRequestFrame {
  return parseStrict(coordinatorRequestFrameSchema, value);
}

export function encodeCoordinatorRequestFrame(
  value: CoordinatorRequestFrame,
): CoordinatorRequestFrame {
  return decodeCoordinatorRequestFrame(value);
}

export function safeDecodeCoordinatorRequestFrame(
  value: unknown,
):
  | { readonly success: true; readonly data: CoordinatorRequestFrame }
  | { readonly success: false; readonly error: unknown } {
  try {
    return { success: true, data: decodeCoordinatorRequestFrame(value) };
  } catch (error) {
    return { success: false, error };
  }
}

export function decodeCoordinatorResponseFrame(value: unknown): CoordinatorResponseFrame {
  return parseStrict(coordinatorResponseFrameSchema, value);
}

export function encodeCoordinatorResponseFrame(
  value: CoordinatorResponseFrame,
): CoordinatorResponseFrame {
  return decodeCoordinatorResponseFrame(value);
}

export function safeDecodeCoordinatorResponseFrame(
  value: unknown,
):
  | { readonly success: true; readonly data: CoordinatorResponseFrame }
  | { readonly success: false; readonly error: unknown } {
  try {
    return { success: true, data: decodeCoordinatorResponseFrame(value) };
  } catch (error) {
    return { success: false, error };
  }
}

export function decodeCoordinatorHandshakeRequest(value: unknown): CoordinatorHandshakeRequest {
  return parseStrict(coordinatorHandshakeRequestSchema, value);
}

export function encodeCoordinatorHandshakeRequest(
  value: CoordinatorHandshakeRequest,
): CoordinatorHandshakeRequest {
  return decodeCoordinatorHandshakeRequest(value);
}

export function decodeCoordinatorHandshakeResponse(value: unknown): CoordinatorHandshakeResponse {
  return parseStrict(coordinatorHandshakeResponseSchema, value);
}

export function encodeCoordinatorHandshakeResponse(
  value: CoordinatorHandshakeResponse,
): CoordinatorHandshakeResponse {
  return decodeCoordinatorHandshakeResponse(value);
}

export function decodeCoordinatorEndpointDescriptor(value: unknown): CoordinatorEndpointDescriptor {
  return parseStrict(endpointDescriptorSchema, value);
}

export function encodeCoordinatorEndpointDescriptor(
  value: CoordinatorEndpointDescriptor,
): CoordinatorEndpointDescriptor {
  return decodeCoordinatorEndpointDescriptor(value);
}

export function safeDecodeCoordinatorEndpointDescriptor(
  value: unknown,
):
  | { readonly success: true; readonly data: CoordinatorEndpointDescriptor }
  | { readonly success: false; readonly error: unknown } {
  try {
    return { success: true, data: decodeCoordinatorEndpointDescriptor(value) };
  } catch (error) {
    return { success: false, error };
  }
}

export type CoordinatorResultByMethod = {
  readonly status: CoordinatorStatusResult;
  readonly resolveWorkspaceWorker: CoordinatorWorkerResult;
  readonly ensureWorkspaceWorker: CoordinatorWorkerResult;
  readonly resolveSessionWorkspace: CoordinatorSessionWorkspaceResult;
  readonly listSessionMetadata: CoordinatorListSessionMetadataResult;
  readonly mintWorkerConnectionCapability: CoordinatorMintWorkerConnectionCapabilityResult;
  readonly ensureWebGateway: CoordinatorWebGatewayResult;
  readonly discoverWebGateway: CoordinatorWebGatewayResult;
  readonly stopWebGateway: CoordinatorWebGatewayResult;
  readonly stopCoordinator: CoordinatorStopResult;
  readonly subscribeDirectoryChanges: CoordinatorSubscribeDirectoryChangesResult;
};

export type CoordinatorSuccessResponse<M extends CoordinatorMethod> = Extract<
  CoordinatorResponseFrame,
  { readonly method: M; readonly outcome: 'ok' }
> & { readonly result: CoordinatorResultByMethod[M] };

export type CoordinatorResponseFor<M extends CoordinatorMethod> = Extract<
  CoordinatorResponseFrame,
  { readonly method: M }
>;
