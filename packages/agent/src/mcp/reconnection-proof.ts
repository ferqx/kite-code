import { createHash } from 'node:crypto';
import type { ExtensionRecord, Json, PublicExecution, ReadContext } from '../extensions';
import { canonicalJson } from '../json';
import type { McpReconnectionInput } from './reconnection-types';

export const reconnectionType = 'builtin.mcp.reconnection';
export const reconnectionId = 'mcp.reconnect';
export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const hash = (value: unknown) =>
  createHash('sha256')
    .update(canonicalJson(value as Json))
    .digest('hex');
export const equal = (a: unknown, b: unknown) =>
  canonicalJson(a as Json) === canonicalJson(b as Json);
const id = (v: unknown, max = 128) =>
  typeof v === 'string' && new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`).test(v);
export const decimal64 = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^(0|[1-9][0-9]*)$/.test(v) &&
  v.length <= 19 &&
  BigInt(v) <= 9223372036854775807n;
const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export function closed(v: unknown, keys: readonly string[]) {
  const o = object(v);
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(o).length !== keys.length ||
    Object.keys(o).some((k) => !keys.includes(k))
  )
    throw Error('mcp_reconnection_invalid');
  return o;
}
export function decodeOperationRef(v: unknown) {
  const o = closed(v, [
    'commandId',
    'sessionId',
    'originStoreId',
    'extensionId',
    'key',
    'executionId',
  ]);
  if (
    !id(o.commandId) ||
    !id(o.sessionId) ||
    !id(o.originStoreId) ||
    o.extensionId !== 'builtin.mcp' ||
    !id(o.executionId) ||
    typeof o.key !== 'string' ||
    !/^connection\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,64}$/.test(o.key)
  )
    throw Error('mcp_reconnection_invalid');
  return o as unknown as McpReconnectionInput['target']['operationRef'];
}
export function decodeReconnectionInput(v: unknown): McpReconnectionInput {
  const o = closed(v, ['serverId', 'key', 'target', 'replacement']);
  const t = closed(o.target, [
    'carrierExecutionId',
    'carrierKey',
    'operationRef',
    'connectionExecutionId',
    'configDigest',
    'currentGeneration',
  ]);
  const ref = decodeOperationRef(t.operationRef);
  if (
    !id(o.serverId) ||
    !id(o.key, 64) ||
    !id(t.carrierExecutionId) ||
    !id(t.carrierKey, 64) ||
    !id(t.connectionExecutionId) ||
    ref.executionId !== t.connectionExecutionId ||
    !ref.key.startsWith(`connection/${o.serverId}/`) ||
    !digest(t.configDigest) ||
    !Number.isSafeInteger(t.currentGeneration) ||
    Number(t.currentGeneration) < 1
  )
    throw Error('mcp_reconnection_invalid');
  const r = object(o.replacement);
  if (r.kind === 'static') closed(r, ['kind', 'expectedConfigDigest']);
  else if (r.kind === 'source') {
    closed(r, ['kind', 'expectedConfigDigest', 'expectedReadSet']);
    const read = closed(r.expectedReadSet, [
      'scopeDigest',
      'user',
      'workspace',
      'approvalEtag',
      'bindingEtag',
      'variablesDigest',
    ]);
    if (
      !digest(read.scopeDigest) ||
      !digest(read.variablesDigest) ||
      (read.approvalEtag !== null && !digest(read.approvalEtag)) ||
      (read.bindingEtag !== null && !digest(read.bindingEtag))
    )
      throw Error('mcp_reconnection_invalid');
    for (const kind of ['user', 'workspace'] as const) {
      if (kind === 'workspace' && read[kind] === null) continue;
      const file = closed(read[kind], ['identity', 'etag', 'error']);
      const identity = closed(file.identity, ['kind', 'pathDigest', 'rootIdentity']);
      if (
        identity.kind !== kind ||
        !digest(identity.pathDigest) ||
        typeof identity.rootIdentity !== 'string' ||
        !identity.rootIdentity ||
        (file.etag !== null && !digest(file.etag)) ||
        (file.error !== null && typeof file.error !== 'string')
      )
        throw Error('mcp_reconnection_invalid');
    }
  } else throw Error('mcp_reconnection_invalid');
  if (!digest(r.expectedConfigDigest)) throw Error('mcp_reconnection_invalid');
  return structuredClone(o) as unknown as McpReconnectionInput;
}
export interface StopProof {
  connectionExecutionId: string;
  resultRevision: string;
  resultDigest: string;
}
export interface ReconnectionStage {
  version: 1;
  originalStoreId: string;
  sessionId: string;
  executionId: string;
  input: McpReconnectionInput;
  inputDigest: string;
  targetRecordKey: string;
  targetRecordRevision: string;
  stage: 'prepared' | 'old_stopped' | 'new_planned' | 'ready' | 'failed' | 'outcome_unknown';
  oldStop: StopProof | null;
  newOperationRef: McpReconnectionInput['target']['operationRef'] | null;
  catalogue: Json | null;
}
export function decodeStage(record: ExtensionRecord, e: PublicExecution): ReconnectionStage {
  const s = closed(record.value, [
    'version',
    'originalStoreId',
    'sessionId',
    'executionId',
    'input',
    'inputDigest',
    'targetRecordKey',
    'targetRecordRevision',
    'stage',
    'oldStop',
    'newOperationRef',
    'catalogue',
  ]);
  const input = decodeReconnectionInput(s.input);
  if (
    record.key !== `reconnection/${e.id}` ||
    record.contentType !== reconnectionType ||
    record.contentVersion !== 1 ||
    record.forkProvenance ||
    record.sessionId !== e.sessionId ||
    record.originStoreId !== e.originStoreId ||
    s.version !== 1 ||
    s.executionId !== e.id ||
    s.sessionId !== e.sessionId ||
    s.originalStoreId !== e.originStoreId ||
    s.inputDigest !== e.inputDigest ||
    hash(input) !== e.inputDigest ||
    s.targetRecordKey !== `connection/${input.serverId}/${input.target.carrierKey}` ||
    !decimal64(s.targetRecordRevision) ||
    s.targetRecordRevision === '0' ||
    typeof s.stage !== 'string' ||
    !['prepared', 'old_stopped', 'new_planned', 'ready', 'failed', 'outcome_unknown'].includes(
      s.stage,
    )
  )
    throw Error('mcp_reconnection_scope_unavailable');
  if (s.oldStop !== null) {
    const stop = closed(s.oldStop, ['connectionExecutionId', 'resultRevision', 'resultDigest']);
    if (
      stop.connectionExecutionId !== input.target.connectionExecutionId ||
      !decimal64(stop.resultRevision) ||
      !digest(stop.resultDigest)
    )
      throw Error('mcp_reconnection_scope_unavailable');
  }
  if (s.newOperationRef !== null) decodeOperationRef(s.newOperationRef);
  if (s.catalogue !== null) decodeCatalogue(s.catalogue);
  return s as unknown as ReconnectionStage;
}
export function decodeCatalogue(v: unknown) {
  const c = closed(v, [
    'originalStoreId',
    'serverId',
    'configDigest',
    'generation',
    'definitions',
    'operationRef',
  ]);
  decodeOperationRef(c.operationRef);
  if (
    !id(c.originalStoreId) ||
    !id(c.serverId) ||
    !digest(c.configDigest) ||
    !Number.isSafeInteger(c.generation) ||
    Number(c.generation) < 1 ||
    !Array.isArray(c.definitions) ||
    c.definitions.length > 16384 ||
    !c.definitions.every((d) => {
      const o = closed(d, ['id', 'version']);
      return typeof o.id === 'string' && !!o.id && typeof o.version === 'string' && !!o.version;
    })
  )
    throw Error('mcp_reconnection_scope_unavailable');
  return c;
}
export function decodeResultDetails(e: PublicExecution) {
  const d = object(object(e.result).details);
  closed(d, [
    'originalStoreId',
    'serverId',
    'target',
    'oldStop',
    'stopAttempted',
    'newConnectionAttempted',
    'newOperationRef',
    'catalogue',
    ...(Object.hasOwn(d, 'toolsMetadata') ? ['toolsMetadata'] : []),
  ]);
  if (typeof d.stopAttempted !== 'boolean' || typeof d.newConnectionAttempted !== 'boolean')
    throw Error('mcp_reconnection_scope_unavailable');
  return d;
}
export async function confirmedStop(
  context: ReadContext,
  input: McpReconnectionInput,
  proof: StopProof | null,
) {
  if (!proof) return null;
  const job = await context.getExecution(input.target.connectionExecutionId);
  const result = object(job?.result),
    details = object(result.details);
  if (
    !decimal64(proof.resultRevision) ||
    !job ||
    job.kind !== 'job' ||
    job.sessionId !== context.sessionId ||
    job.originStoreId !== input.target.operationRef.originStoreId ||
    job.originCommandId !== input.target.operationRef.commandId ||
    !['cancelled', 'failed', 'succeeded'].includes(job.status) ||
    !['cancelled', 'failed', 'succeeded'].includes(String(result.outcome)) ||
    Object.keys(details).length !== 2 ||
    details.transportStopped !== true ||
    details.remoteToolStopConfirmed !== false ||
    job.resultRevision !== proof.resultRevision ||
    hash(job.result) !== proof.resultDigest ||
    (job.definitionId !== 'mcp.source.connection' &&
      job.definitionId !== `mcp.connection.${input.serverId}`) ||
    job.definitionVersion !==
      (job.definitionId === 'mcp.source.connection' ? '1' : input.target.configDigest)
  )
    throw Error('mcp_reconnection_stop_unconfirmed');
  return job;
}
export async function savedReconnection(context: ReadContext, e: PublicExecution) {
  if (
    e.definitionId !== 'builtin.mcp/mcp.reconnect' ||
    e.definitionVersion !== '1' ||
    e.kind !== 'job' ||
    e.sessionId !== context.sessionId ||
    !e.originStoreId ||
    e.status !== 'succeeded' ||
    object(e.result).outcome !== 'succeeded'
  )
    throw Error('mcp_reconnection_scope_unavailable');
  const record = await context.records.get(`reconnection/${e.id}`);
  if (!record) throw Error('mcp_reconnection_scope_unavailable');
  const stage = decodeStage(record, e),
    d = decodeResultDetails(e),
    catalogue = decodeCatalogue(d.catalogue);
  if (
    stage.stage !== 'ready' ||
    !equal(d.target, stage.input.target) ||
    d.originalStoreId !== e.originStoreId ||
    d.serverId !== stage.input.serverId ||
    d.stopAttempted !== true ||
    d.newConnectionAttempted !== true ||
    !equal(d.oldStop, stage.oldStop) ||
    !equal(d.newOperationRef, stage.newOperationRef) ||
    !equal(catalogue, stage.catalogue) ||
    catalogue.configDigest !== stage.input.replacement.expectedConfigDigest ||
    !equal(catalogue.operationRef, stage.newOperationRef)
  )
    throw Error('mcp_reconnection_scope_unavailable');
  if (!stage.oldStop || !stage.newOperationRef) throw Error('mcp_reconnection_scope_unavailable');
  await confirmedStop(context, stage.input, stage.oldStop);
  return { stage, catalogue, record };
}
/** This validates the original parent only; it never recursively walks older reconnections. */
export async function proveConnectionParent(
  context: ReadContext,
  connection: PublicExecution,
  ref: unknown,
  serverId: string,
  configDigest: string,
) {
  const r = decodeOperationRef(ref),
    parent = connection.parentExecutionId
      ? await context.getExecution(connection.parentExecutionId)
      : null;
  if (
    !parent ||
    connection.kind !== 'job' ||
    connection.id !== r.executionId ||
    connection.originCommandId !== r.commandId ||
    connection.sessionId !== context.sessionId ||
    connection.originStoreId !== r.originStoreId ||
    r.sessionId !== context.sessionId ||
    parent.sessionId !== context.sessionId ||
    parent.originStoreId !== connection.originStoreId ||
    parent.rootWorkCommandId !== connection.rootWorkCommandId ||
    parent.rootWorkSeq !== connection.rootWorkSeq ||
    connection.definitionVersion !==
      (connection.definitionId === 'mcp.source.connection' ? '1' : configDigest) ||
    !['mcp.source.connection', `mcp.connection.${serverId}`].includes(
      connection.definitionId ?? '',
    ) ||
    !r.key.startsWith(`connection/${serverId}/`)
  )
    throw Error('mcp_reconnection_scope_unavailable');
  const key = r.key.slice(`connection/${serverId}/`.length);
  if (['mcp.connect', 'builtin.mcp/mcp.connect'].includes(parent.definitionId ?? '')) {
    if (
      parent.definitionVersion !== '1' ||
      !['tool', 'job'].includes(parent.kind) ||
      parent.inputDigest !== hash({ serverId, key })
    )
      throw Error('mcp_reconnection_scope_unavailable');
  } else {
    const p = await savedReconnection(context, parent);
    if (
      p.stage.input.key !== key ||
      p.stage.input.serverId !== serverId ||
      !equal(p.stage.newOperationRef, r) ||
      p.catalogue.configDigest !== configDigest
    )
      throw Error('mcp_reconnection_scope_unavailable');
  }
  return parent;
}
export async function proveCarrier(
  context: ReadContext,
  carrierId: string,
  key: string,
  serverId: string,
) {
  const e = await context.getExecution(carrierId),
    record = await context.records.get(`connection/${serverId}/${key}`);
  if (
    !e ||
    !record ||
    record.forkProvenance ||
    e.sessionId !== context.sessionId ||
    e.originStoreId !== record.originStoreId ||
    record.sessionId !== context.sessionId ||
    record.contentType !== 'builtin.mcp.catalogue' ||
    record.contentVersion !== 1 ||
    e.status !== 'succeeded' ||
    object(e.result).outcome !== 'succeeded'
  )
    throw Error('mcp_reconnection_scope_unavailable');
  let catalogue: Record<string, unknown>;
  if (['mcp.connect', 'builtin.mcp/mcp.connect'].includes(e.definitionId ?? '')) {
    if (
      e.definitionVersion !== '1' ||
      !['tool', 'job'].includes(e.kind) ||
      e.inputDigest !== hash({ serverId, key })
    )
      throw Error('mcp_reconnection_scope_unavailable');
    const details = { ...object(object(e.result).details) };
    delete details.toolsMetadata;
    catalogue = decodeCatalogue(details);
  } else {
    const proof = await savedReconnection(context, e);
    if (proof.stage.input.serverId !== serverId || proof.stage.input.key !== key)
      throw Error('mcp_reconnection_scope_unavailable');
    catalogue = proof.catalogue;
  }
  if (
    !equal(record.value, catalogue) ||
    catalogue.serverId !== serverId ||
    catalogue.originalStoreId !== e.originStoreId
  )
    throw Error('mcp_reconnection_scope_unavailable');
  const ref = decodeOperationRef(catalogue.operationRef),
    connection = await context.getExecution(ref.executionId);
  if (!connection) throw Error('mcp_reconnection_scope_unavailable');
  await proveConnectionParent(context, connection, ref, serverId, String(catalogue.configDigest));
  return { e, record, catalogue, ref, connection };
}
/** Durable zero-adapter rejection or the exact owned transport's confirmed terminal. */
export function stoppedOrUnopened(e: PublicExecution) {
  if (!['failed', 'cancelled', 'succeeded'].includes(e.status) || !decimal64(e.resultRevision))
    return false;
  const result = object(e.result),
    d = object(result.details);
  if (!['failed', 'cancelled', 'succeeded'].includes(String(result.outcome))) return false;
  if (
    Object.keys(d).length === 2 &&
    d.transportStopped === true &&
    d.remoteToolStopConfirmed === false
  )
    return true;
  if (
    Object.keys(result).length === 3 &&
    Object.keys(d).length === 2 &&
    d.adapterAttempted === false &&
    d.stopConfirmation === null &&
    typeof result.content === 'string' &&
    ['approval_denied', 'permission_denied'].includes(result.content)
  )
    return true;
  return false;
}
export function projectExecution(e: PublicExecution, input = false) {
  return {
    id: e.id,
    originStoreId: e.originStoreId ?? null,
    sessionId: e.sessionId,
    originCommandId: e.originCommandId ?? null,
    parentExecutionId: e.parentExecutionId ?? null,
    kind: e.kind,
    definitionId: e.definitionId ?? null,
    definitionVersion: e.definitionVersion ?? null,
    status: e.status,
    ...(input ? { inputDigest: e.inputDigest ?? null } : {}),
  };
}

const safeIdSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' };
const hexSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const closedSchema = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const sourceReadSchema = (kind: string) =>
  closedSchema({
    identity: closedSchema({
      kind: { const: kind },
      pathDigest: hexSchema,
      rootIdentity: { type: 'string', minLength: 1 },
    }),
    etag: { anyOf: [hexSchema, { type: 'null' }] },
    error: { type: ['string', 'null'] },
  });
export const reconnectionInputSchema = closedSchema({
  serverId: safeIdSchema,
  key: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
  target: closedSchema({
    carrierExecutionId: safeIdSchema,
    carrierKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
    operationRef: closedSchema({
      commandId: safeIdSchema,
      sessionId: safeIdSchema,
      originStoreId: safeIdSchema,
      extensionId: { const: 'builtin.mcp' },
      key: { type: 'string', pattern: '^connection/[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,64}$' },
      executionId: safeIdSchema,
    }),
    connectionExecutionId: safeIdSchema,
    configDigest: hexSchema,
    currentGeneration: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  }),
  replacement: {
    oneOf: [
      closedSchema({ kind: { const: 'static' }, expectedConfigDigest: hexSchema }),
      closedSchema({
        kind: { const: 'source' },
        expectedConfigDigest: hexSchema,
        expectedReadSet: closedSchema({
          scopeDigest: hexSchema,
          user: sourceReadSchema('user'),
          workspace: { anyOf: [sourceReadSchema('workspace'), { type: 'null' }] },
          approvalEtag: { anyOf: [hexSchema, { type: 'null' }] },
          bindingEtag: { anyOf: [hexSchema, { type: 'null' }] },
          variablesDigest: hexSchema,
        }),
      }),
    ],
  },
}) as import('../extensions').JsonSchema;
