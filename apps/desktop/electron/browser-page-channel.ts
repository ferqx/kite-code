import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { type NativeBrowserPageHost, serializeBrowserPageFailure } from './browser-page-host';

/** Private paired-host channel. The renderer never receives this endpoint or credential. */
export async function listenBrowserPageHost(host: NativeBrowserPageHost) {
  const token = randomUUID() + randomUUID();
  const server = createServer(async (request, response) => {
    const authorization = request.headers.authorization ?? '';
    const expected = `Bearer ${token}`;
    if (
      request.headers.origin ||
      request.method !== 'POST' ||
      request.url !== '/kite-page' ||
      Buffer.byteLength(authorization) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))
    ) {
      response.writeHead(403).end();
      return;
    }
    let bytes = 0;
    const chunks: Buffer[] = [];
    const abort = new AbortController();
    const disconnected = () => {
      if (!response.writableEnded) abort.abort();
    };
    request.once('aborted', disconnected);
    response.once('close', disconnected);
    let input: unknown;
    try {
      for await (const part of request) {
        const chunk = Buffer.from(part);
        bytes += chunk.length;
        if (bytes > 256 * 1024) throw Error('page_request_limit');
        chunks.push(chunk);
      }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const body = await host.requestSerialized(input, abort.signal);
      if (response.destroyed || response.writableEnded) return;
      response
        .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(body);
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      const failure = serializeBrowserPageFailure(error, input);
      const message =
        error instanceof Error &&
        /^(browser_page_|browser_session_page_|browser_capture_|page_request_)[a-z_]+$/.test(
          error.message,
        )
          ? error.message
          : 'browser_page_request_failed';
      response
        .writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify({ ok: false, error: message, ...(failure ? { failure } : {}) }));
    } finally {
      request.off('aborted', disconnected);
      response.off('close', disconnected);
    }
  });
  server.maxConnections = 16;
  server.requestTimeout = 15000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('browser_page_channel_unavailable');
  return {
    startup: Object.freeze({ endpoint: `http://127.0.0.1:${address.port}/kite-page`, token }),
    async close() {
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
