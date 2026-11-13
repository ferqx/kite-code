import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** A fixture-owned HTTP listener with an OS-assigned loopback port. */
export async function startLoopbackHttpServer(
  handle: (request: Request) => Response | Promise<Response>,
) {
  const server = createServer(async (incoming, outgoing) => {
    const disconnected = new AbortController();
    outgoing.once('close', () => {
      if (!outgoing.writableFinished) disconnected.abort();
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('loopback_address_unavailable');
      const method = incoming.method ?? 'GET';
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2)
        headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
      const request = new Request(`http://127.0.0.1:${address.port}${incoming.url ?? '/'}`, {
        method,
        headers,
        signal: disconnected.signal,
        ...(method === 'GET' || method === 'HEAD'
          ? {}
          : {
              body: Readable.toWeb(incoming) as unknown as ReadableStream,
              duplex: 'half' as const,
            }),
      });
      const response = await handle(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body)
        await pipeline(
          Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
          outgoing,
        );
      else outgoing.end();
    } catch {
      if (outgoing.headersSent) outgoing.destroy();
      else outgoing.writeHead(500).end();
    }
  });
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('loopback_address_unavailable');
  return {
    url: new URL(`http://127.0.0.1:${address.port}/`),
    async close() {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await closed;
    },
  };
}
