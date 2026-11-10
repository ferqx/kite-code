import { createHash, randomUUID } from 'node:crypto';
import { AgentError } from '@kite-ai/agent';
import type { Store } from '@kite-ai/agent/storage';
import {
  evidenceOpenSchema,
  parseDecimal64,
  type TrajectoryEvidenceChunk,
  type TrajectoryEvidenceDescriptor,
  type TrajectoryEvidenceOpen,
  type TrajectoryEvidenceRef,
} from '@kite-ai/trajectory';

export interface TrajectoryMaterial {
  content: Uint8Array;
  mediaType: string;
  availability: TrajectoryEvidenceRef['availability'];
  transformation: string;
}
export type TrajectoryMaterialReader = (
  input: TrajectoryEvidenceOpen & { subjectId: string; signal?: AbortSignal },
) => Promise<TrajectoryMaterial>;
export interface TrajectoryEvidenceRead {
  storeId: string;
  sessionId: string;
  readId: string;
  offset: string;
  limit?: number;
}
type Lease = {
  scope: TrajectoryEvidenceOpen;
  subjectId: string;
  abort: AbortController;
  descriptor?: TrajectoryEvidenceDescriptor;
  bytes?: Uint8Array;
  offset: number;
  reading: boolean;
  expiry?: ReturnType<typeof setTimeout>;
};
/** Material resources alone have leases; event pagination remains stateless. */
export class TrajectoryEvidenceReads {
  private leases = new Map<string, Lease>();
  private closed = false;
  private readonly store: Pick<Store, 'readTrajectoryBinding'>;
  private readonly material: TrajectoryMaterialReader;
  constructor(store: Pick<Store, 'readTrajectoryBinding'>, material: TrajectoryMaterialReader) {
    this.store = store;
    this.material = material;
  }
  private check(readId: string, lease: Lease, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.closed || this.leases.get(readId) !== lease || lease.abort.signal.aborted)
      throw new AgentError('trajectory_evidence_read_closed');
  }
  private touch(readId: string, lease: Lease): void {
    if (lease.expiry) clearTimeout(lease.expiry);
    lease.expiry = setTimeout(() => {
      if (this.leases.get(readId) === lease)
        this.close(readId, lease.subjectId, lease.scope.storeId, lease.scope.sessionId);
    }, 300_000);
    lease.expiry.unref();
  }
  async open(
    input: TrajectoryEvidenceOpen & { subjectId: string },
    signal?: AbortSignal,
  ): Promise<TrajectoryEvidenceDescriptor> {
    if (this.closed) throw new AgentError('service_draining');
    if (this.leases.size >= 4) throw new AgentError('trajectory_evidence_busy');
    const { subjectId, ...value } = input;
    const scope = evidenceOpenSchema.parse(value);
    signal?.throwIfAborted();
    const readId = randomUUID(),
      lease: Lease = { scope, subjectId, abort: new AbortController(), offset: 0, reading: false };
    this.leases.set(readId, lease);
    this.touch(readId, lease);
    const abort = () => lease.abort.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await this.store.readTrajectoryBinding({ ...scope, subjectId });
      this.check(readId, lease, signal);
      const view = await this.material({ ...scope, subjectId, signal: lease.abort.signal });
      this.check(readId, lease, signal);
      await this.store.readTrajectoryBinding({ ...scope, subjectId });
      this.check(readId, lease, signal);
      lease.bytes = Uint8Array.from(view.content);
      lease.descriptor = {
        readId,
        eventId: scope.eventId,
        evidenceId: scope.evidenceId,
        contentVersion: scope.contentVersion,
        availability: view.availability,
        mediaType: view.mediaType,
        viewBytes: String(lease.bytes.byteLength),
        viewSha256: createHash('sha256').update(lease.bytes).digest('hex'),
        transformation: view.transformation,
        policyRevision: '1',
        authorizationEpoch: '1',
      };
      return { ...lease.descriptor };
    } catch (error) {
      this.close(readId, input.subjectId, scope.storeId, scope.sessionId);
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  async read(
    input: TrajectoryEvidenceRead,
    subjectId: string,
    signal?: AbortSignal,
  ): Promise<TrajectoryEvidenceChunk> {
    const lease = this.leases.get(input.readId);
    if (
      !lease?.bytes ||
      !lease.descriptor ||
      lease.subjectId !== subjectId ||
      lease.scope.storeId !== input.storeId ||
      lease.scope.sessionId !== input.sessionId
    )
      throw new AgentError('trajectory_evidence_read_missing');
    this.check(input.readId, lease, signal);
    const offset = parseDecimal64(input.offset),
      limit = input.limit ?? 65536;
    if (
      offset !== BigInt(lease.offset) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 65536 ||
      lease.reading
    )
      throw new AgentError('trajectory_evidence_offset_invalid');
    lease.reading = true;
    try {
      await this.store.readTrajectoryBinding({ ...lease.scope, subjectId });
      this.check(input.readId, lease, signal);
      const end = Math.min(lease.bytes.byteLength, lease.offset + limit);
      const data = Buffer.from(lease.bytes.subarray(lease.offset, end)).toString('base64');
      // Do not advance or deliver a block after a revocation/deletion committed during the read.
      await this.store.readTrajectoryBinding({ ...lease.scope, subjectId });
      this.check(input.readId, lease, signal);
      const result: TrajectoryEvidenceChunk = {
        readId: input.readId,
        offset: String(lease.offset),
        nextOffset: String(end),
        data,
        eof: end === lease.bytes.byteLength,
        viewSha256: lease.descriptor.viewSha256,
        policyRevision: lease.descriptor.policyRevision,
        authorizationEpoch: lease.descriptor.authorizationEpoch,
      };
      lease.offset = end;
      this.touch(input.readId, lease);
      return result;
    } catch (error) {
      this.close(input.readId, subjectId, input.storeId, input.sessionId);
      throw error;
    } finally {
      lease.reading = false;
    }
  }
  close(readId: string, subjectId: string, storeId: string, sessionId: string): void {
    const lease = this.leases.get(readId);
    if (!lease) return;
    if (
      lease.subjectId !== subjectId ||
      lease.scope.storeId !== storeId ||
      lease.scope.sessionId !== sessionId
    )
      throw new AgentError('trajectory_scope_denied');
    this.leases.delete(readId);
    if (lease.expiry) clearTimeout(lease.expiry);
    lease.abort.abort();
    lease.bytes = undefined;
  }
  dispose(): void {
    this.closed = true;
    for (const [id, lease] of this.leases)
      this.close(id, lease.subjectId, lease.scope.storeId, lease.scope.sessionId);
  }
}
