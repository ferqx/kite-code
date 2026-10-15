/** Delivery ordering only: forwards and replays actual HTTP/SSE bytes, never result inventions. */
export function installOriginalDeliveryRace(mode: string) {
  const actualFetch = globalThis.fetch;
  if (!['terminal-before-receipt', 'late-events', 'deferred-sandbox'].includes(mode))
    return () => {};
  const background = new AbortController();
  let diagnosticStarted = false;
  let terminalSeen = false;
  let heldOutput = false;
  const terminalWaiters = new Set<() => void>();
  const finished = () => {
    terminalSeen = true;
    for (const release of [...terminalWaiters]) release();
    terminalWaiters.clear();
  };
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const response = await actualFetch(input, init);
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (
      mode === 'deferred-sandbox' &&
      !diagnosticStarted &&
      url.pathname === '/v1/server' &&
      response.ok
    ) {
      diagnosticStarted = true;
      // The fixture's real HostStatus source remains pending while the ordinary UI starts.
      void actualFetch(`${url.origin}/v1/diagnostics/host-status`, {
        headers: init?.headers,
        signal: background.signal,
      }).catch(() => {});
    }
    if (
      mode === 'terminal-before-receipt' &&
      init?.method === 'POST' &&
      url.pathname.endsWith('/commands') &&
      response.ok &&
      typeof init.body === 'string'
    ) {
      const request = JSON.parse(init.body);
      if (request.kind === 'run.start') {
        const received = (await response.clone().json()) as {
          id: string;
          receipt?: { runId?: string };
        };
        const until = Date.now() + 15000;
        while (Date.now() < until) {
          init.signal?.throwIfAborted();
          const command = (await actualFetch(
            `${url.origin}/v1/commands/${encodeURIComponent(received.id)}`,
            { headers: init.headers, signal: init.signal },
          ).then((reply) => reply.json())) as { receipt?: { runId?: string } };
          const runId = command.receipt?.runId;
          if (runId) {
            const run = (await actualFetch(`${url.origin}/v1/runs/${encodeURIComponent(runId)}`, {
              headers: init.headers,
              signal: init.signal,
            }).then((reply) => reply.json())) as { isActive?: boolean };
            if (run.isActive === false) break;
          }
          await Bun.sleep(25);
        }
      }
    }
    if (
      mode === 'late-events' &&
      !terminalSeen &&
      !heldOutput &&
      response.ok &&
      url.pathname.endsWith('/model-output')
    ) {
      const source = (await response.clone().json()) as {
        output?: { content?: string; reasoning?: string };
      };
      if (
        `${source.output?.content ?? ''} ${source.output?.reasoning ?? ''}`.includes(
          'LATE_EPHEMERAL_REASONING_MARKER',
        )
      ) {
        heldOutput = true;
        // Deliver an actual original Model reader response after its owning Run terminal.
        // Current SSE cursor semantics remain untouched; this is a reader-arrival race.
        await new Promise<void>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout>;
          const clear = () => {
            clearTimeout(timer);
            terminalWaiters.delete(release);
            init?.signal?.removeEventListener('abort', abort);
          };
          const release = () => {
            clear();
            resolve();
          };
          const abort = () => {
            clear();
            reject(init?.signal?.reason ?? Error('late_reader_aborted'));
          };
          timer = setTimeout(release, 15000);
          terminalWaiters.add(release);
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener('abort', abort, { once: true });
        });
      }
    }
    if (mode === 'late-events' && url.pathname === '/v1/events' && response.ok && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            return;
          }
          pending += decoder.decode(next.value, { stream: true });
          let boundary = pending.indexOf('\n\n');
          while (boundary >= 0) {
            const frame = pending.slice(0, boundary + 2);
            pending = pending.slice(boundary + 2);
            boundary = pending.indexOf('\n\n');
            const data = /^data: (.+)$/m.exec(frame)?.[1];
            if (
              data &&
              frame.includes('event: change') &&
              (JSON.parse(data) as { type?: string }).type === 'run.finished'
            )
              finished();
          }
          // Forward the exact original frame bytes and original cursor, without regression.
          controller.enqueue(next.value);
        },
        async cancel(reason) {
          finished();
          await reader.cancel(reason);
          reader.releaseLock();
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    return response;
  }) as typeof fetch;
  return () => {
    finished();
    background.abort();
    globalThis.fetch = actualFetch;
  };
}
