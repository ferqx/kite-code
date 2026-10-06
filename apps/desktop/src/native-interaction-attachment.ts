import { ClientError, type InteractionAttachment } from '@kite-ai/client';
import type { NativeAttachmentOpen, NativeBridge } from './native-bridge';

/** A view-only reader; the original controller and public SDK own the card proof. */
export async function readNativeInteractionAttachment(input: {
  bridge: NativeBridge;
  generation: number;
  viewSelection?: number;
  attachment: InteractionAttachment;
  signal: AbortSignal;
  isCurrent: () => boolean;
}) {
  const readId = crypto.randomUUID(),
    attachment = structuredClone(input.attachment);
  const check = () => {
    input.signal.throwIfAborted();
    if (!input.isCurrent()) throw new ClientError('attachment_view_changed');
  };
  const close = () =>
    input.bridge
      .request({ method: 'interactionAttachment.close', generation: input.generation, readId })
      .catch(() => {});
  const abort = () => {
    void close();
  };
  input.signal.addEventListener('abort', abort, { once: true });
  try {
    check();
    const raw = await input.bridge.request({
      method: 'interactionAttachment.open',
      generation: input.generation,
      readId,
      key: attachment.key,
    });
    check();
    if (!raw || !('readId' in raw) || raw.kind !== 'interactionAttachment.opened')
      throw new ClientError('attachment_metadata_invalid');
    const opened = raw as NativeAttachmentOpen,
      ref = opened.reference;
    if (
      opened.readId !== readId ||
      opened.viewGeneration !== input.generation ||
      !Number.isSafeInteger(opened.viewSelection) ||
      opened.viewSelection < 1 ||
      (input.viewSelection !== undefined && opened.viewSelection !== input.viewSelection) ||
      opened.identity !== attachment.key ||
      ref.id !== attachment.reference.id ||
      ref.mediaType !== attachment.reference.mediaType ||
      ref.size !== attachment.reference.size ||
      ref.scope.kind !== attachment.reference.scope.kind ||
      ref.scope.id !== attachment.reference.scope.id ||
      !/^(0|[1-9][0-9]{0,18})$/.test(ref.size) ||
      BigInt(ref.size) > BigInt(Number.MAX_SAFE_INTEGER) ||
      !/^[a-f0-9]{64}$/.test(ref.hash)
    )
      throw new ClientError('attachment_metadata_invalid');
    const content = new Uint8Array(Number(ref.size));
    let offset = 0;
    for (;;) {
      check();
      const chunk = await input.bridge.request({
        method: 'interactionAttachment.read',
        generation: input.generation,
        readId,
        offset,
        limit: 65536,
      });
      check();
      if (
        !chunk ||
        !('readId' in chunk) ||
        !('offset' in chunk) ||
        chunk.kind !== 'interactionAttachment.chunk' ||
        chunk.readId !== readId ||
        chunk.offset !== offset ||
        !Number.isSafeInteger(chunk.nextOffset) ||
        typeof chunk.eof !== 'boolean' ||
        typeof chunk.data !== 'string' ||
        chunk.data.length > 87384 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)
      )
        throw new ClientError('attachment_chunk_invalid');
      const bytes = atob(chunk.data),
        next = offset + bytes.length;
      if (
        bytes.length > 65536 ||
        next !== chunk.nextOffset ||
        next > content.length ||
        (!chunk.eof && bytes.length === 0) ||
        chunk.eof !== (next === content.length)
      )
        throw new ClientError('attachment_chunk_invalid');
      for (let index = 0; index < bytes.length; index++)
        content[offset + index] = bytes.charCodeAt(index);
      offset = next;
      if (chunk.eof) break;
    }
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', content)),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    check();
    if (hash !== ref.hash) throw new ClientError('attachment_content_mismatch');
    try {
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
    } catch {
      throw new ClientError('attachment_encoding_invalid');
    }
    return { reference: ref, content };
  } finally {
    input.signal.removeEventListener('abort', abort);
    await close();
  }
}
