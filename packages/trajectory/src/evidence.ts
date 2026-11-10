import { z } from 'zod';
import { decimal64Schema } from './cursor';

export const opaqueIdSchema = z.string().min(1).max(512);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const evidenceKindSchema = z.enum([
  'model_input',
  'model_output',
  'tool_input',
  'tool_result',
  'job_output',
  'artifact',
  'file_change',
  'verification',
  'interaction',
  'context',
  'message',
]);
export const evidenceAvailabilitySchema = z.enum([
  'available',
  'partial',
  'truncated',
  'missing',
  'unavailable',
  'redacted',
  'empty',
]);
export const evidenceRefSchema = z.strictObject({
  evidenceId: opaqueIdSchema,
  contentVersion: opaqueIdSchema,
  kind: evidenceKindSchema,
  availability: evidenceAvailabilitySchema,
  mediaType: z.string().min(1).max(256),
  visibleBytes: decimal64Schema.optional(),
});
export type TrajectoryEvidenceRef = z.infer<typeof evidenceRefSchema>;
export const evidenceOpenSchema = z.strictObject({
  storeId: opaqueIdSchema,
  sessionId: opaqueIdSchema,
  upperCursor: decimal64Schema,
  atCursor: decimal64Schema,
  eventId: opaqueIdSchema,
  evidenceId: opaqueIdSchema,
  contentVersion: opaqueIdSchema,
});
export const evidenceDescriptorSchema = z.strictObject({
  readId: opaqueIdSchema,
  eventId: opaqueIdSchema,
  evidenceId: opaqueIdSchema,
  contentVersion: opaqueIdSchema,
  availability: evidenceAvailabilitySchema,
  mediaType: z.string().min(1).max(256),
  viewBytes: decimal64Schema,
  viewSha256: sha256Schema,
  transformation: opaqueIdSchema,
  policyRevision: decimal64Schema,
  authorizationEpoch: decimal64Schema,
});
export const evidenceChunkSchema = z.strictObject({
  readId: opaqueIdSchema,
  offset: decimal64Schema,
  nextOffset: decimal64Schema,
  data: z.string(),
  eof: z.boolean(),
  viewSha256: sha256Schema,
  policyRevision: decimal64Schema,
  authorizationEpoch: decimal64Schema,
});
export type TrajectoryEvidenceOpen = z.infer<typeof evidenceOpenSchema>;
export type TrajectoryEvidenceDescriptor = z.infer<typeof evidenceDescriptorSchema>;
export type TrajectoryEvidenceChunk = z.infer<typeof evidenceChunkSchema>;

export const evidenceReadRequestSchema = z.strictObject({
  storeId: opaqueIdSchema,
  sessionId: opaqueIdSchema,
  readId: opaqueIdSchema,
  offset: decimal64Schema,
  limit: z.number().int().min(1).max(65536).optional(),
});
export const evidenceCloseRequestSchema = z.strictObject({
  storeId: opaqueIdSchema,
  sessionId: opaqueIdSchema,
  readId: opaqueIdSchema,
});
export type TrajectoryEvidenceReadRequest = z.infer<typeof evidenceReadRequestSchema>;
export type TrajectoryEvidenceCloseRequest = z.infer<typeof evidenceCloseRequestSchema>;
