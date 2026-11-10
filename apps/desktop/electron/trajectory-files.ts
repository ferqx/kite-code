import { createHash, randomUUID } from 'node:crypto';
import {
  evidenceOpenSchema,
  parseDecimal64,
  type TrajectoryEvidenceDescriptor,
  trajectoryReadRequestSchema,
} from '@kite-ai/trajectory';
import type {
  NativeTrajectoryFileRequest,
  NativeTrajectoryFileResult,
} from '../src/native-trajectory-file-bridge';
import { openNativeTrajectoryBundle, TrajectoryBundleCleanupError } from './trajectory-bundle';

type Opened = Awaited<ReturnType<typeof openNativeTrajectoryBundle>>;
type Evidence = { descriptor: TrajectoryEvidenceDescriptor; bytes: Uint8Array; offset: number };
const maximumEvidenceLeases = 16;
const maximumEvidenceBytes = 128 * 1024 * 1024;
/** A selected local package has its own viewing scope. No Client, Runtime or Service is constructed. */
export class NativeTrajectoryFiles {
  private current: { id: string; opened: Opened } | undefined;
  private epoch = 0;
  private readonly evidence = new Map<string, Evidence>();
  private readonly openingEvidence = new Set<object>();
  private evidenceBytes = 0;
  private evidenceEpoch = 0;
  private readonly pending = new Set<Promise<void>>();
  private readonly retiring = new Set<Opened>();
  private readonly closing = new Map<Opened, Promise<void>>();
  private failure: TrajectoryBundleCleanupError | undefined;
  private assert(id: string) {
    if (!this.current || id !== this.current.id) throw Error('trajectory_bundle_view_changed');
    return this.current;
  }
  async open(path: string): Promise<NativeTrajectoryFileResult> {
    if (this.failure) throw this.failure;
    const epoch = ++this.epoch;
    let settled!: () => void;
    const pending = new Promise<void>((resolve) => {
      settled = resolve;
    });
    this.pending.add(pending);
    try {
      await this.release();
      const opened = await openNativeTrajectoryBundle(path);
      this.retiring.add(opened);
      if (epoch !== this.epoch) {
        await this.releaseOwned(opened);
        throw Error('trajectory_bundle_view_changed');
      }
      const id = randomUUID();
      this.current = { id, opened };
      this.retiring.delete(opened);
      return {
        kind: 'trajectory.bundle.opened',
        bundleId: id,
        snapshot: structuredClone(opened.bundle.snapshot),
        minimumCursor: opened.bundle.minimumCursor,
      };
    } catch (error) {
      if (error instanceof TrajectoryBundleCleanupError) this.failure = error;
      throw error;
    } finally {
      this.pending.delete(pending);
      settled();
    }
  }
  async invoke(
    input: Exclude<NativeTrajectoryFileRequest, { method: 'pick' | 'export' }>,
  ): Promise<NativeTrajectoryFileResult> {
    const current = this.assert(input.bundleId),
      bundle = current.opened.bundle;
    switch (input.method) {
      case 'events': {
        const page = await bundle.readEvents(trajectoryReadRequestSchema.parse(input.request));
        this.assert(input.bundleId);
        if (Buffer.byteLength(JSON.stringify(page)) > 512 * 1024)
          throw Error('trajectory_page_too_large');
        return { kind: 'trajectory.page', trajectory: page };
      }
      case 'evidence.open': {
        const epoch = this.evidenceEpoch;
        if (this.evidence.size + this.openingEvidence.size >= maximumEvidenceLeases)
          throw Error('trajectory_evidence_lease_limit');
        const pending = {};
        this.openingEvidence.add(pending);
        let reserved = 0,
          retained = false;
        try {
          const query = evidenceOpenSchema.parse(input.request),
            snapshot = bundle.snapshot;
          if (
            query.storeId !== snapshot.storeId ||
            query.sessionId !== snapshot.sessionId ||
            query.upperCursor !== snapshot.upperCursor ||
            parseDecimal64(query.atCursor) > parseDecimal64(snapshot.upperCursor)
          )
            throw Error('trajectory_bundle_scope_denied');
          let after = bundle.minimumCursor,
            found = false;
          for (;;) {
            const page = await bundle.readEvents({
              storeId: snapshot.storeId,
              sessionId: snapshot.sessionId,
              ...(snapshot.runId ? { runId: snapshot.runId } : {}),
              ...(snapshot.executionId ? { executionId: snapshot.executionId } : {}),
              ...(snapshot.eventKinds ? { eventKinds: snapshot.eventKinds } : {}),
              afterCursor: after,
              upperCursor: snapshot.upperCursor,
            });
            this.assert(input.bundleId);
            if (epoch !== this.evidenceEpoch) throw Error('trajectory_bundle_view_changed');
            found = page.events.some(
              (event) =>
                parseDecimal64(event.sequence) <= parseDecimal64(query.atCursor) &&
                event.eventId === query.eventId &&
                event.evidenceRefs.some(
                  (ref) =>
                    ref.evidenceId === query.evidenceId &&
                    ref.contentVersion === query.contentVersion,
                ),
            );
            if (
              found ||
              page.exhausted ||
              parseDecimal64(page.scannedThrough) >= parseDecimal64(query.atCursor)
            )
              break;
            after = page.scannedThrough;
          }
          if (!found) throw Error('trajectory_evidence_unavailable');
          const section = bundle.manifest.sections.find(
            (section) =>
              section.kind === 'evidence' &&
              section.eventId === query.eventId &&
              section.evidenceId === query.evidenceId &&
              section.contentVersion === query.contentVersion,
          );
          if (section?.kind !== 'evidence') throw Error('trajectory_evidence_missing');
          const length = parseDecimal64(section.bytes);
          // Reserve the validated section size before reading so concurrent opens share a budget.
          if (length > BigInt(maximumEvidenceBytes - this.evidenceBytes))
            throw Error('trajectory_evidence_lease_budget');
          reserved = Number(length);
          this.evidenceBytes += reserved;
          const bytes = await bundle.readEvidence(
            query.eventId,
            query.evidenceId,
            query.contentVersion,
          );
          this.assert(input.bundleId);
          if (epoch !== this.evidenceEpoch) throw Error('trajectory_bundle_view_changed');
          if (!bytes) throw Error('trajectory_evidence_missing');
          const descriptor: TrajectoryEvidenceDescriptor = {
            readId: randomUUID(),
            eventId: query.eventId,
            evidenceId: query.evidenceId,
            contentVersion: query.contentVersion,
            availability: section.availability,
            mediaType: section.mediaType,
            viewBytes: String(bytes.byteLength),
            viewSha256: createHash('sha256').update(bytes).digest('hex'),
            transformation: 'kite.offline-package-bytes@1',
            policyRevision: '1',
            authorizationEpoch: '1',
          };
          this.evidence.set(descriptor.readId, { descriptor, bytes, offset: 0 });
          retained = true;
          return { kind: 'trajectory.evidence.opened', trajectory: descriptor };
        } finally {
          if (this.openingEvidence.delete(pending) && !retained) this.evidenceBytes -= reserved;
        }
      }
      case 'evidence.read': {
        const lease = this.evidence.get(input.readId),
          limit = input.limit ?? 65536;
        if (
          !lease ||
          lease.descriptor.readId !== input.readId ||
          parseDecimal64(input.offset) !== BigInt(lease.offset) ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 65536
        )
          throw Error('trajectory_evidence_offset_invalid');
        const offset = lease.offset,
          end = Math.min(lease.bytes.byteLength, offset + limit);
        const data = Buffer.from(lease.bytes.subarray(offset, end)).toString('base64');
        lease.offset = end;
        return {
          kind: 'trajectory.evidence.chunk',
          trajectory: {
            readId: input.readId,
            offset: String(offset),
            nextOffset: String(end),
            data,
            eof: end === lease.bytes.byteLength,
            viewSha256: lease.descriptor.viewSha256,
            policyRevision: lease.descriptor.policyRevision,
            authorizationEpoch: lease.descriptor.authorizationEpoch,
          },
        };
      }
      case 'evidence.close': {
        const lease = this.evidence.get(input.readId);
        if (lease) {
          this.evidenceBytes -= lease.bytes.byteLength;
          this.evidence.delete(input.readId);
        }
        return null;
      }
      case 'close':
        await this.close();
        return null;
    }
  }
  async close(): Promise<void> {
    ++this.epoch;
    await Promise.all(this.pending);
    await this.release();
    if (this.failure) throw this.failure;
  }
  private async releaseOwned(opened: Opened): Promise<void> {
    this.retiring.add(opened);
    let closing = this.closing.get(opened);
    if (!closing) {
      closing = opened.close();
      this.closing.set(opened, closing);
    }
    await closing;
    this.closing.delete(opened);
    this.retiring.delete(opened);
    if (this.current?.opened === opened) this.current = undefined;
  }
  private async release(): Promise<void> {
    ++this.evidenceEpoch;
    this.evidence.clear();
    this.openingEvidence.clear();
    this.evidenceBytes = 0;
    if (this.current) this.retiring.add(this.current.opened);
    await Promise.all([...this.retiring].map((opened) => this.releaseOwned(opened)));
  }
}
