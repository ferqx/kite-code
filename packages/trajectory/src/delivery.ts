import { z } from 'zod';
import { decimal64Schema } from './cursor';
import { trajectoryAttributesSchemas, trajectoryPhaseSchema } from './events';
import { evidenceRefSchema, opaqueIdSchema } from './evidence';
import { integritySchema } from './integrity';

export const traceScopeSchema = z.strictObject({
  storeRef: opaqueIdSchema,
  sessionRef: opaqueIdSchema,
  workspaceRef: opaqueIdSchema,
  runRef: opaqueIdSchema.optional(),
  executionRef: opaqueIdSchema.optional(),
  parentExecutionRef: opaqueIdSchema.optional(),
  executionOriginStoreRef: opaqueIdSchema.optional(),
  runOriginStoreRef: opaqueIdSchema.optional(),
  operationOriginStoreRef: opaqueIdSchema.optional(),
  parentExecutionOriginStoreRef: opaqueIdSchema.optional(),
  operationRef: opaqueIdSchema.optional(),
});
const attribution = {
  commandRef: opaqueIdSchema.optional(),
  rootWorkCommandRef: opaqueIdSchema.optional(),
  rootWorkSeq: decimal64Schema.optional(),
  definitionRef: opaqueIdSchema.optional(),
  definitionVersion: z.string().max(128).optional(),
};
const traceEnvelope = {
  schema: z.literal('kite.trace-event-view'),
  schemaVersion: z.literal(1),
  eventId: z.string().regex(/^te_[a-f0-9]{64}$/),
  sequence: decimal64Schema,
  scope: traceScopeSchema,
  origin: z.strictObject({ storeRef: opaqueIdSchema, cursor: decimal64Schema }),
  sourceEventType: z.string().min(1).max(256),
  sourceRecordRevision: decimal64Schema,
  phase: trajectoryPhaseSchema,
  recordedStatus: z.string().max(128).nullable(),
  occurredAt: z.number().finite().nullable(),
  attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  identityConfidence: z.enum(['verified_origin', 'legacy_local']),
  evidenceRefs: z.array(evidenceRefSchema),
  originalIdentity: z
    .strictObject({
      storeId: opaqueIdSchema,
      sessionId: opaqueIdSchema,
      workspaceId: opaqueIdSchema,
      executionId: opaqueIdSchema.optional(),
      runId: opaqueIdSchema.optional(),
      parentExecutionId: opaqueIdSchema.optional(),
      operationId: opaqueIdSchema.optional(),
    })
    .optional(),
};
export const traceEventViewSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...traceEnvelope,
    kind: z.literal('message'),
    attributes: trajectoryAttributesSchemas.message
      .pick({ role: true, messageSeq: true, revision: true, status: true })
      .extend({ messageRef: opaqueIdSchema }),
  }),
  z.strictObject({
    ...traceEnvelope,
    kind: z.literal('command'),
    attributes: trajectoryAttributesSchemas.command
      .omit({ commandId: true })
      .extend({ commandRef: opaqueIdSchema }),
  }),
  z.strictObject({
    ...traceEnvelope,
    kind: z.literal('run'),
    attributes: trajectoryAttributesSchemas.run
      .omit({ commandId: true, rootWorkCommandId: true })
      .extend({
        commandRef: opaqueIdSchema.optional(),
        rootWorkCommandRef: opaqueIdSchema.optional(),
      }),
  }),
  z.strictObject({
    ...traceEnvelope,
    kind: z.literal('model'),
    attributes: trajectoryAttributesSchemas.model
      .omit({
        commandId: true,
        rootWorkCommandId: true,
        definitionId: true,
        previousExecutionId: true,
        previousExecutionOriginStoreId: true,
        display: true,
      })
      .extend({
        ...attribution,
        previousExecutionRef: opaqueIdSchema.optional(),
        previousExecutionOriginStoreRef: opaqueIdSchema.optional(),
      }),
  }),
  z.strictObject({
    ...traceEnvelope,
    kind: z.literal('tool'),
    attributes: trajectoryAttributesSchemas.tool
      .omit({
        commandId: true,
        rootWorkCommandId: true,
        definitionId: true,
        callId: true,
        display: true,
      })
      .extend({ ...attribution, callRef: opaqueIdSchema.optional() }),
  }),
  z.strictObject({
    ...traceEnvelope,
    kind: z.literal('job'),
    attributes: trajectoryAttributesSchemas.job
      .omit({
        commandId: true,
        rootWorkCommandId: true,
        definitionId: true,
        childSessionId: true,
        display: true,
      })
      .extend({ ...attribution, childSessionRef: opaqueIdSchema.optional() }),
  }),
  z.strictObject({
    ...traceEnvelope,
    kind: z.literal('interaction'),
    attributes: trajectoryAttributesSchemas.interaction
      .omit({ interactionId: true })
      .extend({ interactionRef: opaqueIdSchema }),
  }),
  z.strictObject({
    ...traceEnvelope,
    kind: z.literal('child'),
    attributes: trajectoryAttributesSchemas.child
      .omit({ childSessionId: true, carrierExecutionId: true, childRunId: true })
      .extend({
        childSessionRef: opaqueIdSchema,
        carrierExecutionRef: opaqueIdSchema,
        childRunRef: opaqueIdSchema.optional(),
      }),
  }),
  z.strictObject({
    ...traceEnvelope,
    kind: z.literal('context'),
    attributes: trajectoryAttributesSchemas.context
      .omit({ selectionId: true, compressionId: true })
      .extend({
        selectionRef: opaqueIdSchema.optional(),
        compressionRef: opaqueIdSchema.optional(),
      }),
  }),
  z.strictObject({
    ...traceEnvelope,
    kind: z.literal('recovery'),
    attributes: trajectoryAttributesSchemas.recovery,
  }),
  z.strictObject({
    ...traceEnvelope,
    kind: z.literal('artifact'),
    attributes: trajectoryAttributesSchemas.artifact
      .omit({ artifactId: true })
      .extend({ artifactRef: opaqueIdSchema }),
  }),
  z.strictObject({
    ...traceEnvelope,
    kind: z.literal('verification'),
    attributes: trajectoryAttributesSchemas.verification
      .omit({ verificationId: true })
      .extend({ verificationRef: opaqueIdSchema }),
  }),
  z.strictObject({
    ...traceEnvelope,
    kind: z.literal('unknown'),
    attributes: trajectoryAttributesSchemas.unknown,
  }),
]);
export type TraceEventView = z.infer<typeof traceEventViewSchema>;
export const tracePartitionSchema = z.strictObject({
  installationId: opaqueIdSchema,
  storeRef: opaqueIdSchema,
  sessionRef: opaqueIdSchema,
  subscriptionEpoch: decimal64Schema,
  lane: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('live') }),
    z.strictObject({ kind: z.literal('history'), exportId: opaqueIdSchema }),
  ]),
});
const traceBatchShape = {
  batchId: opaqueIdSchema,
  leaseToken: opaqueIdSchema,
  processGeneration: decimal64Schema,
  partition: tracePartitionSchema,
  grantRevision: decimal64Schema,
  filterRevision: decimal64Schema,
  upperCursor: decimal64Schema,
  fromCursor: decimal64Schema,
  scannedThrough: decimal64Schema,
  events: z.array(traceEventViewSchema).max(200),
  integrity: integritySchema,
};
export const traceBatchSchema = z.discriminatedUnion('source', [
  z.strictObject({
    ...traceBatchShape,
    source: z.literal('live'),
    partition: tracePartitionSchema.extend({ lane: z.strictObject({ kind: z.literal('live') }) }),
  }),
  z.strictObject({
    ...traceBatchShape,
    source: z.literal('history'),
    partition: tracePartitionSchema.extend({
      lane: z.strictObject({ kind: z.literal('history'), exportId: opaqueIdSchema }),
    }),
  }),
]);
export const traceRejectSchema = z.strictObject({
  eventId: opaqueIdSchema,
  reason: z.enum([
    'retry',
    'invalid_event',
    'unsupported_kind',
    'capacity_exceeded',
    'delivery_failed',
  ]),
});
export const deliveryResultSchema = z.strictObject({
  batchId: opaqueIdSchema,
  leaseToken: opaqueIdSchema,
  processGeneration: decimal64Schema,
  subscriptionEpoch: decimal64Schema,
  acknowledgedEventIds: z.array(opaqueIdSchema).max(200),
  rejected: z.array(traceRejectSchema).max(200),
});
export type TracePartition = z.infer<typeof tracePartitionSchema>;
export type TraceEventBatch = z.infer<typeof traceBatchSchema>;
export type TraceDeliveryResult = z.infer<typeof deliveryResultSchema>;
/** Membership validation precedes any ACK transaction; grant and lease rechecks belong to Host. */
export function validateDeliveryResult(
  value: unknown,
  batch: TraceEventBatch,
): TraceDeliveryResult {
  const result = deliveryResultSchema.parse(value);
  if (
    result.batchId !== batch.batchId ||
    result.leaseToken !== batch.leaseToken ||
    result.processGeneration !== batch.processGeneration ||
    result.subscriptionEpoch !== batch.partition.subscriptionEpoch
  )
    throw new Error('invalid_trace_delivery');
  const sent = new Set(batch.events.map((event) => event.eventId));
  const seen = new Set<string>();
  for (const id of [
    ...result.acknowledgedEventIds,
    ...result.rejected.map((item) => item.eventId),
  ]) {
    if (!sent.has(id) || seen.has(id)) throw new Error('invalid_trace_delivery');
    seen.add(id);
  }
  return result;
}
