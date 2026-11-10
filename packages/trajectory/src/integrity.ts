import { z } from 'zod';
import { decimal64Schema } from './cursor';

export const integrityReasonSchema = z.enum([
  'legacy_format',
  'history_purged',
  'missing_fact',
  'corrupt_fact',
  'unknown_version',
  'unknown_event',
  'identity_unverified',
  'missing_material',
  'truncated_material',
  'incomplete_prefix',
  'source_unavailable',
]);
export const integritySchema = z.strictObject({
  facts: z.enum(['complete', 'partial', 'unknown']),
  identityConfidence: z.enum(['verified_origin', 'legacy_local']),
  reasons: z.array(integrityReasonSchema),
});
export const historyCoverageSchema = z.strictObject({
  enabledAfterCursor: decimal64Schema,
  upperCursor: decimal64Schema,
  status: z.enum(['retained', 'legacy', 'purged', 'unknown']),
  integrity: integritySchema,
});
export type TrajectoryIntegrity = z.infer<typeof integritySchema>;
export type HistoryCoverage = z.infer<typeof historyCoverageSchema>;
