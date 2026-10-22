import type { ElectronApplication } from 'playwright';

export type NativeAnomalyNetworkEntry = {
  method: string;
  path: string;
  commandId?: string;
  kind?: string;
  content?: string;
};
export type NativeAnomalyNetworkFacts = {
  servicePort?: number;
  offline: boolean;
  destroyedSockets: number;
  offlineAttempts: number;
  lostReceipts: { commandId: string; responseStatus: number; receivedBytes: number }[];
  requests: NativeAnomalyNetworkEntry[];
};

/** External driver injection only; no renderer diagnostic surface or application switch. */
export async function installNativeAnomalyNetwork(app: ElectronApplication) {
  await app.evaluate(() => {
    const root = globalThis as typeof globalThis & {
      __nativeAnomalyNetwork?: {
        facts: NativeAnomalyNetworkFacts;
        loseMarker?: string;
      };
    };
    if (root.__nativeAnomalyNetwork) throw Error('anomaly_network_already_installed');
    const original = globalThis.fetch;
    const http = process.getBuiltinModule('node:http') as typeof import('node:http');
    const state = {
      facts: {
        offline: false,
        destroyedSockets: 0,
        offlineAttempts: 0,
        lostReceipts: [],
        requests: [],
      } as NativeAnomalyNetworkFacts,
      loseMarker: undefined as string | undefined,
    };
    root.__nativeAnomalyNetwork = state;
    const wrapped = async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      // Read a clone: never consume the caller's Request/body before forwarding it.
      const request = new Request(input, init);
      const url = new URL(request.url);
      const service = url.hostname === '127.0.0.1' && url.pathname.startsWith('/v1/');
      if (!service) return original(input, init);
      const port = Number(url.port || '80');
      if (state.facts.servicePort && state.facts.servicePort !== port)
        throw Error('anomaly_service_port_changed');
      state.facts.servicePort = port;
      const entry: NativeAnomalyNetworkEntry = {
        method: request.method,
        path: url.pathname,
      };
      let body: string | undefined;
      if (!['GET', 'HEAD'].includes(request.method)) {
        body = await request.clone().text();
        try {
          const value = JSON.parse(body);
          if (typeof value.commandId === 'string') entry.commandId = value.commandId;
          if (typeof value.kind === 'string') entry.kind = value.kind;
          if (typeof value.content === 'string') entry.content = value.content;
        } catch {}
      }
      state.facts.requests.push(entry);
      const lose =
        !state.facts.offline &&
        state.loseMarker !== undefined &&
        entry.content?.replaceAll('\\_', '_') === state.loseMarker &&
        entry.method === 'POST' &&
        /^\/v1\/sessions\/[^/]+\/commands$/.test(entry.path);
      if (!state.facts.offline && !lose) return original(input, init);
      request.signal.throwIfAborted();
      if (lose) {
        if (!entry.commandId) throw Error('anomaly_lost_receipt_command_missing');
        state.loseMarker = undefined;
      } else state.facts.offlineAttempts++;
      const offline = !lose;
      return new Promise<Response>((resolve, reject) => {
        const headers = Object.fromEntries(request.headers.entries());
        const wire = http.request(url, { method: request.method, headers });
        const abort = () => wire.destroy(Error('anomaly_request_aborted'));
        const cleanup = () => request.signal.removeEventListener('abort', abort);
        request.signal.addEventListener('abort', abort, { once: true });
        wire.on('error', (error) => {
          cleanup();
          reject(error);
        });
        wire.setTimeout(10000, () => wire.destroy(Error('anomaly_transport_timeout')));
        if (offline) {
          // Establish a real TCP connection, then kill it before flushing HTTP headers/body.
          // In particular, a mutation attempted while offline cannot reach Service admission.
          wire.on('socket', (socket) => {
            const disconnect = () => {
              state.facts.destroyedSockets++;
              wire.destroy(Error('anomaly_service_offline'));
            };
            if (socket.connecting) socket.once('connect', disconnect);
            else disconnect();
          });
          return;
        }
        wire.once('response', (response) => {
          const socket = response.socket;
          let lost = false;
          const fail = (controller: ReadableStreamDefaultController<Uint8Array>) => {
            if (lost) return;
            lost = true;
            cleanup();
            socket.destroy();
            state.facts.destroyedSockets++;
            controller.error(Error('anomaly_original_receipt_lost'));
          };
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              response.once('data', (chunk: Buffer) => {
                state.facts.lostReceipts.push({
                  commandId: entry.commandId!,
                  responseStatus: response.statusCode!,
                  receivedBytes: chunk.byteLength,
                });
                fail(controller);
              });
              response.once('error', () => fail(controller));
              response.once('end', () => fail(controller));
            },
            cancel() {
              cleanup();
              socket.destroy();
            },
          });
          resolve(
            new Response(stream, {
              status: response.statusCode,
              headers: { 'content-type': String(response.headers['content-type'] ?? '') },
            }),
          );
        });
        // This is the only physical POST. The normal fetch was never invoked for it.
        wire.end(body);
      });
    };
    globalThis.fetch = Object.assign(wrapped, { preconnect: original.preconnect });
  });
}

export async function setNativeAnomalyOffline(app: ElectronApplication, offline: boolean) {
  return app.evaluate((_, offline) => {
    const state = (
      globalThis as typeof globalThis & {
        __nativeAnomalyNetwork?: { facts: NativeAnomalyNetworkFacts };
      }
    ).__nativeAnomalyNetwork;
    if (!state) throw Error('anomaly_network_not_installed');
    const port = state.facts.servicePort;
    if (!port) throw Error('anomaly_service_port_not_observed');
    state.facts.offline = offline;
    if (offline) {
      const handles = (
        process as typeof process & {
          _getActiveHandles(): unknown[];
        }
      )._getActiveHandles();
      const net = process.getBuiltinModule('node:net') as typeof import('node:net');
      for (const handle of handles) {
        if (!(handle instanceof net.Socket) || handle.destroyed || handle.remotePort !== port)
          continue;
        if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(handle.remoteAddress ?? '')) continue;
        state.facts.destroyedSockets++;
        handle.destroy();
      }
    }
    return state.facts.destroyedSockets;
  }, offline);
}

export async function loseNativeAnomalyReceipt(app: ElectronApplication, marker: string) {
  await app.evaluate((_, marker) => {
    const state = (
      globalThis as typeof globalThis & {
        __nativeAnomalyNetwork?: { loseMarker?: string };
      }
    ).__nativeAnomalyNetwork;
    if (!state) throw Error('anomaly_network_not_installed');
    if (state.loseMarker !== undefined) throw Error('anomaly_receipt_already_armed');
    state.loseMarker = marker;
  }, marker);
}

export async function readNativeAnomalyNetwork(
  app: ElectronApplication,
): Promise<NativeAnomalyNetworkFacts> {
  return app.evaluate(() => {
    const state = (
      globalThis as typeof globalThis & {
        __nativeAnomalyNetwork?: { facts: NativeAnomalyNetworkFacts };
      }
    ).__nativeAnomalyNetwork;
    if (!state) throw Error('anomaly_network_not_installed');
    return state.facts;
  });
}
