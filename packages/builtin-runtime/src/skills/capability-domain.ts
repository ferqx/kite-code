import { createHash } from 'node:crypto';
import Ajv, { type ValidateFunction } from 'ajv';

export type CapabilityApprovalV1 = 'none' | 'auto_review' | 'user';
export type CapabilityEffectLevelV1 = 'none' | 'read' | 'write' | 'destructive' | 'unknown';

export interface EffectProfileV1 {
  filesystem: CapabilityEffectLevelV1;
  network: CapabilityEffectLevelV1;
  externalState: CapabilityEffectLevelV1;
}

export interface CapabilityDescriptorV1 {
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
  declaredEffects: EffectProfileV1;
  effectiveEffects: EffectProfileV1;
  policy: { workspaceTrustRequired: boolean; minimumApproval: CapabilityApprovalV1 };
  execution?: { retry: 'never' | 'safe_read' | 'idempotency_key'; idempotencyKeyArgument?: string };
  availability: 'available' | 'degraded' | 'unavailable' | 'quarantined';
  diagnostics: string[];
}

export interface CapabilitySnapshotV1 {
  revision: string;
  descriptors: CapabilityDescriptorV1[];
}

export type JsonSchemaV1 = Record<string, unknown>;

export interface CompiledCapabilitySchemaV1 {
  schema: JsonSchemaV1;
  validate: ValidateFunction;
}

const ajv = new Ajv({ allErrors: true, strict: true });
const identityAjv = new Ajv({ allErrors: true, strict: true, useDefaults: true });
const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_SCHEMA_DEPTH = 32;
const MAX_OBJECT_NODES = 4096;
const MAX_PROPERTIES = 1024;

interface SchemaBudgetV1 {
  nodes: number;
  props: number;
  depthOk: boolean;
}

export function digestCapabilityValueV1(value: unknown): string {
  return createHash('sha256').update(stableStringifyV1(value)).digest('hex');
}

export function descriptorRevisionV1(input: Omit<CapabilityDescriptorV1, 'revision'>): string {
  return digestCapabilityValueV1(input);
}

export function createCapabilitySnapshotV1(
  descriptors: CapabilityDescriptorV1[],
): CapabilitySnapshotV1 {
  const ordered = [...descriptors].sort((left, right) =>
    left.capabilityId.localeCompare(right.capabilityId),
  );
  return {
    revision: digestCapabilityValueV1(
      ordered.map((descriptor) => ({
        capabilityId: descriptor.capabilityId,
        revision: descriptor.revision,
      })),
    ),
    descriptors: ordered,
  };
}

export function compileCapabilitySchemaV1(
  value: unknown,
): { ok: true; compiled: CompiledCapabilitySchemaV1 } | { ok: false; diagnostic: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, diagnostic: 'MCP tool inputSchema must be a JSON object.' };
  }
  const schema = value as JsonSchemaV1;
  if (schema.type !== 'object') {
    return {
      ok: false,
      diagnostic: 'P0 supports only object-root JSON Schema Draft-07 inputSchema.',
    };
  }
  let serialized: string;
  try {
    const candidate = JSON.stringify(schema);
    if (candidate === undefined) {
      return {
        ok: false,
        diagnostic: 'Unsupported MCP inputSchema: schema must be JSON-serializable.',
      };
    }
    serialized = candidate;
  } catch {
    return {
      ok: false,
      diagnostic: 'Unsupported MCP inputSchema: schema must be JSON-serializable.',
    };
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SCHEMA_BYTES) {
    return {
      ok: false,
      diagnostic: `MCP inputSchema exceeds the ${MAX_SCHEMA_BYTES / 1024} KiB serialized size limit.`,
    };
  }
  const budget = measureSchemaBudgetV1(schema);
  if (!budget.depthOk) {
    return {
      ok: false,
      diagnostic: `MCP inputSchema exceeds the maximum nesting depth of ${MAX_SCHEMA_DEPTH}.`,
    };
  }
  if (budget.nodes > MAX_OBJECT_NODES) {
    return {
      ok: false,
      diagnostic: `MCP inputSchema has ${budget.nodes} object nodes, exceeding the limit of ${MAX_OBJECT_NODES}.`,
    };
  }
  if (budget.props > MAX_PROPERTIES) {
    return {
      ok: false,
      diagnostic: `MCP inputSchema has ${budget.props} properties, exceeding the limit of ${MAX_PROPERTIES}.`,
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

export function validateCapabilityArgumentsV1(
  schema: unknown,
  args: Record<string, unknown>,
): string | null {
  const compiled = compileCapabilitySchemaV1(schema);
  if (!compiled.ok) return compiled.diagnostic;
  if (compiled.compiled.validate(args)) return null;
  return `Arguments do not match MCP inputSchema: ${ajv.errorsText(compiled.compiled.validate.errors)}`;
}

/**
 * Clone and validate dynamic capability arguments while applying the admitted
 * schema defaults. The caller's object is never mutated; the returned value is
 * the sole canonical identity input for a dynamic capability invocation.
 */
export function canonicalizeCapabilityArgumentsV1(
  schema: unknown,
  args: unknown,
): { ok: true; args: Record<string, unknown> } | { ok: false; diagnostic: string } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, diagnostic: 'MCP tool arguments must be a JSON object.' };
  }
  const admitted = compileCapabilitySchemaV1(schema);
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

function stableStringifyV1(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringifyV1).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringifyV1(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function measureSchemaBudgetV1(value: unknown, depth = 0): SchemaBudgetV1 {
  if (depth > MAX_SCHEMA_DEPTH) return { nodes: 0, props: 0, depthOk: false };
  if (!value || typeof value !== 'object') return { nodes: 0, props: 0, depthOk: true };
  if (Array.isArray(value)) {
    return value.reduce<SchemaBudgetV1>(
      (acc, item) => mergeBudgetV1(acc, measureSchemaBudgetV1(item, depth + 1)),
      { nodes: 0, props: 0, depthOk: true },
    );
  }
  const record = value as Record<string, unknown>;
  return Object.values(record).reduce<SchemaBudgetV1>(
    (acc, item) => mergeBudgetV1(acc, measureSchemaBudgetV1(item, depth + 1)),
    { nodes: 1, props: Object.keys(record).length, depthOk: true },
  );
}

function mergeBudgetV1(left: SchemaBudgetV1, right: SchemaBudgetV1): SchemaBudgetV1 {
  return {
    nodes: left.nodes + right.nodes,
    props: left.props + right.props,
    depthOk: left.depthOk && right.depthOk,
  };
}
