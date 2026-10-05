import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const sequence = decimal.max(19).refine((value) => BigInt(value) <= 9223372036854775807n);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(4096);
export const FileCheckpointListQuerySchema = z.strictObject({
  afterKey: z
    .string()
    .regex(/^checkpoint\/[a-f0-9]{64}\/point$/)
    .optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export const FileCheckpointBaselineSchema = z.strictObject({
  hash,
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  device: decimal,
  inode: decimal,
});
export const FileCheckpointArtifactSchema = z.strictObject({
  id: text,
  mediaType: z.literal('application/octet-stream'),
  size: decimal,
  scope: z.strictObject({ kind: z.literal('execution'), id }),
});
export const FileCheckpointBoundarySchema = z.strictObject({
  storeId: id,
  workspaceId: id,
  sessionId: id,
  runId: id,
  contextSelectionId: id,
  messageId: id.nullable(),
  messageSeq: sequence,
  triggerMessageId: id,
  triggerSeq: sequence,
});
export const FileCheckpointSchema = z.strictObject({
  id: hash,
  boundary: FileCheckpointBoundarySchema,
  workspace: z.strictObject({ device: decimal, inode: decimal }),
});
const directory = z.strictObject({
  items: z.array(z.strictObject({ checkpoint: FileCheckpointSchema, revision: sequence })).max(200),
  nextAfterKey: z
    .string()
    .regex(/^checkpoint\/[a-f0-9]{64}\/point$/)
    .nullable(),
});
const preview = z.strictObject({
  checkpoint: FileCheckpointSchema,
  files: z.array(
    z.strictObject({
      path: text,
      recordRevision: sequence,
      status: z.enum(['restore', 'remove', 'unchanged', 'conflict', 'unavailable']),
      reason: z.string().max(256).nullable(),
      preimage: FileCheckpointArtifactSchema.nullable(),
      original: FileCheckpointBaselineSchema.nullable(),
      expected: FileCheckpointBaselineSchema.nullable(),
    }),
  ),
});
const journalFile = z.strictObject({
  path: text,
  operation: z.enum(['restore', 'remove', 'unchanged']),
  state: z.enum([
    'not_started',
    'pending',
    'restored',
    'removed',
    'unchanged',
    'failed',
    'outcome_unknown',
  ]),
  expected: FileCheckpointBaselineSchema,
  original: FileCheckpointBaselineSchema.nullable(),
  preimage: FileCheckpointArtifactSchema.nullable(),
  error: z.string().max(256).nullable(),
});
const journal = z.strictObject({
  id,
  checkpointId: hash,
  executionId: id,
  planDigest: hash,
  phase: z.enum(['restoring', 'restored', 'failed', 'outcome_unknown']),
  files: z.array(journalFile),
});
const journalV2 = journal.extend({
  rootWorkSeq: sequence,
  files: z.array(
    journalFile.extend({
      expected: FileCheckpointBaselineSchema.nullable(),
      confirmedPost: z
        .strictObject({ baseline: FileCheckpointBaselineSchema.nullable() })
        .nullable(),
    }),
  ),
});
const blocked = z.strictObject({
  id,
  checkpointId: hash,
  phase: z.literal('blocked'),
  reason: z.literal('checkpoint_restore_boundary_unavailable'),
  headRevision: sequence,
  fileRevisions: z.array(z.strictObject({ path: text, revision: sequence })),
});
export const FileCheckpointRestoreJournalSchema = z.union([blocked, journal, journalV2]);
const restoreStatus = z.strictObject({
  journal: FileCheckpointRestoreJournalSchema.nullable(),
  execution: z
    .strictObject({
      id,
      status: z.enum([
        'planned',
        'dispatching',
        'running',
        'succeeded',
        'failed',
        'cancelled',
        'outcome_unknown',
      ]),
      resultRevision: sequence,
    })
    .nullable(),
});
const observation = { storeId: id, sessionId: id, workspaceId: id };
/** Current observation is separate from each immutable original point and carrier. */
export const FileCheckpointPageSchema = z.strictObject({ ...observation, payload: directory });
export const FileCheckpointDetailSchema = z.strictObject({ ...observation, payload: preview });
export const FileRestoreStatusSchema = z.strictObject({ ...observation, payload: restoreStatus });
/** Selected current aliases are distinct from the checkpoint's immutable source boundary. */
export const FileCheckpointRecoveryBoundarySchema = z.strictObject({
  ...observation,
  contextSelectionId: id,
  checkpoint: FileCheckpointSchema,
  boundary: z.strictObject({ messageId: id, seq: sequence }).nullable(),
  trigger: z.strictObject({ messageId: id, seq: sequence }),
});
