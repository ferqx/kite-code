import { ClientError } from './decode';
import type { QueryResponse } from './generated/api';
import type { AgentClient } from './index';
import { digestModelBody } from './model-input';

export interface McpToolsOrigin {
  readonly originStoreId: string;
  readonly sessionId: string;
  readonly serverId: string;
  readonly configDigest: string;
  readonly connectionExecutionId: string;
  readonly publisherExecutionId: string;
  readonly generation: number;
}
export interface McpToolsContentRef {
  readonly id: string;
  readonly scope: { readonly kind: 'execution'; readonly id: string };
  readonly mediaType: 'application/json; charset=utf-8' | 'application/octet-stream';
  readonly size: string;
  readonly hash: string;
}
export interface McpToolsSnapshot {
  readonly recordKey: string;
  readonly sourceRecordKey: string;
  readonly origin: McpToolsOrigin;
  readonly availability: 'available' | 'unavailable';
  readonly reason: string | null;
  readonly toolCount: number;
  readonly index: McpToolsContentRef | null;
}
export interface McpToolsSnapshots {
  readonly version: 1;
  readonly sessionId: string;
  readonly items: readonly McpToolsSnapshot[];
  readonly nextAfterKey: string | null;
}
export interface McpToolsBinding extends McpToolsOrigin {
  readonly indexDigest: string | null;
}
export interface McpToolsEntry {
  readonly index: number;
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly label: string;
  readonly labelComplete: boolean;
  readonly descriptorHash: string;
  readonly descriptorBytes: string;
  readonly manifest: McpToolsContentRef;
}
export interface McpToolsPage {
  readonly version: 1;
  readonly recordKey: string;
  readonly binding: McpToolsBinding;
  readonly availability: 'available' | 'unavailable';
  readonly reason: string | null;
  readonly toolCount: number;
  readonly startIndex: number;
  readonly entries: readonly McpToolsEntry[];
  readonly nextIndex: number | null;
  readonly complete: boolean;
  readonly live: boolean;
  readonly currentGeneration: number | null;
}
/** Complete original SDK metadata; additional admitted fields are preserved verbatim. */
export interface McpToolMetadata {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

const jsonMime = 'application/json; charset=utf-8';
const bytesMime = 'application/octet-stream';
const chunkBytes = 64 * 1024;
const nodeBytes = 256 * 1024;
const maximumChunks = 2048;
const originKeys = [
  'originStoreId',
  'sessionId',
  'serverId',
  'configDigest',
  'connectionExecutionId',
  'publisherExecutionId',
  'generation',
] as const;
function invalid(): never {
  throw new ClientError('mcp_tools_metadata_invalid');
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
};
function closed(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key)))
    invalid();
}
const opaque = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const text = (value: unknown, maximum = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;
const hex = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const decimal = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^(0|[1-9][0-9]{0,18})$/.test(value) &&
  BigInt(value) <= 9223372036854775807n;
const integer = (value: unknown, minimum: number, maximum: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
const recordKey = (value: unknown): value is string =>
  typeof value === 'string' && /^tools\/[a-f0-9]{64}$/.test(value);
const reason = (value: unknown): value is string =>
  typeof value === 'string' && /^mcp_tools_[a-z_]{1,64}$/.test(value);

function wellFormedLabel(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function validateOrigin(value: unknown, binding = false): McpToolsOrigin {
  const o = object(value);
  closed(o, binding ? [...originKeys, 'indexDigest'] : originKeys);
  if (
    ![
      'originStoreId',
      'sessionId',
      'serverId',
      'connectionExecutionId',
      'publisherExecutionId',
    ].every((key) => opaque(o[key])) ||
    !hex(o.configDigest) ||
    !integer(o.generation, 1, Number.MAX_SAFE_INTEGER) ||
    (binding && o.indexDigest !== null && !hex(o.indexDigest))
  )
    invalid();
  return o as unknown as McpToolsOrigin;
}
function sameOrigin(left: McpToolsOrigin, right: McpToolsOrigin): boolean {
  return originKeys.every((key) => left[key] === right[key]);
}
function validateContentRef(value: unknown, origin: McpToolsOrigin): McpToolsContentRef {
  const ref = object(value),
    scope = object(ref.scope);
  closed(ref, ['id', 'scope', 'mediaType', 'size', 'hash']);
  closed(scope, ['kind', 'id']);
  if (
    !opaque(ref.id) ||
    !decimal(ref.size) ||
    BigInt(ref.size) < 1n ||
    BigInt(ref.size) > BigInt(nodeBytes) ||
    !hex(ref.hash) ||
    ref.mediaType !== jsonMime ||
    scope.kind !== 'execution' ||
    scope.id !== origin.publisherExecutionId
  )
    invalid();
  return ref as unknown as McpToolsContentRef;
}
function validateEntry(value: unknown, origin: McpToolsOrigin): McpToolsEntry {
  const entry = object(value);
  closed(entry, [
    'index',
    'definitionId',
    'definitionVersion',
    'label',
    'labelComplete',
    'descriptorHash',
    'descriptorBytes',
    'manifest',
  ]);
  if (
    !integer(entry.index, 0, 16383) ||
    !text(entry.definitionId) ||
    !text(entry.definitionVersion, 128) ||
    typeof entry.label !== 'string' ||
    entry.label.length > 120 ||
    !wellFormedLabel(entry.label) ||
    typeof entry.labelComplete !== 'boolean' ||
    !hex(entry.descriptorHash) ||
    !decimal(entry.descriptorBytes) ||
    BigInt(entry.descriptorBytes) < 1n ||
    BigInt(entry.descriptorBytes) > BigInt(maximumChunks * chunkBytes)
  )
    invalid();
  validateContentRef(entry.manifest, origin);
  return entry as unknown as McpToolsEntry;
}

function payload(response: QueryResponse, contentType: string): Record<string, unknown> {
  let copy: unknown;
  try {
    const encoded = JSON.stringify(response);
    if (new TextEncoder().encode(encoded).byteLength > 32 * 1024) invalid();
    copy = JSON.parse(encoded);
  } catch (error) {
    if (error instanceof ClientError) throw error;
    return invalid();
  }
  if (!Array.isArray(copy) || copy.length !== 1) invalid();
  const item = object(copy[0]);
  closed(item, [
    'extensionId',
    'contentType',
    'contentVersion',
    'summary',
    'payload',
    'actions',
    'artifactRefs',
  ]);
  if (
    item.extensionId !== 'builtin.mcp' ||
    item.contentType !== contentType ||
    item.contentVersion !== 1 ||
    !text(item.summary) ||
    !Array.isArray(item.actions) ||
    item.actions.length !== 0 ||
    !Array.isArray(item.artifactRefs) ||
    item.artifactRefs.length !== 0
  )
    invalid();
  return object(item.payload);
}

export function decodeMcpToolsSnapshots(response: QueryResponse): McpToolsSnapshots {
  const value = payload(response, 'builtin.mcp.tools.snapshots');
  closed(value, ['version', 'sessionId', 'items', 'nextAfterKey']);
  if (
    value.version !== 1 ||
    !opaque(value.sessionId) ||
    !Array.isArray(value.items) ||
    value.items.length > 32 ||
    (value.nextAfterKey !== null && !recordKey(value.nextAfterKey))
  )
    invalid();
  let previous = '';
  for (const item of value.items) {
    const snapshot = object(item);
    closed(snapshot, [
      'recordKey',
      'sourceRecordKey',
      'origin',
      'availability',
      'reason',
      'toolCount',
      'index',
    ]);
    const origin = validateOrigin(snapshot.origin);
    if (
      !recordKey(snapshot.recordKey) ||
      snapshot.recordKey <= previous ||
      !text(snapshot.sourceRecordKey, 512) ||
      origin.sessionId !== value.sessionId ||
      !integer(snapshot.toolCount, 0, 16384)
    )
      invalid();
    previous = snapshot.recordKey;
    if (snapshot.availability === 'available') {
      if (snapshot.reason !== null) invalid();
      validateContentRef(snapshot.index, origin);
    } else if (
      snapshot.availability !== 'unavailable' ||
      !reason(snapshot.reason) ||
      snapshot.index !== null
    )
      invalid();
  }
  // Filtering by Server can consume original keys without returning a matching row.
  if (value.nextAfterKey !== null && value.nextAfterKey < previous) invalid();
  return value as unknown as McpToolsSnapshots;
}

export function decodeMcpToolsPage(response: QueryResponse): McpToolsPage {
  const value = payload(response, 'builtin.mcp.tools');
  closed(value, [
    'version',
    'recordKey',
    'binding',
    'availability',
    'reason',
    'toolCount',
    'startIndex',
    'entries',
    'nextIndex',
    'complete',
    'live',
    'currentGeneration',
  ]);
  const binding = validateOrigin(value.binding, true) as McpToolsBinding;
  if (
    value.version !== 1 ||
    !recordKey(value.recordKey) ||
    !integer(value.toolCount, 0, 16384) ||
    !integer(value.startIndex, 0, value.toolCount) ||
    !Array.isArray(value.entries) ||
    value.entries.length > 32 ||
    typeof value.complete !== 'boolean' ||
    typeof value.live !== 'boolean' ||
    (value.currentGeneration !== null &&
      !integer(value.currentGeneration, 1, Number.MAX_SAFE_INTEGER)) ||
    (value.live && value.currentGeneration !== binding.generation)
  )
    invalid();
  if (value.availability === 'unavailable') {
    if (
      !reason(value.reason) ||
      value.entries.length !== 0 ||
      value.complete ||
      value.nextIndex !== null
    )
      invalid();
  } else if (value.availability === 'available') {
    if (value.reason !== null || !hex(binding.indexDigest)) invalid();
    for (const [index, item] of value.entries.entries()) {
      const entry = validateEntry(item, binding);
      if (entry.index !== value.startIndex + index || entry.index >= value.toolCount) invalid();
    }
    const end = value.startIndex + value.entries.length;
    if (
      end > value.toolCount ||
      (value.nextIndex === null
        ? !value.complete || end !== value.toolCount
        : value.complete ||
          value.entries.length === 0 ||
          value.nextIndex !== end ||
          end >= value.toolCount)
    )
      invalid();
  } else invalid();
  return value as unknown as McpToolsPage;
}

/** Reads one original descriptor. Completion never uses a preview or current live cache. */
export async function readMcpToolDescriptor(options: {
  readonly currentStoreId: string;
  readonly sessionId: string;
  readonly binding: McpToolsBinding;
  readonly entry: McpToolsEntry;
  readonly signal?: AbortSignal;
  readonly readArtifact: AgentClient['readArtifact'];
}): Promise<McpToolMetadata> {
  const { currentStoreId, sessionId, signal, readArtifact } = options;
  signal?.throwIfAborted();
  if (!opaque(currentStoreId) || !opaque(sessionId)) invalid();
  let binding: McpToolsBinding, entry: McpToolsEntry;
  try {
    binding = structuredClone(options.binding);
    entry = structuredClone(options.entry);
  } catch {
    return invalid();
  }
  validateOrigin(binding, true);
  validateEntry(entry, binding);
  if (binding.sessionId !== sessionId || !hex(binding.indexDigest)) invalid();
  const read = async (ref: McpToolsContentRef): Promise<Uint8Array> => {
    signal?.throwIfAborted();
    const result = await readArtifact(
      sessionId,
      { expectedStoreId: currentStoreId, refId: ref.id, scope: { ...ref.scope } },
      {
        signal,
        expectedReference: {
          storeId: binding.originStoreId,
          size: ref.size,
          hash: ref.hash,
          mediaType: ref.mediaType,
        },
      },
    );
    signal?.throwIfAborted();
    const r = result.reference;
    if (
      r.id !== ref.id ||
      r.storeId !== binding.originStoreId ||
      r.scope.kind !== 'execution' ||
      r.scope.id !== binding.publisherExecutionId ||
      r.size !== ref.size ||
      r.hash !== ref.hash ||
      r.mediaType !== ref.mediaType ||
      BigInt(result.content.byteLength) !== BigInt(ref.size) ||
      (await digestModelBody(result.content)) !== ref.hash
    )
      invalid();
    signal?.throwIfAborted();
    return result.content;
  };
  let manifest: Record<string, unknown>;
  try {
    manifest = object(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          await read(entry.manifest),
        ),
      ),
    );
  } catch (error) {
    if (error instanceof ClientError || signal?.aborted) throw error;
    return invalid();
  }
  closed(manifest, [
    'kind',
    'version',
    'origin',
    'toolIndex',
    'definitionId',
    'definitionVersion',
    'descriptorHash',
    'descriptorBytes',
    'chunks',
  ]);
  const origin = validateOrigin(manifest.origin);
  if (
    manifest.kind !== 'mcp_tool_descriptor' ||
    manifest.version !== 1 ||
    !sameOrigin(origin, binding) ||
    manifest.toolIndex !== entry.index ||
    manifest.definitionId !== entry.definitionId ||
    manifest.definitionVersion !== entry.definitionVersion ||
    manifest.descriptorHash !== entry.descriptorHash ||
    manifest.descriptorBytes !== entry.descriptorBytes ||
    !Array.isArray(manifest.chunks) ||
    manifest.chunks.length === 0 ||
    manifest.chunks.length > maximumChunks
  )
    invalid();
  const chunks: McpToolsContentRef[] = [],
    ids = new Set([entry.manifest.id]);
  let total = 0;
  for (const [index, item] of manifest.chunks.entries()) {
    const ref = object(item);
    closed(ref, ['id', 'size', 'hash']);
    if (
      !opaque(ref.id) ||
      ids.has(ref.id) ||
      !decimal(ref.size) ||
      !hex(ref.hash) ||
      BigInt(ref.size) < 1n ||
      BigInt(ref.size) > BigInt(chunkBytes) ||
      (index < manifest.chunks.length - 1 && ref.size !== String(chunkBytes))
    )
      invalid();
    ids.add(ref.id);
    total += Number(ref.size);
    chunks.push({
      id: ref.id,
      size: ref.size,
      hash: ref.hash,
      scope: { kind: 'execution', id: binding.publisherExecutionId },
      mediaType: bytesMime,
    });
  }
  if (BigInt(total) !== BigInt(entry.descriptorBytes)) invalid();
  let complete: Uint8Array;
  try {
    complete = new Uint8Array(total);
  } catch {
    throw new ClientError('artifact_capacity');
  }
  let offset = 0;
  for (const ref of chunks) {
    const bytes = await read(ref);
    complete.set(bytes, offset);
    offset += bytes.byteLength;
  }
  if ((await digestModelBody(complete)) !== entry.descriptorHash) invalid();
  signal?.throwIfAborted();
  let metadata: Record<string, unknown>;
  try {
    metadata = object(
      JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(complete)),
    );
  } catch {
    return invalid();
  }
  if (
    typeof metadata.name !== 'string' ||
    (metadata.description !== undefined && typeof metadata.description !== 'string') ||
    object(metadata.inputSchema).type !== 'object' ||
    (metadata.outputSchema !== undefined && object(metadata.outputSchema).type !== 'object') ||
    (entry.labelComplete ? metadata.name !== entry.label : !metadata.name.startsWith(entry.label))
  )
    invalid();
  signal?.throwIfAborted();
  return metadata as unknown as McpToolMetadata;
}
