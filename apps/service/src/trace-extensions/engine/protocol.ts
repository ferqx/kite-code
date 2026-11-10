import { z } from 'zod';

export const engineBudgetsSchema = z.strictObject({
  heapBytes: z
    .number()
    .int()
    .min(1024 * 1024)
    .max(64 * 1024 * 1024),
  stackBytes: z
    .number()
    .int()
    .min(16 * 1024)
    .max(512 * 1024),
  callbackMs: z.number().int().min(10).max(5000),
  messageBytes: z
    .number()
    .int()
    .min(1024)
    .max(768 * 1024),
  brokerCalls: z.number().int().min(1).max(64),
  brokerConcurrency: z.number().int().min(1).max(8),
});
export type TraceEngineBudgets = z.infer<typeof engineBudgetsSchema>;
export const defaultEngineBudgets: TraceEngineBudgets = Object.freeze({
  heapBytes: 16 * 1024 * 1024,
  stackBytes: 256 * 1024,
  callbackMs: 5000,
  messageBytes: 768 * 1024,
  brokerCalls: 32,
  brokerConcurrency: 4,
});
export type EngineJson =
  | null
  | boolean
  | number
  | string
  | EngineJson[]
  | { [key: string]: EngineJson };
export function copyEngineJson(value: unknown, maxBytes: number): EngineJson {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > maxBytes)
    throw Error('trace_engine_message_limit');
  return JSON.parse(encoded) as EngineJson;
}
export const runnerRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('initialize'),
    generation: z.string().regex(/^(0|[1-9][0-9]*)$/),
    source: z.string().max(512 * 1024),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    wasmPath: z.string(),
    wasmDigest: z.string().regex(/^[a-f0-9]{64}$/),
    budgets: engineBudgetsSchema,
  }),
  z.strictObject({
    type: z.literal('invoke'),
    id: z.number().int().positive(),
    method: z.enum(['initialize', 'onEvents', 'flush', 'shutdown']),
    input: z.unknown(),
  }),
  z.strictObject({
    type: z.literal('broker_result'),
    id: z.number().int().positive(),
    callId: z.number().int().positive(),
    value: z.unknown().optional(),
    error: z.literal('broker_rejected').optional(),
  }),
]);
export const runnerResponseSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('ready'), generation: z.string() }),
  z.strictObject({
    type: z.literal('result'),
    generation: z.string(),
    id: z.number().int().positive(),
    value: z.unknown(),
  }),
  z.strictObject({
    type: z.literal('failed'),
    generation: z.string(),
    id: z.number().int().nonnegative(),
    code: z.enum([
      'evaluation_failed',
      'message_limit',
      'invalid_extension',
      'broker_limit',
      'timeout',
      'protocol_error',
    ]),
  }),
  z.strictObject({
    type: z.literal('broker'),
    generation: z.string(),
    id: z.number().int().positive(),
    callId: z.number().int().positive(),
    method: z.string().min(1).max(64),
    input: z.unknown(),
  }),
]);
