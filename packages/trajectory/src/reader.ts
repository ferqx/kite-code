import { z } from 'zod';
import { decimal64Schema, parseDecimal64 } from './cursor';
import { knownTrajectoryKindSchema, trajectoryEventSchema } from './events';
import { opaqueIdSchema } from './evidence';
import { canonicalSerialize } from './identity';
import { historyCoverageSchema, integritySchema } from './integrity';

export const trajectoryScopeSchema = z.strictObject({
  storeId: opaqueIdSchema,
  sessionId: opaqueIdSchema,
  runId: opaqueIdSchema.optional(),
  executionId: opaqueIdSchema.optional(),
  eventKinds: z
    .array(knownTrajectoryKindSchema)
    .max(knownTrajectoryKindSchema.options.length)
    .optional(),
});
export const trajectorySnapshotSchema = z.strictObject({
  ...trajectoryScopeSchema.shape,
  upperCursor: decimal64Schema,
  historyCoverage: historyCoverageSchema,
  formatVersion: z.literal(1),
});
export const trajectoryReadRequestSchema = z.strictObject({
  ...trajectoryScopeSchema.shape,
  afterCursor: decimal64Schema,
  upperCursor: decimal64Schema,
  limit: z.number().int().min(1).max(200).optional(),
});
export const trajectoryPageSchema = z.strictObject({
  ...trajectoryScopeSchema.shape,
  afterCursor: decimal64Schema,
  upperCursor: decimal64Schema,
  scannedThrough: decimal64Schema,
  exhausted: z.boolean(),
  events: z.array(trajectoryEventSchema).max(200),
  integrity: integritySchema,
});
export type TrajectoryScope = z.infer<typeof trajectoryScopeSchema>;
export type TrajectorySnapshot = z.infer<typeof trajectorySnapshotSchema>;
export type TrajectoryReadRequest = z.infer<typeof trajectoryReadRequestSchema>;
export type TrajectoryPage = z.infer<typeof trajectoryPageSchema>;
/** Empty matching pages may advance; gaps between global source cursors are ordinary filtering. */
export function verifyTrajectoryPage(
  value: unknown,
  request: TrajectoryReadRequest,
): TrajectoryPage {
  const query = trajectoryReadRequestSchema.parse(request);
  const page = trajectoryPageSchema.parse(value);
  const after = parseDecimal64(query.afterCursor);
  const upper = parseDecimal64(query.upperCursor);
  const through = parseDecimal64(page.scannedThrough);
  if (
    after > upper ||
    through < after ||
    through > upper ||
    page.storeId !== query.storeId ||
    page.sessionId !== query.sessionId ||
    page.runId !== query.runId ||
    page.executionId !== query.executionId ||
    canonicalSerialize(page.eventKinds ?? []) !== canonicalSerialize(query.eventKinds ?? []) ||
    page.upperCursor !== query.upperCursor ||
    page.afterCursor !== query.afterCursor ||
    page.exhausted !== (through === upper) ||
    (!page.exhausted && through === after) ||
    page.events.length > (query.limit ?? 200)
  )
    throw new Error('invalid_trajectory_page');
  let previous = after;
  const eventIds = new Set<string>();
  for (const event of page.events) {
    const cursor = parseDecimal64(event.sequence);
    if (
      cursor <= previous ||
      cursor > through ||
      event.sessionId !== query.sessionId ||
      (query.runId !== undefined && event.runId !== query.runId) ||
      (query.executionId !== undefined && event.executionId !== query.executionId) ||
      (query.eventKinds !== undefined && !query.eventKinds.some((kind) => kind === event.kind)) ||
      eventIds.has(event.eventId)
    )
      throw new Error('invalid_trajectory_page');
    previous = cursor;
    eventIds.add(event.eventId);
  }
  return page;
}
