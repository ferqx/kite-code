import Ajv from 'ajv';
import type { ArtifactReader, ArtifactRef, Json, PublicExecution } from '../../extensions';

/** Deliberately finite, local JSON Schema subset; no remote refs, patterns or custom keywords. */
function finiteSchema(schema: Json) {
  const keywords = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'description',
  ]);
  let nodes = 0;
  function literal(value: Json, depth: number): void {
    if (++nodes > 512 || depth > 16) throw new Error('validation_schema_unavailable');
    if (value && typeof value === 'object')
      for (const nested of Object.values(value)) literal(nested, depth + 1);
  }
  function inspect(value: Json, depth = 0): void {
    if (++nodes > 512 || depth > 16 || !value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('validation_schema_unavailable');
    for (const [key, child] of Object.entries(value)) {
      if (!keywords.has(key)) throw new Error('validation_schema_unavailable');
      if (key === 'properties') {
        if (!child || typeof child !== 'object' || Array.isArray(child))
          throw new Error('validation_schema_unavailable');
        for (const nested of Object.values(child)) inspect(nested, depth + 1);
      } else if (key === 'items' || (key === 'additionalProperties' && typeof child === 'object'))
        inspect(child, depth + 1);
      else literal(child, depth + 1);
    }
  }
  if (
    new TextEncoder().encode(JSON.stringify(schema)).byteLength > 32 * 1024 ||
    !schema ||
    typeof schema !== 'object' ||
    Array.isArray(schema) ||
    schema.type !== 'object'
  )
    throw new Error('validation_schema_unavailable');
  inspect(schema);
  const validate = new Ajv({ strict: true, allErrors: false, validateFormats: false }).compile(
    schema,
  );
  return validate;
}

export function checkStructuredSchema(schema: Json, value: Json): 'passed' | 'failed' {
  const validate = finiteSchema(schema);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1024 * 1024)
    throw new Error('validation_artifact_budget');
  let nodes = 0;
  function bounded(input: Json, depth = 0): void {
    if (++nodes > 10000 || depth > 32) throw new Error('validation_artifact_budget');
    if (input && typeof input === 'object')
      for (const child of Object.values(input)) bounded(child, depth + 1);
  }
  bounded(value);
  return validate(value) ? 'passed' : 'failed';
}

/** Only inspect the actual unified execution result, never a model's success narrative. */
export function checkSemanticResult(check: Record<string, Json>, execution: PublicExecution) {
  if (execution.status === 'outcome_unknown') return 'unknown';
  const result = execution.result;
  const details =
    result && typeof result === 'object' && !Array.isArray(result) ? result.details : null;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return 'inconclusive';
  if (check.kind === 'command') {
    if (
      !['succeeded', 'failed'].includes(execution.status) ||
      details.groupStopped !== true ||
      !Number.isInteger(details.exitCode)
    )
      return 'inconclusive';
    return details.exitCode === check.expectedExitCode ? 'passed' : 'failed';
  }
  if (
    execution.status !== 'succeeded' ||
    details.isError === true ||
    details.structuredContent === undefined ||
    check.schema === undefined
  )
    return 'inconclusive';
  return checkStructuredSchema(check.schema, details.structuredContent);
}

export async function checkArtifactSchema(reader: ArtifactReader, ref: ArtifactRef, schema: Json) {
  const validate = finiteSchema(schema);
  if (!/^\d+$/.test(ref.size) || BigInt(ref.size) > 1024n * 1024n)
    throw new Error('validation_artifact_budget');
  const bytes = await reader.read(ref);
  if (bytes.byteLength > 1024 * 1024) throw new Error('validation_artifact_budget');
  const value: Json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  let values = 0;
  function bounded(input: Json, depth = 0): void {
    if (++values > 10000 || depth > 32) throw new Error('validation_artifact_budget');
    if (input && typeof input === 'object')
      for (const v of Object.values(input)) bounded(v, depth + 1);
  }
  bounded(value);
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))),
  )
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
  return { outcome: validate(value) ? 'passed' : 'failed', hash };
}
