import type { McpServerConfig } from '@kite/builtin-runtime/mcp';
import type { EffectProfile } from '@kite/runtime-contract';
import { z } from 'zod';

const authHeaderSchema = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/);
const authSchemeSchema = z
  .string()
  .min(1)
  .refine((value) => !/[\r\n]/.test(value));
const mcpAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z
    .object({
      type: z.literal('environment'),
      header: authHeaderSchema,
      env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      scheme: authSchemeSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('credential'),
      header: authHeaderSchema,
      credentialRef: z.string().min(1).max(128),
      scheme: authSchemeSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('oauth'),
      credentialRef: z.string().min(1).max(128).optional(),
      scopes: z.array(z.string().min(1)).optional(),
      clientId: z.string().min(1).optional(),
      clientSecretRef: z.string().min(1).max(128).optional(),
    })
    .strict(),
]);

export const mcpServerSchema = z
  .object({
    type: z.enum(['stdio', 'http']).optional(),
    enabled: z.boolean().optional(),
    required: z.boolean().optional(),
    cwd: z.string().min(1).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    auth: mcpAuthSchema.optional(),
    trust: z
      .union([
        z.enum(['untrusted', 'trusted']),
        z.object({
          provenance: z.enum(['admin', 'user', 'project']),
          allowAnnotations: z.literal('read_only'),
        }),
      ])
      .optional(),
    enabledTools: z.array(z.string().min(1)).optional(),
    disabledTools: z.array(z.string().min(1)).optional(),
    tools: z
      .record(
        z.string().min(1),
        z.object({
          enabled: z.boolean().optional(),
          effects: z
            .object({
              filesystem: z.enum(['none', 'read', 'write', 'destructive', 'unknown']).optional(),
              network: z.enum(['none', 'read', 'write', 'destructive', 'unknown']).optional(),
              externalState: z.enum(['none', 'read', 'write', 'destructive', 'unknown']).optional(),
            })
            .optional(),
          minimumApproval: z.enum(['none', 'auto_review', 'user']).optional(),
          retry: z.enum(['never', 'safe_read', 'idempotency_key']).optional(),
          idempotencyKeyArgument: z.string().min(1).optional(),
        }),
      )
      .optional(),
    timeout: z.number().optional(),
  })
  .superRefine((value, context) => {
    if (value.auth && value.type !== 'http') {
      context.addIssue({
        code: 'custom',
        path: ['auth'],
        message: 'Authentication configuration is supported only for HTTP MCP servers.',
      });
    }
  });

/** Expand ${VAR} and ${VAR:-default} references at connection time. */
export function expandEnvVars(value: string): string {
  return value.replace(
    /\$\{(\w+)(?::-([^}]*))?\}/g,
    (_match, varName: string, defaultValue: string | undefined) => {
      const envValue = process.env[varName];
      if (envValue !== undefined && envValue !== '') return envValue;
      return defaultValue ?? '';
    },
  );
}

/** Normalize one validated raw MCP server declaration. */
export function normalizeMcpServerConfig(raw: Record<string, unknown>): McpServerConfig {
  const type: McpServerConfig['type'] = raw.type === 'http' ? 'http' : 'stdio';
  const config: McpServerConfig = { type };

  if (typeof raw.enabled === 'boolean') config.enabled = raw.enabled;
  if (typeof raw.required === 'boolean') config.required = raw.required;
  if (typeof raw.cwd === 'string' && raw.cwd.length > 0) config.cwd = expandEnvVars(raw.cwd);

  if (typeof raw.command === 'string') config.command = expandEnvVars(raw.command);
  if (Array.isArray(raw.args)) {
    config.args = raw.args.filter((a): a is string => typeof a === 'string').map(expandEnvVars);
  }
  if (typeof raw.url === 'string') config.url = expandEnvVars(raw.url);
  if (raw.env && typeof raw.env === 'object') {
    config.env = Object.fromEntries(
      Object.entries(raw.env as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([key, value]) => [key, value]),
    );
  }
  if (raw.headers && typeof raw.headers === 'object') {
    config.headers = Object.fromEntries(
      Object.entries(raw.headers as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([key, value]) => [key, value]),
    );
  }
  if (raw.auth && typeof raw.auth === 'object') {
    const auth = raw.auth as Record<string, unknown>;
    if (auth.type === 'none') config.auth = { type: 'none' };
    if (
      auth.type === 'environment' &&
      typeof auth.header === 'string' &&
      typeof auth.env === 'string'
    ) {
      config.auth = {
        type: 'environment',
        header: auth.header,
        env: auth.env,
        ...(typeof auth.scheme === 'string' ? { scheme: auth.scheme } : {}),
      };
    }
    if (
      auth.type === 'credential' &&
      typeof auth.header === 'string' &&
      typeof auth.credentialRef === 'string'
    ) {
      config.auth = {
        type: 'credential',
        header: auth.header,
        credentialRef: auth.credentialRef,
        ...(typeof auth.scheme === 'string' ? { scheme: auth.scheme } : {}),
      };
    }
    if (auth.type === 'oauth') {
      config.auth = {
        type: 'oauth',
        ...(typeof auth.credentialRef === 'string' ? { credentialRef: auth.credentialRef } : {}),
        ...(Array.isArray(auth.scopes)
          ? { scopes: auth.scopes.filter((scope): scope is string => typeof scope === 'string') }
          : {}),
        ...(typeof auth.clientId === 'string' ? { clientId: auth.clientId } : {}),
        ...(typeof auth.clientSecretRef === 'string'
          ? { clientSecretRef: auth.clientSecretRef }
          : {}),
      };
    }
  }
  if (raw.trust === 'trusted' || raw.trust === 'untrusted') config.trust = raw.trust;
  if (raw.trust && typeof raw.trust === 'object') {
    const trust = raw.trust as Record<string, unknown>;
    if (
      (trust.provenance === 'admin' ||
        trust.provenance === 'user' ||
        trust.provenance === 'project') &&
      trust.allowAnnotations === 'read_only'
    ) {
      config.trust = { provenance: trust.provenance, allowAnnotations: 'read_only' };
    }
  }
  if (Array.isArray(raw.enabledTools)) {
    config.enabledTools = [
      ...new Set(raw.enabledTools.filter((name): name is string => typeof name === 'string')),
    ];
  }
  if (Array.isArray(raw.disabledTools)) {
    config.disabledTools = [
      ...new Set(raw.disabledTools.filter((name): name is string => typeof name === 'string')),
    ];
  }
  if (raw.tools && typeof raw.tools === 'object') {
    const tools: NonNullable<McpServerConfig['tools']> = {};
    for (const [toolName, rawPolicy] of Object.entries(raw.tools as Record<string, unknown>)) {
      if (!rawPolicy || typeof rawPolicy !== 'object') continue;
      const policy = rawPolicy as Record<string, unknown>;
      const normalizedEffects: Partial<EffectProfile> = {};
      if (policy.effects && typeof policy.effects === 'object') {
        for (const key of ['filesystem', 'network', 'externalState'] as const) {
          const level = (policy.effects as Record<string, unknown>)[key];
          if (
            level === 'none' ||
            level === 'read' ||
            level === 'write' ||
            level === 'destructive' ||
            level === 'unknown'
          ) {
            normalizedEffects[key] = level;
          }
        }
      }
      const minimumApproval = policy.minimumApproval;
      const retry = policy.retry;
      const idempotencyKeyArgument = policy.idempotencyKeyArgument;
      tools[toolName] = {
        ...(typeof policy.enabled === 'boolean' ? { enabled: policy.enabled } : {}),
        ...(Object.keys(normalizedEffects).length > 0 ? { effects: normalizedEffects } : {}),
        ...(minimumApproval === 'none' ||
        minimumApproval === 'auto_review' ||
        minimumApproval === 'user'
          ? { minimumApproval }
          : {}),
        ...(retry === 'never' || retry === 'safe_read' || retry === 'idempotency_key'
          ? { retry }
          : {}),
        ...(typeof idempotencyKeyArgument === 'string' && idempotencyKeyArgument.length > 0
          ? { idempotencyKeyArgument }
          : {}),
      };
    }
    config.tools = tools;
  }
  if (typeof raw.timeout === 'number' && raw.timeout > 0) config.timeout = raw.timeout;
  return config;
}
