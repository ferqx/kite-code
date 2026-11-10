import { type AgentClient, ClientError, type Message, type SessionView } from '@kite-ai/client';

/** One selected observation epoch. A failed page never advances the saved baseline. */
export function createTuiHistoryReader(
  client: Pick<AgentClient, 'listMessages' | 'listMessageChanges' | 'serverInfo'>,
  storeId: string,
) {
  let saved: { sessionId: string; cursor: string; messages: Message[] } | undefined;
  let epoch = 0;
  async function readAtCursor(
    sessionId: string,
    upperCursor: string,
    readView: () => Promise<SessionView>,
    signal: AbortSignal,
  ): Promise<{ cursor: string; messages: Message[] }> {
    const generation = epoch;
    const check = () => {
      signal.throwIfAborted();
      if (generation !== epoch) throw new ClientError('history_identity_mismatch');
    };
    check();
    const previous = saved?.sessionId === sessionId ? saved : undefined;
    if (
      previous &&
      client.serverInfo?.capabilities.includes('message_changes') &&
      BigInt(previous.cursor) > BigInt(upperCursor)
    )
      return { cursor: previous.cursor, messages: previous.messages };
    let entries = new Map<string, Message>();
    let cursor = previous?.cursor;
    if (
      previous &&
      client.serverInfo?.capabilities.includes('message_changes') &&
      BigInt(previous.cursor) <= BigInt(upperCursor)
    ) {
      entries = new Map(previous.messages.map((message) => [message.id, message]));
      try {
        while (cursor !== upperCursor) {
          const afterCursor = cursor!;
          let afterSeq = '0';
          let upperSeq: string | undefined;
          let nextCursor: string | undefined;
          const ids = new Set<string>();
          for (;;) {
            const page = await client.listMessageChanges(
              sessionId,
              {
                storeId,
                afterCursor,
                upperCursor,
                afterSeq,
                upperSeq,
                limit: 200,
              },
              { signal },
            );
            check();
            if (nextCursor !== undefined && nextCursor !== page.nextCursor)
              throw new ClientError('history_cursor_invalid');
            if (
              BigInt(page.nextCursor) <= BigInt(afterCursor) ||
              BigInt(page.nextCursor) > BigInt(upperCursor) ||
              (upperSeq !== undefined && upperSeq !== page.highWaterSeq)
            )
              throw new ClientError('history_cursor_invalid');
            nextCursor = page.nextCursor;
            upperSeq = page.highWaterSeq;
            for (const id of page.removedIds) {
              if (ids.has(id)) throw new ClientError('history_identity_mismatch');
              ids.add(id);
              entries.delete(id);
            }
            for (const message of page.messages) {
              if (
                ids.has(message.id) ||
                message.sessionId !== sessionId ||
                BigInt(message.seq) <= BigInt(afterSeq) ||
                BigInt(message.seq) > BigInt(upperSeq)
              )
                throw new ClientError('history_identity_mismatch');
              ids.add(message.id);
              entries.set(message.id, message);
            }
            if (page.nextAfterSeq === null) break;
            if (
              BigInt(page.nextAfterSeq) <= BigInt(afterSeq) ||
              BigInt(page.nextAfterSeq) > BigInt(upperSeq)
            )
              throw new ClientError('history_cursor_invalid');
            afterSeq = page.nextAfterSeq;
          }
          cursor = nextCursor;
        }
        const messages = [...entries.values()].sort((a, b) =>
          BigInt(a.seq) < BigInt(b.seq) ? -1 : 1,
        );
        check();
        saved = { sessionId, cursor: upperCursor, messages };
        return { cursor: upperCursor, messages };
      } catch (error) {
        if (!(error instanceof ClientError) || error.code !== 'cursor_expired') throw error;
      }
    }
    const view = await readView();
    check();
    if (view.storeId !== storeId || view.session.id !== sessionId)
      throw new ClientError('history_identity_mismatch');
    const messages: Message[] = [];
    let afterSeq = '0';
    for (;;) {
      const page = await client.listMessages(sessionId, {
        afterSeq,
        upperSeq: view.session.nextSeq,
        limit: 200,
        signal,
      });
      check();
      for (const message of page) {
        if (
          message.sessionId !== sessionId ||
          BigInt(message.seq) <= BigInt(afterSeq) ||
          BigInt(message.seq) > BigInt(view.session.nextSeq)
        )
          throw new ClientError('history_identity_mismatch');
        messages.push(message);
        afterSeq = message.seq;
      }
      if (page.length < 200) break;
    }
    saved = { sessionId, cursor: view.snapshotCursor, messages };
    return { cursor: view.snapshotCursor, messages };
  }
  return {
    reset() {
      epoch++;
      saved = undefined;
    },
    readAtCursor,
    async read(view: SessionView, signal: AbortSignal): Promise<Message[]> {
      if (view.storeId !== storeId) throw new ClientError('history_identity_mismatch');
      return (await readAtCursor(view.session.id, view.snapshotCursor, async () => view, signal))
        .messages;
    },
  };
}
