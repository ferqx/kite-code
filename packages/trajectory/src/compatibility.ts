import { z } from 'zod';
import { decimal64Schema } from './cursor';
import { type TrajectoryEvent, trajectoryEventSchema } from './events';
import { opaqueIdSchema } from './evidence';

// Only these fields survive an unsupported major version. No unknown attributes or evidence escape.
const safeEnvelopeSchema = z.object({
  schema: z.literal('kite.trajectory'),
  schemaVersion: z.number().int().positive(),
  eventId: z.string().regex(/^te_[a-f0-9]{64}$/),
  sequence: decimal64Schema,
  origin: z.strictObject({ storeId: opaqueIdSchema, cursor: decimal64Schema }),
  sessionId: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  sourceEventType: z.string().min(1).max(256),
});
export type SafeTrajectoryEnvelope = z.infer<typeof safeEnvelopeSchema>;
export type DecodedTrajectoryEvent =
  | { status: 'supported'; event: TrajectoryEvent }
  | { status: 'unsupported_version'; envelope: SafeTrajectoryEnvelope }
  | { status: 'invalid'; reason: 'corrupt_fact' };
export function decodeTrajectoryEvent(value: unknown): DecodedTrajectoryEvent {
  const envelope = safeEnvelopeSchema.safeParse(value);
  if (!envelope.success) return { status: 'invalid', reason: 'corrupt_fact' };
  if (envelope.data.schemaVersion !== 1)
    return { status: 'unsupported_version', envelope: envelope.data };
  const parsed = trajectoryEventSchema.safeParse(value);
  return parsed.success
    ? { status: 'supported', event: parsed.data }
    : { status: 'invalid', reason: 'corrupt_fact' };
}
