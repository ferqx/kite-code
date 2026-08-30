import { z } from 'zod';
import { LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_ } from './codecs';

export const KITE_LOCAL_NATIVE_PROTOCOL_VERSION = 1 as const;
export const KITE_LOCAL_NATIVE_REQUEST_SCHEMA_ = 'kite.local-native.request.v1' as const;
export const KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_ = 'kite.local-native.response.v1' as const;
export const KITE_LOCAL_NATIVE_MAX_FRAME_BYTES = 32_768;
export const KITE_LOCAL_RUNTIME_LIFECYCLE_SCHEMA_ =
  'kite.local-service-lifecycle-reservation.v1' as const;

const identifier = z.string().min(1).max(512).refine(noControlCharacters);
const absolutePath = identifier.refine(
  (value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value),
  'expected an absolute path',
);
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const origin = z
  .string()
  .url()
  .refine((value) => /^http:\/\/127\.0\.0\.1:\d+$/u.test(value));

export const kiteLocalRuntimeLifecycleReservationSchema = z
  .object({
    schema: z.literal(KITE_LOCAL_RUNTIME_LIFECYCLE_SCHEMA_),
    pid: z.number().int().positive(),
    processStartIdentity: identifier,
    instanceId: identifier,
    buildId: identifier,
    startedAt: z.string().datetime({ offset: true }),
    socketDevice: z.number().int().nonnegative().optional(),
    socketInode: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (value) => (value.socketDevice === undefined) === (value.socketInode === undefined),
    'socket identity must be complete',
  );

export type KiteLocalRuntimeLifecycleReservation = z.infer<
  typeof kiteLocalRuntimeLifecycleReservationSchema
>;

export function decodeKiteLocalRuntimeLifecycleReservation(
  value: unknown,
): KiteLocalRuntimeLifecycleReservation {
  return kiteLocalRuntimeLifecycleReservationSchema.parse(value);
}

export function encodeKiteLocalRuntimeLifecycleReservation(
  value: KiteLocalRuntimeLifecycleReservation,
): string {
  const validated = decodeKiteLocalRuntimeLifecycleReservation(value);
  const frame = `${JSON.stringify(validated)}\n`;
  if (Buffer.byteLength(frame, 'utf8') > 4_096) {
    throw new RangeError('Local Service lifecycle reservation is oversized.');
  }
  return frame;
}

const baseRequest = z
  .object({
    schema: z.literal(KITE_LOCAL_NATIVE_REQUEST_SCHEMA_),
    requestId: identifier,
    protocolVersion: z.literal(KITE_LOCAL_NATIVE_PROTOCOL_VERSION),
    clientContractRevision: z.literal(LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_),
    expectedBuildId: identifier,
  })
  .strict();

export const kiteLocalNativeRequestSchema = z.discriminatedUnion('operation', [
  baseRequest.extend({ operation: z.literal('describe') }).strict(),
  baseRequest
    .extend({
      operation: z.literal('web_ensure'),
      staticAssetRoot: absolutePath,
    })
    .strict(),
  baseRequest.extend({ operation: z.literal('web_status') }).strict(),
  baseRequest.extend({ operation: z.literal('web_stop') }).strict(),
  baseRequest.extend({ operation: z.literal('service_stop') }).strict(),
]);

const baseResponse = z
  .object({
    schema: z.literal(KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_),
    requestId: identifier,
  })
  .strict();

const serviceIdentity = z
  .object({
    instanceId: identifier,
    pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    startedAt: z.iso.datetime({ offset: true }),
    protocolVersion: z.literal(KITE_LOCAL_NATIVE_PROTOCOL_VERSION),
    clientContractRevision: z.literal(LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_),
    serverVersion: identifier,
    buildId: identifier,
    httpOrigin: origin,
  })
  .strict();

export const kiteLocalNativeResponseSchema = z.union([
  baseResponse
    .extend({
      operation: z.literal('describe'),
      outcome: z.literal('ready'),
      service: serviceIdentity,
      accessToken: token,
    })
    .strict(),
  baseResponse
    .extend({
      operation: z.literal('web_ensure'),
      outcome: z.literal('ready'),
      origin,
      launchUrl: z
        .string()
        .url()
        .refine((value) => /#[A-Za-z0-9_-]{43}$/u.test(value)),
      assetDigest: digest,
    })
    .strict(),
  baseResponse
    .extend({
      operation: z.literal('web_status'),
      outcome: z.literal('ready'),
      state: z.literal('absent'),
    })
    .strict(),
  baseResponse
    .extend({
      operation: z.literal('web_status'),
      outcome: z.literal('ready'),
      state: z.literal('ready'),
      origin,
      assetDigest: digest,
    })
    .strict(),
  baseResponse
    .extend({
      operation: z.literal('web_ensure'),
      outcome: z.literal('unavailable'),
      state: z.enum(['absent', 'ready']),
      diagnostic: z.enum(['web_assets_missing', 'web_readiness_failed', 'web_stop_failed']),
    })
    .strict(),
  baseResponse
    .extend({
      operation: z.literal('web_stop'),
      outcome: z.enum(['applied', 'noop', 'unavailable']),
      state: z.enum(['absent', 'ready']),
      diagnostic: z.literal('web_stop_failed').optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if ((value.outcome === 'unavailable') !== (value.diagnostic !== undefined)) {
        context.addIssue({
          code: 'custom',
          message: 'web stop diagnostic mismatch',
        });
      }
      if (
        (value.outcome === 'unavailable' && value.state !== 'ready') ||
        (value.outcome !== 'unavailable' && value.state !== 'absent')
      ) {
        context.addIssue({
          code: 'custom',
          message: 'web stop state mismatch',
        });
      }
    }),
  baseResponse
    .extend({
      operation: z.literal('service_stop'),
      outcome: z.enum(['applied', 'service_busy', 'unavailable']),
      state: z.enum(['absent', 'starting', 'ready', 'quiescing', 'draining']),
    })
    .strict(),
  baseResponse
    .extend({
      operation: z.literal('rejected'),
      outcome: z.literal('rejected'),
      diagnostic: z.enum(['invalid_request', 'incompatible', 'unavailable']),
    })
    .strict(),
]);

export type KiteLocalNativeRequest = z.infer<typeof kiteLocalNativeRequestSchema>;
export type KiteLocalNativeResponse = z.infer<typeof kiteLocalNativeResponseSchema>;

export function decodeKiteLocalNativeRequest(value: unknown): KiteLocalNativeRequest {
  return kiteLocalNativeRequestSchema.parse(value);
}

export function decodeKiteLocalNativeResponse(value: unknown): KiteLocalNativeResponse {
  return kiteLocalNativeResponseSchema.parse(value);
}

export function encodeKiteLocalNativeFrame(
  value: KiteLocalNativeRequest | KiteLocalNativeResponse,
): string {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame, 'utf8') > KITE_LOCAL_NATIVE_MAX_FRAME_BYTES) {
    throw new RangeError('Local Native IPC frame exceeds its fixed bound.');
  }
  return frame;
}

function noControlCharacters(value: string): boolean {
  return !/\p{Cc}/u.test(value);
}
