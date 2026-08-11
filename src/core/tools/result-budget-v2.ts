import { createHash } from 'node:crypto';

export const TOOL_RESULT_UTF8_ENVELOPE_MAX_BYTES_V2 = 128 * 1_024;
export const TOOL_RESULT_STREAM_MAX_CHARS_V2 = 4_000;
export const TOOL_RESULT_BUDGET_POLICY_ID_V2 = 'tool-result-budget:v2';
export const TOOL_RESULT_PROJECTOR_REVISION_V2 = 'tool-result-projector-registry:v2';
export const TOOL_RESULT_VALIDATOR_ID_V2 = 'tool-result-envelope-validator:v2';
export const READ_FILE_DECODER_CONTRACT_ID_V2 = 'read-file-decoder:utf8-utf16-bom-eol:v2';
export const RUNTIME_OUTPUT_SCHEMA_MAX_UTF8_BYTES_V2 = 32 * 1_024;

export type FrozenRuntimeOutputSchemaV2 =
  | { status: 'absent'; schemaDigest: string }
  | { status: 'frozen'; schemaDigest: string; schema: Record<string, unknown> }
  | { status: 'unsupported'; schemaDigest: string };

export type ToolResultProjectorIdV2 =
  | 'stream-head-tail:v1'
  | 'read-line-window:v1'
  | 'utf8-envelope:v1'
  | 'structured-receipt:v1';

export type ToolModelResultBudgetV2 =
  | { kind: 'stream_head_tail'; maxCharsPerStream: number }
  | {
      kind: 'line_window';
      maxUtf8Bytes: number;
      continuation: 'line_byte_cursor_v2';
      decoderContractId: string;
    }
  | { kind: 'serialized'; maxUtf8Bytes: number }
  | {
      kind: 'structured';
      maxUtf8Bytes: number;
      projectorId: ToolResultProjectorIdV2;
    };

export interface ResolvedToolResultBudgetV2 {
  source: 'builtin_spec' | 'runtime_binding';
  toolIdentity: string;
  bindingDigest: string;
  budget: ToolModelResultBudgetV2;
  projectorId: ToolResultProjectorIdV2;
  projectorRevision: typeof TOOL_RESULT_PROJECTOR_REVISION_V2;
  validatorId: typeof TOOL_RESULT_VALIDATOR_ID_V2;
  policyId: typeof TOOL_RESULT_BUDGET_POLICY_ID_V2;
  /** Bounded queue-time schema used by dynamic MCP result normalization. */
  outputSchema?: FrozenRuntimeOutputSchemaV2;
}

export interface ToolResultContinuationReceiptV2 {
  kind: 'line_byte_cursor_v2';
  status: 'partial' | 'completed' | 'completed_empty' | 'stale_continuation';
  cursor?: {
    lineOffset: number;
    utf8ByteOffsetInLine: number;
    endLineExclusive: number;
    pathDigest: string;
    resourceRevision: string;
    initialOffset: number;
    effectiveInitialLimit: number;
    windowIdentity: string;
    cursorDigest: string;
  };
}

export interface ToolResultBudgetReceiptV2 {
  version: 2;
  projectionMode: 'compat_v1' | 'budget_v2';
  policyId: string;
  toolIdentity: string;
  bindingDigest: string;
  projectorId: ToolResultProjectorIdV2 | 'compat-projector:v1';
  projectorRevision: string;
  validatorId: string;
  rawResultDigest: string;
  modelContentDigest: string;
  modelContentUtf8Bytes: number;
  streamProjection?: {
    stdoutDigest: string;
    stderrDigest: string;
    stdoutChars: number;
    stderrChars: number;
  };
  continuation?: ToolResultContinuationReceiptV2;
}

export interface FinalizedProjectedToolResultV2<Meta extends object> {
  ok: boolean;
  modelContent: string;
  streams?: { stdout: string; stderr: string };
  resultMeta: Meta & {
    rawResultDigest: string;
    modelContentDigest: string;
    digestScope: 'raw' | 'projected';
    toolResultReceipt: ToolResultBudgetReceiptV2;
  };
  receipt: ToolResultBudgetReceiptV2;
}

function canonicalize(value: unknown, seen = new Set<object>()): unknown {
  if (value === undefined) return { $undefined: true };
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) throw new Error('Tool result cannot contain a cycle.');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, seen));
    if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry, seen)]),
    );
  } finally {
    seen.delete(value);
  }
}

export function canonicalToolResultBytesV2(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function toolResultDigestV2(domain: string, value: string): string {
  return createHash('sha256').update(`${domain}\0${value}`).digest('hex');
}

function projectorIdForBudget(budget: ToolModelResultBudgetV2): ToolResultProjectorIdV2 {
  switch (budget.kind) {
    case 'stream_head_tail':
      return 'stream-head-tail:v1';
    case 'line_window':
      return 'read-line-window:v1';
    case 'serialized':
      return 'utf8-envelope:v1';
    case 'structured':
      return budget.projectorId;
  }
}

export function validateToolModelResultBudgetV2(budget: ToolModelResultBudgetV2): void {
  const finitePositive = (value: number) => Number.isSafeInteger(value) && value > 0;
  switch (budget.kind) {
    case 'stream_head_tail':
      if (!finitePositive(budget.maxCharsPerStream)) {
        throw new Error('stream_head_tail requires a finite positive maxCharsPerStream.');
      }
      return;
    case 'line_window':
      if (!finitePositive(budget.maxUtf8Bytes)) {
        throw new Error('line_window requires a finite positive maxUtf8Bytes.');
      }
      if (budget.continuation !== 'line_byte_cursor_v2') {
        throw new Error('line_window requires line_byte_cursor_v2 continuation.');
      }
      if (!budget.decoderContractId.trim()) {
        throw new Error('line_window requires a decoderContractId in its binding identity.');
      }
      return;
    case 'serialized':
      if (!finitePositive(budget.maxUtf8Bytes)) {
        throw new Error('serialized requires a finite positive maxUtf8Bytes.');
      }
      return;
    case 'structured':
      if (!finitePositive(budget.maxUtf8Bytes)) {
        throw new Error('structured requires a finite positive maxUtf8Bytes.');
      }
      if (
        !(['structured-receipt:v1', 'utf8-envelope:v1'] as const).includes(
          budget.projectorId as 'structured-receipt:v1',
        )
      ) {
        throw new Error(`Unknown structured projector '${budget.projectorId}'.`);
      }
      return;
    default:
      throw new Error('Unknown ToolModelResultBudgetV2 kind.');
  }
}

export function resolveBuiltinToolResultBudgetV2(input: {
  toolName: string;
  budget: ToolModelResultBudgetV2;
  governanceRevision?: string;
}): ResolvedToolResultBudgetV2 {
  validateToolModelResultBudgetV2(input.budget);
  const projectorId = projectorIdForBudget(input.budget);
  const identity: Omit<ResolvedToolResultBudgetV2, 'bindingDigest'> & {
    governanceRevision: string;
  } = {
    source: 'builtin_spec' as const,
    toolIdentity: `builtin:${input.toolName}`,
    budget: input.budget,
    projectorId,
    projectorRevision: TOOL_RESULT_PROJECTOR_REVISION_V2,
    validatorId: TOOL_RESULT_VALIDATOR_ID_V2,
    governanceRevision: input.governanceRevision ?? 'none',
    policyId: TOOL_RESULT_BUDGET_POLICY_ID_V2,
  };
  return Object.freeze({
    ...identity,
    bindingDigest: toolResultDigestV2('tool-result-budget-binding:v2', JSON.stringify(identity)),
  });
}

export function resolveRuntimeToolResultBudgetV2(input: {
  toolIdentity: string;
  catalogRevision: string;
  bindingRevision: string;
  budget: ToolModelResultBudgetV2;
  outputSchema?: FrozenRuntimeOutputSchemaV2;
}): ResolvedToolResultBudgetV2 {
  if (!input.toolIdentity || !input.catalogRevision || !input.bindingRevision) {
    throw new Error('Runtime tool result binding requires stable identity and revisions.');
  }
  validateToolModelResultBudgetV2(input.budget);
  const projectorId = projectorIdForBudget(input.budget);
  const identity: Omit<ResolvedToolResultBudgetV2, 'bindingDigest'> & {
    catalogRevision: string;
    bindingRevision: string;
  } = {
    source: 'runtime_binding' as const,
    toolIdentity: input.toolIdentity,
    catalogRevision: input.catalogRevision,
    bindingRevision: input.bindingRevision,
    budget: input.budget,
    projectorId,
    projectorRevision: TOOL_RESULT_PROJECTOR_REVISION_V2,
    validatorId: TOOL_RESULT_VALIDATOR_ID_V2,
    policyId: TOOL_RESULT_BUDGET_POLICY_ID_V2,
    ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
  };
  return Object.freeze({
    source: identity.source,
    toolIdentity: identity.toolIdentity,
    budget: identity.budget,
    projectorId: identity.projectorId,
    projectorRevision: identity.projectorRevision,
    validatorId: identity.validatorId,
    policyId: identity.policyId,
    ...(identity.outputSchema ? { outputSchema: identity.outputSchema } : {}),
    bindingDigest: toolResultDigestV2('tool-result-runtime-binding:v2', JSON.stringify(identity)),
  });
}

const OUTPUT_SCHEMA_PROSE_KEYS_V2 = new Set([
  'description',
  'title',
  '$comment',
  'examples',
  'default',
]);

const OUTPUT_SCHEMA_MAP_KEYWORDS_V2 = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies',
]);
const OUTPUT_SCHEMA_VALUE_KEYWORDS_V2 = new Set([
  'additionalProperties',
  'unevaluatedProperties',
  'propertyNames',
  'items',
  'additionalItems',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'contentSchema',
]);
const OUTPUT_SCHEMA_ARRAY_KEYWORDS_V2 = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);

function cloneJsonValueV2(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonValueV2);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, cloneJsonValueV2(entry)]),
  );
}

function semanticOutputSchemaV2(value: unknown): unknown {
  if (typeof value === 'boolean') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return cloneJsonValueV2(value);
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !OUTPUT_SCHEMA_PROSE_KEYS_V2.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => {
        if (
          OUTPUT_SCHEMA_MAP_KEYWORDS_V2.has(key) &&
          entry &&
          typeof entry === 'object' &&
          !Array.isArray(entry)
        ) {
          return [
            key,
            Object.fromEntries(
              Object.entries(entry as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([propertyName, propertySchema]) => [
                  propertyName,
                  Array.isArray(propertySchema) && key === 'dependencies'
                    ? cloneJsonValueV2(propertySchema)
                    : semanticOutputSchemaV2(propertySchema),
                ]),
            ),
          ];
        }
        if (OUTPUT_SCHEMA_VALUE_KEYWORDS_V2.has(key)) {
          return [
            key,
            Array.isArray(entry)
              ? entry.map(semanticOutputSchemaV2)
              : semanticOutputSchemaV2(entry),
          ];
        }
        if (OUTPUT_SCHEMA_ARRAY_KEYWORDS_V2.has(key) && Array.isArray(entry)) {
          return [key, entry.map(semanticOutputSchemaV2)];
        }
        return [key, cloneJsonValueV2(entry)];
      }),
  );
}

function deepFreezeJsonV2<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    deepFreezeJsonV2(entry);
  }
  return Object.freeze(value);
}

export function freezeRuntimeOutputSchemaV2(
  outputSchema: Record<string, unknown> | undefined,
): FrozenRuntimeOutputSchemaV2 {
  if (!outputSchema) {
    return Object.freeze({
      status: 'absent',
      schemaDigest: toolResultDigestV2('runtime-output-schema:v2', 'absent'),
    });
  }
  let semantic: unknown;
  let canonical: string;
  try {
    semantic = semanticOutputSchemaV2(outputSchema);
    canonical = canonicalToolResultBytesV2(semantic);
  } catch {
    return Object.freeze({
      status: 'unsupported',
      schemaDigest: toolResultDigestV2('runtime-output-schema:v2', 'uncanonicalizable'),
    });
  }
  const schemaDigest = toolResultDigestV2('runtime-output-schema:v2', canonical);
  if (
    !semantic ||
    typeof semantic !== 'object' ||
    Array.isArray(semantic) ||
    Buffer.byteLength(canonical, 'utf8') > RUNTIME_OUTPUT_SCHEMA_MAX_UTF8_BYTES_V2
  ) {
    return Object.freeze({ status: 'unsupported', schemaDigest });
  }
  return Object.freeze({
    status: 'frozen',
    schemaDigest,
    schema: deepFreezeJsonV2(semantic as Record<string, unknown>),
  });
}

export function validateFrozenRuntimeOutputSchemaV2(frozen: FrozenRuntimeOutputSchemaV2): void {
  if (!/^[0-9a-f]{64}$/.test(frozen.schemaDigest)) {
    throw new Error('Runtime output schema binding has an invalid digest.');
  }
  if (frozen.status === 'absent') {
    if (frozen.schemaDigest !== toolResultDigestV2('runtime-output-schema:v2', 'absent')) {
      throw new Error('Absent runtime output schema binding has a mismatched digest.');
    }
    return;
  }
  if (frozen.status === 'unsupported') return;
  const semantic = semanticOutputSchemaV2(frozen.schema);
  const canonicalSchema = canonicalToolResultBytesV2(frozen.schema);
  const canonicalSemantic = canonicalToolResultBytesV2(semantic);
  if (
    canonicalSchema !== canonicalSemantic ||
    Buffer.byteLength(canonicalSchema, 'utf8') > RUNTIME_OUTPUT_SCHEMA_MAX_UTF8_BYTES_V2 ||
    frozen.schemaDigest !== toolResultDigestV2('runtime-output-schema:v2', canonicalSchema)
  ) {
    throw new Error('Runtime output schema binding failed canonical digest validation.');
  }
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let end = low;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return value.slice(0, Math.max(0, end));
}

export function truncateUtf8EnvelopeV2(content: string, maxUtf8Bytes: number): string {
  if (Buffer.byteLength(content, 'utf8') <= maxUtf8Bytes) return content;
  const marker = '\n...[tool result truncated by utf8-envelope:v1]';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (markerBytes >= maxUtf8Bytes) return utf8Prefix(marker, maxUtf8Bytes);
  return `${utf8Prefix(content, maxUtf8Bytes - markerBytes)}${marker}`;
}

function projectStructuredEnvelopeV2(content: string, maxUtf8Bytes: number): string {
  let validJson = true;
  try {
    JSON.parse(content);
  } catch {
    validJson = false;
  }
  if (validJson && Buffer.byteLength(content, 'utf8') <= maxUtf8Bytes) return content;
  const digest = toolResultDigestV2('tool-result-structured-source:v2', content);
  const candidates = [
    JSON.stringify({ truncated: true, projector: 'structured-receipt:v1', sourceDigest: digest }),
    JSON.stringify({ truncated: true }),
    '{}',
  ];
  const projected = candidates.find(
    (candidate) => Buffer.byteLength(candidate, 'utf8') <= maxUtf8Bytes,
  );
  if (!projected) throw new Error('structured-receipt:v1 budget cannot fit a valid JSON envelope.');
  return projected;
}

function projectStreamHeadTailV2(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const marker = `\n... [${content.length - maxChars} or more chars omitted by stream-head-tail:v1]\n`;
  if (marker.length >= maxChars) return marker.slice(0, maxChars);
  const retained = maxChars - marker.length;
  const headChars = Math.ceil(retained / 2);
  const tailChars = retained - headChars;
  return `${content.slice(0, headChars)}${marker}${content.slice(content.length - tailChars)}`;
}

export function finalizeProjectedToolResultV2<Meta extends object>(input: {
  rawResult: unknown;
  projected: {
    ok: boolean;
    modelContent: string;
    streams?: { stdout: string; stderr: string };
    resultMeta: Meta;
  };
  resolvedBudget: ResolvedToolResultBudgetV2;
  projectionMode: 'compat_v1' | 'budget_v2';
  continuation?: ToolResultContinuationReceiptV2;
}): FinalizedProjectedToolResultV2<Meta> {
  const rawBytes = canonicalToolResultBytesV2(input.rawResult);
  let modelContent = input.projected.modelContent;
  let streams = input.projected.streams;
  if (input.projectionMode === 'budget_v2') {
    const budget = input.resolvedBudget.budget;
    if (budget.kind === 'serialized' || budget.kind === 'structured') {
      modelContent =
        budget.kind === 'structured'
          ? projectStructuredEnvelopeV2(modelContent, budget.maxUtf8Bytes)
          : truncateUtf8EnvelopeV2(modelContent, budget.maxUtf8Bytes);
      streams = streams
        ? {
            stdout: truncateUtf8EnvelopeV2(streams.stdout, budget.maxUtf8Bytes),
            stderr: truncateUtf8EnvelopeV2(streams.stderr, budget.maxUtf8Bytes),
          }
        : undefined;
    } else if (budget.kind === 'line_window') {
      if (Buffer.byteLength(modelContent, 'utf8') > budget.maxUtf8Bytes) {
        throw new Error('read-line-window:v1 produced an oversized model envelope.');
      }
    } else if (streams) {
      const selectedStream =
        modelContent === streams.stdout
          ? 'stdout'
          : modelContent === streams.stderr
            ? 'stderr'
            : undefined;
      streams = {
        stdout: projectStreamHeadTailV2(streams.stdout, budget.maxCharsPerStream),
        stderr: projectStreamHeadTailV2(streams.stderr, budget.maxCharsPerStream),
      };
      if (selectedStream) modelContent = streams[selectedStream];
    } else {
      throw new Error('stream-head-tail:v1 requires both projected streams.');
    }
  }
  const rawResultDigest = toolResultDigestV2('tool-result-raw:v2', rawBytes);
  const modelContentDigest = toolResultDigestV2('tool-result-model-content:v2', modelContent);
  const receipt: ToolResultBudgetReceiptV2 = Object.freeze({
    version: 2,
    projectionMode: input.projectionMode,
    policyId:
      input.projectionMode === 'budget_v2'
        ? input.resolvedBudget.policyId
        : 'tool-result-compat:v1',
    toolIdentity: input.resolvedBudget.toolIdentity,
    bindingDigest: input.resolvedBudget.bindingDigest,
    projectorId:
      input.projectionMode === 'budget_v2'
        ? input.resolvedBudget.projectorId
        : 'compat-projector:v1',
    projectorRevision:
      input.projectionMode === 'budget_v2'
        ? input.resolvedBudget.projectorRevision
        : 'compat-projector:v1',
    validatorId: input.resolvedBudget.validatorId,
    rawResultDigest,
    modelContentDigest,
    modelContentUtf8Bytes: Buffer.byteLength(modelContent, 'utf8'),
    ...(streams
      ? {
          streamProjection: {
            stdoutDigest: toolResultDigestV2('tool-result-stream-stdout:v2', streams.stdout),
            stderrDigest: toolResultDigestV2('tool-result-stream-stderr:v2', streams.stderr),
            stdoutChars: streams.stdout.length,
            stderrChars: streams.stderr.length,
          },
        }
      : {}),
    ...(input.continuation ? { continuation: input.continuation } : {}),
  });
  const digestScope: 'raw' | 'projected' =
    modelContent === input.projected.modelContent ? 'raw' : 'projected';
  return Object.freeze({
    ok: input.projected.ok,
    modelContent,
    ...(streams ? { streams: Object.freeze({ ...streams }) } : {}),
    resultMeta: Object.freeze({
      ...input.projected.resultMeta,
      rawResultDigest,
      modelContentDigest,
      digestScope,
      toolResultReceipt: receipt,
    }),
    receipt,
  });
}

export const CORE_TOOL_FAILURE_BUDGET_V2: ToolModelResultBudgetV2 = Object.freeze({
  kind: 'structured',
  maxUtf8Bytes: 2_048,
  projectorId: 'structured-receipt:v1',
});

export const STREAM_TOOL_RESULT_BUDGET_V2: ToolModelResultBudgetV2 = Object.freeze({
  kind: 'stream_head_tail',
  maxCharsPerStream: TOOL_RESULT_STREAM_MAX_CHARS_V2,
});

export const READ_FILE_RESULT_BUDGET_V2: ToolModelResultBudgetV2 = Object.freeze({
  kind: 'line_window',
  maxUtf8Bytes: TOOL_RESULT_UTF8_ENVELOPE_MAX_BYTES_V2,
  continuation: 'line_byte_cursor_v2',
  decoderContractId: READ_FILE_DECODER_CONTRACT_ID_V2,
});

export const UTF8_TOOL_RESULT_BUDGET_V2: ToolModelResultBudgetV2 = Object.freeze({
  kind: 'serialized',
  maxUtf8Bytes: TOOL_RESULT_UTF8_ENVELOPE_MAX_BYTES_V2,
});

export function coreToolFailureContentV2(code: string): string {
  return JSON.stringify({
    ok: false,
    code: 'core-tool-failure:v1',
    failure: code.slice(0, 128),
    guidance: 'Review the tool request and retry with valid bounded input.',
  });
}
