/**
 * Mock Model Fixture Server — minimal OpenAI-compatible HTTP server
 * for PTY system tests.
 *
 * The TUI subprocess connects to this server as its model provider.
 * Responses are pre-configured per test scenario and consumed sequentially.
 *
 * Uses Bun.serve() — zero additional dependencies.
 */

import { startTestHttpServer } from '../../helpers/test-http-server';

// Reuse the MockResponse shape from the existing mock model
export interface MockResponse {
  message?: {
    content?: string;
    /** Optional SSE chunks; joined for non-streaming responses. */
    content_chunks?: string[];
    /** 推理/思考内容（DeepSeek reasoning_content），生成 reason block */
    reasoning_content?: string;
    /** Optional DeepSeek reasoning SSE chunks; joined for non-streaming responses. */
    reasoning_chunks?: string[];
    tool_calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
    /** 无效工具调用：args 为原始 JSON 字符串（可包含格式错误），模拟模型输出非法 JSON 的场景 */
    invalid_tool_calls?: Array<{ id: string; name: string; args: string }>;
  };
  delay?: number;
  /** Delay between SSE frames, used to assert progressive rendering. */
  chunk_delay?: number;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  /** Inject an invalid JSON SSE data frame. */
  malformed_sse?: boolean;
  /** Emit a provider connection error after content frames, before the terminal frame. */
  disconnect_after_content?: boolean;
  error?: string;
}

export interface MockChatRequest {
  body: Record<string, unknown>;
  messages: Array<{ role?: string; content?: unknown }>;
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
  /** Full request bodies received by /v1/chat/completions */
  getRequests(): MockChatRequest[];
  /** Whether a chat request at or after since includes text in any message content */
  hasRequestMessage(text: string, since?: number): boolean;
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
  let requests: MockChatRequest[] = [];

  const server = startTestHttpServer({
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
        const bodyRecord =
          body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
        const messages = Array.isArray(bodyRecord.messages)
          ? (bodyRecord.messages as Array<{ role?: string; content?: unknown }>)
          : [];
        requests.push({ body: bodyRecord, messages });
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

        const content = resp.message?.content ?? resp.message?.content_chunks?.join('') ?? '';
        const reasoningContent =
          resp.message?.reasoning_content ?? resp.message?.reasoning_chunks?.join('') ?? '';
        const toolCalls = resp.message?.tool_calls;
        const invalidToolCalls = resp.message?.invalid_tool_calls;

        if (stream) {
          // SSE streaming response
          const sseFrames: string[] = [];
          const write = (data: string) => {
            sseFrames.push(data);
          };
          if (resp.malformed_sse) write('data: {not-json}\n\n');

          // Send reasoning_content delta (DeepSeek-style thinking)
          for (const reasoningChunk of resp.message?.reasoning_chunks ?? [reasoningContent]) {
            if (!reasoningChunk) continue;
            write(
              `data: ${JSON.stringify({
                choices: [
                  {
                    index: 0,
                    delta: { role: 'assistant', reasoning_content: reasoningChunk },
                    finish_reason: null,
                  },
                ],
              })}\n\n`,
            );
          }

          if (toolCalls && toolCalls.length > 0) {
            // Send tool calls as deltas
            for (const [toolIndex, tc] of toolCalls.entries()) {
              write(
                `data: ${JSON.stringify({
                  choices: [
                    {
                      index: 0,
                      delta: {
                        role: 'assistant',
                        tool_calls: [
                          {
                            index: toolIndex,
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

          // Send invalid tool calls with raw (possibly malformed) args
          if (invalidToolCalls && invalidToolCalls.length > 0) {
            for (const [invalidIndex, tc] of invalidToolCalls.entries()) {
              write(
                `data: ${JSON.stringify({
                  choices: [
                    {
                      index: 0,
                      delta: {
                        role: 'assistant',
                        tool_calls: [
                          {
                            index: (toolCalls?.length ?? 0) + invalidIndex,
                            id: tc.id,
                            type: 'function',
                            function: { name: tc.name, arguments: tc.args },
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
          for (const contentChunk of resp.message?.content_chunks ?? [content]) {
            write(
              `data: ${JSON.stringify({
                choices: [{ index: 0, delta: { content: contentChunk }, finish_reason: null }],
              })}\n\n`,
            );
          }

          if (resp.disconnect_after_content) {
            write(
              `data: ${JSON.stringify({
                error: {
                  message: 'socket ECONNRESET: model stream disconnected',
                  type: 'server_error',
                },
              })}\n\n`,
            );
          } else {
            // Done
            write(
              `data: ${JSON.stringify({
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                ...(resp.usage ? { usage: resp.usage } : {}),
              })}\n\n`,
            );
            write('data: [DONE]\n\n');
          }

          const body =
            resp.chunk_delay && resp.chunk_delay > 0
              ? new ReadableStream<Uint8Array>({
                  async start(controller) {
                    const encoder = new TextEncoder();
                    for (const frame of sseFrames) {
                      controller.enqueue(encoder.encode(frame));
                      await new Promise((resolve) => setTimeout(resolve, resp.chunk_delay));
                    }
                    controller.close();
                  },
                })
              : sseFrames.join('');
          return new Response(body, {
            headers: { 'content-type': 'text/event-stream' },
          });
        }

        // Non-streaming response
        const message: Record<string, unknown> = {
          role: 'assistant',
          content,
        };
        if (reasoningContent) message.reasoning_content = reasoningContent;
        if (toolCalls || invalidToolCalls) {
          const allToolCalls: Array<Record<string, unknown>> = [];
          if (toolCalls) {
            for (const tc of toolCalls) {
              allToolCalls.push({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: JSON.stringify(tc.args) },
              });
            }
          }
          if (invalidToolCalls) {
            for (const tc of invalidToolCalls) {
              // Send raw args string directly (may be malformed JSON)
              allToolCalls.push({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: tc.args },
              });
            }
          }
          message.tool_calls = allToolCalls;
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
      requests = [];
    },
    getRequestCount: () => callCount,
    getRequests: () => [...requests],
    hasRequestMessage: (text: string, since = 0) =>
      requests
        .slice(since)
        .some((request) =>
          request.messages.some((message) => messageContentIncludes(message.content, text)),
        ),
    stop: () => server.stop(),
  };
}

function messageContentIncludes(content: unknown, text: string): boolean {
  if (typeof content === 'string') return content.includes(text);
  if (Array.isArray(content)) {
    return content.some((part) => {
      if (!part || typeof part !== 'object') return false;
      const record = part as Record<string, unknown>;
      return typeof record.text === 'string' && record.text.includes(text);
    });
  }
  return false;
}
