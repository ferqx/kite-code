import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import type { WorkflowJsonSchema } from '../workflow-contract';

export function digestWorkflowValue(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}
export function descriptorRevision(value: unknown): string {
  return digestWorkflowValue(value);
}
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
/** Same strict object-root Draft-07 admission and Ajv keywords as the existing Workflow compiler. */
export function compileWorkflowSchema(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return { ok: false as const, diagnostic: 'Workflow schema must be a JSON object.' };
  const schema = value as WorkflowJsonSchema;
  if (schema.type !== 'object')
    return {
      ok: false as const,
      diagnostic: 'Workflow supports only object-root JSON Schema Draft-07.',
    };
  try {
    if (JSON.stringify(schema) === undefined) throw Error();
  } catch {
    return {
      ok: false as const,
      diagnostic: 'Unsupported Workflow schema: schema must be JSON-serializable.',
    };
  }
  try {
    // Each contract owns its schema registry. A sibling Skill's $id is not an implicit dependency.
    const ajv = new Ajv({ allErrors: true, strict: true });
    const validate = ajv.compile(schema);
    if ('$async' in validate && validate.$async)
      return {
        ok: false as const,
        diagnostic: 'Workflow requires synchronous JSON Schema validation.',
      };
    return {
      ok: true as const,
      compiled: { schema, validate, errorText: () => ajv.errorsText(validate.errors) },
    };
  } catch (error) {
    return {
      ok: false as const,
      diagnostic: `Unsupported Workflow schema: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
export function validateWorkflowArguments(schema: unknown, input: unknown): string | null {
  const compiled = compileWorkflowSchema(schema);
  if (!compiled.ok) return compiled.diagnostic;
  if (compiled.compiled.validate(input)) return null;
  return `Arguments do not match Workflow schema: ${compiled.compiled.errorText()}`;
}
