import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { WebSocketServer } from 'ws';

const loopback = '127.0.0.1';
// Give ordinary clients time to read a rejection while still finishing a buffered
// upload. Discard a bounded amount without admitting or retaining the body.
const rejectedBodyDrainBytes = 2 * 1024 * 1024;
const rejectedBodyDrainMs = 1000;

export interface LoopbackServer {
  readonly port: number;
  /** Retain one bounded control response through the listener's final shutdown. */
  flushResponse(request: Request): void;
  stop(force?: boolean): Promise<void>;
}

type LoopbackHandler = (request: Request, address?: string) => Response | Promise<Response>;

export async function serveLoopback(
  fetch: LoopbackHandler,
  attach?: (server: Server) => void,
): Promise<LoopbackServer> {
  const responses = new WeakMap<Request, ServerResponse>();
  const server = createServer(
    getRequestListener(
      (request, { incoming, outgoing }) => {
        // The Node adapter exposes an empty stream for bodyless POST/DELETE.
        // Keep the distinction used by the browser's same-origin session endpoint.
        if (
          !request.headers.has('transfer-encoding') &&
          [null, '0'].includes(request.headers.get('content-length')) &&
          request.body
        )
          request = new Request(request.url, {
            method: request.method,
            headers: request.headers,
            signal: request.signal,
          });
        const response = outgoing as ServerResponse;
        responses.set(request, response);
        response.once('finish', () => {
          if (incoming.complete || incoming.destroyed) return;
          const body = request.body;
          if (!body || body.locked) {
            incoming.destroy();
            return;
          }
          // Pull through the existing stream, whose backpressure controls IncomingMessage.
          const reader = body.getReader();
          const deadline = setTimeout(() => incoming.destroy(), rejectedBodyDrainMs);
          deadline.unref();
          void (async () => {
            try {
              let drained = 0;
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                drained += value.byteLength;
                if (drained > rejectedBodyDrainBytes) {
                  incoming.destroy();
                  break;
                }
              }
            } catch {
              incoming.destroy();
            } finally {
              clearTimeout(deadline);
              reader.releaseLock();
            }
          })();
        });
        return fetch(request, incoming.socket.remoteAddress);
      },
      // The wrapper's default body cleanup detaches stream cancellation from
      // IncomingMessage. Use the native stream so lifecycle seal can cancel it.
      { overrideGlobalObjects: false, autoCleanupIncoming: false },
    ),
  );
  const sockets = new Set<Socket>();
  const flushing = new Map<Socket, Set<ServerResponse>>();
  let closing: Promise<void> | undefined;
  let forcing = false;
  server.on('request', (_request, response) => {
    response.once('finish', () => {
      // A request completed during close() can miss the initial idle sweep.
      if (closing) server.closeIdleConnections();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  attach?.(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, loopback, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('loopback_listener_unavailable');
  return {
    port: address.port,
    flushResponse(request) {
      const response = responses.get(request);
      const socket = response?.socket;
      if (!response || !socket || response.writableFinished || socket.destroyed) return;
      let pending = flushing.get(socket);
      if (!pending) {
        pending = new Set();
        flushing.set(socket, pending);
      }
      if (pending.has(response)) return;
      pending.add(response);
      const release = () => {
        clearTimeout(deadline);
        response.off('finish', release);
        response.off('close', release);
        pending.delete(response);
        if (!pending.size) {
          flushing.delete(socket);
          if (forcing) socket.destroySoon();
        }
      };
      const deadline = setTimeout(() => {
        release();
        if (forcing) socket.destroy();
      }, 1000);
      deadline.unref();
      response.once('finish', release);
      response.once('close', release);
    },
    stop(force) {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (force) {
        forcing = true;
        for (const socket of sockets) if (!flushing.has(socket)) socket.destroy();
      }
      return closing;
    },
  };
}

export interface LoopbackWebSocket {
  readonly readyState: number;
  send(data: string): unknown;
  close(): unknown;
}

export async function serveLoopbackWebSocket(options: {
  admit(url: URL, hasOrigin: boolean): boolean;
  websocket: {
    maxPayloadLength: number;
    open(socket: LoopbackWebSocket): void;
    message(socket: LoopbackWebSocket, value: string): Promise<void>;
    close(socket: LoopbackWebSocket): void;
  };
}): Promise<LoopbackServer> {
  const handlers = options.websocket;
  const websocket = new WebSocketServer({ noServer: true, maxPayload: handlers.maxPayloadLength });
  return serveLoopback(
    (request) =>
      new Response('denied', {
        status: options.admit(new URL(request.url), request.headers.has('origin')) ? 400 : 403,
      }),
    (server) => {
      server.on('upgrade', (request, connection, head) => {
        let admitted = false;
        try {
          admitted = options.admit(
            new URL(request.url ?? '/', `http://${loopback}`),
            request.headers.origin !== undefined,
          );
        } catch {
          connection.destroy();
          return;
        }
        if (!admitted) {
          connection.once('error', () => connection.destroy());
          connection.end(
            'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
          );
          return;
        }
        websocket.handleUpgrade(request, connection, head, (socket) => {
          socket.on('error', () => socket.terminate());
          socket.on('close', () => handlers.close(socket));
          socket.on('message', (value) => {
            void handlers.message(socket, String(value)).catch(() => socket.terminate());
          });
          handlers.open(socket);
        });
      });
    },
  );
}
