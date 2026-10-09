// Test-owned transport instrumentation; every response remains from the actual Service.
const original = globalThis.fetch;
const network = {
  events: [] as { after: string; status: number }[],
  ready: 0,
  changes: 0,
  posts: [] as string[],
  messages: [] as {
    session: string;
    after: string;
    upper: string;
    limit: string;
    startedAt: number;
    responseMs?: number;
    status?: number;
  }[],
  pause: false,
  release: undefined as (() => void) | undefined,
  abort: undefined as AbortController | undefined,
  holdHistory: false,
  held: false,
  releaseHistory: undefined as (() => void) | undefined,
};
Object.assign(globalThis, { __nativeHistoryNetwork: network });
const instrumented: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async (
  input,
  init,
) => {
  const request = new Request(input, init),
    url = new URL(request.url);
  if (request.method === 'POST') network.posts.push(url.pathname);
  if (url.pathname.endsWith('/messages')) {
    const reading = {
      session: url.pathname.split('/').at(-2)!,
      after: url.searchParams.get('afterSeq') ?? '0',
      upper: url.searchParams.get('upperSeq') ?? '',
      limit: url.searchParams.get('limit') ?? '',
      startedAt: Date.now(),
      responseMs: undefined as number | undefined,
      status: undefined as number | undefined,
    };
    network.messages.push(reading);
    const response = await original(input, init);
    reading.responseMs = Date.now() - reading.startedAt;
    reading.status = response.status;
    if (
      network.holdHistory &&
      url.pathname.endsWith('/sessions/s/messages') &&
      Number(url.searchParams.get('afterSeq')) >= 200
    ) {
      network.holdHistory = false;
      network.held = true;
      await new Promise<void>((resolve) => {
        network.releaseHistory = resolve;
      });
    }
    return response;
  }
  if (url.pathname !== '/v1/events') return original(input, init);
  if (network.pause)
    await new Promise<void>((resolve) => {
      network.release = resolve;
    });
  const controller = new AbortController();
  network.abort = controller;
  const abort = () => controller.abort(request.signal.reason);
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  const response = await original(request, { signal: controller.signal });
  network.events.push({ after: url.searchParams.get('after')!, status: response.status });
  if (!response.ok || !response.body) return response;
  const decoder = new TextDecoder();
  let pending = '';
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, target) {
        pending += decoder.decode(chunk, { stream: true });
        let boundary = pending.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          if (frame.includes('event: ready\n')) network.ready++;
          if (frame.includes('event: change\n')) network.changes++;
          boundary = pending.indexOf('\n\n');
        }
        target.enqueue(chunk);
      },
    }),
  );
  return new Response(body, { status: response.status, headers: response.headers });
};

Object.assign(globalThis, { fetch: instrumented });
