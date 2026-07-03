/**
 * Mock Model Fixture Server — minimal OpenAI-compatible HTTP server
 * for PTY system tests.
 *
 * The TUI subprocess connects to this server as its model provider.
 * Responses are pre-configured per test scenario and consumed sequentially.
 *
 * Uses Bun.serve() — zero additional dependencies.
 */

// Reuse the MockResponse shape from the existing mock model
export interface MockResponse {
  message?: {
    content: string;
    tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  };
  delay?: number;
  error?: string;
}

export interface MockModelServer {
  /** Base URL for OpenAI-compatible API (e.g. "http://127.0.0.1:3456/v1") */
  baseURL: string;
  /** Port the server is listening on */
  port: number;
  /** Set the response list (replaces any previous list) */
  setResponses(responses: MockResponse[]): void;
  /** How many /v1/chat/completions requests have been received */
  getRequestCount(): number;
  /** Stop the server */
  stop(): void;
}

/**
 * Create a mock OpenAI-compatible server on a random available port.
 *
 * Handles:
 *   POST /v1/chat/completions — returns mock responses sequentially
 *   GET /v1/models — returns a minimal model list
 *
 * Supports both non-streaming (application/json) and streaming
 * (text/event-stream SSE) responses based on the request's `stream` field.
 */
export function createMockModelServer(): MockModelServer {
  let responses: MockResponse[] = [];
  let callCount = 0;

  const server = Bun.serve({
    port: 0, // random available port
    async fetch(req) {
      const url = new URL(req.url);

      // ── GET /v1/models ──
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        return new Response(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'mock-model', object: 'model', owned_by: 'test' }],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }

      // ── POST /v1/chat/completions ──
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await req.json().catch(() => ({}));
        const stream = body?.stream === true;
        const idx = callCount;
        callCount++;

        // Wrap around if out of responses (defensive)
        const resp = responses[idx % responses.length || 0];
        if (!resp) {
          return new Response(
            JSON.stringify({
              choices: [
                { index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' },
              ],
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        }

        // Error injection
        if (resp.error) {
          return new Response(
            JSON.stringify({ error: { message: resp.error, type: 'server_error' } }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          );
        }

        // Delay injection (for timing-sensitive tests)
        if (resp.delay && resp.delay > 0) {
          await new Promise((r) => setTimeout(r, resp.delay));
        }

        const content = resp.message?.content ?? '';
        const toolCalls = resp.message?.tool_calls;

        if (stream) {
          // SSE streaming response
          let sseBody = '';
          const write = (data: string) => {
            sseBody += data;
          };

          if (toolCalls && toolCalls.length > 0) {
            // Send tool calls as deltas
            for (const tc of toolCalls) {
              write(
                `data: ${JSON.stringify({
                  choices: [
                    {
                      index: 0,
                      delta: {
                        role: 'assistant',
                        tool_calls: [
                          {
                            index: 0,
                            id: tc.id,
                            type: 'function',
                            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`,
              );
            }
          }

          // Content delta
          write(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: { content }, finish_reason: null }],
            })}\n\n`,
          );

          // Done
          write(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}\n\n`,
          );
          write('data: [DONE]\n\n');

          return new Response(sseBody, {
            headers: { 'content-type': 'text/event-stream' },
          });
        }

        // Non-streaming response
        const message: Record<string, unknown> = {
          role: 'assistant',
          content,
        };
        if (toolCalls) {
          message.tool_calls = toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          }));
        }

        return new Response(
          JSON.stringify({
            id: `mock-${idx}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'mock-model',
            choices: [
              {
                index: 0,
                message,
                finish_reason: 'stop',
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }

      // ── Unknown route ──
      return new Response('Not Found', { status: 404 });
    },
  });

  const port = server.port ?? 0;
  const baseURL = `http://127.0.0.1:${port}/v1`;

  return {
    baseURL,
    port,
    setResponses(r: MockResponse[]) {
      responses = r;
      callCount = 0;
    },
    getRequestCount: () => callCount,
    stop: () => server.stop(),
  };
}
