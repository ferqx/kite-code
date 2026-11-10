import type { TraceDeliveryResult, TraceEventBatch } from '@kite-ai/trajectory';
import { decimal64Schema } from '@kite-ai/trajectory';
import { z } from 'zod';
import type { EngineJson } from './engine';
import type { TraceGrantState } from './types';

const count = z.number().int().nonnegative();
const outgoingState = z.enum([
  'pending',
  'sending',
  'accepted',
  'retry_wait',
  'rejected',
  'partial_unknown',
  'unconfirmed',
  'sampled_out',
  'stopped',
]);
const outgoingCode = z.union([
  z.enum([
    'partial_success',
    'response_unavailable',
    'response_invalid',
    'transport_unconfirmed',
    'send_not_authorized',
    'permission_revoked',
    'task_cancelled',
    'retry_exhausted',
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ENETUNREACH',
    'EHOSTUNREACH',
  ]),
  z.string().regex(/^http_[3-5][0-9]{2}$/),
]);
/** Finite reference-adapter summary; no span envelope, endpoint, arbitrary errors or secrets. */
export const traceConsumerInspectionSchema = z.strictObject({
  grant: z.strictObject({ revision: decimal64Schema, epoch: decimal64Schema, active: z.boolean() }),
  openSpans: count,
  acceptedEvents: count,
  unmappedEvents: z.strictObject({
    notSpan: count,
    identityUnavailable: count,
    timingUnavailable: count,
    incompletePrefix: count,
  }),
  outgoingTotal: count,
  outgoingStates: z.array(z.strictObject({ status: outgoingState, count })).max(9),
  outgoing: z
    .array(
      z.strictObject({
        key: z.string().max(512),
        taskId: z.string().max(512),
        status: outgoingState,
        code: outgoingCode.nullable(),
        attempts: count,
        rejectedCount: count.nullable(),
        possibleDuplicate: z.union([z.literal(0), z.literal(1)]),
      }),
    )
    .max(200),
});
export type TraceConsumerInspection = z.infer<typeof traceConsumerInspectionSchema>;
export interface TrustedTraceInspectionInput {
  installationId: string;
  kind: 'opentelemetry';
  digest: string;
  settings: Record<string, string | number | boolean>;
}
export type TrustedTraceConsumerInspector = (
  input: TrustedTraceInspectionInput,
) => Promise<TraceConsumerInspection | null>;

/** Trusted first-party consumer port. SDK bundles cannot select or construct this implementation. */
export interface TraceConsumer {
  readonly generation: string;
  initialize(input: EngineJson, signal?: AbortSignal): Promise<void>;
  onEvents(batch: TraceEventBatch, signal?: AbortSignal): Promise<TraceDeliveryResult>;
  retire(): Promise<{ confirmed: boolean }>;
  pump?(): Promise<unknown>;
  cancelTask?(taskId: string): Promise<void>;
  setGrant?(stamp: { revision: string; epoch: string; active: boolean }): Promise<void>;
  inspect?(): Promise<TraceConsumerInspection>;
}
export interface TrustedTraceConsumerInput {
  installationId: string;
  kind: 'opentelemetry';
  digest: string;
  generation: string;
  grant: TraceGrantState;
  settings: Record<string, string | number | boolean>;
  authorizeSend(
    taskId: string,
    endpoint: string,
    signal: AbortSignal,
    credentialHandle?: string,
  ): Promise<{ headers: Record<string, string>; target: { address: string; family: 4 | 6 } }>;
}
export type TrustedTraceConsumerFactory = (
  input: TrustedTraceConsumerInput,
) => Promise<TraceConsumer>;
