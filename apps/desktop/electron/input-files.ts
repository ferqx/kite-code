import { createHash, type Hash } from 'node:crypto';
import { type AgentClient, ClientError, type InputFileReference } from '@kite-ai/client';

type Draft = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  received: number;
  digest: Hash;
  hash?: string;
  chunks: Uint8Array[];
  publications: Map<string, Promise<InputFileReference>>;
  inFlight: number;
  released: boolean;
};
/** Window-owned byte preparation before a Session exists. Bounded chunks never become a
 * Base64 document or a renderer-selected filesystem read; published originals live in Artifact. */
export class NativeInputFiles {
  private readonly drafts = new Map<string, Draft>();
  private readonly pending = new Set<Promise<InputFileReference>>();
  private readonly owned = new Set<Draft>();
  private reserved = 0;
  private closed = false;
  begin(input: { id: string; name: string; mediaType: string; size: number }) {
    if (
      this.closed ||
      this.owned.size >= 128 ||
      [...this.owned].some((draft) => draft.id === input.id) ||
      !Number.isSafeInteger(input.size) ||
      input.size < 0 ||
      input.size > 256 * 1024 * 1024 ||
      this.reserved + input.size > 256 * 1024 * 1024
    )
      throw new ClientError('native_file_budget_unavailable');
    this.reserved += input.size;
    const draft: Draft = {
      ...input,
      received: 0,
      digest: createHash('sha256'),
      chunks: [],
      publications: new Map(),
      inFlight: 0,
      released: false,
    };
    this.drafts.set(input.id, draft);
    this.owned.add(draft);
  }
  append(id: string, offset: number, data: Uint8Array) {
    const draft = this.drafts.get(id);
    if (
      this.closed ||
      !draft ||
      draft.hash ||
      draft.received !== offset ||
      !(data instanceof Uint8Array) ||
      !data.byteLength ||
      data.byteLength > 65536 ||
      draft.received + data.byteLength > draft.size
    )
      throw new ClientError('native_file_chunk_invalid');
    const bytes = Uint8Array.from(data);
    draft.digest.update(bytes);
    draft.chunks.push(bytes);
    draft.received += bytes.byteLength;
  }
  finish(id: string) {
    const draft = this.drafts.get(id);
    if (this.closed || !draft || draft.received !== draft.size)
      throw new ClientError('native_file_incomplete');
    draft.hash ??= draft.digest.digest('hex');
  }
  async publish(client: AgentClient, storeId: string, sessionId: string, ids: readonly string[]) {
    if (this.closed || ids.length > 128 || new Set(ids).size !== ids.length)
      throw new ClientError('native_file_invalid');
    const result: InputFileReference[] = [];
    for (const id of ids) {
      const draft = this.drafts.get(id);
      if (!draft?.hash) throw new ClientError('native_file_missing');
      const key = JSON.stringify([storeId, sessionId]);
      let pending = draft.publications.get(key);
      if (!pending) {
        draft.inFlight++;
        // Hold the original chunk set through ACK/unknown resolution even if the UI releases its draft.
        const chunks = draft.chunks;
        const importId = createHash('sha256')
          .update(JSON.stringify([storeId, sessionId, id]))
          .digest('hex');
        pending = (async () => {
          // Query the same original identity before retrying an upload whose ACK may be lost.
          try {
            const existing = await client.getInputFileImport(sessionId, importId);
            if (
              existing.originStoreId !== storeId ||
              existing.sessionId !== sessionId ||
              existing.state === 'released' ||
              existing.name !== draft.name ||
              existing.reference.hash !== draft.hash ||
              existing.reference.size !== String(draft.size) ||
              existing.reference.mediaType !== draft.mediaType
            )
              throw new ClientError('input_file_import_conflict');
            return { name: existing.name, uri: existing.uri, reference: existing.reference };
          } catch (error) {
            if (!(error instanceof ClientError) || error.code !== 'input_file_not_found')
              throw error;
          }
          let offset = 0;
          return client.uploadInputFile(
            sessionId,
            {
              expectedStoreId: storeId,
              id: importId,
              name: draft.name,
              mediaType: draft.mediaType,
              size: String(draft.size),
              hash: draft.hash!,
            },
            new ReadableStream<Uint8Array>({
              pull(controller) {
                const chunk = chunks[offset++];
                if (chunk) controller.enqueue(chunk);
                else controller.close();
              },
            }),
          );
        })();
        draft.publications.set(key, pending);
        this.pending.add(pending);
        void pending.then(
          () => {
            this.pending.delete(pending!);
            this.settled(draft);
          },
          () => {
            this.pending.delete(pending!);
            draft.publications.delete(key);
            this.settled(draft);
          },
        );
      }
      result.push(await pending);
    }
    return result;
  }
  release(id: string) {
    const draft = this.drafts.get(id);
    if (!draft) return;
    this.drafts.delete(id);
    draft.released = true;
    this.collect(draft);
  }
  private settled(draft: Draft) {
    draft.inFlight--;
    this.collect(draft);
  }
  private collect(draft: Draft) {
    if (!draft.released || draft.inFlight || !this.owned.delete(draft)) return;
    this.reserved -= draft.size;
    draft.chunks = [];
    draft.publications.clear();
  }
  reset() {
    for (const id of this.drafts.keys()) this.release(id);
  }
  async close() {
    this.closed = true;
    this.reset();
    await Promise.allSettled([...this.pending]);
  }
}
