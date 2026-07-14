import Ajv, { type ValidateFunction } from 'ajv';

export type JsonSchema = Record<string, unknown>;

export interface CompiledCapabilitySchema {
  schema: JsonSchema;
  validate: ValidateFunction;
}

const ajv = new Ajv({ allErrors: true, strict: true });

/**
 * P0 intentionally supports only object-root Draft-07 schemas: that is the
 * intersection of MCP tool arguments, AI SDK jsonSchema(), and local runtime
 * validation. Other valid JSON Schema dialects remain diagnosable but cannot
 * become executable bindings.
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
