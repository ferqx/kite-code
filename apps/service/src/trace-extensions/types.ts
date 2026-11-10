import {
  decimal64Schema,
  evidenceKindSchema,
  knownTrajectoryKindSchema,
  trajectoryScopeSchema,
} from '@kite-ai/trajectory';
import { z } from 'zod';

const name = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
const settingName = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/);
const origin = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ['https:', 'http:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        url.origin === value
      );
    } catch {
      return false;
    }
  });
export const traceManifestSchema = z.strictObject({
  apiVersion: z.literal(1),
  name,
  history: z.boolean(),
  eventKinds: z.array(knownTrajectoryKindSchema).max(knownTrajectoryKindSchema.options.length),
  evidenceKinds: z.array(evidenceKindSchema).max(evidenceKindSchema.options.length),
  origins: z.array(origin).max(8),
  settings: z
    .record(settingName, z.enum(['string', 'number', 'boolean']))
    .refine((value) => Object.keys(value).length <= 16),
});
export const traceGrantSchema = z.strictObject({
  scopes: z
    .array(trajectoryScopeSchema.omit({ eventKinds: true }))
    .min(1)
    .max(64),
  eventKinds: z
    .array(knownTrajectoryKindSchema)
    .min(1)
    .max(knownTrajectoryKindSchema.options.length),
  metadata: z.array(z.enum(['timing', 'usage', 'output_checkpoint'])).max(3),
  evidenceKinds: z.array(evidenceKindSchema).max(evidenceKindSchema.options.length),
  origins: z.array(origin).max(8),
  originalIdentity: z.boolean(),
  allowHistory: z.boolean(),
  credentialHandles: z.array(z.string().uuid()).max(8).optional(),
  allowPrivateNetwork: z.boolean().optional(),
  evidenceContent: z.enum(['redacted', 'full']).optional(),
});
export type TraceManifest = z.infer<typeof traceManifestSchema>;
export type TraceGrant = z.infer<typeof traceGrantSchema>;
export interface TraceGrantState {
  revision: string;
  epoch: string;
  active: boolean;
  grant: TraceGrant;
}
export const traceHistoryRequestSchema = z.strictObject({
  scope: trajectoryScopeSchema.omit({ eventKinds: true }),
  fromSequence: decimal64Schema.optional(),
  toSequence: decimal64Schema.optional(),
  eventKinds: z
    .array(knownTrajectoryKindSchema)
    .max(knownTrajectoryKindSchema.options.length)
    .optional(),
  contentMode: z.enum(['metadata', 'authorized_evidence']),
});
export type TraceHistoryRequest = z.infer<typeof traceHistoryRequestSchema>;
export class TraceHostError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export function sameScope(
  grant: TraceGrant,
  scope: { storeId: string; sessionId: string; runId?: string; executionId?: string },
): boolean {
  return grant.scopes.some(
    (allowed) =>
      allowed.storeId === scope.storeId &&
      allowed.sessionId === scope.sessionId &&
      (allowed.runId === undefined || allowed.runId === scope.runId) &&
      (allowed.executionId === undefined || allowed.executionId === scope.executionId),
  );
}
