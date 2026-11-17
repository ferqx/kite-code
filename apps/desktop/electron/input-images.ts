import { createHash } from 'node:crypto';
import { type AgentClient, ClientError, type InputImage } from '@kite-ai/client';
import { inputImageCount, inputImageWindowCount } from '../src/input-images-bridge';

const imageBytes = 16 * 1024 * 1024;
type Draft = {
  id: string;
  name: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  size: number;
  hash: string;
  chunks: Buffer[];
  received: number;
  bytes?: Buffer;
  publications: Map<string, Promise<InputImage>>;
};

/** Only user-delivered bytes enter this owner; it never reads renderer-supplied paths. */
export class NativeInputImages {
  private readonly drafts = new Map<string, Draft>();
  private readonly pending = new Set<Promise<InputImage>>();
  private reserved = 0;
  private closed = false;
  begin(input: Omit<Draft, 'chunks' | 'received' | 'bytes' | 'publications'>) {
    if (
      this.closed ||
      this.drafts.size >= inputImageWindowCount ||
      this.drafts.has(input.id) ||
      input.size <= 0 ||
      input.size > imageBytes ||
      this.reserved + input.size > imageBytes * 4
    )
      throw new ClientError('native_image_budget_unavailable');
    this.reserved += input.size;
    this.drafts.set(input.id, { ...input, chunks: [], received: 0, publications: new Map() });
  }
  append(id: string, offset: number, data: string) {
    const draft = this.drafts.get(id),
      bytes = Buffer.from(data, 'base64');
    if (
      this.closed ||
      !draft ||
      draft.bytes ||
      draft.received !== offset ||
      bytes.length > 65536 ||
      !bytes.length ||
      bytes.toString('base64') !== data ||
      draft.received + bytes.length > draft.size
    )
      throw new ClientError('native_image_chunk_invalid');
    draft.chunks.push(bytes);
    draft.received += bytes.length;
  }
  finish(id: string) {
    const draft = this.drafts.get(id);
    if (this.closed || !draft || draft.received !== draft.size)
      throw new ClientError('native_image_incomplete');
    if (!draft.bytes) {
      const bytes = Buffer.concat(draft.chunks);
      if (createHash('sha256').update(bytes).digest('hex') !== draft.hash)
        throw new ClientError('native_image_hash_mismatch');
      draft.bytes = bytes;
      draft.chunks = [];
    }
  }
  snapshot(id: string) {
    const draft = this.drafts.get(id);
    if (!draft?.bytes) throw new ClientError('native_image_missing');
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < draft.bytes.length; offset += 65536)
      chunks.push(draft.bytes.subarray(offset, offset + 65536));
    return {
      id,
      kind: 'image' as const,
      name: draft.name,
      mediaType: draft.mediaType,
      size: draft.size,
      hash: draft.hash,
      state: 'ready' as const,
      chunks,
    };
  }
  restore(
    item: { id: string; name: string; mediaType: string; size: number; hash: string },
    chunks: readonly Uint8Array[],
  ) {
    const existing = this.drafts.get(item.id);
    if (existing) {
      if (
        !existing.bytes ||
        existing.hash !== item.hash ||
        existing.size !== item.size ||
        existing.name !== item.name ||
        existing.mediaType !== item.mediaType
      )
        throw new ClientError('native_image_invalid');
      return;
    }
    this.begin({ ...item, mediaType: item.mediaType as Draft['mediaType'] });
    try {
      let offset = 0;
      for (const chunk of chunks) {
        this.append(item.id, offset, Buffer.from(chunk).toString('base64'));
        offset += chunk.byteLength;
      }
      this.finish(item.id);
    } catch (error) {
      this.release(item.id);
      throw error;
    }
  }
  preview(id: string, offset: number) {
    const draft = this.drafts.get(id);
    if (!draft?.bytes || !Number.isSafeInteger(offset) || offset < 0 || offset > draft.size)
      throw new ClientError('native_image_missing');
    return draft.bytes.subarray(offset, offset + 65536);
  }
  async publish(
    client: AgentClient,
    storeId: string,
    sessionId: string,
    ids: readonly string[],
  ): Promise<InputImage[]> {
    if (this.closed || ids.length > inputImageCount || new Set(ids).size !== ids.length)
      throw new ClientError('native_image_invalid');
    const result: InputImage[] = [];
    for (const id of ids) {
      const draft = this.drafts.get(id);
      if (!draft?.bytes) throw new ClientError('native_image_missing');
      const key = JSON.stringify([storeId, sessionId]);
      let pending = draft.publications.get(key);
      if (!pending) {
        pending = client.uploadInputImage(sessionId, {
          expectedStoreId: storeId,
          id: `${id}-${sessionId}`,
          name: draft.name,
          mediaType: draft.mediaType,
          data: draft.bytes.toString('base64'),
        });
        draft.publications.set(key, pending);
        this.pending.add(pending);
        void pending.then(
          () => this.pending.delete(pending!),
          () => {
            this.pending.delete(pending!);
            draft.publications.delete(key);
          },
        );
      }
      result.push(await pending);
    }
    return result;
  }
  release(id: string) {
    const draft = this.drafts.get(id);
    if (draft) {
      this.reserved -= draft.size;
      this.drafts.delete(id);
    }
  }
  reset() {
    this.drafts.clear();
    this.reserved = 0;
  }
  async close() {
    this.closed = true;
    this.reset();
    await Promise.allSettled([...this.pending]);
  }
}
