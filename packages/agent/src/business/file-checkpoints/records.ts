import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import type {
  ActionContext,
  ExtensionRecord,
  Json,
  JsonSchema,
  RecordDefinition,
} from '../../extensions';
import { canonicalJson } from '../../json';
import { AgentError } from '../../storage/types';
import { fileCheckpointForkRule, forkType } from './fork';
import type { FileCheckpoint, FileCheckpointRecord } from './types';

export const namespace = 'builtin.files';
export const pointType = 'builtin.files.checkpoint';
export const fileType = 'builtin.files.checkpoint.file';
export const headType = 'builtin.files.checkpoint.head';
export const intentType = 'builtin.files.checkpoint.intent';
export const effectType = 'builtin.files.checkpoint.restore-effect';
const id = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' };
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const decimal = { type: 'string', pattern: '^(0|[1-9][0-9]*)$' };
const text = { type: 'string', minLength: 1, maxLength: 4096 };
const object = (
  properties: Record<string, Json>,
  required = Object.keys(properties),
): JsonSchema => ({ type: 'object', additionalProperties: false, properties, required });
export const baselineSchema = object({
  hash,
  size: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  device: decimal,
  inode: decimal,
});
const source = object({
  executionId: id,
  runId: id,
  definitionId: { enum: ['files.write', 'files.edit'] },
  definitionVersion: { const: '2' },
  attempt: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  inputDigest: hash,
  modelExecutionId: id,
  modelInputHash: hash,
});
const artifact = object({
  id: text,
  mediaType: { const: 'application/octet-stream' },
  size: decimal,
  scope: object({ kind: { const: 'execution' }, id }),
});
const preimage = object({
  source,
  baseline: { anyOf: [baselineSchema, { type: 'null' }] },
  artifact: { anyOf: [artifact, { type: 'null' }] },
});
export const boundarySchema = object({
  storeId: id,
  workspaceId: id,
  sessionId: id,
  runId: id,
  contextSelectionId: id,
  messageId: { anyOf: [id, { type: 'null' }] },
  messageSeq: decimal,
  triggerMessageId: id,
  triggerSeq: decimal,
});
const pointSchema = object({
  id: hash,
  boundary: boundarySchema,
  workspace: object({ device: decimal, inode: decimal }),
});
const headSchema = object({
  checkpointId: hash,
  executionId: id,
  state: { enum: ['pending', 'idle', 'unknown'] },
});
const fileSchema = object({
  checkpointId: hash,
  path: text,
  first: { anyOf: [preimage, { type: 'null' }] },
  last: { anyOf: [object({ source, baseline: baselineSchema }), { type: 'null' }] },
  pending: { anyOf: [preimage, { type: 'null' }] },
  state: { enum: ['pending', 'captured', 'failed', 'unknown'] },
});
const blockedIntentSchema = object({
  id,
  checkpointId: hash,
  phase: { const: 'blocked' },
  reason: { const: 'checkpoint_restore_boundary_unavailable' },
  headRevision: decimal,
  fileRevisions: { type: 'array', items: object({ path: text, revision: decimal }) },
});
const restoreFileProperties: Record<string, Json> = {
  path: text,
  operation: { enum: ['restore', 'remove', 'unchanged'] },
  state: {
    enum: [
      'not_started',
      'pending',
      'restored',
      'removed',
      'unchanged',
      'failed',
      'outcome_unknown',
    ],
  },
  expected: baselineSchema,
  original: { anyOf: [baselineSchema, { type: 'null' }] },
  preimage: { anyOf: [artifact, { type: 'null' }] },
  error: { anyOf: [{ type: 'string', maxLength: 256 }, { type: 'null' }] },
};
const intentSchema = (version: 1 | 2): JsonSchema => ({
  anyOf: [
    blockedIntentSchema,
    object({
      id,
      checkpointId: hash,
      executionId: id,
      planDigest: hash,
      ...(version === 2 ? { rootWorkSeq: decimal } : {}),
      phase: { enum: ['restoring', 'restored', 'failed', 'outcome_unknown'] },
      files: {
        type: 'array',
        items: object({
          ...restoreFileProperties,
          ...(version === 2
            ? {
                expected: { anyOf: [baselineSchema, { type: 'null' }] },
                confirmedPost: {
                  anyOf: [
                    object({ baseline: { anyOf: [baselineSchema, { type: 'null' }] } }),
                    { type: 'null' },
                  ],
                },
              }
            : {}),
        }),
      },
    }),
  ],
});
const effectSchema = object({
  restoreId: id,
  checkpointId: hash,
  executionId: id,
  rootWorkSeq: decimal,
  path: text,
  expected: { anyOf: [baselineSchema, { type: 'null' }] },
  beforeImage: { anyOf: [artifact, { type: 'null' }] },
  confirmedPost: {
    anyOf: [object({ baseline: { anyOf: [baselineSchema, { type: 'null' }] } }), { type: 'null' }],
  },
  state: { enum: ['pending', 'confirmed', 'unknown'] },
});
const snapshotRecord = (type: string, version: number, schema: JsonSchema): JsonSchema =>
  object({
    extensionId: { const: namespace },
    sessionId: id,
    key: text,
    revision: decimal,
    contentType: { const: type },
    contentVersion: { const: version },
    originStoreId: id,
    value: schema,
  });
const forkSchema = object({
  events: {
    type: 'array',
    maxItems: 64,
    items: {
      oneOf: [
        object({
          kind: { const: 'capture' },
          point: snapshotRecord(pointType, 1, pointSchema),
          head: snapshotRecord(headType, 1, headSchema),
          files: {
            type: 'array',
            minItems: 1,
            maxItems: 64,
            items: snapshotRecord(fileType, 1, fileSchema),
          },
        }),
        object({
          kind: { const: 'restore' },
          journal: snapshotRecord(intentType, 2, intentSchema(2)),
          effects: {
            type: 'array',
            maxItems: 64,
            items: snapshotRecord(effectType, 1, effectSchema),
          },
        }),
      ],
    },
  },
});
const forkRule = fileCheckpointForkRule({
  namespace,
  pointType,
  headType,
  fileType,
  intentType,
  effectType,
  point,
  file,
  decode,
});
export const recordDefinitions: readonly RecordDefinition[] = [
  {
    contentType: headType,
    contentVersion: 1,
    schema: headSchema,
    fork: forkRule,
  },
  { contentType: pointType, contentVersion: 1, schema: pointSchema },
  { contentType: fileType, contentVersion: 1, schema: fileSchema },
  { contentType: intentType, contentVersion: 1, schema: intentSchema(1) },
  { contentType: intentType, contentVersion: 2, schema: intentSchema(2) },
  { contentType: effectType, contentVersion: 1, schema: effectSchema },
  { contentType: forkType, contentVersion: 1, schema: forkSchema, fork: forkRule },
];
const ajv = new Ajv({ strict: false, allErrors: false });
const validators = new Map(
  recordDefinitions.map((definition) => [
    `${definition.contentType}@${definition.contentVersion}`,
    ajv.compile(definition.schema),
  ]),
);
export function validate(
  type: string,
  value: unknown,
  version = type === intentType ? 2 : 1,
): void {
  if (!validators.get(`${type}@${version}`)?.(value))
    throw new AgentError('checkpoint_record_invalid');
}
export function digest(value: Json): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
export function bytesDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
export function pointKey(id: string): string {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new AgentError('checkpoint_id_invalid');
  return `checkpoint/${id}/point`;
}
export function fileKey(id: string, path: string): string {
  return `${pointKey(id).slice(0, -5)}file/${bytesDigest(Buffer.from(path))}`;
}
export function decode<T>(record: ExtensionRecord, type: string): T {
  if (
    record.extensionId !== namespace ||
    record.contentType !== type ||
    (record.contentVersion !== 1 && !(type === intentType && record.contentVersion === 2))
  )
    throw new AgentError('checkpoint_record_unavailable');
  validate(type, record.value, record.contentVersion);
  return record.value as T;
}
export function point(record: ExtensionRecord): FileCheckpoint {
  const value = decode<FileCheckpoint>(record, pointType);
  if (
    record.key !== pointKey(value.id) ||
    digest(value.boundary as unknown as Json) !== value.id ||
    record.sessionId !== value.boundary.sessionId ||
    record.originStoreId !== value.boundary.storeId
  )
    throw new AgentError('checkpoint_scope_conflict');
  return value;
}
export function file(record: ExtensionRecord, checkpoint: FileCheckpoint): FileCheckpointRecord {
  const value = decode<FileCheckpointRecord>(record, fileType);
  if (
    value.checkpointId !== checkpoint.id ||
    record.key !== fileKey(checkpoint.id, value.path) ||
    record.sessionId !== checkpoint.boundary.sessionId ||
    record.originStoreId !== checkpoint.boundary.storeId
  )
    throw new AgentError('checkpoint_scope_conflict');
  return value;
}
export async function write(
  context: ActionContext,
  key: string,
  type: string,
  value: unknown,
  prior: ExtensionRecord | null,
): Promise<ExtensionRecord> {
  validate(type, value);
  return context.records.write({
    key,
    contentType: type,
    contentVersion: type === intentType ? 2 : 1,
    expectedRevision: prior?.revision ?? null,
    value: value as Json,
    executable: true,
  });
}
