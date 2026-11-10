import { decimal64Schema, integritySchema, trajectoryScopeSchema } from '@kite-ai/trajectory';
import { z } from 'zod';
import { otelIntegrationConfigSchema } from '../trace-integrations/opentelemetry/configuration';
import { traceConsumerInspectionSchema } from './consumer';
import { traceGrantSchema, traceHistoryRequestSchema, traceManifestSchema } from './types';

const installationStatus = z.enum([
  'installed',
  'configured',
  'enabled',
  'disabled',
  'uninstalled',
]);
export const traceBundleSchema = z.strictObject({
  apiVersion: z.literal(1),
  source: z.string().max(512 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const traceInstallRequestSchema = z.strictObject({
  manifest: traceManifestSchema,
  bundle: traceBundleSchema,
});
export const traceOtelInstallRequestSchema = otelIntegrationConfigSchema
  .omit({ credentialHandle: true })
  .extend({ sampleRate: otelIntegrationConfigSchema.shape.sampleRate.unwrap().optional() });
const installationSummarySchema = z.strictObject({
  kind: z.enum(['third_party', 'opentelemetry']),
  installationId: z.string().uuid(),
  name: z.string(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  status: installationStatus,
});
export const tracePartitionStatusSchema = z.strictObject({
  id: z.string(),
  installationId: z.string().uuid(),
  epoch: decimal64Schema,
  lane: z.enum(['live', 'history']),
  exportId: z.string().optional(),
  scope: trajectoryScopeSchema,
  fromCursor: decimal64Schema,
  upperCursor: decimal64Schema,
  sourceScanPosition: decimal64Schema,
  contiguousAcknowledgedPosition: decimal64Schema,
  status: z.enum(['active', 'paused', 'cancelled', 'revoked', 'unavailable']),
  integrity: integritySchema,
  pending: z.number().int().nonnegative(),
  deadLetter: z.number().int().nonnegative(),
  exhausted: z.boolean(),
  deliveryComplete: z.boolean(),
  contentMode: z.enum(['metadata', 'authorized_evidence']),
});
const settingsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number().finite(), z.boolean()]),
);
const credentialSchema = z.strictObject({
  handle: z.string().uuid(),
  origin: z.string(),
  active: z.boolean(),
});
export const traceInstallationSchema = installationSummarySchema.extend({
  manifest: traceManifestSchema,
  settings: settingsSchema,
  grant: z
    .strictObject({
      revision: decimal64Schema,
      epoch: decimal64Schema,
      active: z.boolean(),
      grant: traceGrantSchema,
    })
    .nullable(),
  partitions: z.array(tracePartitionStatusSchema),
  credentials: z.array(credentialSchema),
});
export const traceExtensionSchemas = {
  TraceOtelInstallRequest: traceOtelInstallRequestSchema,
  TraceRemoteDeliveryStatus: z.discriminatedUnion('status', [
    z.strictObject({ kind: z.literal('third_party'), status: z.literal('not_applicable') }),
    z.strictObject({
      kind: z.literal('opentelemetry'),
      status: z.literal('not_started'),
      inspection: z.null(),
    }),
    z.strictObject({
      kind: z.literal('opentelemetry'),
      status: z.literal('unavailable'),
      inspection: z.null(),
      code: z.literal('inspection_unavailable'),
    }),
    z.strictObject({
      kind: z.literal('opentelemetry'),
      status: z.literal('available'),
      inspection: traceConsumerInspectionSchema,
    }),
  ]),
  TraceInstallRequest: traceInstallRequestSchema,
  TraceBundleValidation: z.strictObject({
    valid: z.literal(true),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  TraceInstallResult: z.strictObject({ installationId: z.string().uuid() }),
  TraceInstallationList: z.strictObject({ installations: z.array(installationSummarySchema) }),
  TraceInstallation: traceInstallationSchema,
  TraceAction: z.strictObject({}),
  TraceActionResult: z.strictObject({ completed: z.literal(true) }),
  TraceConfigureRequest: z.strictObject({ settings: settingsSchema }),
  TraceGrantRequest: traceGrantSchema,
  TraceHistoryRequest: traceHistoryRequestSchema,
  TraceHistoryResult: z.strictObject({ partitionId: z.string() }),
  TracePartitionStatus: tracePartitionStatusSchema,
  TraceDeadLetterList: z.strictObject({
    entries: z
      .array(
        z.strictObject({
          eventId: z.string(),
          sequence: decimal64Schema,
          attempts: z.number().int().min(8),
          reason: z.enum([
            'retry',
            'invalid_event',
            'unsupported_kind',
            'capacity_exceeded',
            'delivery_failed',
          ]),
        }),
      )
      .max(200),
  }),
  TraceCredentialBind: z.strictObject({
    origin: z.string().max(2048),
    secret: z.string().min(1).max(8192),
  }),
  TraceCredentialResult: z.strictObject({ handle: z.string().uuid(), origin: z.string() }),
  TraceCredentialRevoke: z.strictObject({ handle: z.string().uuid() }),
} as const;
export const traceExtensionRoutes = [
  {
    method: 'get',
    path: '/v1/trace/extensions/{installationId}/delivery',
    response: 'TraceRemoteDeliveryStatus',
  },
  {
    method: 'post',
    path: '/v1/trace/integrations/opentelemetry/install',
    request: 'TraceOtelInstallRequest',
    response: 'TraceInstallResult',
    statuses: [201],
  },
  { method: 'get', path: '/v1/trace/extensions', response: 'TraceInstallationList' },
  {
    method: 'post',
    path: '/v1/trace/extensions/validate',
    request: 'TraceInstallRequest',
    response: 'TraceBundleValidation',
  },
  {
    method: 'post',
    path: '/v1/trace/extensions/install',
    request: 'TraceInstallRequest',
    response: 'TraceInstallResult',
    statuses: [201],
  },
  { method: 'get', path: '/v1/trace/extensions/{installationId}', response: 'TraceInstallation' },
  {
    method: 'post',
    path: '/v1/trace/extensions/{installationId}/configure',
    request: 'TraceConfigureRequest',
    response: 'TraceInstallation',
  },
  {
    method: 'post',
    path: '/v1/trace/extensions/{installationId}/grant',
    request: 'TraceGrantRequest',
    response: 'TraceInstallation',
  },
  ...(['enable', 'disable', 'revoke', 'uninstall'] as const).map((action) => ({
    method: 'post' as const,
    path: `/v1/trace/extensions/{installationId}/${action}`,
    request: 'TraceAction' as const,
    response: 'TraceActionResult' as const,
  })),
  {
    method: 'post',
    path: '/v1/trace/extensions/{installationId}/update',
    request: 'TraceInstallRequest',
    response: 'TraceInstallation',
  },
  {
    method: 'post',
    path: '/v1/trace/extensions/{installationId}/history',
    request: 'TraceHistoryRequest',
    response: 'TraceHistoryResult',
  },
  {
    method: 'get',
    path: '/v1/trace/extensions/{installationId}/partitions/{partitionId}',
    response: 'TracePartitionStatus',
  },
  {
    method: 'get',
    path: '/v1/trace/extensions/{installationId}/partitions/{partitionId}/dead-letters',
    response: 'TraceDeadLetterList',
  },
  {
    method: 'post',
    path: '/v1/trace/extensions/{installationId}/partitions/{partitionId}/retry',
    request: 'TraceAction',
    response: 'TraceActionResult',
  },
  {
    method: 'post',
    path: '/v1/trace/extensions/{installationId}/partitions/{partitionId}/cancel',
    request: 'TraceAction',
    response: 'TraceActionResult',
  },
  ...(['pause', 'resume'] as const).map((action) => ({
    method: 'post' as const,
    path: `/v1/trace/extensions/{installationId}/partitions/{partitionId}/${action}`,
    request: 'TraceAction' as const,
    response: 'TraceActionResult' as const,
  })),
  {
    method: 'post',
    path: '/v1/trace/extensions/{installationId}/credentials/bind',
    request: 'TraceCredentialBind',
    response: 'TraceCredentialResult',
  },
  {
    method: 'post',
    path: '/v1/trace/extensions/{installationId}/credentials/revoke',
    request: 'TraceCredentialRevoke',
    response: 'TraceActionResult',
  },
] as const;
