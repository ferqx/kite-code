import { z } from 'zod';

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const code = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9_]+$/);
const serverId = z.string().regex(/^mcp-[a-f0-9]{64}$/);
const sourceEntry = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('http'), url: z.string().min(1).max(8192) }),
  z.strictObject({ type: z.literal('stdio'), command: z.string().min(1).max(4096) }),
]);
const target = { serverId };
export const UserMcpSettingsOperationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('add'),
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    entry: sourceEntry,
  }),
  z.strictObject({ kind: z.literal('remove'), ...target }),
  z.strictObject({ kind: z.literal('enabled'), ...target, enabled: z.boolean() }),
  z.strictObject({ kind: z.literal('authStatus'), ...target }),
  z.strictObject({ kind: z.literal('login'), ...target }),
  z.strictObject({ kind: z.literal('authRefresh'), ...target }),
  z.strictObject({ kind: z.literal('clear'), ...target }),
  z.strictObject({ kind: z.literal('revoke'), ...target }),
  // The reference is an existing opaque vault handle, never a secret or a path.
  z.strictObject({
    kind: z.literal('bind'),
    ...target,
    expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({ kind: z.literal('connect'), ...target }),
  z.strictObject({ kind: z.literal('refresh'), ...target }),
  z.strictObject({ kind: z.literal('reconnect'), ...target }),
  z.strictObject({ kind: z.literal('disconnect'), ...target }),
]);
export const UserMcpSettingsQuerySchema = z.strictObject({ storeId: id });
export const UserMcpSettingsRequestSchema = z.strictObject({
  commandId: id,
  storeId: id,
  expectedReadSet: digest,
  operation: UserMcpSettingsOperationSchema,
});
export const UserMcpOperationQuerySchema = z.strictObject({ storeId: id });
export const UserMcpToolsQuerySchema = z.strictObject({
  storeId: id,
  serverId,
  generation: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  afterIndex: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
export const UserMcpAuthenticationSchema = z.strictObject({
  policy: z.enum(['none', 'credential', 'oauth', 'auto']),
  status: z.enum(['none', 'missing', 'present', 'locked', 'unavailable', 'unknown']),
  loginAllowed: z.boolean(),
});
export const UserMcpConnectionSchema = z.strictObject({
  state: z.enum(['disconnected', 'connecting', 'ready', 'failed', 'outcome_unknown']),
  generation: z.number().int().positive().nullable(),
  toolCount: z.number().int().nonnegative().nullable(),
});
export const UserMcpSettingsViewSchema = z.strictObject({
  scope: z.literal('user'),
  storeId: id,
  readSet: digest.nullable(),
  sources: z.array(
    z.strictObject({
      id: serverId,
      name: z.string().min(1).max(256),
      transport: z.enum(['http', 'stdio']).nullable(),
      address: z.string().max(8192).nullable(),
      enabled: z.boolean(),
      configured: z.boolean(),
      diagnostics: z.array(code),
      authentication: UserMcpAuthenticationSchema,
      connection: UserMcpConnectionSchema,
    }),
  ),
  errors: z.array(code),
});
export const UserMcpOperationResultSchema = z.strictObject({
  scope: z.literal('user'),
  storeId: id,
  commandId: id,
  expectedReadSet: digest,
  operation: UserMcpSettingsOperationSchema,
  state: z.enum(['pending', 'applied', 'failed', 'outcome_unknown']),
  receipt: z.strictObject({
    code: code.nullable(),
    cancelled: z.boolean(),
    configuration: z.enum(['unchanged', 'published', 'outcome_unknown']),
    authentication: UserMcpAuthenticationSchema.nullable(),
    connection: UserMcpConnectionSchema.nullable(),
    revocation: z.enum(['completed', 'not_supported']).nullable(),
  }),
});
export const UserMcpToolsPageSchema = z.strictObject({
  scope: z.literal('user'),
  storeId: id,
  serverId,
  generation: z.number().int().positive(),
  entries: z.array(
    z.strictObject({
      index: z.number().int().nonnegative(),
      definitionId: z.string().min(1).max(256),
      definitionVersion: digest,
      descriptor: z.json(),
    }),
  ),
  nextAfterIndex: z.number().int().nonnegative().nullable(),
  complete: z.boolean(),
});

export type UserMcpSettingsOperation = z.infer<typeof UserMcpSettingsOperationSchema>;
export type UserMcpSettingsView = z.infer<typeof UserMcpSettingsViewSchema>;
export type UserMcpOperationResult = z.infer<typeof UserMcpOperationResultSchema>;
export type UserMcpToolsPage = z.infer<typeof UserMcpToolsPageSchema>;
