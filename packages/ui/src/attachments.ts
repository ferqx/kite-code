import type { Interaction } from '@kite-ai/client';
import { type AttachmentReader, interactionAttachment } from '@kite-ai/client';

export {
  type AttachmentReader,
  type InteractionAttachment,
  interactionAttachment,
  requiresInteractionAttachment,
} from '@kite-ai/client';
export async function loadInteractionAttachment(
  interaction: Interaction,
  reader: AttachmentReader,
  signal: AbortSignal,
) {
  const intent = interactionAttachment(structuredClone(interaction));
  if (!intent) throw new Error('attachment_missing');
  signal.throwIfAborted();
  const result = await reader(structuredClone(intent), { signal });
  signal.throwIfAborted();
  const ref = structuredClone(result.reference);
  const content = new Uint8Array(result.content);
  if (
    ref.id !== intent.reference.id ||
    ref.mediaType !== intent.reference.mediaType ||
    ref.size !== intent.reference.size ||
    ref.scope.kind !== intent.reference.scope.kind ||
    ref.scope.id !== intent.reference.scope.id ||
    !/^[a-f0-9]{64}$/.test(ref.hash) ||
    BigInt(content.byteLength) !== BigInt(ref.size)
  )
    throw new Error('attachment_metadata_mismatch');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', content));
  signal.throwIfAborted();
  if (Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('') !== ref.hash)
    throw new Error('attachment_content_mismatch');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
  } catch {
    throw new Error('attachment_encoding_invalid');
  }
  signal.throwIfAborted();
  return { identity: intent.key, reference: ref, text };
}
