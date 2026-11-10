import {
  canonicalSerialize,
  parseDecimal64,
  type TrajectoryBundleManifest,
  type TrajectoryBundleSection,
  type TrajectoryEvidenceRef,
  type TrajectoryIntegrity,
  type TrajectoryPage,
  type TrajectoryReadRequest,
  type TrajectorySnapshot,
  trajectoryBundleManifestSchema,
  trajectoryEventSchema,
  trajectorySnapshotSchema,
  verifyTrajectoryPage,
} from '@kite-ai/trajectory';
import type { TrajectoryReplaySource } from './trajectory-replay';

export interface TrajectoryBundleDirectory {
  list(signal?: AbortSignal): Promise<string[]>;
  read(path: string, signal?: AbortSignal, maximumBytes?: number): Promise<Uint8Array>;
}
export interface TrajectoryBundleFrame {
  path: string;
  bytes: Uint8Array;
}
export interface TrajectoryBundleBudgets {
  maxManifestBytes?: number;
  maxEntries?: number;
  maxSectionBytes?: number;
  maxTotalBytes?: number;
  maxCacheBytes?: number;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const sectionPath = /^(?:events\/[0-9]{8}\.jsonl|evidence\/[a-f0-9]{64}\.bin)$/;
function fail(code: string): never {
  throw new Error(`trajectory_bundle_${code}`);
}
async function digest(bytes: Uint8Array): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function pageBase(snapshot: TrajectorySnapshot, afterCursor: string) {
  return {
    storeId: snapshot.storeId,
    sessionId: snapshot.sessionId,
    ...(snapshot.runId === undefined ? {} : { runId: snapshot.runId }),
    ...(snapshot.executionId === undefined ? {} : { executionId: snapshot.executionId }),
    ...(snapshot.eventKinds === undefined ? {} : { eventKinds: [...snapshot.eventKinds] }),
    afterCursor,
    upperCursor: snapshot.upperCursor,
  };
}
function query(
  snapshot: TrajectorySnapshot,
  afterCursor: string,
  limit = 200,
): TrajectoryReadRequest {
  return { ...pageBase(snapshot, afterCursor), limit };
}
function withIncompletePrefix(integrity: TrajectoryIntegrity): TrajectoryIntegrity {
  return {
    ...integrity,
    facts: integrity.facts === 'complete' ? 'partial' : integrity.facts,
    reasons: [...new Set([...integrity.reasons, 'incomplete_prefix' as const])],
  };
}
/** Frames are written to a caller-owned destination; manifest is emitted only after verified exhaustion. */
export async function* createTrajectoryBundle(input: {
  snapshot: TrajectorySnapshot;
  fromCursor?: string;
  readEvents(request: TrajectoryReadRequest, signal?: AbortSignal): Promise<TrajectoryPage>;
  readEvidence?: (
    eventId: string,
    reference: TrajectoryEvidenceRef,
    signal?: AbortSignal,
  ) => Promise<Uint8Array | null>;
  signal?: AbortSignal;
}): AsyncGenerator<TrajectoryBundleFrame> {
  const snapshot = trajectorySnapshotSchema.parse(structuredClone(input.snapshot));
  let after = input.fromCursor ?? '0';
  if (parseDecimal64(after) > parseDecimal64(snapshot.upperCursor)) fail('range_invalid');
  const fromCursor = after;
  const sections: TrajectoryBundleSection[] = [];
  const evidenceKeys = new Set<string>();
  let index = 0;
  let integrity = snapshot.historyCoverage.integrity;
  while (true) {
    input.signal?.throwIfAborted();
    const request = query(snapshot, after);
    const page = verifyTrajectoryPage(await input.readEvents(request, input.signal), request);
    input.signal?.throwIfAborted();
    const path = `events/${String(index++).padStart(8, '0')}.jsonl`;
    if (!sectionPath.test(path)) fail('entry_limit');
    const bytes = encoder.encode(
      page.events.map((event) => canonicalSerialize(event)).join('\n') +
        (page.events.length ? '\n' : ''),
    );
    sections.push({
      path,
      kind: 'events',
      bytes: String(bytes.byteLength),
      sha256: await digest(bytes),
      afterCursor: after,
      scannedThrough: page.scannedThrough,
      eventCount: page.events.length,
    });
    yield { path, bytes };
    if (input.readEvidence)
      for (const event of page.events)
        for (const ref of event.evidenceRefs) {
          if (!['available', 'partial', 'truncated', 'empty'].includes(ref.availability)) continue;
          const key = canonicalSerialize([event.eventId, ref.evidenceId, ref.contentVersion]);
          if (evidenceKeys.has(key)) continue;
          evidenceKeys.add(key);
          const value = await input.readEvidence(event.eventId, ref, input.signal);
          input.signal?.throwIfAborted();
          if (value === null) continue;
          const material = Uint8Array.from(value);
          const evidencePath = `evidence/${await digest(encoder.encode(key))}.bin`;
          sections.push({
            path: evidencePath,
            kind: 'evidence',
            bytes: String(material.byteLength),
            sha256: await digest(material),
            eventId: event.eventId,
            evidenceId: ref.evidenceId,
            contentVersion: ref.contentVersion,
            mediaType: ref.mediaType,
            availability: ref.availability,
          });
          yield { path: evidencePath, bytes: material };
        }
    if (page.integrity.facts !== 'complete')
      integrity = {
        ...page.integrity,
        reasons: [...new Set([...integrity.reasons, ...page.integrity.reasons])],
      };
    if (page.exhausted) break;
    after = page.scannedThrough;
  }
  if (fromCursor !== '0') integrity = withIncompletePrefix(integrity);
  const manifest: TrajectoryBundleManifest = {
    format: 'kite.trajectory-bundle',
    version: 1,
    snapshot,
    fromCursor,
    toCursor: snapshot.upperCursor,
    completePrefix: fromCursor === '0',
    integrity,
    sections,
  };
  input.signal?.throwIfAborted();
  yield {
    path: 'manifest.json',
    bytes: encoder.encode(canonicalSerialize(trajectoryBundleManifestSchema.parse(manifest))),
  };
}

export interface LocalTrajectoryBundle extends TrajectoryReplaySource {
  readonly manifest: TrajectoryBundleManifest;
  readonly minimumCursor: string;
  readonly cacheBytes: number;
  readEvidence(
    eventId: string,
    evidenceId: string,
    contentVersion: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array | null>;
  clearCache(): void;
}
/** The injected port is a local package reader. No URLs or external paths in a package are opened. */
export async function openTrajectoryBundle(
  directory: TrajectoryBundleDirectory,
  budgets: TrajectoryBundleBudgets = {},
  signal?: AbortSignal,
): Promise<LocalTrajectoryBundle> {
  const limits = {
    maxManifestBytes: budgets.maxManifestBytes ?? 4 * 1024 * 1024,
    maxEntries: budgets.maxEntries ?? 100_000,
    maxSectionBytes: budgets.maxSectionBytes ?? 64 * 1024 * 1024,
    maxTotalBytes: budgets.maxTotalBytes ?? 1024 * 1024 * 1024,
    maxCacheBytes: budgets.maxCacheBytes ?? 2 * 1024 * 1024,
  };
  for (const [name, limit] of Object.entries(limits))
    if (!Number.isSafeInteger(limit) || limit < (name === 'maxCacheBytes' ? 0 : 1))
      fail('budget_invalid');
  signal?.throwIfAborted();
  const names = await directory.list(signal);
  signal?.throwIfAborted();
  if (
    names.length > limits.maxEntries ||
    new Set(names).size !== names.length ||
    names.some((path) => path !== 'manifest.json' && !sectionPath.test(path)) ||
    !names.includes('manifest.json')
  )
    fail('directory_invalid');
  const manifestBytes = await directory.read('manifest.json', signal, limits.maxManifestBytes);
  signal?.throwIfAborted();
  if (manifestBytes.byteLength > limits.maxManifestBytes) fail('manifest_budget');
  let manifest: TrajectoryBundleManifest;
  try {
    manifest = trajectoryBundleManifestSchema.parse(JSON.parse(decoder.decode(manifestBytes)));
  } catch {
    return fail('manifest_invalid');
  }
  const expected = new Set(['manifest.json']);
  const evidenceKeys = new Set<string>();
  let total = BigInt(manifestBytes.byteLength);
  let after = manifest.fromCursor;
  const eventSections: Extract<TrajectoryBundleSection, { kind: 'events' }>[] = [];
  const evidenceSections = new Map<
    string,
    Extract<TrajectoryBundleSection, { kind: 'evidence' }>
  >();
  if (
    parseDecimal64(manifest.fromCursor) > parseDecimal64(manifest.toCursor) ||
    manifest.toCursor !== manifest.snapshot.upperCursor ||
    manifest.snapshot.historyCoverage.upperCursor !== manifest.toCursor ||
    manifest.completePrefix !== (manifest.fromCursor === '0')
  )
    fail('range_invalid');
  for (const section of manifest.sections) {
    if (
      !sectionPath.test(section.path) ||
      expected.has(section.path) ||
      !names.includes(section.path) ||
      parseDecimal64(section.bytes) > BigInt(limits.maxSectionBytes)
    )
      fail('section_invalid');
    expected.add(section.path);
    total += parseDecimal64(section.bytes);
    if (section.kind === 'events') {
      if (
        !section.path.startsWith('events/') ||
        section.afterCursor !== after ||
        parseDecimal64(section.scannedThrough) < parseDecimal64(after) ||
        parseDecimal64(section.scannedThrough) > parseDecimal64(manifest.toCursor) ||
        (section.scannedThrough === after && after !== manifest.toCursor)
      )
        fail('range_invalid');
      eventSections.push(section);
      after = section.scannedThrough;
    } else {
      if (!section.path.startsWith('evidence/')) fail('section_invalid');
      const key = canonicalSerialize([section.eventId, section.evidenceId, section.contentVersion]);
      if (evidenceKeys.has(key)) fail('evidence_duplicate');
      evidenceKeys.add(key);
      evidenceSections.set(key, section);
    }
  }
  if (total > BigInt(limits.maxTotalBytes)) fail('total_budget');
  if (expected.size !== names.length || after !== manifest.toCursor || eventSections.length === 0)
    fail('directory_invalid');
  const snapshot = structuredClone(manifest.snapshot);
  snapshot.historyCoverage.integrity = manifest.completePrefix
    ? structuredClone(manifest.integrity)
    : withIncompletePrefix(manifest.integrity);
  let cachedBytes = 0;
  const cache = new Map<string, Uint8Array>();
  const sectionBytes = async (
    section: TrajectoryBundleSection,
    readSignal?: AbortSignal,
  ): Promise<Uint8Array> => {
    readSignal?.throwIfAborted();
    const hit = cache.get(section.path);
    if (hit) {
      cache.delete(section.path);
      cache.set(section.path, hit);
      return Uint8Array.from(hit);
    }
    const value = Uint8Array.from(
      await directory.read(section.path, readSignal, limits.maxSectionBytes),
    );
    readSignal?.throwIfAborted();
    if (
      value.byteLength > limits.maxSectionBytes ||
      BigInt(value.byteLength) !== parseDecimal64(section.bytes) ||
      (await digest(value)) !== section.sha256
    )
      fail('section_integrity');
    readSignal?.throwIfAborted();
    if (value.byteLength <= limits.maxCacheBytes) {
      while (cachedBytes + value.byteLength > limits.maxCacheBytes) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cachedBytes -= cache.get(oldest)!.byteLength;
        cache.delete(oldest);
      }
      cache.set(section.path, value);
      cachedBytes += value.byteLength;
    }
    return Uint8Array.from(value);
  };
  const result: LocalTrajectoryBundle = {
    get snapshot() {
      return structuredClone(snapshot);
    },
    offline: true,
    get manifest() {
      return structuredClone(manifest);
    },
    minimumCursor: manifest.fromCursor,
    get cacheBytes() {
      return cachedBytes;
    },
    clearCache() {
      cache.clear();
      cachedBytes = 0;
    },
    async readEvents(request, readSignal) {
      const template = query(snapshot, request.afterCursor, request.limit);
      if (
        canonicalSerialize(template) !==
          canonicalSerialize({ ...request, limit: request.limit ?? 200 }) ||
        parseDecimal64(request.afterCursor) < parseDecimal64(manifest.fromCursor)
      )
        fail('request_invalid');
      const events: TrajectoryPage['events'] = [];
      let scannedThrough = request.afterCursor;
      const limit = request.limit ?? 200;
      for (const section of eventSections) {
        if (parseDecimal64(section.scannedThrough) <= parseDecimal64(request.afterCursor)) continue;
        let values: unknown[];
        try {
          const text = decoder.decode(await sectionBytes(section, readSignal));
          values =
            text === ''
              ? []
              : text.endsWith('\n')
                ? text
                    .slice(0, -1)
                    .split('\n')
                    .map((line) => JSON.parse(line))
                : fail('events_invalid');
        } catch (error) {
          if (readSignal?.aborted) throw error;
          return fail('events_invalid');
        }
        const sectionEvents = values.map((value) => trajectoryEventSchema.parse(value));
        if (sectionEvents.length !== section.eventCount) fail('events_invalid');
        verifyTrajectoryPage(
          {
            ...pageBase(snapshot, section.afterCursor),
            scannedThrough: section.scannedThrough,
            exhausted: section.scannedThrough === snapshot.upperCursor,
            events: sectionEvents,
            integrity: snapshot.historyCoverage.integrity,
          },
          query(snapshot, section.afterCursor),
        );
        for (const event of sectionEvents) {
          if (parseDecimal64(event.sequence) <= parseDecimal64(request.afterCursor)) continue;
          events.push(event);
          if (events.length === limit) {
            scannedThrough = event.sequence;
            break;
          }
        }
        if (events.length === limit) break;
        scannedThrough = section.scannedThrough;
      }
      if (request.afterCursor === snapshot.upperCursor) scannedThrough = snapshot.upperCursor;
      return verifyTrajectoryPage(
        {
          ...pageBase(snapshot, request.afterCursor),
          scannedThrough,
          exhausted: scannedThrough === snapshot.upperCursor,
          events,
          integrity: snapshot.historyCoverage.integrity,
        },
        request,
      );
    },
    async readEvidence(eventId, evidenceId, contentVersion, readSignal) {
      const section = evidenceSections.get(
        canonicalSerialize([eventId, evidenceId, contentVersion]),
      );
      if (!section) return null;
      // Verify that the packaged event actually binds this version; a manifest entry grants no new scope.
      let afterCursor = manifest.fromCursor;
      let found = false;
      while (true) {
        const page = await result.readEvents(query(snapshot, afterCursor), readSignal);
        for (const event of page.events)
          if (event.eventId === eventId)
            found = event.evidenceRefs.some(
              (ref) =>
                ref.evidenceId === evidenceId &&
                ref.contentVersion === contentVersion &&
                ref.mediaType === section.mediaType &&
                ref.availability === section.availability,
            );
        if (found || page.exhausted) break;
        afterCursor = page.scannedThrough;
      }
      if (!found) fail('evidence_binding_invalid');
      return sectionBytes(section, readSignal);
    },
  };
  return result;
}
