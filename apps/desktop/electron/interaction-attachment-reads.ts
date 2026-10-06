import {
  type AttachmentReader,
  ClientError,
  type Interaction,
  interactionAttachment,
} from '@kite-ai/client';
import type { NativeAttachmentChunk, NativeAttachmentOpen } from '../src/native-bridge';
import type { ModelOutputViewScope } from './model-output-reads';

export type AttachmentView = ModelOutputViewScope & { interactions: readonly Interaction[] };
type Lease = {
  readId: string;
  scope: ModelOutputViewScope;
  key: string;
  abort: AbortController;
  bytes?: Uint8Array;
  offset: number;
};
function offered(view: AttachmentView, key: string) {
  for (const card of view.interactions) {
    try {
      const attachment = interactionAttachment(card);
      if (attachment?.key === key) return attachment;
    } catch {
      /* An invalid current card has no readable attachment identity. */
    }
  }
  return undefined;
}

/** Reads only an actually offered original card through the controller's verified reader. */
export class NativeInteractionAttachmentReads {
  private lease: Lease | undefined;
  private readonly reader: AttachmentReader;
  private readonly current: () => AttachmentView | undefined;
  private readonly loaded = new Map<string, ModelOutputViewScope>();
  constructor(reader: AttachmentReader, current: () => AttachmentView | undefined) {
    this.reader = reader;
    this.current = current;
  }
  private check(lease: Lease) {
    const now = this.current();
    if (
      this.lease !== lease ||
      lease.abort.signal.aborted ||
      !now ||
      now.generation !== lease.scope.generation ||
      now.selection !== lease.scope.selection ||
      now.storeId !== lease.scope.storeId ||
      now.sessionId !== lease.scope.sessionId ||
      !offered(now, lease.key)
    )
      throw new ClientError('attachment_view_changed');
  }
  async open(input: { readId: string; key: string }): Promise<NativeAttachmentOpen> {
    if (this.lease) throw new ClientError('attachment_read_busy');
    const now = this.current(),
      attachment = now && offered(now, input.key);
    if (!now || !attachment) throw new ClientError('interaction_scope_mismatch');
    const lease: Lease = {
      readId: input.readId,
      scope: {
        generation: now.generation,
        selection: now.selection,
        storeId: now.storeId,
        sessionId: now.sessionId,
      },
      key: attachment.key,
      abort: new AbortController(),
      offset: 0,
    };
    this.lease = lease;
    try {
      const loaded = await this.reader(attachment, { signal: lease.abort.signal });
      this.check(lease);
      lease.bytes = new Uint8Array(loaded.content);
      return {
        kind: 'interactionAttachment.opened',
        readId: lease.readId,
        viewGeneration: now.generation,
        viewSelection: now.selection,
        identity: attachment.key,
        reference: loaded.reference,
      };
    } catch (error) {
      if (this.lease === lease) this.release();
      throw error;
    }
  }
  read(input: { readId: string; offset: number; limit: number }): NativeAttachmentChunk {
    const lease = this.lease;
    if (!lease || lease.readId !== input.readId || !lease.bytes)
      throw new ClientError('attachment_read_missing');
    this.check(lease);
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset !== lease.offset ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 65536
    )
      throw new ClientError('attachment_offset_invalid');
    const end = Math.min(lease.bytes.byteLength, lease.offset + input.limit),
      offset = lease.offset;
    lease.offset = end;
    if (end === lease.bytes.byteLength) this.loaded.set(lease.key, lease.scope);
    return {
      kind: 'interactionAttachment.chunk',
      readId: lease.readId,
      offset,
      nextOffset: end,
      eof: end === lease.bytes.byteLength,
      data: Buffer.from(lease.bytes.subarray(offset, end)).toString('base64'),
    };
  }
  hasLoaded(key: string) {
    const now = this.current(),
      scope = this.loaded.get(key);
    return (
      !!now &&
      !!scope &&
      now.generation === scope.generation &&
      now.selection === scope.selection &&
      now.storeId === scope.storeId &&
      now.sessionId === scope.sessionId &&
      !!offered(now, key)
    );
  }
  close(readId: string) {
    if (this.lease?.readId === readId) {
      this.lease.abort.abort();
      this.lease = undefined;
    }
  }
  release() {
    this.lease?.abort.abort();
    this.lease = undefined;
    this.loaded.clear();
  }
}
