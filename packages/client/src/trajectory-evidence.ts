import {
  evidenceChunkSchema,
  evidenceDescriptorSchema,
  parseDecimal64,
  type TrajectoryEvidenceCloseRequest,
  type TrajectoryEvidenceDescriptor,
  type TrajectoryEvidenceOpen,
  type TrajectoryEvidenceReadRequest,
} from '@kite-ai/trajectory';
import { ClientError } from './decode';

export interface TrajectoryEvidenceSource {
  openTrajectoryEvidence(
    input: TrajectoryEvidenceOpen,
    options?: { signal?: AbortSignal },
  ): Promise<TrajectoryEvidenceDescriptor>;
  readTrajectoryEvidenceChunk(
    input: TrajectoryEvidenceReadRequest,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  closeTrajectoryEvidence(input: TrajectoryEvidenceCloseRequest): Promise<unknown>;
}
/** Verify exactly the projected bytes delivered by this immutable view lease. */
export async function readTrajectoryEvidence(
  source: TrajectoryEvidenceSource,
  input: TrajectoryEvidenceOpen,
  options: { signal?: AbortSignal } = {},
): Promise<{ descriptor: TrajectoryEvidenceDescriptor; content: Uint8Array }> {
  options.signal?.throwIfAborted();
  const descriptor = evidenceDescriptorSchema.parse(
    await source.openTrajectoryEvidence(input, options),
  );
  const close = { storeId: input.storeId, sessionId: input.sessionId, readId: descriptor.readId };
  try {
    if (
      descriptor.eventId !== input.eventId ||
      descriptor.evidenceId !== input.evidenceId ||
      descriptor.contentVersion !== input.contentVersion
    )
      throw new ClientError('trajectory_evidence_identity_mismatch');
    const size = parseDecimal64(descriptor.viewBytes);
    if (size > BigInt(Number.MAX_SAFE_INTEGER))
      throw new ClientError('trajectory_evidence_size_unrepresentable');
    const bytes = new Uint8Array(Number(size));
    let offset = 0;
    for (;;) {
      options.signal?.throwIfAborted();
      const chunk = evidenceChunkSchema.parse(
        await source.readTrajectoryEvidenceChunk(
          { ...close, offset: String(offset), limit: 65536 },
          options,
        ),
      );
      options.signal?.throwIfAborted();
      if (
        chunk.readId !== descriptor.readId ||
        chunk.offset !== String(offset) ||
        chunk.viewSha256 !== descriptor.viewSha256 ||
        chunk.policyRevision !== descriptor.policyRevision ||
        chunk.authorizationEpoch !== descriptor.authorizationEpoch ||
        chunk.data.length > 87384 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)
      )
        throw new ClientError('trajectory_evidence_chunk_invalid');
      const binary = atob(chunk.data),
        end = offset + binary.length;
      if (
        binary.length > 65536 ||
        end > bytes.length ||
        chunk.nextOffset !== String(end) ||
        chunk.eof !== (end === bytes.length) ||
        (!chunk.eof && binary.length === 0)
      )
        throw new ClientError('trajectory_evidence_chunk_invalid');
      for (let i = 0; i < binary.length; i++) bytes[offset + i] = binary.charCodeAt(i);
      offset = end;
      if (chunk.eof) break;
    }
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    options.signal?.throwIfAborted();
    const hash = Array.from(new Uint8Array(digest), (value) =>
      value.toString(16).padStart(2, '0'),
    ).join('');
    if (hash !== descriptor.viewSha256) throw new ClientError('trajectory_evidence_digest_invalid');
    return { descriptor, content: bytes };
  } finally {
    await source.closeTrajectoryEvidence(close);
  }
}
