import { z } from 'zod';
import { decimal64Schema } from './cursor';
import { trajectoryDisplaySchema, trajectoryMessageDisplaySchema } from './display';
import { evidenceRefSchema, opaqueIdSchema } from './evidence';
import { compressionPresentationSchema } from './presentation';

export const knownTrajectoryKindSchema = z.enum([
  'command',
  'run',
  'model',
  'tool',
  'job',
  'interaction',
  'child',
  'context',
  'recovery',
  'artifact',
  'verification',
  'message',
]);
export type KnownTrajectoryKind = z.infer<typeof knownTrajectoryKindSchema>;
export const trajectoryPhaseSchema = z.enum([
  'planned',
  'dispatching',
  'running',
  'waiting_interaction',
  'waiting_execution',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'outcome_unknown',
  'observed',
]);
export type KnownTrajectoryPhase = z.infer<typeof trajectoryPhaseSchema>;
const usage = z.strictObject({
  inputTokens: decimal64Schema.optional(),
  outputTokens: decimal64Schema.optional(),
  totalTokens: decimal64Schema.optional(),
  cachedInputTokens: decimal64Schema.optional(),
});
const executionAttribution = {
  commandId: opaqueIdSchema.optional(),
  rootWorkCommandId: opaqueIdSchema.optional(),
  rootWorkSeq: decimal64Schema.optional(),
  definitionId: opaqueIdSchema.optional(),
  definitionVersion: z.string().max(128).optional(),
};
const gap = z.strictObject({
  stream: z.enum(['stdout', 'stderr', 'progress']),
  fromSeq: decimal64Schema,
  throughSeq: decimal64Schema,
  droppedBytes: decimal64Schema,
});
export const outputCheckpointShape = {
  upperOutputSeq: decimal64Schema.optional(),
  stream: z.enum(['stdout', 'stderr', 'progress', 'gap']).optional(),
  gaps: z.array(gap).optional(),
  droppedBytes: decimal64Schema.optional(),
  truncated: z.boolean().optional(),
};
export const trajectoryAttributesSchemas = {
  message: z.strictObject({
    display: trajectoryMessageDisplaySchema.optional(),
    messageId: opaqueIdSchema,
    role: z.enum(['user', 'assistant']),
    messageSeq: decimal64Schema,
    revision: decimal64Schema,
    status: z.enum(['complete', 'incomplete']),
  }),
  command: z.strictObject({
    commandId: opaqueIdSchema,
    commandType: z.string().max(128).optional(),
    reasonCode: z.string().max(128).optional(),
  }),
  run: z.strictObject({
    commandId: opaqueIdSchema.optional(),
    rootWorkCommandId: opaqueIdSchema.optional(),
    rootWorkSeq: decimal64Schema.optional(),
    reasonCode: z.string().max(128).optional(),
    cancellationRequested: z.boolean().optional(),
  }),
  model: z.strictObject({
    ...executionAttribution,
    display: trajectoryDisplaySchema.optional(),
    compressionId: opaqueIdSchema.optional(),
    compressionTrigger: z.enum(['automatic', 'manual']).optional(),
    compression: compressionPresentationSchema.optional(),
    resultRevision: decimal64Schema.optional(),
    previousExecutionId: opaqueIdSchema.optional(),
    previousExecutionOriginStoreId: opaqueIdSchema.optional(),
    retryReason: z
      .enum(['provider_unavailable', 'connection_failed', 'stream_incomplete'])
      .optional(),
    retryAttempt: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER).optional(),
    maxAttempts: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
    usage: usage.optional(),
  }),
  tool: z.strictObject({
    ...executionAttribution,
    display: trajectoryDisplaySchema.optional(),
    ...outputCheckpointShape,
    callId: opaqueIdSchema.optional(),
    resultRevision: decimal64Schema.optional(),
  }),
  job: z.strictObject({
    ...executionAttribution,
    display: trajectoryDisplaySchema.optional(),
    childSessionId: opaqueIdSchema.optional(),
    delivery: z.enum(['pending', 'consumed', 'suppressed']).optional(),
    deliveryReasonCode: z.string().max(128).optional(),
    resultRevision: decimal64Schema.optional(),
    ...outputCheckpointShape,
  }),
  interaction: z.strictObject({
    interactionId: opaqueIdSchema,
    interactionKind: z.enum(['approval', 'question', 'plan_review']).optional(),
    revision: decimal64Schema,
    decision: z
      .enum(['requested', 'projected', 'answered', 'accepted', 'rejected', 'cancelled'])
      .optional(),
  }),
  child: z.strictObject({
    childSessionId: opaqueIdSchema,
    carrierExecutionId: opaqueIdSchema,
    childRunId: opaqueIdSchema.optional(),
    delivery: z.enum(['pending', 'accepted', 'delivered', 'rejected']).optional(),
  }),
  context: z.strictObject({
    selectionId: opaqueIdSchema.optional(),
    compressionId: opaqueIdSchema.optional(),
    compressionTrigger: z.enum(['automatic', 'manual']).optional(),
    compression: compressionPresentationSchema.optional(),
    revision: decimal64Schema.optional(),
    action: z.enum(['selected', 'compressed', 'published']).optional(),
  }),
  recovery: z.strictObject({
    reasonCode: z.string().max(128).optional(),
    outcome: z.enum(['interrupted', 'unknown', 'verified', 'resumed', 'failed']).optional(),
  }),
  artifact: z.strictObject({
    artifactId: opaqueIdSchema,
    mediaType: z.string().max(256).optional(),
  }),
  verification: z.strictObject({
    verificationId: opaqueIdSchema,
    outcome: z.enum(['passed', 'failed', 'unknown']),
    method: z.enum(['business_reconciliation', 'required_check', 'test_evidence']),
  }),
  unknown: z.strictObject({
    reason: z.enum(['unrecognized_source_type', 'legacy_fields_missing', 'unsupported_version']),
  }),
};
export const trajectoryEnvelopeShape = {
  schema: z.literal('kite.trajectory'),
  schemaVersion: z.literal(1),
  eventId: z.string().regex(/^te_[a-f0-9]{64}$/),
  sequence: decimal64Schema,
  origin: z.strictObject({ storeId: opaqueIdSchema, cursor: decimal64Schema }),
  sessionId: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  runId: opaqueIdSchema.optional(),
  executionId: opaqueIdSchema.optional(),
  parentExecutionId: opaqueIdSchema.optional(),
  executionOriginStoreId: opaqueIdSchema.optional(),
  runOriginStoreId: opaqueIdSchema.optional(),
  operationOriginStoreId: opaqueIdSchema.optional(),
  parentExecutionOriginStoreId: opaqueIdSchema.optional(),
  messageOriginStoreId: opaqueIdSchema.optional(),
  operationId: opaqueIdSchema.optional(),
  attempt: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  sourceEventType: z.string().min(1).max(256),
  sourceRecordRevision: decimal64Schema,
  phase: trajectoryPhaseSchema,
  recordedStatus: z.string().max(128).nullable(),
  occurredAt: z.number().finite().nullable(),
  identityConfidence: z.enum(['verified_origin', 'legacy_local']),
  evidenceRefs: z.array(evidenceRefSchema),
};
export const trajectoryEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...trajectoryEnvelopeShape,
    kind: z.literal('message'),
    attributes: trajectoryAttributesSchemas.message,
  }),
  z.strictObject({
    ...trajectoryEnvelopeShape,
    kind: z.literal('command'),
    attributes: trajectoryAttributesSchemas.command,
  }),
  z.strictObject({
    ...trajectoryEnvelopeShape,
    kind: z.literal('run'),
    attributes: trajectoryAttributesSchemas.run,
  }),
  z.strictObject({
    ...trajectoryEnvelopeShape,
    kind: z.literal('model'),
    attributes: trajectoryAttributesSchemas.model,
  }),
  z.strictObject({
    ...trajectoryEnvelopeShape,
    kind: z.literal('tool'),
    attributes: trajectoryAttributesSchemas.tool,
  }),
  z.strictObject({
    ...trajectoryEnvelopeShape,
    kind: z.literal('job'),
    attributes: trajectoryAttributesSchemas.job,
  }),
  z.strictObject({
    ...trajectoryEnvelopeShape,
    kind: z.literal('interaction'),
    attributes: trajectoryAttributesSchemas.interaction,
  }),
  z.strictObject({
    ...trajectoryEnvelopeShape,
    kind: z.literal('child'),
    attributes: trajectoryAttributesSchemas.child,
  }),
  z.strictObject({
    ...trajectoryEnvelopeShape,
    kind: z.literal('context'),
    attributes: trajectoryAttributesSchemas.context,
  }),
  z.strictObject({
    ...trajectoryEnvelopeShape,
    kind: z.literal('recovery'),
    attributes: trajectoryAttributesSchemas.recovery,
  }),
  z.strictObject({
    ...trajectoryEnvelopeShape,
    kind: z.literal('artifact'),
    attributes: trajectoryAttributesSchemas.artifact,
  }),
  z.strictObject({
    ...trajectoryEnvelopeShape,
    kind: z.literal('verification'),
    attributes: trajectoryAttributesSchemas.verification,
  }),
  z.strictObject({
    ...trajectoryEnvelopeShape,
    kind: z.literal('unknown'),
    attributes: trajectoryAttributesSchemas.unknown,
  }),
]);
export type TrajectoryEvent = z.infer<typeof trajectoryEventSchema>;
