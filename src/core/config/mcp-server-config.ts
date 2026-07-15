import { z } from 'zod';
import type { EffectProfile } from '@/protocol/capabilities';
import type { McpServerConfig } from '../mcp/types';

export const mcpServerSchema = z.object({
  type: z.enum(['stdio', 'http']).optional(),
  enabled: z.boolean().optional(),
  required: z.boolean().optional(),
  cwd: z.string().min(1).optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  trust: z
    .union([
      z.enum(['untrusted', 'trusted']),
      z.object({
        provenance: z.enum(['admin', 'user', 'project']),
        allowAnnotations: z.literal('read_only'),
      }),
    ])
    .optional(),
  tools: z
    .record(
      z.string(),
      z.object({
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
        .map(([key, value]) => [key, expandEnvVars(value)]),
    );
  }
  if (raw.headers && typeof raw.headers === 'object') {
    config.headers = Object.fromEntries(
      Object.entries(raw.headers as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([key, value]) => [key, expandEnvVars(value)]),
    );
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
