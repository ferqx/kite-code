import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const key = z.string().min(1).max(256);
export const OutputFileTargetSchema = z.strictObject({
  storeId: id,
  sessionId: id,
  fileId: z.string().regex(/^[a-f0-9]{64}$/),
  locator: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('delivery'), key }),
    z.strictObject({ kind: z.literal('legacy-operation'), executionId: id }),
    z.strictObject({ kind: z.literal('legacy-inherited'), key }),
  ]),
});
export const OutputFileSummarySchema = OutputFileTargetSchema.extend({
  ownerRunId: id,
  name: z.string().min(1).max(512),
  mediaType: z.string().min(1).max(256),
  size: decimal,
  publishedAt: z.union([z.string().datetime(), z.literal('')]),
});
export const OutputFilesPageSchema = z.strictObject({
  scope: z.strictObject({ storeId: id, sessionId: id }),
  revision: decimal,
  items: z.array(OutputFileSummarySchema).max(50),
  collections: z
    .array(
      z.strictObject({
        collectionId: key.regex(/^collection\/[0-9]{20}\/[A-Za-z0-9_.:-]+$/),
        revision: decimal,
        ownerRunId: id,
        state: z.enum(['pending', 'failed', 'ready']),
        expectedCount: z.number().int().min(0).max(100).nullable(),
        publishedCount: z.number().int().min(0).max(100),
        errorCode: z.string().min(1).max(128).optional(),
        retryUntil: z.string().datetime().optional(),
      }),
    )
    .max(50),
  nextCursor: key.optional(),
  nextCollectionCursor: key.optional(),
});
export const OutputFilesQuerySchema = z.strictObject({
  storeId: id,
  runId: id.optional(),
  beforeKey: key.optional(),
  collectionBeforeKey: key.optional(),
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-4][0-9]|50)$/)
    .optional(),
});
export const OutputFileResolveRequestSchema = z.strictObject({
  expectedStoreId: id,
  target: OutputFileTargetSchema,
});
export const OutputCollectionRetryRequestSchema = z.strictObject({
  expectedStoreId: id,
  collectionId: key.regex(/^collection\/[0-9]{20}\/[A-Za-z0-9_.:-]+$/),
  expectedRevision: decimal,
});
