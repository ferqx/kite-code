import { z } from 'zod';
import { trajectoryBundleManifestSchema } from './bundle';
import { decimal64Schema } from './cursor';
import {
  deliveryResultSchema,
  traceBatchSchema,
  traceEventViewSchema,
  tracePartitionSchema,
} from './delivery';
import { trajectoryEventSchema } from './events';
import {
  evidenceChunkSchema,
  evidenceCloseRequestSchema,
  evidenceDescriptorSchema,
  evidenceOpenSchema,
  evidenceReadRequestSchema,
  evidenceRefSchema,
} from './evidence';
import { historyCoverageSchema, integritySchema } from './integrity';
import {
  trajectoryPageSchema,
  trajectoryReadRequestSchema,
  trajectorySnapshotSchema,
} from './reader';

export const trajectorySchemas = {
  Decimal64: decimal64Schema,
  TrajectoryBundleManifest: trajectoryBundleManifestSchema,
  TrajectoryEvent: trajectoryEventSchema,
  TrajectoryEvidenceRef: evidenceRefSchema,
  TrajectoryEvidenceOpen: evidenceOpenSchema,
  TrajectoryEvidenceReadRequest: evidenceReadRequestSchema,
  TrajectoryEvidenceCloseRequest: evidenceCloseRequestSchema,
  TrajectoryEvidenceDescriptor: evidenceDescriptorSchema,
  TrajectoryEvidenceChunk: evidenceChunkSchema,
  TrajectoryIntegrity: integritySchema,
  HistoryCoverage: historyCoverageSchema,
  TrajectorySnapshot: trajectorySnapshotSchema,
  TrajectoryReadRequest: trajectoryReadRequestSchema,
  TrajectoryPage: trajectoryPageSchema,
  TraceEventView: traceEventViewSchema,
  TracePartition: tracePartitionSchema,
  TraceEventBatch: traceBatchSchema,
  TraceDeliveryResult: deliveryResultSchema,
} as const;
/** Generated from the runtime validators; Service imports the same schemas for HTTP generation. */
export function trajectoryJsonSchemas() {
  return Object.fromEntries(
    Object.entries(trajectorySchemas).map(([name, schema]) => [name, z.toJSONSchema(schema)]),
  );
}
