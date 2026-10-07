import { z } from 'zod';

const id = z.string().min(1).max(256);
const scopeId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const mode = z.enum(['ask', 'auto', 'accept_edits', 'full']).nullable();
const state = z.enum(['available', 'unavailable']);
export const HostStatusQuerySchema = z.strictObject({
  workspaceId: scopeId.optional(),
  sessionId: scopeId.optional(),
});
export const HostStatusSchema = z.strictObject({
  version: z.literal(1),
  identity: z.strictObject({
    instanceId: id,
    buildId: id,
    apiMajor: z.literal(1),
    profileAccessKey: id,
    dataAvailability: z.enum(['available', 'unavailable']),
    storeId: id.nullable(),
  }),
  scope: z.strictObject({ workspaceId: id.nullable(), sessionId: id.nullable() }),
  execution: z.strictObject({
    state,
    reason: z.enum(['diagnostic_source_unavailable']).nullable(),
    sandbox: z.discriminatedUnion('backend', [
      z.strictObject({
        backend: z.literal('none'),
        available: z.literal(false),
        qualification: z.literal('unqualified'),
      }),
      z.strictObject({
        backend: z.literal('macos_seatbelt'),
        available: z.literal(true),
        qualification: z.literal('host_scope'),
      }),
    ]),
    shell: z.strictObject({
      configured: z.boolean(),
      available: z.boolean(),
      supervision: z.enum(['none', 'posix_group', 'macos_coalition']),
      qualification: z.enum([
        'not_configured',
        'darwin_supervision_only',
        'darwin_host_boundary',
        'unavailable',
      ]),
      reason: z
        .enum([
          'shell_not_configured',
          'shell_platform_unqualified',
          'shell_asset_unavailable',
          'invalid_shell_configuration',
          'diagnostic_source_unavailable',
        ])
        .nullable(),
    }),
    permissions: z.strictObject({
      state: z.enum(['available', 'unbound', 'unavailable']),
      scope: z.enum(['default', 'session', 'unbound']),
      mode,
      defaultMode: mode,
      workspaceTrust: z.enum(['trusted', 'untrusted', 'scope_changed', 'unbound', 'unavailable']),
      reason: z.enum(['data_unavailable', 'permission_source_unavailable']).nullable(),
    }),
  }),
  release: z.strictObject({
    state,
    active: z.literal(false),
    production: z.null(),
    qualification: z.literal('unverified'),
    reason: z.enum(['release_manifest_not_bound', 'diagnostic_source_unavailable']),
  }),
  telemetry: z.strictObject({
    state,
    enabled: z.literal(false),
    exporterConfigured: z.literal(false),
    diskSpool: z.literal(false),
    reason: z.enum(['exporter_not_configured', 'diagnostic_source_unavailable']),
  }),
});
