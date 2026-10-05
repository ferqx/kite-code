import { ClientError } from './decode';
import type {
  SessionExportCompletion,
  SessionExportManifest,
  SessionExportPage,
  SessionExportPageQuery,
  SessionExportTextPage,
  SessionExportTextQuery,
} from './generated/api';
import { canonicalModelBody, digestModelBody } from './model-input';
import { parseCursorSequence } from './sse';

export type SessionExportSection = SessionExportPage['section'];
const sections: readonly SessionExportSection[] = [
  'sessions',
  'commands',
  'runs',
  'messages',
  'message_parts',
  'executions',
  'execution_output',
  'interactions',
  'context_snapshots',
  'extension_records',
  'artifact_refs',
];
const invalid = () => new ClientError('invalid_export_response');
const decimal = (value: string) => {
  try {
    return parseCursorSequence(value);
  } catch {
    throw invalid();
  }
};

export function sessionExportParameters(input: object): URLSearchParams {
  return new URLSearchParams(
    Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, key === 'manifest' ? JSON.stringify(value) : String(value)]),
  );
}

export function verifySessionExportManifest(
  manifest: SessionExportManifest,
  storeId: string,
  sessionId: string,
): SessionExportManifest {
  if (
    manifest.storeId !== storeId ||
    manifest.rootSessionId !== sessionId ||
    manifest.sections.length !== sections.length ||
    new Set(manifest.sections.map((section) => section.section)).size !== sections.length
  )
    throw invalid();
  decimal(manifest.snapshotCursor);
  decimal(manifest.dataVersion);
  for (const item of manifest.sections) {
    const upper = decimal(item.highWaterSeq),
      count = decimal(item.count);
    if (!sections.includes(item.section) || count > upper || (count === 0n) !== (upper === 0n))
      throw invalid();
  }
  if (decimal(manifest.sections.find((item) => item.section === 'sessions')!.count) < 1n)
    throw invalid();
  return manifest;
}

export function verifySessionExportPage(
  page: SessionExportPage,
  input: SessionExportPageQuery,
): SessionExportPage {
  const manifest = input.manifest,
    section = manifest.sections.find((item) => item.section === input.section);
  if (
    !section ||
    page.storeId !== input.storeId ||
    page.rootSessionId !== manifest.rootSessionId ||
    page.snapshotCursor !== manifest.snapshotCursor ||
    page.section !== input.section ||
    page.upperSeq !== section.highWaterSeq ||
    page.records.length > (input.limit ?? 200)
  )
    throw invalid();
  const upper = decimal(page.upperSeq);
  let previous = decimal(input.afterSeq ?? '0');
  if (previous > upper) throw invalid();
  for (const record of page.records) {
    const seq = decimal(record.seq);
    if (record.section !== input.section || seq <= previous || seq > upper) throw invalid();
    previous = seq;
  }
  if (
    (page.nextAfterSeq !== null &&
      (!page.records.length || page.nextAfterSeq !== String(previous) || previous >= upper)) ||
    (page.nextAfterSeq === null && previous !== upper)
  )
    throw invalid();
  return page;
}

export function sessionExportTextBytes(page: SessionExportTextPage): Uint8Array {
  try {
    const raw = atob(page.contentBase64);
    if (btoa(raw) !== page.contentBase64 || raw.length > 65536) throw invalid();
    return Uint8Array.from(raw, (value) => value.charCodeAt(0));
  } catch {
    throw invalid();
  }
}

export function verifySessionExportTextPage(
  page: SessionExportTextPage,
  input: SessionExportTextQuery,
): SessionExportTextPage {
  const bytes = sessionExportTextBytes(page),
    after = decimal(input.afterByte ?? '0'),
    length = decimal(page.byteLength),
    next = after + BigInt(bytes.byteLength);
  if (
    page.storeId !== input.storeId ||
    page.rootSessionId !== input.manifest.rootSessionId ||
    page.section !== input.section ||
    page.seq !== input.seq ||
    page.field !== input.field ||
    page.afterByte !== String(after) ||
    bytes.byteLength > (input.limitBytes ?? 65536) ||
    next > length ||
    (page.nextAfterByte === null ? next !== length : page.nextAfterByte !== String(next)) ||
    (page.nextAfterByte !== null && (!bytes.byteLength || next >= length))
  )
    throw invalid();
  return page;
}

export function verifySessionExportCompletion(
  completion: SessionExportCompletion,
  manifest: SessionExportManifest,
): SessionExportCompletion {
  if (canonicalModelBody(completion.manifest) !== canonicalModelBody(manifest)) throw invalid();
  return completion;
}

export type SessionExportFrame =
  | { kind: 'manifest'; manifest: SessionExportManifest }
  | { kind: 'record'; record: SessionExportPage['records'][number] }
  | { kind: 'text'; page: SessionExportTextPage }
  | {
      kind: 'text_complete';
      section: SessionExportSection;
      seq: string;
      field: string;
      byteLength: string;
      sha256: string;
    }
  | {
      kind: 'complete';
      completion: SessionExportCompletion;
      rawTextVerified: true;
      media: 'original-scope-references';
    };

export interface SessionExportReader {
  check(): void;
  begin(): Promise<SessionExportManifest>;
  page(input: Omit<SessionExportPageQuery, 'storeId'>): Promise<SessionExportPage>;
  text(input: Omit<SessionExportTextQuery, 'storeId'>): Promise<SessionExportTextPage>;
  verify(manifest: SessionExportManifest): Promise<SessionExportCompletion>;
}

/** Pull-driven records export. Partial consumers never receive a valid completion footer. */
export async function* streamSessionExport(
  reader: SessionExportReader,
  options: { signal?: AbortSignal } = {},
): AsyncGenerator<SessionExportFrame> {
  const check = () => {
    options.signal?.throwIfAborted();
    reader.check();
  };
  check();
  const manifest = structuredClone(await reader.begin()),
    sessions = new Set<string>();
  check();
  yield { kind: 'manifest', manifest: structuredClone(manifest) };
  for (const name of sections) {
    const section = manifest.sections.find((item) => item.section === name)!;
    let afterSeq: string | null = '0',
      count = 0n;
    while (afterSeq !== null) {
      check();
      const page = await reader.page({ manifest, section: name, afterSeq });
      check();
      for (const record of page.records) {
        if (
          record.record === null ||
          Array.isArray(record.record) ||
          typeof record.record !== 'object'
        )
          throw invalid();
        const fields = record.record as Record<string, unknown>;
        if (name === 'sessions') {
          if (
            fields.id !== record.id ||
            record.sessionId !== record.id ||
            fields.root_id !== manifest.rootSessionId ||
            sessions.has(record.id)
          )
            throw invalid();
          sessions.add(record.id);
        } else if (!sessions.has(record.sessionId)) throw invalid();
        if (++count > decimal(section.count)) throw invalid();
        yield { kind: 'record', record: structuredClone(record) };
        for (const [field, value] of Object.entries(fields)) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          const descriptor = value as Record<string, unknown>;
          if (descriptor.kind !== 'export_text') throw invalid();
          if (
            descriptor.field !== field ||
            typeof descriptor.byteLength !== 'string' ||
            typeof descriptor.sha256 !== 'string' ||
            !/^[a-f0-9]{64}$/.test(descriptor.sha256) ||
            decimal(descriptor.byteLength) <= 65536n
          )
            throw invalid();
          let afterByte: string | null = '0',
            bytes = 0;
          const chunks: Uint8Array[] = [];
          while (afterByte !== null) {
            check();
            const text = await reader.text({
              manifest,
              section: name,
              seq: record.seq,
              field,
              afterByte,
            });
            check();
            if (text.byteLength !== descriptor.byteLength) throw invalid();
            const chunk = sessionExportTextBytes(text);
            bytes += chunk.byteLength;
            if (!Number.isSafeInteger(bytes) || BigInt(bytes) > decimal(descriptor.byteLength))
              throw invalid();
            chunks.push(chunk);
            yield { kind: 'text', page: structuredClone(text) };
            afterByte = text.nextAfterByte;
          }
          if (BigInt(bytes) !== decimal(descriptor.byteLength)) throw invalid();
          const complete = new Uint8Array(bytes);
          let offset = 0;
          for (const chunk of chunks) {
            complete.set(chunk, offset);
            offset += chunk.byteLength;
          }
          if ((await digestModelBody(complete)) !== descriptor.sha256)
            throw new ClientError('export_text_hash_mismatch');
          check();
          yield {
            kind: 'text_complete',
            section: name,
            seq: record.seq,
            field,
            byteLength: descriptor.byteLength,
            sha256: descriptor.sha256,
          };
        }
      }
      afterSeq = page.nextAfterSeq;
    }
    if (count !== decimal(section.count)) throw new ClientError('export_records_incomplete');
    if (name === 'sessions' && !sessions.has(manifest.rootSessionId)) throw invalid();
  }
  check();
  const completion = await reader.verify(manifest);
  check();
  yield {
    kind: 'complete',
    completion,
    rawTextVerified: true,
    media: 'original-scope-references',
  };
}
