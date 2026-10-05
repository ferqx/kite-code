import { ClientError, decodeResponse } from './decode';
import type { ModelInputPage, ModelInputSnapshot } from './generated/api';
import { parseCursorSequence } from './sse';

export function canonicalModelBody(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalModelBody).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalModelBody((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}

export async function digestModelBody(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** No success is published until the complete finite response has reached a verified EOF. */
export async function readVerifiedModelBody(
  response: Response,
  signal: AbortSignal,
  kind: 'model-input' | 'model-output',
): Promise<unknown> {
  const code = kind.replace('-', '_');
  const size = response.headers.get(`x-${kind}-size`);
  const hash = response.headers.get(`x-${kind}-hash`);
  if (
    !size ||
    !hash ||
    !/^(0|[1-9][0-9]{0,18})$/.test(size) ||
    BigInt(size) > 9223372036854775807n ||
    !/^[a-f0-9]{64}$/.test(hash) ||
    !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')
  ) {
    await response.body?.cancel();
    throw new ClientError(`${code}_metadata_invalid`);
  }
  const expected = parseCursorSequence(size);
  if (!response.body) throw new ClientError(`${code}_incomplete`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (!Number.isSafeInteger(bytes) || BigInt(bytes) > expected)
        throw new ClientError(`${code}_incomplete`);
      chunks.push(chunk.value);
    }
    if (BigInt(bytes) !== expected) throw new ClientError(`${code}_incomplete`);
    const complete = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      complete.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if ((await digestModelBody(complete)) !== hash) throw new ClientError(`${code}_hash_mismatch`);
    signal.throwIfAborted();
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(complete),
      );
    } catch {
      throw new ClientError('invalid_response');
    }
    signal.throwIfAborted();
    return value;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readModelInputResponse(
  response: Response,
  signal: AbortSignal,
): Promise<ModelInputSnapshot> {
  return verifyModelInputSnapshot(
    await readVerifiedModelBody(response, signal, 'model-input'),
    signal,
  );
}

/** Pure complete-snapshot validation, shared with the bounded trusted Native transport. */
export async function verifyModelInputSnapshot(
  value: unknown,
  signal?: AbortSignal,
): Promise<ModelInputSnapshot> {
  signal?.throwIfAborted();
  let copy: unknown;
  try {
    copy = structuredClone(value);
  } catch {
    throw new ClientError('invalid_response');
  }
  const snapshot = decodeResponse('ModelInputSnapshot', copy);
  parseCursorSequence(snapshot.rootWorkSeq);
  parseCursorSequence(snapshot.snapshotCursor);
  const original = new TextEncoder().encode(canonicalModelBody(snapshot.request));
  if (
    BigInt(original.byteLength) !== parseCursorSequence(snapshot.bodyBytes) ||
    (await digestModelBody(original)) !== snapshot.bodyHash ||
    snapshot.request.requestId !== snapshot.executionId ||
    (snapshot.confirmation === 'succeeded') !== (snapshot.status === 'succeeded')
  )
    throw new ClientError('model_input_hash_mismatch');
  signal?.throwIfAborted();
  return snapshot;
}

export function verifyModelInputPage(
  page: ModelInputPage,
  identity: { storeId: string; sessionId: string },
  query: { afterSeq?: string; upperSeq?: string },
): ModelInputPage {
  if (page.storeId !== identity.storeId || page.sessionId !== identity.sessionId)
    throw new ClientError('model_input_identity_mismatch');
  const high = parseCursorSequence(page.highWaterSeq);
  const upper = parseCursorSequence(page.upperSeq);
  let previous = parseCursorSequence(query.afterSeq ?? '0');
  if (upper > high || previous > upper || (query.upperSeq && page.upperSeq !== query.upperSeq))
    throw new ClientError('invalid_page_bounds');
  const ids = new Set<string>();
  for (const item of page.items) {
    const seq = parseCursorSequence(item.seq);
    if (
      seq <= previous ||
      seq > upper ||
      item.sessionId !== identity.sessionId ||
      ids.has(item.executionId) ||
      (item.confirmation === 'succeeded') !== (item.status === 'succeeded')
    )
      throw new ClientError('model_input_identity_mismatch');
    previous = seq;
    ids.add(item.executionId);
  }
  if (
    page.nextAfterSeq !== null &&
    (!page.items.length || parseCursorSequence(page.nextAfterSeq) !== previous || previous >= upper)
  )
    throw new ClientError('invalid_page_bounds');
  return page;
}
