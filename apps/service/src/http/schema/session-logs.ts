import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const sequence = z
  .string()
  .max(19)
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const name = z.string().regex(/^[A-Za-z0-9@][A-Za-z0-9_.:@/-]{0,127}$/);
export const BrowserSessionLogQuerySchema = z.strictObject({
  afterCursor: sequence,
  upperCursor: sequence.optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export const SessionLogQuerySchema = BrowserSessionLogQuerySchema.extend({ storeId: id });
export const SessionLogDetailsSchema = z.strictObject({
  kind: z.enum(['model', 'tool', 'job']).optional(),
  definitionId: name.optional(),
  definitionVersion: name.optional(),
  commandId: id.optional(),
  runId: id.optional(),
  executionId: id.optional(),
  interactionId: id.optional(),
  attempt: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
});
export const SessionLogEntrySchema = z.strictObject({
  cursor: sequence,
  sessionId: id,
  objectId: id,
  type: z.string().regex(/^[a-z][a-z0-9_.]{0,127}$/),
  revision: sequence,
  occurredAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  category: z.enum([
    'command',
    'run',
    'execution',
    'interaction',
    'message',
    'context',
    'extension',
    'session',
    'other',
  ]),
  recordedStatus: z
    .enum([
      'accepted',
      'applied',
      'rejected',
      'needs_review',
      'running',
      'waiting_interaction',
      'waiting_execution',
      'cancelling',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
      'planned',
      'dispatching',
      'succeeded',
      'outcome_unknown',
      'pending',
      'answered',
      'complete',
      'incomplete',
    ])
    .nullable(),
  summary: z.string().max(256),
  details: SessionLogDetailsSchema,
  modelExecutionId: id.nullable(),
});
/** Closed, bounded diagnostics; neither event payload nor an execution permission. */
export const SessionLogPageSchema = z.strictObject({
  storeId: id,
  sessionId: id,
  upperCursor: sequence,
  nextAfterCursor: sequence.nullable(),
  replayFloor: sequence,
  snapshotCursor: sequence,
  entries: z.array(SessionLogEntrySchema).max(200),
  complete: z.boolean(),
});
