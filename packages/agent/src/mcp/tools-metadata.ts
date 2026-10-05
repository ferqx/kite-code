import { createHash } from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ActionContext, ArtifactRef, Json, ReadContext } from '../extensions';
import { canonicalJson } from '../json';
import { proveConnectionParent, savedReconnection } from './reconnection-proof';

export const toolsSnapshotType = 'builtin.mcp.tools.snapshot';
export interface ToolsOrigin {
  originStoreId: string;
  sessionId: string;
  serverId: string;
  configDigest: string;
  connectionExecutionId: string;
  publisherExecutionId: string;
  generation: number;
}
export interface ToolsContentRef {
  id: string;
  scope: { kind: 'execution'; id: string };
  mediaType: 'application/json; charset=utf-8' | 'application/octet-stream';
  size: string;
  hash: string;
}
export interface ToolsSnapshot {
  recordKey: string;
  sourceRecordKey: string;
  origin: ToolsOrigin;
  availability: 'available' | 'unavailable';
  reason: string | null;
  toolCount: number;
  index: ToolsContentRef | null;
}
export interface ToolsEntry {
  index: number;
  definitionId: string;
  definitionVersion: string;
  label: string;
  labelComplete: boolean;
  descriptorHash: string;
  descriptorBytes: string;
  manifest: ToolsContentRef;
}
export interface ToolsMetadataCapture {
  serverId: string;
  configDigest: string;
  generation: number;
  available: boolean;
  tools: readonly { definitionId: string; definitionVersion: string; descriptor: Tool }[];
}
const jsonMime = 'application/json; charset=utf-8' as const;
const bytesMime = 'application/octet-stream' as const;
const nodeLimit = 256 * 1024;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const encoded = (value: unknown) => Buffer.from(canonicalJson(value as Json));
const obj = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('mcp_tools_metadata_invalid');
  return value as Record<string, unknown>;
};
const closed = (value: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(value).length !== keys.length || !keys.every((key) => key in value))
    throw new Error('mcp_tools_metadata_invalid');
};
const decimal = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(0|[1-9][0-9]*)$/.test(value) &&
  value.length <= 19 &&
  BigInt(value) <= 9223372036854775807n;
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;
const hex = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (n >= 0xdc00 && n <= 0xdfff) return false;
  }
  return true;
}
const same = (a: unknown, b: unknown) => canonicalJson(a as Json) === canonicalJson(b as Json);
function origin(value: unknown): ToolsOrigin {
  const o = obj(value);
  closed(o, [
    'originStoreId',
    'sessionId',
    'serverId',
    'configDigest',
    'connectionExecutionId',
    'publisherExecutionId',
    'generation',
  ]);
  if (
    !['originStoreId', 'sessionId', 'connectionExecutionId', 'publisherExecutionId'].every((k) =>
      text(o[k]),
    ) ||
    typeof o.serverId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(o.serverId) ||
    !hex(o.configDigest) ||
    !Number.isSafeInteger(o.generation) ||
    Number(o.generation) < 1
  )
    throw new Error('mcp_tools_metadata_invalid');
  return o as unknown as ToolsOrigin;
}
function internalRef(value: unknown): { id: string; size: string; hash: string } {
  const r = obj(value);
  closed(r, ['id', 'size', 'hash']);
  if (!text(r.id) || !decimal(r.size) || !hex(r.hash))
    throw new Error('mcp_tools_metadata_invalid');
  return r as unknown as { id: string; size: string; hash: string };
}
function contentRef(
  value: unknown,
  o: ToolsOrigin,
  mime: typeof jsonMime | typeof bytesMime,
): ToolsContentRef {
  const r = obj(value);
  closed(r, ['id', 'scope', 'mediaType', 'size', 'hash']);
  const scope = obj(r.scope);
  closed(scope, ['kind', 'id']);
  internalRef({ id: r.id, size: r.size, hash: r.hash });
  if (r.mediaType !== mime || scope.kind !== 'execution' || scope.id !== o.publisherExecutionId)
    throw new Error('mcp_tools_metadata_invalid');
  return r as unknown as ToolsContentRef;
}
const expand = (
  r: { id: string; size: string; hash: string },
  o: ToolsOrigin,
): ToolsContentRef => ({
  ...r,
  scope: { kind: 'execution', id: o.publisherExecutionId },
  mediaType: jsonMime,
});
export async function publishToolsSnapshot(
  context: ActionContext,
  sourceRecordKey: string,
  connectionExecutionId: string,
  captured: ToolsMetadataCapture,
): Promise<ToolsSnapshot> {
  const own = await context.getExecution(context.executionId);
  if (!own?.originStoreId || own.sessionId !== context.sessionId)
    throw new Error('mcp_tools_publisher_invalid');
  const o: ToolsOrigin = {
    originStoreId: own.originStoreId,
    sessionId: context.sessionId,
    serverId: captured.serverId,
    configDigest: captured.configDigest,
    connectionExecutionId,
    publisherExecutionId: own.id,
    generation: captured.generation,
  };
  const snapshot: ToolsSnapshot = {
    recordKey: `tools/${hash(Buffer.from(own.id))}`,
    sourceRecordKey,
    origin: o,
    availability: 'unavailable',
    reason: 'mcp_tools_metadata_unavailable',
    toolCount: captured.tools.length,
    index: null,
  };
  let publications = 0,
    metadataBytes = 0;
  const publish = async (bytes: Uint8Array, mime: typeof jsonMime | typeof bytesMime) => {
    publications++;
    if (mime === jsonMime) metadataBytes += bytes.length;
    if (
      publications > 65536 ||
      (mime === jsonMime && (bytes.length > nodeLimit || metadataBytes > 64 * 1024 * 1024))
    )
      throw new Error('mcp_tools_metadata_limit');
    const ref = await context.artifacts!.publish({
      key: `tools-${publications}`,
      content: bytes,
      mediaType: mime,
    });
    if (
      !text(ref.id) ||
      ref.size !== String(bytes.length) ||
      ref.mediaType !== mime ||
      ref.scope?.kind !== 'execution' ||
      ref.scope.id !== own.id
    )
      throw new Error('mcp_tools_publisher_invalid');
    return { id: ref.id, size: ref.size, hash: hash(bytes) };
  };
  try {
    origin(o);
    if (!captured.available || captured.tools.length > 16384)
      throw new Error('mcp_tools_metadata_limit');
    if (!context.artifacts) throw new Error('mcp_tools_artifacts_unavailable');
    const pages: { id: string; size: string; hash: string }[] = [];
    let entries: ToolsEntry[] = [];
    for (const [index, tool] of captured.tools.entries()) {
      const bytes = encoded(tool.descriptor);
      if (!bytes.length || Math.ceil(bytes.length / 65536) > 2048)
        throw new Error('mcp_tools_metadata_limit');
      const chunks: { id: string; size: string; hash: string }[] = [];
      for (let offset = 0; offset < bytes.length; offset += 65536)
        chunks.push(await publish(bytes.subarray(offset, offset + 65536), bytesMime));
      const descriptorHash = hash(bytes),
        descriptorBytes = String(bytes.length);
      const manifest = await publish(
        encoded({
          kind: 'mcp_tool_descriptor',
          version: 1,
          origin: o,
          toolIndex: index,
          definitionId: tool.definitionId,
          definitionVersion: tool.definitionVersion,
          descriptorHash,
          descriptorBytes,
          chunks,
        }),
        jsonMime,
      );
      let label = tool.descriptor.name.slice(0, 120);
      if (/[\uD800-\uDBFF]$/.test(label)) label = label.slice(0, -1);
      if (!wellFormed(label)) throw new Error('mcp_tools_metadata_invalid');
      entries.push({
        index,
        definitionId: tool.definitionId,
        definitionVersion: tool.definitionVersion,
        label,
        labelComplete: label === tool.descriptor.name,
        descriptorHash,
        descriptorBytes,
        manifest: expand(manifest, o),
      });
      if (entries.length === 32 || index === captured.tools.length - 1) {
        pages.push(
          await publish(
            encoded({
              kind: 'mcp_tools_index_page',
              version: 1,
              origin: o,
              startIndex: index - entries.length + 1,
              toolCount: captured.tools.length,
              entries,
            }),
            jsonMime,
          ),
        );
        entries = [];
      }
    }
    const root = await publish(
      encoded({
        kind: 'mcp_tools_index',
        version: 1,
        origin: o,
        sourceRecordKey,
        toolCount: captured.tools.length,
        itemsPerPage: 32,
        pages,
      }),
      jsonMime,
    );
    snapshot.availability = 'available';
    snapshot.reason = null;
    snapshot.index = expand(root, o);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    snapshot.reason = ['mcp_tools_metadata_limit', 'mcp_tools_artifacts_unavailable'].includes(code)
      ? code
      : 'mcp_tools_publication_failed';
  }
  if (encoded(snapshot).length > 8192) throw new Error('mcp_tools_metadata_limit');
  // An unconfirmed record write is not degraded into a fabricated saved snapshot.
  await context.records.write({
    key: snapshot.recordKey,
    expectedRevision: null,
    contentType: toolsSnapshotType,
    contentVersion: 1,
    value: snapshot as unknown as Json,
  });
  return snapshot;
}
export async function readToolsSnapshot(context: ReadContext, key: string): Promise<ToolsSnapshot> {
  const record = await context.records.get(key);
  if (
    !record ||
    record.forkProvenance ||
    record.sessionId !== context.sessionId ||
    record.contentType !== toolsSnapshotType ||
    record.contentVersion !== 1
  )
    throw new Error('mcp_tools_scope_unavailable');
  const s = obj(record.value);
  closed(s, [
    'recordKey',
    'sourceRecordKey',
    'origin',
    'availability',
    'reason',
    'toolCount',
    'index',
  ]);
  const o = origin(s.origin);
  if (
    o.sessionId !== context.sessionId ||
    (record.originStoreId !== null && record.originStoreId !== o.originStoreId) ||
    s.recordKey !== key ||
    key !== `tools/${hash(Buffer.from(o.publisherExecutionId))}` ||
    typeof s.sourceRecordKey !== 'string' ||
    !Number.isInteger(s.toolCount) ||
    Number(s.toolCount) < 0 ||
    Number(s.toolCount) > 16384 ||
    !['available', 'unavailable'].includes(String(s.availability))
  )
    throw new Error('mcp_tools_scope_unavailable');
  if (s.availability === 'available') {
    contentRef(s.index, o, jsonMime);
    if (s.reason !== null) throw new Error('mcp_tools_metadata_invalid');
  } else if (
    s.index !== null ||
    typeof s.reason !== 'string' ||
    ![
      'mcp_tools_metadata_unavailable',
      'mcp_tools_metadata_limit',
      'mcp_tools_artifacts_unavailable',
      'mcp_tools_publication_failed',
    ].includes(s.reason)
  )
    throw new Error('mcp_tools_metadata_invalid');
  const publisher = await context.getExecution(o.publisherExecutionId);
  const connection = await context.getExecution(o.connectionExecutionId);
  const source = await context.records.get(s.sourceRecordKey);
  const v = obj(source?.value),
    operation = obj(v.operationRef);
  const result = obj(publisher?.result),
    details = obj(result.details),
    metadata = obj(details.toolsMetadata);
  const reconnectPublisher = publisher?.definitionId === 'builtin.mcp/mcp.reconnect';
  let reconnectProof: Awaited<ReturnType<typeof savedReconnection>> | undefined;
  if (reconnectPublisher && publisher) reconnectProof = await savedReconnection(context, publisher);
  const catalogueDetails = reconnectProof ? obj(details.catalogue) : details;
  const sourceProof = { ...catalogueDetails };
  delete sourceProof.toolsMetadata;
  const prefix = `connection/${o.serverId}/`;
  if (
    typeof operation.key !== 'string' ||
    !operation.key.startsWith(prefix) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(operation.key.slice(prefix.length)) ||
    !connection?.parentExecutionId
  )
    throw new Error('mcp_tools_scope_unavailable');
  await proveConnectionParent(context, connection, operation, o.serverId, o.configDigest);
  if (
    !publisher ||
    !connection ||
    !source ||
    source.forkProvenance ||
    source.sessionId !== context.sessionId ||
    source.contentVersion !== 1 ||
    source.originStoreId !== o.originStoreId ||
    publisher.originStoreId !== o.originStoreId ||
    connection.originStoreId !== o.originStoreId ||
    publisher.sessionId !== context.sessionId ||
    connection.sessionId !== context.sessionId ||
    result.outcome !== 'succeeded' ||
    publisher.definitionVersion !== '1' ||
    ![
      'mcp.connect',
      'builtin.mcp/mcp.connect',
      'mcp.catalogue.refresh',
      'builtin.mcp/mcp.catalogue.refresh',
      'builtin.mcp/mcp.reconnect',
    ].includes(publisher.definitionId ?? '') ||
    !['tool', 'job'].includes(publisher.kind) ||
    connection.kind !== 'job' ||
    ![`mcp.connection.${o.serverId}`, 'mcp.source.connection'].includes(
      connection.definitionId ?? '',
    ) ||
    v.serverId !== o.serverId ||
    v.configDigest !== o.configDigest ||
    v.originalStoreId !== o.originStoreId ||
    v.generation !== o.generation ||
    operation.executionId !== o.connectionExecutionId ||
    operation.sessionId !== context.sessionId ||
    operation.originStoreId !== o.originStoreId ||
    operation.extensionId !== 'builtin.mcp' ||
    operation.commandId !== connection.originCommandId ||
    connection.definitionVersion !==
      (connection.definitionId === 'mcp.source.connection' ? '1' : o.configDigest) ||
    metadata.recordKey !== key ||
    metadata.availability !== s.availability ||
    metadata.reason !== s.reason ||
    catalogueDetails.serverId !== o.serverId ||
    catalogueDetails.configDigest !== o.configDigest ||
    catalogueDetails.generation !== o.generation ||
    !same(sourceProof, v) ||
    !same(catalogueDetails.operationRef, v.operationRef) ||
    !Array.isArray(v.definitions) ||
    v.definitions.length !== s.toolCount ||
    !same(catalogueDetails.definitions, v.definitions) ||
    (source.contentType === 'builtin.mcp.refresh'
      ? v.executionId !== o.publisherExecutionId ||
        s.sourceRecordKey !== `refresh/${o.publisherExecutionId}` ||
        !['mcp.catalogue.refresh', 'builtin.mcp/mcp.catalogue.refresh'].includes(
          publisher.definitionId ?? '',
        ) ||
        v.inputDigest !== publisher.inputDigest ||
        v.runId !== publisher.runId
      : source.contentType !== 'builtin.mcp.catalogue' ||
        !s.sourceRecordKey.startsWith(`connection/${o.serverId}/`) ||
        (reconnectProof
          ? reconnectProof.stage.input.serverId !== o.serverId ||
            reconnectProof.stage.input.key !== s.sourceRecordKey.slice(prefix.length) ||
            !same(reconnectProof.stage.newOperationRef, operation)
          : !['mcp.connect', 'builtin.mcp/mcp.connect'].includes(publisher.definitionId ?? '') ||
            publisher.inputDigest !==
              hash(
                encoded({
                  serverId: o.serverId,
                  key: s.sourceRecordKey.slice(`connection/${o.serverId}/`.length),
                }),
              )))
  )
    throw new Error('mcp_tools_scope_unavailable');
  return s as unknown as ToolsSnapshot;
}
async function node(context: ReadContext, ref: ToolsContentRef): Promise<Record<string, unknown>> {
  if (!context.artifacts) throw new Error('mcp_tools_artifacts_unavailable');
  if (BigInt(ref.size) > BigInt(nodeLimit)) throw new Error('mcp_tools_metadata_limit');
  const bytes = await context.artifacts.read(ref as ArtifactRef);
  if (String(bytes.length) !== ref.size || hash(bytes) !== ref.hash)
    throw new Error('mcp_tools_metadata_invalid');
  return obj(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}
export async function readToolsPage(
  context: ReadContext,
  snapshot: ToolsSnapshot,
  afterIndex: number,
  limit: number,
  indexDigest?: string,
) {
  const o = snapshot.origin;
  const base = {
    version: 1,
    recordKey: snapshot.recordKey,
    binding: { ...o, indexDigest: snapshot.index?.hash ?? null },
    availability: 'unavailable',
    reason: snapshot.reason,
    toolCount: snapshot.toolCount,
    startIndex: afterIndex,
    entries: [] as ToolsEntry[],
    nextIndex: null as number | null,
    complete: false,
    live: false,
    currentGeneration: null as number | null,
  };
  if (snapshot.availability !== 'available') return base;
  try {
    if (
      (afterIndex > 0 && !indexDigest) ||
      (indexDigest !== undefined && indexDigest !== snapshot.index!.hash) ||
      afterIndex > snapshot.toolCount
    )
      throw new Error('mcp_tools_metadata_invalid');
    const root = await node(context, snapshot.index!);
    closed(root, [
      'kind',
      'version',
      'origin',
      'sourceRecordKey',
      'toolCount',
      'itemsPerPage',
      'pages',
    ]);
    if (
      root.kind !== 'mcp_tools_index' ||
      root.version !== 1 ||
      !same(root.origin, o) ||
      root.sourceRecordKey !== snapshot.sourceRecordKey ||
      root.toolCount !== snapshot.toolCount ||
      root.itemsPerPage !== 32 ||
      !Array.isArray(root.pages) ||
      root.pages.length !== Math.ceil(snapshot.toolCount / 32)
    )
      throw new Error('mcp_tools_metadata_invalid');
    const refs = root.pages.map(internalRef);
    if (new Set(refs.map((r) => r.id)).size !== refs.length)
      throw new Error('mcp_tools_metadata_invalid');
    const entries: ToolsEntry[] = [];
    let position = afterIndex;
    while (position < snapshot.toolCount && entries.length < limit) {
      const pageStart = Math.floor(position / 32) * 32;
      const page = await node(context, expand(refs[Math.floor(position / 32)]!, o));
      closed(page, ['kind', 'version', 'origin', 'startIndex', 'toolCount', 'entries']);
      if (
        page.kind !== 'mcp_tools_index_page' ||
        page.version !== 1 ||
        !same(page.origin, o) ||
        page.startIndex !== pageStart ||
        page.toolCount !== snapshot.toolCount ||
        !Array.isArray(page.entries) ||
        page.entries.length !== Math.min(32, snapshot.toolCount - pageStart)
      )
        throw new Error('mcp_tools_metadata_invalid');
      for (const [offset, raw] of page.entries.entries()) {
        const e = obj(raw);
        closed(e, [
          'index',
          'definitionId',
          'definitionVersion',
          'label',
          'labelComplete',
          'descriptorHash',
          'descriptorBytes',
          'manifest',
        ]);
        contentRef(e.manifest, o, jsonMime);
        if (
          e.index !== pageStart + offset ||
          !text(e.definitionId) ||
          !text(e.definitionVersion) ||
          typeof e.label !== 'string' ||
          e.label.length > 120 ||
          !wellFormed(e.label) ||
          typeof e.labelComplete !== 'boolean' ||
          !hex(e.descriptorHash) ||
          !decimal(e.descriptorBytes)
        )
          throw new Error('mcp_tools_metadata_invalid');
      }
      while (position < pageStart + page.entries.length && entries.length < limit) {
        const e = page.entries[position - pageStart] as unknown as ToolsEntry;
        if (encoded({ ...base, entries: [...entries, e] }).length > 31 * 1024) break;
        entries.push(e);
        position++;
      }
      if (position < pageStart + page.entries.length) break;
    }
    if (!entries.length && position < snapshot.toolCount)
      throw new Error('mcp_tools_metadata_limit');
    return {
      ...base,
      availability: 'available',
      reason: null,
      entries,
      nextIndex: position < snapshot.toolCount ? position : null,
      complete: position === snapshot.toolCount,
    };
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    return {
      ...base,
      reason: code === 'mcp_tools_artifacts_unavailable' ? code : 'mcp_tools_metadata_unavailable',
    };
  }
}
