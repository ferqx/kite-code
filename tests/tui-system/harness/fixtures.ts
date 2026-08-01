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
  /**
   * Tool calls remain pending until a matching tool-result request arrives.
   * Mark only intentionally aborted turns (deny/Escape) as `aborted`;
   * otherwise teardown fails closed.
   */
  toolContinuation?: 'required' | 'aborted';
  /** Preconditions for the request that is about to consume this response. */
  expectedRequest?: {
    toolResults?: Array<{
      toolCallId: string;
      contentIncludes?: string[];
      contentExcludes?: string[];
    }>;
  };
}

export interface MockChatRequest {
  body: Record<string, unknown>;
  messages: Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
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
  /** Whether the first request after since contains this exact user message. */
  hasRequestMessage(text: string, since: number): boolean;
  /** Configure the local /v1/models response used by first-run scenarios. */
  setModelsResponse(response: { status?: number; delay?: number; models?: string[] }): void;
  /** GET URLs received by the local model-discovery fixture. */
  getModelRequests(): string[];
  /** Fail when requests exceeded the queue or configured responses remain unused. */
  assertComplete(): void;
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
  let responseCursor = 0;
  let callCount = 0;
  const requests: MockChatRequest[] = [];
  const modelRequests: string[] = [];
  const unexpectedRequests: number[] = [];
  const contractViolations: string[] = [];
  const pendingToolContinuations = new Map<string, number>();
  let modelsResponse: { status: number; delay: number; models: string[] } = {
    status: 200,
    delay: 0,
    models: ['mock-model'],
  };

  const server = startTestHttpServer({
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'GET') modelRequests.push(url.href);

      // ── GET /v1/models ──
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const response = { ...modelsResponse, models: [...modelsResponse.models] };
        if (response.delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, response.delay));
        }
        if (response.status < 200 || response.status >= 300) {
          return new Response(JSON.stringify({ error: { message: 'model list rejected' } }), {
            status: response.status,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            object: 'list',
            data: response.models.map((id) => ({ id, object: 'model', owned_by: 'test' })),
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
          ? (bodyRecord.messages as Array<{
              role?: string;
              content?: unknown;
              tool_call_id?: string;
            }>)
          : [];
        requests.push({ body: bodyRecord, messages });
        const stream = body?.stream === true;
        const idx = callCount;
        callCount++;

        const resp = responses[responseCursor++];
        if (!resp) {
          unexpectedRequests.push(idx);
          return new Response(
            JSON.stringify({
              error: {
                message: `Unexpected model request ${idx + 1}: response queue exhausted`,
                type: 'test_fixture_error',
              },
            }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          );
        }

        const requestContractFailures: string[] = [];
        const toolResultIds = new Set(
          messages
            .filter((message) => message.role === 'tool')
            .map((message) => message.tool_call_id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0),
        );
        const resolvedPendingIds = [...toolResultIds].filter((toolCallId) =>
          pendingToolContinuations.has(toolCallId),
        );
        const explicitlyCheckedIds = new Set(
          (resp.expectedRequest?.toolResults ?? []).map((expected) => expected.toolCallId),
        );
        for (const toolCallId of resolvedPendingIds) {
          if (!explicitlyCheckedIds.has(toolCallId)) {
            requestContractFailures.push(
              `request ${idx + 1} resolves tool result ${toolCallId} without an expectedRequest.toolResults outcome contract`,
            );
          }
        }
        for (const toolCallId of toolResultIds) {
          pendingToolContinuations.delete(toolCallId);
        }

        for (const expected of resp.expectedRequest?.toolResults ?? []) {
          const toolResult = messages.find(
            (message) => message.role === 'tool' && message.tool_call_id === expected.toolCallId,
          );
          if (!toolResult) {
            requestContractFailures.push(
              `request ${idx + 1} is missing expected tool result ${expected.toolCallId}`,
            );
            continue;
          }
          const content = serializedMessageContent(toolResult.content);
          for (const text of expected.contentIncludes ?? []) {
            if (!content.includes(text)) {
              requestContractFailures.push(
                `tool result ${expected.toolCallId} in request ${idx + 1} does not include ${JSON.stringify(text)}; content=${JSON.stringify(content.slice(0, 500))}`,
              );
            }
          }
          for (const text of expected.contentExcludes ?? []) {
            if (content.includes(text)) {
              requestContractFailures.push(
                `tool result ${expected.toolCallId} in request ${idx + 1} unexpectedly includes ${JSON.stringify(text)}`,
              );
            }
          }
        }

        if (requestContractFailures.length > 0) {
          contractViolations.push(...requestContractFailures);
          return new Response(
            JSON.stringify({
              error: {
                message: requestContractFailures.join('; '),
                type: 'test_fixture_contract_error',
              },
            }),
            { status: 422, headers: { 'content-type': 'application/json' } },
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
        const emittedToolCallIds = [
          ...(toolCalls ?? []).map((toolCall) => toolCall.id),
          ...(invalidToolCalls ?? []).map((toolCall) => toolCall.id),
        ];
        if (
          emittedToolCallIds.length > 0 &&
          !resp.disconnect_after_content &&
          resp.toolContinuation !== 'aborted'
        ) {
          for (const toolCallId of emittedToolCallIds) {
            if (pendingToolContinuations.has(toolCallId)) {
              contractViolations.push(
                `response ${idx + 1} reused unresolved tool call id ${toolCallId}`,
              );
            }
            pendingToolContinuations.set(toolCallId, idx + 1);
          }
        }

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
      if (responseCursor < responses.length) {
        throw new Error(
          `Cannot replace mock response phase with ${responses.length - responseCursor} unconsumed response(s).`,
        );
      }
      if (pendingToolContinuations.size > 0) {
        throw new Error(
          `Cannot replace mock response phase while tool result(s) are pending: ${formatPendingToolContinuations(pendingToolContinuations)}`,
        );
      }
      responses = [...r];
      responseCursor = 0;
    },
    getRequestCount: () => callCount,
    getRequests: () => [...requests],
    hasRequestMessage: (text: string, since: number) => {
      const messages = requests[since]?.messages ?? [];
      const expected = normalizeRequestedText(text);
      let matched = false;
      for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (message?.role !== 'user') continue;
        const content = normalizedMessageContent(message.content);
        if (!content || content.trimStart().startsWith('<runtime-state')) continue;
        if (content === expected) {
          matched = true;
          continue;
        }
        if (matched) return false;
      }
      return matched;
    },
    setModelsResponse(response) {
      modelsResponse = {
        status: response.status ?? 200,
        delay: response.delay ?? 0,
        models: response.models ?? ['mock-model'],
      };
    },
    getModelRequests: () => [...modelRequests],
    assertComplete() {
      const failures: string[] = [];
      if (unexpectedRequests.length > 0) {
        failures.push(
          `response queue exhausted for request(s): ${unexpectedRequests
            .map((index) => index + 1)
            .join(', ')}`,
        );
      }
      if (responseCursor < responses.length) {
        failures.push(
          `${responses.length - responseCursor} configured response(s) were unconsumed`,
        );
      }
      if (pendingToolContinuations.size > 0) {
        failures.push(
          `tool result(s) are still pending: ${formatPendingToolContinuations(pendingToolContinuations)}`,
        );
      }
      if (contractViolations.length > 0) {
        failures.push(`request contract violation(s): ${contractViolations.join('; ')}`);
      }
      if (failures.length > 0)
        throw new Error(`Mock model fixture incomplete: ${failures.join('; ')}`);
    },
    stop: () => server.stop(),
  };
}

function normalizedMessageContent(content: unknown): string | undefined {
  if (typeof content === 'string') return normalizeRequestedText(content);
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        const record = part as Record<string, unknown>;
        return typeof record.text === 'string' ? record.text : '';
      })
      .join('');
    return normalizeRequestedText(text);
  }
  return undefined;
}

function normalizeRequestedText(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

function serializedMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function formatPendingToolContinuations(pending: ReadonlyMap<string, number>): string {
  return [...pending.entries()]
    .map(([toolCallId, responseNumber]) => `${toolCallId} (response ${responseNumber})`)
    .join(', ');
}
