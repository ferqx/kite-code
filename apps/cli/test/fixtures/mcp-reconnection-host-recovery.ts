import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import type { TuiMcpReconnectionIntent } from '@kite-ai/ui/tui';
import { decodeMcpReconnectionFact } from '../../host/tui-mcp-reconnection';
import { reconnectionHostFixture, until } from './mcp-reconnection-host';

/** Socket relay forwards the original bytes to the actual Service, then destroys its reply. */
export async function reconnectionRecoveryFixture(ask = false) {
  const f = await reconnectionHostFixture(ask);
  const actualFetch = globalThis.fetch;
  const sockets = new Set<Socket>();
  let forwarding = '',
    drop: 'POST' | 'GET' | undefined;
  let original: TuiMcpReconnectionIntent | undefined;
  let posts = 0,
    gets = 0,
    physicalDrops = 0;
  let relayFailure: unknown;
  const relay = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const bytes of request) chunks.push(Buffer.from(bytes));
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers))
        if (value && !['host', 'connection', 'content-length'].includes(key))
          headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const upstream = await actualFetch(forwarding, {
        method: request.method,
        headers,
        ...(request.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
      });
      if (!upstream.ok) throw Error('owned_reconnection_relay_upstream_rejected');
      const command = (await upstream.json()) as {
        id?: string;
        receipt?: { executionId?: string };
      };
      if (command.id !== original?.request.commandId)
        throw Error('owned_reconnection_relay_identity');
      if (request.method === 'POST') {
        await until(async () => {
          const actual = await f.client.getCommand(original!.request.commandId);
          const receipt = actual.receipt;
          const executionId =
            receipt && typeof receipt === 'object' && !Array.isArray(receipt)
              ? (receipt as Record<string, unknown>).executionId
              : undefined;
          if (typeof executionId !== 'string') return undefined;
          const fact = decodeMcpReconnectionFact(
            await f.client.queryExtension('s', 'builtin.mcp', 'mcp.reconnection', { executionId }),
          );
          return fact.phase === 'ready' ? fact : undefined;
        });
      }
      physicalDrops++;
      response.socket!.destroy();
    } catch (error) {
      relayFailure = error;
      response.destroy();
    }
  });
  relay.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      relay.once('error', reject);
      relay.listen(0, '127.0.0.1', resolve);
    });
    const address = relay.address();
    if (!address || typeof address === 'string')
      throw Error('owned_reconnection_relay_unavailable');
    const relayOrigin = `http://127.0.0.1:${address.port}`;
    const intercepted = Object.assign(async (...args: Parameters<typeof fetch>) => {
      const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]));
      const method = args[1]?.method ?? (args[0] instanceof Request ? args[0].method : 'GET');
      const body =
        method === 'POST' && typeof args[1]?.body === 'string'
          ? (JSON.parse(args[1].body) as { commandId?: string })
          : undefined;
      const targetPost =
        method === 'POST' &&
        original !== undefined &&
        body?.commandId === original.request.commandId;
      const targetGet =
        method === 'GET' && url.pathname === `/v1/commands/${original?.request.commandId}`;
      if (targetPost) posts++;
      if (targetGet) gets++;
      if (drop && ((drop === 'POST' && targetPost) || (drop === 'GET' && targetGet))) {
        drop = undefined;
        forwarding = url.href;
        return actualFetch(`${relayOrigin}${url.pathname}${url.search}`, args[1]);
      }
      return actualFetch(...args);
    }, actualFetch);
    globalThis.fetch = intercepted;
    return {
      f,
      lose(intent: TuiMcpReconnectionIntent, method: 'POST' | 'GET') {
        original = intent;
        drop = method;
      },
      counts: () => ({ posts, gets, physicalDrops, relayFailed: relayFailure !== undefined }),
      async close() {
        let failure: unknown;
        if (globalThis.fetch === intercepted) globalThis.fetch = actualFetch;
        else failure = Error('owned_relay_fetch_cleanup_unconfirmed');
        const closed = new Promise<void>((resolve) => relay.close(() => resolve()));
        for (const socket of sockets) socket.destroy();
        await closed;
        try {
          await f.close();
        } catch (error) {
          failure ??= error;
        }
        if (failure) throw failure;
      },
    };
  } catch (error) {
    relay.close();
    for (const socket of sockets) socket.destroy();
    try {
      await f.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'owned_relay_setup_cleanup');
    }
    throw error;
  }
}
