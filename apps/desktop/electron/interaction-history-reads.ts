import { type AgentClient, ClientError, interactionAttachment } from '@kite-ai/client';
import {
  type NativeInteractionHistoryPage,
  type NativeInteractionHistoryScope,
  verifyInteractionHistoryPage,
} from '../src/interaction-history-bridge';
import { NativeInteractionAttachmentReads } from './interaction-attachment-reads';

type Client = Pick<
  AgentClient,
  'listInteractions' | 'getInteraction' | 'readInteractionAttachment'
> & {
  readonly serverInfo?: Pick<NonNullable<AgentClient['serverInfo']>, 'storeId' | 'capabilities'>;
};
type Lease = {
  readId: string;
  scope: NativeInteractionHistoryScope;
  abort: AbortController;
  cursor?: string;
  afterId?: string;
  complete: boolean;
  reading: boolean;
  cards: Map<string, NativeInteractionHistoryPage['page']['interactions'][number]>;
};

/** Public record reading owns no answer observation or loaded approval proof. */
export class NativeInteractionHistoryReads {
  private lease?: Lease;
  readonly attachments: NativeInteractionAttachmentReads;
  private readonly client: Client;
  private readonly current: () => NativeInteractionHistoryScope | undefined;
  constructor(client: Client, current: () => NativeInteractionHistoryScope | undefined) {
    this.client = client;
    this.current = current;
    this.attachments = new NativeInteractionAttachmentReads(
      async (attachment, options) => {
        const lease = this.lease;
        if (!lease) throw new ClientError('interaction_history_read_missing');
        this.check(lease);
        const card = [...lease.cards.values()].find((value) => {
          try {
            return interactionAttachment(value)?.key === attachment.key;
          } catch {
            return false;
          }
        });
        if (!card) throw new ClientError('interaction_scope_mismatch');
        const fresh = await client.getInteraction(
          lease.scope.sessionId,
          card.id,
          { storeId: lease.scope.storeId, origin: 'all' },
          options,
        );
        this.check(lease);
        if (JSON.stringify(fresh) !== JSON.stringify(card))
          throw new ClientError('interaction_history_changed');
        const result = await client.readInteractionAttachment(card, options);
        this.check(lease);
        return result;
      },
      () => {
        const lease = this.lease;
        if (!lease || !this.matches(lease)) return;
        return {
          generation: lease.scope.generation,
          selection: lease.scope.viewSelection,
          storeId: lease.scope.storeId,
          sessionId: lease.scope.sessionId,
          interactions: [...lease.cards.values()],
        };
      },
    );
  }
  private matches(lease: Lease) {
    const now = this.current();
    return (
      this.lease === lease &&
      !lease.abort.signal.aborted &&
      this.client.serverInfo?.storeId === lease.scope.storeId &&
      !!now &&
      Object.keys(lease.scope).every(
        (key) =>
          now[key as keyof NativeInteractionHistoryScope] ===
          lease.scope[key as keyof NativeInteractionHistoryScope],
      )
    );
  }
  private check(lease: Lease) {
    if (!this.matches(lease)) throw new ClientError('interaction_history_view_changed');
  }
  async open(input: {
    readId: string;
    viewSelection: number;
    historyEpoch: number;
  }): Promise<NativeInteractionHistoryPage> {
    const scope = this.current();
    if (
      !scope ||
      scope.viewSelection !== input.viewSelection ||
      scope.historyEpoch !== input.historyEpoch
    )
      throw new ClientError('native_selection_changed');
    if (!this.client.serverInfo?.capabilities.includes('interactions'))
      throw new ClientError('capability_unavailable');
    this.release();
    const lease: Lease = {
      readId: input.readId,
      scope: { ...scope },
      abort: new AbortController(),
      complete: false,
      reading: true,
      cards: new Map(),
    };
    this.lease = lease;
    return this.readPage(lease);
  }
  async next(readId: string) {
    const lease = this.lease;
    if (!lease || lease.readId !== readId)
      throw new ClientError('interaction_history_read_missing');
    this.check(lease);
    if (lease.reading) throw new ClientError('interaction_history_read_busy');
    if (lease.complete || !lease.afterId)
      throw new ClientError('interaction_history_read_complete');
    return this.readPage(lease);
  }
  private async readPage(lease: Lease): Promise<NativeInteractionHistoryPage> {
    this.check(lease);
    lease.reading = true;
    try {
      const page = await this.client.listInteractions(
        lease.scope.sessionId,
        {
          storeId: lease.scope.storeId,
          origin: 'all',
          limit: 20,
          ...(lease.afterId ? { afterId: lease.afterId } : {}),
        },
        { signal: lease.abort.signal },
      );
      this.check(lease);
      verifyInteractionHistoryPage(
        page,
        lease.scope,
        lease.cursor ? { cursor: lease.cursor, afterId: lease.afterId } : undefined,
      );
      lease.cursor = page.snapshotCursor;
      lease.afterId = page.nextAfterId ?? undefined;
      lease.complete = page.nextAfterId === null;
      for (const card of page.interactions) lease.cards.set(card.id, structuredClone(card));
      return {
        kind: 'interactionHistory.page',
        readId: lease.readId,
        scope: { ...lease.scope },
        page,
      };
    } catch (error) {
      if (this.lease === lease) this.release();
      throw error;
    } finally {
      lease.reading = false;
    }
  }
  close(readId: string) {
    if (this.lease?.readId === readId) this.release();
  }
  release() {
    this.lease?.abort.abort();
    this.lease = undefined;
    this.attachments.release();
  }
}
