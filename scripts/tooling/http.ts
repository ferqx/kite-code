import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer, type ServerOptions } from 'node:https';
import type { Socket } from 'node:net';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface FixtureServer {
  readonly url: URL;
  readonly hostname: string;
  readonly port: number;
  stop(force?: boolean): Promise<void>;
  ref(): void;
  unref(): void;
}
interface FixtureServerOptions {
  hostname?: string;
  port?: number;
  idleTimeout?: number;
  maxRequestBodySize?: number;
  tls?: ServerOptions;
  fetch(request: Request, server: FixtureServer): Response | Promise<Response>;
  error?(error: Error): Response | Promise<Response>;
}
class BodyLimitError extends Error {}
function body(input: IncomingMessage, max: number) {
  if (!input.headers['content-length'] && !input.headers['transfer-encoding']) return undefined;
  if (input.headers['content-length'] === '0') return undefined;
  if (Number(input.headers['content-length']) > max) throw new BodyLimitError();
  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > max) callback(new BodyLimitError());
      else callback(null, chunk);
    },
  });
  input.once('error', (error) => limit.destroy(error));
  // Keep a stream error observable by the Request consumer without an unhandled event.
  limit.on('error', () => {});
  input.pipe(limit);
  return Readable.toWeb(limit) as unknown as ReadableStream<Uint8Array>;
}
async function send(target: ServerResponse, response: Response, method: string | undefined) {
  target.statusCode = response.status;
  if (response.statusText) target.statusMessage = response.statusText;
  for (const [name, value] of response.headers)
    if (name !== 'set-cookie') target.setHeader(name, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) target.setHeader('set-cookie', cookies);
  if (method === 'HEAD' || !response.body) {
    await response.body?.cancel();
    target.end();
  } else {
    await pipeline(
      Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream),
      target,
    );
  }
}

/** Fixture HTTP(S), with a ready URL, streaming body, abort and confirmed socket close. */
export async function serve(options: FixtureServerOptions): Promise<FixtureServer> {
  const hostname = options.hostname ?? '127.0.0.1';
  const maximum = options.maxRequestBodySize ?? 128 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw Error('fixture_http_body_limit_invalid');
  const sockets = new Set<Socket>();
  const server = options.tls ? createHttpsServer(options.tls) : createHttpServer();
  if (options.idleTimeout !== undefined) server.setTimeout(options.idleTimeout * 1000);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('request', (incoming, outgoing) => {
    const controller = new AbortController();
    outgoing.once('close', () => {
      if (!outgoing.writableFinished) controller.abort();
    });
    const handle = async () => {
      const headers = new Headers();
      for (let index = 0; index < incoming.rawHeaders.length; index += 2)
        headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
      const method = incoming.method ?? 'GET';
      const request = new Request(new URL(incoming.url ?? '/', fixture.url), {
        method,
        headers,
        signal: controller.signal,
        ...(method === 'GET' || method === 'HEAD'
          ? {}
          : { body: body(incoming, maximum), duplex: 'half' as const }),
      });
      await send(outgoing, await options.fetch(request, fixture), method);
    };
    void handle().catch(async (error: unknown) => {
      if (controller.signal.aborted || outgoing.destroyed) return;
      if (outgoing.headersSent) {
        outgoing.destroy();
        return;
      }
      try {
        const response =
          error instanceof BodyLimitError
            ? new Response('Request body too large', { status: 413 })
            : await (options.error?.(error instanceof Error ? error : Error(String(error))) ??
                new Response('Internal Server Error', { status: 500 }));
        await send(outgoing, response, incoming.method);
      } catch {
        outgoing.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, hostname, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('fixture_http_address_invalid');
  const literal = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  let closing: Promise<void> | undefined;
  const fixture: FixtureServer = {
    hostname,
    port: address.port,
    url: new URL(`${options.tls ? 'https' : 'http'}://${literal}:${address.port}/`),
    stop(force) {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (force) for (const socket of sockets) socket.destroy();
      return closing;
    },
    ref: () => {
      server.ref();
    },
    unref: () => {
      server.unref();
    },
  };
  return fixture;
}
