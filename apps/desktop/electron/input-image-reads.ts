import { type AgentClient, ClientError, type Message } from '@kite-ai/client';
import type { NativeInputFileResult, NativeInputImageRequest } from '../src/input-images-bridge';
import type { NativeToolMessageScope } from '../src/tool-messages-bridge';
import { nativeToolImages } from './tool-images';
import { nativeToolMessageFact } from './tool-message-fact';

type Lease = {
  readId: string;
  scope: NativeToolMessageScope;
  abort: AbortController;
  messageId: string;
  index: number;
  identity: string;
  bytes?: Uint8Array;
};
export class NativeInputImageReads {
  private readonly reads = new Map<string, Lease>();
  private readonly pending = new Set<Promise<NativeInputFileResult>>();
  private readonly client: AgentClient;
  private readonly current: () => NativeToolMessageScope | undefined;
  private readonly messages: () => ReadonlyMap<string, Message>;
  constructor(
    client: AgentClient,
    current: () => NativeToolMessageScope | undefined,
    messages: () => ReadonlyMap<string, Message>,
  ) {
    this.client = client;
    this.current = current;
    this.messages = messages;
  }
  private check(lease: Lease) {
    const now = this.current(),
      message = this.messages().get(lease.messageId);
    if (
      lease.abort.signal.aborted ||
      !now ||
      JSON.stringify(now) !== JSON.stringify(lease.scope) ||
      JSON.stringify(message) !== lease.identity ||
      this.reads.get(lease.readId) !== lease
    )
      throw new ClientError('input_image_view_changed');
  }
  open(
    request: Extract<NativeInputImageRequest, { method: 'input.image.open' }>,
  ): Promise<NativeInputFileResult> {
    const pending = this.load(request);
    this.pending.add(pending);
    void pending.then(
      () => this.pending.delete(pending),
      () => this.pending.delete(pending),
    );
    return pending;
  }
  private async load(
    request: Extract<NativeInputImageRequest, { method: 'input.image.open' }>,
  ): Promise<NativeInputFileResult> {
    const scope = this.current(),
      message = this.messages().get(request.messageId);
    if (
      !scope ||
      scope.generation !== request.generation ||
      scope.viewSelection !== request.viewSelection ||
      scope.historyEpoch !== request.historyEpoch ||
      !message ||
      !['user', 'tool'].includes(message.role) ||
      message.status !== 'complete' ||
      !Number.isSafeInteger(request.index) ||
      request.index < 0
    )
      throw new ClientError('input_image_view_changed');
    if (this.reads.has(request.readId) || this.reads.size >= 4 || this.pending.size >= 4)
      throw new ClientError('input_image_read_busy');
    const lease: Lease = {
      readId: request.readId,
      scope: { ...scope },
      abort: new AbortController(),
      messageId: message.id,
      index: request.index,
      identity: JSON.stringify(message),
    };
    this.reads.set(request.readId, lease);
    try {
      const resolveImage = async () => {
        if (message.role === 'user') return message.images?.[request.index];
        if (message.sourceIds?.length !== 1) throw new ClientError('tool_images_invalid');
        const execution = await this.client.getExecution(message.sourceIds[0]!, {
          signal: lease.abort.signal,
        });
        this.check(lease);
        if (
          !nativeToolMessageFact({
            execution,
            message,
            messages: this.messages().values(),
            sessionId: scope.sessionId,
          })
        )
          throw new ClientError('tool_images_invalid');
        return nativeToolImages(execution)[request.index];
      };
      const image = await resolveImage();
      if (!image || BigInt(image.reference.size) > 16n * 1024n * 1024n)
        throw new ClientError('input_image_view_changed');
      const ref = image.reference;
      const result = await this.client.readArtifact(
        ref.sessionId,
        { expectedStoreId: scope.storeId, refId: ref.id, scope: ref.scope },
        { signal: lease.abort.signal, expectedReference: ref },
      );
      this.check(lease);
      if (message.role === 'tool' && JSON.stringify(await resolveImage()) !== JSON.stringify(image))
        throw new ClientError('tool_images_invalid');
      lease.bytes = result.content;
      return {
        kind: 'input.image.open',
        readId: lease.readId,
        size: lease.bytes.byteLength,
        hash: result.reference.hash,
        mediaType: ref.mediaType,
      };
    } catch (error) {
      this.close(request.readId);
      throw error;
    }
  }
  read(readId: string, offset: number): NativeInputFileResult {
    const lease = this.reads.get(readId);
    if (!lease?.bytes || !Number.isSafeInteger(offset) || offset < 0 || offset > lease.bytes.length)
      throw new ClientError('input_image_offset_invalid');
    this.check(lease);
    const chunk = lease.bytes.subarray(offset, offset + 65536),
      nextOffset = offset + chunk.length;
    return {
      kind: 'input.image.chunk',
      readId,
      offset,
      nextOffset,
      data: Buffer.from(chunk).toString('base64'),
      done: nextOffset === lease.bytes.length,
    };
  }
  close(readId: string) {
    const lease = this.reads.get(readId);
    if (lease) {
      this.reads.delete(readId);
      lease.abort.abort();
      lease.bytes = undefined;
    }
  }
  release() {
    for (const id of this.reads.keys()) this.close(id);
  }
  async closeAll() {
    this.release();
    await Promise.allSettled([...this.pending]);
  }
}
