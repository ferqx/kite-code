import { type AgentClient, ClientError, type Message } from '@kite-ai/client';
import type { NativeModelBodyChunk, NativeModelBodyOpen } from '../src/native-bridge';

export type ModelOutputViewScope = {
  generation: number;
  selection: number;
  storeId: string;
  sessionId: string;
};
type Lease = {
  readId: string;
  scope: ModelOutputViewScope;
  executionId: string;
  abort: AbortController;
  bytes?: Uint8Array;
  offset: number;
};
/** One view-body lease; it never starts or cancels execution and never restores a lost handle. */
export class NativeModelOutputReads<K extends 'modelOutput' | 'modelInput' = 'modelOutput'> {
  private readonly kind: K;
  private lease: Lease | undefined;
  private readonly client: AgentClient;
  private readonly current: () => ModelOutputViewScope | undefined;
  constructor(
    client: AgentClient,
    current: () => ModelOutputViewScope | undefined,
    kind: K = 'modelOutput' as K,
  ) {
    this.kind = kind;
    this.client = client;
    this.current = current;
  }
  private code(value: string) {
    return this.kind === 'modelInput' ? value.replace('model_output_', 'model_input_') : value;
  }
  private check(lease: Lease) {
    const now = this.current();
    if (
      this.lease !== lease ||
      lease.abort.signal.aborted ||
      !now ||
      Object.keys(lease.scope).some(
        (key) =>
          now[key as keyof ModelOutputViewScope] !== lease.scope[key as keyof ModelOutputViewScope],
      )
    )
      throw new ClientError(this.code('model_output_view_changed'));
  }
  async open(
    input: {
      readId: string;
      expectedStoreId: string;
      sessionId: string;
      executionId: string;
    },
    source?: { sessionId: string; runId: string; body: NonNullable<Message['outputBody']> },
  ): Promise<NativeModelBodyOpen<K>> {
    if (this.lease) throw new ClientError(this.code('model_output_read_busy'));
    const scope = this.current();
    if (!scope || scope.sessionId !== input.sessionId)
      throw new ClientError('native_selection_changed');
    if (scope.storeId !== input.expectedStoreId) throw new ClientError('store_identity_mismatch');
    if (
      !this.client.serverInfo?.capabilities.includes(
        this.kind === 'modelInput' ? 'model_inputs' : 'model_outputs',
      )
    )
      throw new ClientError('capability_unavailable');
    const lease: Lease = {
      readId: input.readId,
      scope: { ...scope },
      executionId: input.executionId,
      abort: new AbortController(),
      offset: 0,
    };
    this.lease = lease;
    try {
      const sourceSessionId = source?.sessionId ?? input.sessionId;
      const snapshot = await (this.kind === 'modelInput'
        ? this.client.getModelInput(input.sessionId, input.executionId, {
            expectedStoreId: input.expectedStoreId,
            signal: lease.abort.signal,
          })
        : this.client.getModelOutput(sourceSessionId, input.executionId, {
            expectedStoreId: input.expectedStoreId,
            signal: lease.abort.signal,
          }));
      this.check(lease);
      if (
        snapshot.storeId !== scope.storeId ||
        snapshot.sessionId !== sourceSessionId ||
        snapshot.executionId !== lease.executionId
      )
        throw new ClientError(this.code('model_output_identity_mismatch'));
      if (source) {
        if (
          !('output' in snapshot) ||
          snapshot.runId !== source.runId ||
          snapshot.output.complete !== source.body.complete ||
          snapshot.contentBytes !== source.body.contentBytes ||
          snapshot.reasoningBytes !== source.body.reasoningBytes ||
          (source.body.complete &&
            (snapshot.status !== 'succeeded' ||
              snapshot.output.toolCalls.length !== source.body.toolCallCount))
        )
          throw new ClientError('model_output_identity_mismatch');
      }
      const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
      this.check(lease);
      lease.bytes = bytes;
      return {
        kind: `${this.kind}.opened`,
        readId: lease.readId,
        viewGeneration: scope.generation,
        viewSelection: scope.selection,
        storeId: scope.storeId,
        sessionId: sourceSessionId,
        executionId: lease.executionId,
        wireBytes: String(bytes.byteLength),
        bodyHash: snapshot.bodyHash,
        bodyBytes: snapshot.bodyBytes,
      };
    } catch (error) {
      if (this.lease === lease) this.release();
      throw error;
    }
  }
  read(input: { readId: string; offset: number; limit: number }): NativeModelBodyChunk<K> {
    const lease = this.lease;
    if (!lease || lease.readId !== input.readId || !lease.bytes)
      throw new ClientError(this.code('model_output_read_missing'));
    this.check(lease);
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset !== lease.offset ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 65536
    )
      throw new ClientError(this.code('model_output_offset_invalid'));
    const offset = lease.offset,
      end = Math.min(lease.bytes.byteLength, offset + input.limit);
    const data = Buffer.from(lease.bytes.subarray(offset, end)).toString('base64');
    lease.offset = end;
    return {
      kind: `${this.kind}.chunk`,
      readId: lease.readId,
      offset,
      nextOffset: end,
      eof: end === lease.bytes.byteLength,
      data,
    };
  }
  close(readId: string) {
    if (this.lease?.readId === readId) this.release();
  }
  release() {
    const lease = this.lease;
    this.lease = undefined;
    lease?.abort.abort();
    if (lease) lease.bytes = undefined;
  }
}
