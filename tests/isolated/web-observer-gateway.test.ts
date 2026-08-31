import { afterEach, describe, expect, test } from 'bun:test';
import type { RuntimeClientEvent } from '@kite-ai/runtime-contract';
import {
  createWebGatewayCarrier,
  type WebGatewayCarrier,
} from '../../apps/kite-service/src/web-gateway';
import {
  createWebObserverCore,
  type WebObserverLiveInput,
} from '../../apps/kite-service/src/web-observer';
import {
  createWebObserverTransport,
  type WebObserverWebSocket,
} from '../../apps/kite-web/src/transport/client';

const carriers: WebGatewayCarrier[] = [];
afterEach(async () => {
  await Promise.allSettled(carriers.splice(0).map((carrier) => carrier.close()));
});

const historyEvent: RuntimeClientEvent = {
  type: 'user.message',
  messageId: 'message-1',
  kind: 'task',
  text: 'Read-only history.',
};

const liveEvent: RuntimeClientEvent = {
  type: 'model.requested',
  requestId: 'request-1',
};

describe('real Web transport → Gateway → Observer composition', () => {
  test('bootstraps a tab without credentials, reads path-free data, streams live, and only releases Observer state', async () => {
    let tabDisconnects = 0;
    const carrier = createWebGatewayCarrier({
      staticAssetRoot: '/private/not-browser-visible',
      instanceId: 'gateway-combination-1',
      readAsset: async () => new Response('<!doctype html><title>Kite</title>'),
      createObserver: (binding) => {
        const core = createWebObserverCore({
          gatewayInstanceId: 'gateway-combination-1',
          contractRevision: 'contract-1',
          createTabBinding: () => binding,
          directory: {
            list: () => [
              {
                workspaceId: 'workspace-1',
                label: 'Workspace',
                sessions: [
                  {
                    sessionId: 'session-1',
                    displayName: 'Running Observer session',
                    updatedAt: 1,
                    lastSequence: 2,
                    status: 'running',
                  },
                ],
              },
            ],
          },
          history: {
            loadSession: async () => ({
              sessionId: 'session-1',
              lastSequence: 1,
              records: [{ sequence: 1, events: [historyEvent] }],
            }),
          },
          live: {
            subscribe: ({ signal }) => liveUntilAbort(signal),
          },
        });
        return {
          ...core,
          disconnect: async (request) => {
            if (binding.tabHandle !== 'bootstrap') tabDisconnects += 1;
            return core.disconnect(request);
          },
        };
      },
    });
    carriers.push(carrier);

    const rawFrames: unknown[] = [];
    const origin = new URL(carrier.origin);
    const transport = createWebObserverTransport({
      location: {
        host: origin.host,
        origin: carrier.origin,
        protocol: origin.protocol,
      },
      fetch: (input, init) => browserFetch(carrier.origin, input, init),
      webSocketFactory: (url) => browserSocket(url, carrier.origin, rawFrames),
    });

    const connection = await transport.connect();
    expect(connection.tabHandle).toMatch(/^[A-Za-z0-9_-]{32}$/u);

    const directory = await transport.listDirectory();
    expect(directory.workspaces[0]?.sessions[0]?.sessionId).toBe('session-1');
    expect(JSON.stringify(directory)).not.toContain('/private/');
    const history = await transport.loadHistory('session-1');
    expect(history.messages[0]?.blocks).toEqual([{ kind: 'text', text: 'Read-only history.' }]);

    let resolveLive!: (value: { readonly sequence: number; readonly type: string }) => void;
    const received = new Promise<{ readonly sequence: number; readonly type: string }>(
      (resolvePromise) => {
        resolveLive = resolvePromise;
      },
    );
    const subscription = await transport.subscribe({
      sessionId: 'session-1',
      afterSequence: history.observedLastSequence,
      onEvent: (event) =>
        resolveLive({ sequence: event.type === 'message' ? event.sequence : -1, type: event.type }),
    });
    await Bun.sleep(50);
    expect(rawFrames).toHaveLength(3);
    await expect(withDeadline(received)).resolves.toEqual({ sequence: 2, type: 'message' });
    await subscription.unsubscribe();
    await transport.disconnect();
    expect(tabDisconnects).toBe(1);
  });
});

function liveUntilAbort(signal: AbortSignal): AsyncIterable<WebObserverLiveInput> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { sessionId: 'session-1', sequence: 2, event: liveEvent };
      await new Promise<void>((resolvePromise) => {
        if (signal.aborted) resolvePromise();
        else signal.addEventListener('abort', () => resolvePromise(), { once: true });
      });
    },
  };
}

async function browserFetch(
  origin: string,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('origin', origin);
  headers.set('sec-fetch-site', 'same-origin');
  headers.set('sec-fetch-mode', 'cors');
  return fetch(new URL(String(input), origin), { ...init, headers });
}

function browserSocket(url: string, origin: string, frames: unknown[]): WebObserverWebSocket {
  const socket = new WebSocket(url, {
    headers: {
      Origin: origin,
      'Sec-Fetch-Mode': 'websocket',
      'Sec-Fetch-Site': 'same-origin',
    },
  } as unknown as string[]);
  socket.addEventListener('message', (event) => {
    try {
      frames.push(JSON.parse(String(event.data)) as unknown);
    } catch {
      frames.push('invalid');
    }
  });
  return socket as unknown as WebObserverWebSocket;
}

async function withDeadline<Value>(value: Promise<Value>): Promise<Value> {
  return Promise.race([
    value,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Web composition deadline exceeded.')), 1_000),
    ),
  ]);
}
