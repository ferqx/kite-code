import type { Json } from '../storage/types';

/** Selected remote declarations, never a registration, policy, grant or instruction. */
export interface UntrustedMcpTool {
  readonly source: 'mcp_tool_metadata';
  readonly trustedAsAuthority: false;
  readonly name: string;
  readonly description: {
    readonly text: string;
    readonly status: 'complete' | 'truncated' | 'absent';
  };
  /** Structure only: omitted literals/references can carry significant operation semantics. */
  readonly inputSchema:
    | { readonly status: 'structure_only'; readonly schema: Json }
    | { readonly status: 'omitted' };
}
const types = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const shortName = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 128;

/** Deliberately closed schema vocabulary; arbitrary remote data cannot ride a known wrapper. */
function validStructure(schema: unknown): boolean {
  let nodes = 0;
  function visit(value: unknown, depth: number): boolean {
    if (++nodes > 128 || depth > 8) return false;
    if (typeof value === 'boolean') return true;
    if (!record(value)) return false;
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'type') {
        if (
          !(typeof entry === 'string' && types.has(entry)) &&
          !(Array.isArray(entry) && entry.length <= 7 && entry.every((type) => types.has(type)))
        )
          return false;
      } else if (key === 'properties') {
        if (
          !record(entry) ||
          Object.keys(entry).length > 64 ||
          !Object.entries(entry).every(
            ([name, child]) => shortName(name) && visit(child, depth + 1),
          )
        )
          return false;
      } else if (key === 'required') {
        if (!Array.isArray(entry) || entry.length > 64 || !entry.every(shortName)) return false;
      } else if (['items', 'additionalProperties', 'not'].includes(key)) {
        if (!visit(entry, depth + 1)) return false;
      } else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key)) {
        if (
          !Array.isArray(entry) ||
          entry.length > 16 ||
          !entry.every((child) => visit(child, depth + 1))
        )
          return false;
      } else return false;
    }
    return true;
  }
  return visit(schema, 0) && Buffer.byteLength(JSON.stringify(schema)) <= 8192;
}

export function validUntrustedMcpTool(value: unknown): value is UntrustedMcpTool {
  if (
    !record(value) ||
    !keys(value, ['source', 'trustedAsAuthority', 'name', 'description', 'inputSchema']) ||
    value.source !== 'mcp_tool_metadata' ||
    value.trustedAsAuthority !== false ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    value.name.length > 256 ||
    !record(value.description) ||
    !keys(value.description, ['text', 'status']) ||
    typeof value.description.text !== 'string' ||
    value.description.text.length > 2048 ||
    typeof value.description.status !== 'string' ||
    !['complete', 'truncated', 'absent'].includes(value.description.status) ||
    (value.description.status === 'absent' && value.description.text !== '') ||
    !record(value.inputSchema)
  )
    return false;
  return value.inputSchema.status === 'omitted'
    ? keys(value.inputSchema, ['status'])
    : value.inputSchema.status === 'structure_only' &&
        keys(value.inputSchema, ['status', 'schema']) &&
        validStructure(value.inputSchema.schema);
}

/** Bounded structure projection, not secret detection or complete JSON Schema semantics. */
export function createUntrustedMcpTool(input: {
  name: string;
  description?: string;
  inputSchema: unknown;
}): UntrustedMcpTool {
  let nodes = 0;
  function project(value: unknown, depth: number): Json {
    if (++nodes > 128 || depth > 8) throw new Error('mcp_review_schema_limit');
    if (typeof value === 'boolean') return value;
    if (!record(value)) throw new Error('mcp_review_schema_shape');
    const result: Record<string, Json> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'type') {
        if (typeof entry === 'string' && types.has(entry)) result.type = entry;
        else if (
          Array.isArray(entry) &&
          entry.length <= 7 &&
          entry.every((type) => types.has(type))
        )
          result.type = [...entry];
      } else if (key === 'properties' && record(entry)) {
        const entries = Object.entries(entry);
        if (entries.length > 64 || entries.some(([name]) => !shortName(name)))
          throw new Error('mcp_review_schema_limit');
        result.properties = Object.fromEntries(
          entries.map(([name, child]) => [name, project(child, depth + 1)]),
        );
      } else if (key === 'required' && Array.isArray(entry)) {
        if (entry.length > 64 || !entry.every(shortName))
          throw new Error('mcp_review_schema_limit');
        result.required = [...entry];
      } else if (['items', 'additionalProperties', 'not'].includes(key)) {
        result[key] = project(entry, depth + 1);
      } else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key) && Array.isArray(entry)) {
        if (entry.length > 16) throw new Error('mcp_review_schema_limit');
        result[key] = entry.map((child) => project(child, depth + 1));
      }
    }
    return result;
  }
  let inputSchema: UntrustedMcpTool['inputSchema'];
  try {
    const schema = project(input.inputSchema, 0);
    inputSchema = validStructure(schema)
      ? { status: 'structure_only', schema }
      : { status: 'omitted' };
  } catch {
    inputSchema = { status: 'omitted' };
  }
  function freeze<T>(value: T): T {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  }
  return freeze({
    source: 'mcp_tool_metadata',
    trustedAsAuthority: false,
    name: input.name,
    description: {
      text: input.description?.slice(0, 2048) ?? '',
      status:
        input.description === undefined
          ? 'absent'
          : input.description.length > 2048
            ? 'truncated'
            : 'complete',
    },
    inputSchema,
  });
}
