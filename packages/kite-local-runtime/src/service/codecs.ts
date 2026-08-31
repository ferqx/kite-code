import {
  assertProtocolJsonValue,
  RUNTIME_PROTOCOL_SCHEMA,
  RUNTIME_PROTOCOL_VERSION,
} from '@kite-ai/runtime-protocol';
import { z } from 'zod';

export const LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA_ = 'kite.local-runtime-service.v1' as const;
export const LOCAL_RUNTIME_SERVICE_LOCK_SCHEMA_ = 'kite.local-service-lock.v1' as const;
export const LOCAL_RUNTIME_SERVICE_TOKEN_SCHEMA_ = 'kite.local-runtime-token.v1' as const;
export const LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_ = 'kite-local-runtime-contract-v2' as const;

const MAX_IDENTITY_LENGTH = 512;
const MAX_URL_LENGTH = 512;

const boundedIdentity = z
  .string()
  .min(1)
  .max(MAX_IDENTITY_LENGTH)
  .refine((value) => !/\p{Cc}/u.test(value), 'identity contains a control character');

const servicePid = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const startedAt = z.iso.datetime({ offset: true });

function isLoopbackOrigin(value: string): boolean {
  const port = value.match(/^http:\/\/127\.0\.0\.1:(\d{1,5})$/u)?.[1];
  return port !== undefined && Number(port) >= 1 && Number(port) <= 65_535;
}

function isLoopbackWebSocket(value: string): boolean {
  const port = value.match(/^ws:\/\/127\.0\.0\.1:(\d{1,5})\/rpc$/u)?.[1];
  return port !== undefined && Number(port) >= 1 && Number(port) <= 65_535;
}

function endpointPort(value: string): string | undefined {
  return value.match(/:(\d{1,5})(?:\/rpc)?$/u)?.[1];
}

const endpoint = z
  .object({
    origin: z
      .string()
      .min(1)
      .max(MAX_URL_LENGTH)
      .refine(isLoopbackOrigin, 'origin must be an exact IPv4 loopback endpoint'),
    websocketUrl: z
      .string()
      .min(1)
      .max(MAX_URL_LENGTH)
      .refine(isLoopbackWebSocket, 'websocketUrl must be an exact loopback /rpc endpoint'),
  })
  .strict()
  .superRefine((value, context) => {
    if (endpointPort(value.origin) !== endpointPort(value.websocketUrl)) {
      context.addIssue({
        code: 'custom',
        path: ['websocketUrl'],
        message: 'origin and websocketUrl must use the same port',
      });
    }
  });

const localRuntimeServiceDescriptorSchema = z
  .object({
    schema: z.literal(LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA_),
    instanceId: boundedIdentity,
    pid: servicePid,
    startedAt,
    endpoint,
    protocolVersion: z.literal(RUNTIME_PROTOCOL_VERSION),
    clientContractRevision: z.literal(LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_),
    serverVersion: boundedIdentity,
    buildId: boundedIdentity,
  })
  .strict();

export type LocalRuntimeServiceDescriptor = z.infer<typeof localRuntimeServiceDescriptorSchema>;
export const LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA = localRuntimeServiceDescriptorSchema;

const lockOperation = z.enum(['ensure', 'start', 'status', 'stop', 'restart']);
const localServiceLockIdentitySchema = z
  .object({
    schema: z.literal(LOCAL_RUNTIME_SERVICE_LOCK_SCHEMA_),
    nonce: boundedIdentity,
    pid: servicePid,
    operation: lockOperation.optional(),
    instanceId: boundedIdentity.optional(),
    createdAt: startedAt,
  })
  .strict();

export type LocalServiceLockIdentity = z.infer<typeof localServiceLockIdentitySchema>;
export const LOCAL_SERVICE_LOCK_IDENTITY_SCHEMA = localServiceLockIdentitySchema;

export const LOCAL_RUNTIME_TOKEN_KINDS = Object.freeze(['access', 'control'] as const);
export type LocalRuntimeTokenKind = (typeof LOCAL_RUNTIME_TOKEN_KINDS)[number];

const localRuntimeTokenSchema = z
  .string()
  .min(32)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/u, 'token must use the bounded base64url alphabet');

export type LocalRuntimeToken = z.infer<typeof localRuntimeTokenSchema>;
export const LOCAL_RUNTIME_TOKEN_SCHEMA = localRuntimeTokenSchema;

function parseStrict<T>(schema: z.ZodType<T>, value: unknown): T {
  assertProtocolJsonValue(value);
  return schema.parse(value);
}

export function decodeLocalRuntimeServiceDescriptor(value: unknown): LocalRuntimeServiceDescriptor {
  return parseStrict(localRuntimeServiceDescriptorSchema, value);
}

export function encodeLocalRuntimeServiceDescriptor(
  value: LocalRuntimeServiceDescriptor,
): LocalRuntimeServiceDescriptor {
  return decodeLocalRuntimeServiceDescriptor(value);
}

export function safeDecodeLocalRuntimeServiceDescriptor(
  value: unknown,
):
  | { readonly success: true; readonly data: LocalRuntimeServiceDescriptor }
  | { readonly success: false; readonly error: unknown } {
  try {
    return { success: true, data: decodeLocalRuntimeServiceDescriptor(value) };
  } catch (error) {
    return { success: false, error };
  }
}

export function decodeLocalServiceLockIdentity(value: unknown): LocalServiceLockIdentity {
  return parseStrict(localServiceLockIdentitySchema, value);
}

export function encodeLocalServiceLockIdentity(
  value: LocalServiceLockIdentity,
): LocalServiceLockIdentity {
  return decodeLocalServiceLockIdentity(value);
}

export function safeDecodeLocalServiceLockIdentity(
  value: unknown,
):
  | { readonly success: true; readonly data: LocalServiceLockIdentity }
  | { readonly success: false; readonly error: unknown } {
  try {
    return { success: true, data: decodeLocalServiceLockIdentity(value) };
  } catch (error) {
    return { success: false, error };
  }
}

/** Token files contain only the validated token bytes; their kind is selected by the filename. */
export function decodeLocalRuntimeToken(value: unknown): LocalRuntimeToken {
  return parseStrict(localRuntimeTokenSchema, value);
}

export function encodeLocalRuntimeToken(value: string): LocalRuntimeToken {
  return decodeLocalRuntimeToken(value);
}

export function safeDecodeLocalRuntimeToken(
  value: unknown,
):
  | { readonly success: true; readonly data: LocalRuntimeToken }
  | { readonly success: false; readonly error: unknown } {
  try {
    return { success: true, data: decodeLocalRuntimeToken(value) };
  } catch (error) {
    return { success: false, error };
  }
}

export const LOCAL_RUNTIME_PROTOCOL_IDENTITY_ = Object.freeze({
  schema: RUNTIME_PROTOCOL_SCHEMA,
  version: RUNTIME_PROTOCOL_VERSION,
} as const);
