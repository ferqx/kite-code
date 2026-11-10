import { z } from 'zod';
import { decimal64Schema } from './cursor';
import { evidenceAvailabilitySchema, opaqueIdSchema, sha256Schema } from './evidence';
import { integritySchema } from './integrity';
import { trajectorySnapshotSchema } from './reader';

const section = { path: z.string().min(1).max(256), bytes: decimal64Schema, sha256: sha256Schema };
export const trajectoryBundleManifestSchema = z.strictObject({
  format: z.literal('kite.trajectory-bundle'),
  version: z.literal(1),
  snapshot: trajectorySnapshotSchema,
  fromCursor: decimal64Schema,
  toCursor: decimal64Schema,
  completePrefix: z.boolean(),
  integrity: integritySchema,
  sections: z.array(
    z.discriminatedUnion('kind', [
      z.strictObject({
        ...section,
        kind: z.literal('events'),
        afterCursor: decimal64Schema,
        scannedThrough: decimal64Schema,
        eventCount: z.number().int().min(0).max(200),
      }),
      z.strictObject({
        ...section,
        kind: z.literal('evidence'),
        eventId: opaqueIdSchema,
        evidenceId: opaqueIdSchema,
        contentVersion: opaqueIdSchema,
        mediaType: z.string().min(1).max(256),
        availability: evidenceAvailabilitySchema,
      }),
    ]),
  ),
});
export type TrajectoryBundleManifest = z.infer<typeof trajectoryBundleManifestSchema>;
export type TrajectoryBundleSection = TrajectoryBundleManifest['sections'][number];
