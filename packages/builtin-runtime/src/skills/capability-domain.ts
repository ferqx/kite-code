import { createHash } from 'node:crypto';
import Ajv, { type ValidateFunction } from 'ajv';

export type CapabilityApproval = 'none' | 'auto_review' | 'user';
export type CapabilityEffectLevel = 'none' | 'read' | 'write' | 'destructive' | 'unknown';

export interface EffectProfile {
  filesystem: CapabilityEffectLevel;
  network: CapabilityEffectLevel;
  externalState: CapabilityEffectLevel;
}

export interface CapabilityDescriptor {
  capabilityId: string;
  revision: string;
  kind: 'builtin_tool' | 'mcp_tool' | 'mcp_resource' | 'mcp_prompt' | 'skill' | 'subagent';
  displayName: string;
  description: string;
  modelDescription?: string;
  descriptionProvenance?:
    | 'builtin'
    | 'user_config'
    | 'approved_project'
    | 'generated'
    | 'remote_untrusted';
  provider: {
    type: 'builtin' | 'mcp' | 'skill' | 'subagent';
    id: string;
    version?: string;
    provenance: 'builtin' | 'admin' | 'user' | 'project' | 'remote';
  };
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  declaredEffects: EffectProfile;
  effectiveEffects: EffectProfile;
  policy: { workspaceTrustRequired: boolean; minimumApproval: CapabilityApproval };
  execution?: { retry: 'never' | 'safe_read' | 'idempotency_key'; idempotencyKeyArgument?: string };
  availability: 'available' | 'degraded' | 'unavailable' | 'quarantined';
  diagnostics: string[];
}

export interface CapabilitySnapshot {
  revision: string;
  descriptors: CapabilityDescriptor[];
}

export type JsonSchema = Record<string, unknown>;

export interface CompiledCapabilitySchema {
  schema: JsonSchema;
  validate: ValidateFunction;
}

const ajv = new Ajv({ allErrors: true, strict: true });
const identityAjv = new Ajv({ allErrors: true, strict: true, useDefaults: true });

export function digestCapabilityValue(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function descriptorRevision(input: Omit<CapabilityDescriptor, 'revision'>): string {
  return digestCapabilityValue(input);
}

export function createCapabilitySnapshot(descriptors: CapabilityDescriptor[]): CapabilitySnapshot {
  const ordered = [...descriptors].sort((left, right) =>
    left.capabilityId.localeCompare(right.capabilityId),
  );
  return {
    revision: digestCapabilityValue(
      ordered.map((descriptor) => ({
        capabilityId: descriptor.capabilityId,
        revision: descriptor.revision,
      })),
    ),
    descriptors: ordered,
  };
}

export function compileCapabilitySchema(
  value: unknown,
): { ok: true; compiled: CompiledCapabilitySchema } | { ok: false; diagnostic: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, diagnostic: 'MCP tool inputSchema must be a JSON object.' };
  }
  const schema = value as JsonSchema;
  if (schema.type !== 'object') {
    return {
      ok: false,
      diagnostic: 'P0 supports only object-root JSON Schema Draft-07 inputSchema.',
    };
  }
  try {
    const candidate = JSON.stringify(schema);
    if (candidate === undefined) {
      return {
        ok: false,
        diagnostic: 'Unsupported MCP inputSchema: schema must be JSON-serializable.',
      };
    }
  } catch {
    return {
      ok: false,
      diagnostic: 'Unsupported MCP inputSchema: schema must be JSON-serializable.',
    };
  }
  try {
    return { ok: true, compiled: { schema, validate: ajv.compile(schema) } };
  } catch (error) {
    ajv.removeSchema(schema);
    return {
      ok: false,
      diagnostic: `Unsupported MCP inputSchema: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function validateCapabilityArguments(
  schema: unknown,
  args: Record<string, unknown>,
): string | null {
  const compiled = compileCapabilitySchema(schema);
  if (!compiled.ok) return compiled.diagnostic;
  if (compiled.compiled.validate(args)) return null;
  return `Arguments do not match MCP inputSchema: ${ajv.errorsText(compiled.compiled.validate.errors)}`;
}

/**
 * Clone and validate dynamic capability arguments while applying the admitted
 * schema defaults. The caller's object is never mutated; the returned value is
 * the sole canonical identity input for a dynamic capability invocation.
 */
export function canonicalizeCapabilityArguments(
  schema: unknown,
  args: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false; diagnostic: string } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, diagnostic: 'MCP tool arguments must be a JSON object.' };
  }
  const admitted = compileCapabilitySchema(schema);
  if (!admitted.ok) return admitted;
  let cloned: Record<string, unknown>;
  try {
    cloned = structuredClone(args as Record<string, unknown>);
  } catch {
    return { ok: false, diagnostic: 'MCP tool arguments must be JSON-cloneable.' };
  }
  try {
    const validate = identityAjv.compile(admitted.compiled.schema);
    if (validate(cloned)) return { ok: true, args: cloned };
    return {
      ok: false,
      diagnostic: `Arguments do not match MCP inputSchema: ${identityAjv.errorsText(validate.errors)}`,
    };
  } catch {
    return { ok: false, diagnostic: 'Unsupported MCP inputSchema for canonical identity.' };
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
