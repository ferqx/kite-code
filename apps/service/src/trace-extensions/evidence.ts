import { createHash, randomUUID } from 'node:crypto';
import {
  decimal64Schema,
  type TrajectoryEvidenceChunk,
  type TrajectoryEvidenceDescriptor,
} from '@kite-ai/trajectory';
import { z } from 'zod';
import type { TrajectoryEvidenceReads } from '../trajectory/evidence';
import type { TraceConsumerStore } from './consumer-store';
import { TraceHostError } from './types';

const openSchema = z.strictObject({
  batchId: z.string().max(512),
  eventId: z.string().max(512),
  evidenceId: z.string().max(512),
  contentVersion: z.string().max(512),
});
const readSchema = z.strictObject({
  readId: z.string().uuid(),
  offset: decimal64Schema,
  limit: z.number().int().min(1).max(65536).optional(),
});
const closeSchema = z.strictObject({ readId: z.string().uuid() });
export interface TraceEvidenceContext {
  installationId: string;
  revision: string;
  epoch: string;
  generation: string;
  signal: AbortSignal;
}
interface EvidenceLease {
  context: TraceEvidenceContext;
  partitionId: string;
  sourceId?: string;
  storeId: string;
  sessionId: string;
  descriptor: TrajectoryEvidenceDescriptor;
  offset: string;
  abort(): void;
}
/** Accurate-event binding and epoch-custodied views; original source refs never leave this owner. */
export class TraceEvidenceBroker {
  private readonly store: TraceConsumerStore;
  private readonly source: TrajectoryEvidenceReads | undefined;
  private readonly subjectId: string;
  private readonly leases = new Map<string, EvidenceLease>();
  constructor(
    store: TraceConsumerStore,
    source: TrajectoryEvidenceReads | undefined,
    subjectId: string,
  ) {
    this.store = store;
    this.source = source;
    this.subjectId = subjectId;
  }
  private check(context: TraceEvidenceContext): void {
    context.signal.throwIfAborted();
    this.store.assertAuthorization(
      context.installationId,
      context.revision,
      context.epoch,
      context.generation,
    );
  }
  private checkPartition(partitionId: string, context: TraceEvidenceContext): void {
    const partition = this.store.inspectPartition(partitionId);
    if (
      partition.installationId !== context.installationId ||
      partition.status !== 'active' ||
      partition.epoch !== context.epoch ||
      partition.contentMode !== 'authorized_evidence'
    )
      throw new TraceHostError('trace_evidence_read_invalid');
  }
  async open(value: unknown, context: TraceEvidenceContext): Promise<TrajectoryEvidenceDescriptor> {
    const input = openSchema.parse(value);
    this.check(context);
    if (
      [...this.leases.values()].filter(
        (lease) => lease.context.installationId === context.installationId,
      ).length >= 4
    )
      throw new TraceHostError('trace_evidence_busy');
    const binding = this.store.evidenceForBatch(
      context.installationId,
      context.revision,
      context.epoch,
      context.generation,
      input.batchId,
      input.eventId,
      input.evidenceId,
      input.contentVersion,
    );
    this.checkPartition(binding.partitionId, context);
    const grant = this.store.grant(context.installationId);
    const readId = randomUUID();
    let sourceId: string | undefined;
    const abort = () => this.closeLease(readId);
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      let descriptor: TrajectoryEvidenceDescriptor;
      if (grant.grant.evidenceContent !== 'full') {
        descriptor = {
          readId,
          eventId: input.eventId,
          evidenceId: input.evidenceId,
          contentVersion: input.contentVersion,
          availability: 'redacted',
          mediaType: 'application/octet-stream',
          viewBytes: '0',
          viewSha256: createHash('sha256').update('').digest('hex'),
          transformation: 'trace.redacted@1',
          policyRevision: context.revision,
          authorizationEpoch: context.epoch,
        };
      } else {
        if (!this.source) throw new TraceHostError('trace_evidence_unavailable');
        const original = await this.source.open(
          { ...binding.source, subjectId: this.subjectId },
          context.signal,
        );
        sourceId = original.readId;
        this.check(context);
        descriptor = {
          ...original,
          readId,
          eventId: input.eventId,
          evidenceId: input.evidenceId,
          contentVersion: input.contentVersion,
          transformation: `trace.authorized@1:${original.transformation}`,
          policyRevision: context.revision,
          authorizationEpoch: context.epoch,
        };
      }
      this.check(context);
      this.checkPartition(binding.partitionId, context);
      this.leases.set(readId, {
        context,
        partitionId: binding.partitionId,
        ...(sourceId ? { sourceId } : {}),
        storeId: binding.source.storeId,
        sessionId: binding.source.sessionId,
        descriptor,
        offset: '0',
        abort,
      });
      this.store.audit(context.installationId, 'evidence_open', 'allowed');
      return { ...descriptor };
    } catch (error) {
      context.signal.removeEventListener('abort', abort);
      if (sourceId)
        this.source?.close(
          sourceId,
          this.subjectId,
          binding.source.storeId,
          binding.source.sessionId,
        );
      this.store.audit(context.installationId, 'evidence_open', 'denied');
      throw error;
    }
  }
  async read(value: unknown, context: TraceEvidenceContext): Promise<TrajectoryEvidenceChunk> {
    const input = readSchema.parse(value),
      lease = this.leases.get(input.readId);
    if (
      !lease ||
      lease.context.installationId !== context.installationId ||
      lease.context.epoch !== context.epoch ||
      lease.context.revision !== context.revision ||
      lease.context.generation !== context.generation
    )
      throw new TraceHostError('trace_evidence_read_missing');
    try {
      this.check(context);
      this.checkPartition(lease.partitionId, context);
      if (lease.offset !== input.offset) throw new TraceHostError('trace_evidence_read_invalid');
      let chunk: TrajectoryEvidenceChunk;
      if (lease.sourceId) {
        const original = await this.source!.read(
          {
            storeId: lease.storeId,
            sessionId: lease.sessionId,
            readId: lease.sourceId,
            offset: input.offset,
            ...(input.limit ? { limit: input.limit } : {}),
          },
          this.subjectId,
          context.signal,
        );
        chunk = {
          ...original,
          readId: input.readId,
          policyRevision: context.revision,
          authorizationEpoch: context.epoch,
        };
        if (chunk.viewSha256 !== lease.descriptor.viewSha256)
          throw new TraceHostError('trace_evidence_view_changed');
      } else
        chunk = {
          readId: input.readId,
          offset: input.offset,
          nextOffset: '0',
          data: '',
          eof: true,
          viewSha256: lease.descriptor.viewSha256,
          policyRevision: context.revision,
          authorizationEpoch: context.epoch,
        };
      this.check(context);
      this.checkPartition(lease.partitionId, context);
      if (this.leases.get(input.readId) !== lease)
        throw new TraceHostError('trace_evidence_read_missing');
      lease.offset = chunk.nextOffset;
      this.store.audit(context.installationId, 'evidence_chunk', 'allowed');
      return chunk;
    } catch (error) {
      this.closeLease(input.readId);
      this.store.audit(context.installationId, 'evidence_chunk', 'denied');
      throw error;
    }
  }
  close(value: unknown, context: TraceEvidenceContext): void {
    const input = closeSchema.parse(value),
      lease = this.leases.get(input.readId);
    if (!lease) return;
    if (
      lease.context.installationId !== context.installationId ||
      lease.context.epoch !== context.epoch ||
      lease.context.generation !== context.generation
    )
      throw new TraceHostError('trace_evidence_read_missing');
    this.closeLease(input.readId);
  }
  private closeLease(readId: string): void {
    const lease = this.leases.get(readId);
    if (!lease) return;
    this.leases.delete(readId);
    lease.context.signal.removeEventListener('abort', lease.abort);
    if (lease.sourceId)
      this.source?.close(lease.sourceId, this.subjectId, lease.storeId, lease.sessionId);
    this.store.audit(lease.context.installationId, 'evidence_close', 'closed');
  }
  revoke(installationId: string): void {
    for (const [id, lease] of this.leases)
      if (lease.context.installationId === installationId) this.closeLease(id);
  }
}
