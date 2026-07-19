import Ajv, { type ValidateFunction } from 'ajv';

export type JsonSchema = Record<string, unknown>;

export interface CompiledCapabilitySchema {
  schema: JsonSchema;
  validate: ValidateFunction;
}

const ajv = new Ajv({ allErrors: true, strict: true });

// Schema admission budget — prevents oversized or deeply nested schemas from
// a remote MCP server from wasting CPU during discovery, blowing up model
// context, or causing recursive stack overflows.
const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_SCHEMA_DEPTH = 32;
const MAX_OBJECT_NODES = 4096;
const MAX_PROPERTIES = 1024;

interface SchemaBudget {
  nodes: number;
  props: number;
  depthOk: boolean;
}

function measureSchemaBudget(value: unknown, depth = 0): SchemaBudget {
  if (depth > MAX_SCHEMA_DEPTH) return { nodes: 0, props: 0, depthOk: false };
  if (!value || typeof value !== 'object') return { nodes: 0, props: 0, depthOk: true };
  if (Array.isArray(value)) {
    return (value as unknown[]).reduce<SchemaBudget>(
      (acc, item) => {
        const child = measureSchemaBudget(item, depth + 1);
        return {
          nodes: acc.nodes + child.nodes,
          props: acc.props + child.props,
          depthOk: acc.depthOk && child.depthOk,
        };
      },
      { nodes: 0, props: 0, depthOk: true },
    );
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return Object.values(record).reduce<SchemaBudget>(
    (acc, item) => {
      const child = measureSchemaBudget(item, depth + 1);
      return {
        nodes: acc.nodes + child.nodes,
        props: acc.props + child.props,
        depthOk: acc.depthOk && child.depthOk,
      };
    },
    { nodes: 1, props: keys.length, depthOk: true },
  );
}

/**
 * P0 intentionally supports only object-root Draft-07 schemas: that is the
 * intersection of MCP tool arguments, AI SDK jsonSchema(), and local runtime
 * validation. Other valid JSON Schema dialects remain diagnosable but cannot
 * become executable bindings.
 *
 * Schemas exceeding admission budget limits (size, depth, nodes, properties)
 * are rejected with a diagnostic so the downstream catalog can quarantine the
 * tool rather than disclosing a potentially dangerous schema.
 */
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

  // Schema admission budget — single traversal for depth, nodes, and properties.
  // Use byte length, not .length, so multi-byte characters (e.g. CJK tool names)
  // are correctly counted against the KiB limit.
  const serialized = JSON.stringify(schema);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SCHEMA_BYTES) {
    return {
      ok: false,
      diagnostic: `MCP inputSchema exceeds the ${MAX_SCHEMA_BYTES / 1024} KiB serialized size limit.`,
    };
  }
  const budget = measureSchemaBudget(schema);
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
