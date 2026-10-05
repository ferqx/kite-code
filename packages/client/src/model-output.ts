import { ClientError, decodeResponse } from './decode';
import type { ModelOutputSnapshot } from './generated/api';
import { canonicalModelBody, digestModelBody, readVerifiedModelBody } from './model-input';
import { parseCursorSequence } from './sse';

/** A prefix is readable history, never a complete response or usable partial Tool arguments. */
export async function readModelOutputResponse(
  response: Response,
  signal: AbortSignal,
): Promise<ModelOutputSnapshot> {
  return verifyModelOutputSnapshot(
    await readVerifiedModelBody(response, signal, 'model-output'),
    signal,
  );
}

/** The same public body verifier also serves a finite, trusted Native main-to-renderer transport. */
export async function verifyModelOutputSnapshot(
  value: unknown,
  signal?: AbortSignal,
): Promise<ModelOutputSnapshot> {
  signal?.throwIfAborted();
  let copy: unknown;
  try {
    copy = structuredClone(value);
  } catch {
    throw new ClientError('invalid_response');
  }
  const snapshot = decodeResponse('ModelOutputSnapshot', copy);
  parseCursorSequence(snapshot.rootWorkSeq);
  parseCursorSequence(snapshot.snapshotCursor);
  const encoder = new TextEncoder();
  const original = encoder.encode(canonicalModelBody(snapshot.output));
  if (
    BigInt(original.byteLength) !== parseCursorSequence(snapshot.bodyBytes) ||
    (await digestModelBody(original)) !== snapshot.bodyHash ||
    BigInt(encoder.encode(snapshot.output.content).byteLength) !==
      parseCursorSequence(snapshot.contentBytes) ||
    BigInt(encoder.encode(snapshot.output.reasoning).byteLength) !==
      parseCursorSequence(snapshot.reasoningBytes) ||
    snapshot.output.complete !== (snapshot.status === 'succeeded') ||
    (!snapshot.output.complete && snapshot.output.toolCalls.length !== 0)
  )
    throw new ClientError('model_output_hash_mismatch');
  signal?.throwIfAborted();
  return snapshot;
}
