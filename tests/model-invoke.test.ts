import { afterEach, describe, expect, test } from 'bun:test';
import type { ToolSet } from 'ai';
import { z } from 'zod';
import { humanMessage } from '../src/core/messages';
import { createChatModel } from '../src/core/model/factory';
import { invokeBoundModel } from '../src/core/model/invoke';
import { createMockModelServer } from './tui-system/harness/fixtures';

const servers: Array<ReturnType<typeof createMockModelServer>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

function setup(providerType: 'deepseek' | 'openai-compatible' = 'deepseek') {
  const server = createMockModelServer();
  servers.push(server);
  return {
    server,
    model: createChatModel({
      apiKey: 'test-key',
      baseURL: server.baseURL,
      modelName: 'mock-model',
      providerName: 'mock',
      providerType,
      sandbox: { enabled: true },
    }),
  };
}

describe('invokeBoundModel streaming', () => {
  test('emits cumulative text and reasoning while preserving the final response', async () => {
    const { server, model } = setup();
    server.setResponses([
      {
        message: {
          reasoning_chunks: ['inspect ', 'first'],
          content_chunks: ['final ', 'answer'],
        },
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ]);
    const textDeltas: string[] = [];
    const reasoningDeltas: string[] = [];

    const response = await invokeBoundModel({
      model,
      tools: {} as ToolSet,
      messages: [humanMessage('hello')],
      streaming: true,
      onTextDelta: (text) => textDeltas.push(text),
      onReasoningDelta: (text) => reasoningDeltas.push(text),
    });

    expect(server.getRequests()[0]?.body.stream).toBe(true);
    expect(textDeltas).toEqual(['final ', 'final answer']);
    expect(reasoningDeltas).toEqual(['inspect ', 'inspect first']);
    expect(response.content).toBe('final answer');
    expect(response.additional_kwargs.reasoning_content).toBe('inspect first');
    expect(response.response_metadata.usage).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
  });

  test('preserves streamed tool calls without executing tool handlers', async () => {
    const { server, model } = setup('openai-compatible');
    server.setResponses([
      {
        message: {
          content: 'checking',
          tool_calls: [{ id: 'call-1', name: 'read_file', args: { path: 'README.md' } }],
        },
      },
    ]);
    let executed = false;

    const response = await invokeBoundModel({
      model,
      tools: {
        read_file: {
          inputSchema: z.object({ path: z.string() }),
          execute: async () => {
            executed = true;
            return 'unexpected';
          },
        },
      } as unknown as ToolSet,
      messages: [humanMessage('inspect')],
      streaming: true,
    });

    expect(executed).toBe(false);
    expect(response.tool_calls).toEqual([
      {
        id: 'call-1',
        name: 'read_file',
        args: { path: 'README.md' },
        type: 'tool_call',
      },
    ]);
  });

  test('uses generateText without delta callbacks when streaming is disabled', async () => {
    const { server, model } = setup('openai-compatible');
    server.setResponses([{ message: { content: 'non-streamed' } }]);
    const deltas: string[] = [];

    const response = await invokeBoundModel({
      model,
      tools: {} as ToolSet,
      messages: [humanMessage('hello')],
      streaming: false,
      onTextDelta: (text) => deltas.push(text),
    });

    expect(server.getRequests()[0]?.body.stream).not.toBe(true);
    expect(deltas).toEqual([]);
    expect(response.content).toBe('non-streamed');
  });

  test('propagates a streamed provider failure without emitting deltas', async () => {
    const { server, model } = setup('openai-compatible');
    server.setResponses([{ error: 'stream failed' }]);
    const deltas: string[] = [];

    await expect(
      invokeBoundModel({
        model,
        tools: {} as ToolSet,
        messages: [humanMessage('hello')],
        streaming: true,
        onTextDelta: (text) => deltas.push(text),
      }),
    ).rejects.toThrow();
    expect(deltas).toEqual([]);
  });

  test('cancels an in-flight stream through AbortSignal', async () => {
    const { server, model } = setup('openai-compatible');
    server.setResponses([
      {
        message: { content_chunks: ['first', ' second', ' third'] },
        chunk_delay: 200,
      },
    ]);
    const controller = new AbortController();
    const deltas: string[] = [];

    await expect(
      invokeBoundModel({
        model,
        tools: {} as ToolSet,
        messages: [humanMessage('hello')],
        streaming: true,
        signal: controller.signal,
        onTextDelta: (text) => {
          deltas.push(text);
          controller.abort();
        },
      }),
    ).rejects.toThrow();
    expect(deltas).toEqual(['first']);
  });

  test('terminates a stream when the shared idle deadline expires', async () => {
    const { server, model } = setup('openai-compatible');
    server.setResponses([
      {
        message: { content_chunks: ['first', ' second'] },
        chunk_delay: 200,
      },
    ]);

    await expect(
      invokeBoundModel({
        model,
        tools: {} as ToolSet,
        messages: [humanMessage('hello')],
        streaming: true,
        deadlineAt: Date.now() + 1_000,
        firstByteTimeoutMs: 100,
        idleTimeoutMs: 20,
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  test('ignores empty chunks while retaining cumulative text', async () => {
    const { server, model } = setup('openai-compatible');
    server.setResponses([{ message: { content_chunks: ['', 'answer'] } }]);
    const deltas: string[] = [];

    const response = await invokeBoundModel({
      model,
      tools: {} as ToolSet,
      messages: [humanMessage('hello')],
      streaming: true,
      onTextDelta: (text) => deltas.push(text),
    });

    expect(deltas).toEqual(['answer']);
    expect(response.content).toBe('answer');
  });

  test('rejects malformed SSE without producing a terminal message', async () => {
    const { server, model } = setup('openai-compatible');
    server.setResponses([{ malformed_sse: true, message: { content: 'unreachable' } }]);
    const deltas: string[] = [];

    await expect(
      invokeBoundModel({
        model,
        tools: {} as ToolSet,
        messages: [humanMessage('hello')],
        streaming: true,
        onTextDelta: (text) => deltas.push(text),
      }),
    ).rejects.toThrow();
    expect(deltas).toEqual([]);
  });

  test('keeps partial text visible across reconnect and commits only the completed tool call', async () => {
    const { server, model } = setup('openai-compatible');
    server.setResponses([
      {
        message: {
          content_chunks: ['Reading ', 'the project'],
          tool_calls: [{ id: 'partial-call', name: 'read_file', args: { path: 'WRONG.md' } }],
        },
        disconnect_after_content: true,
      },
      {
        message: {
          content_chunks: ['Reading ', 'the project', ' now'],
          tool_calls: [{ id: 'final-call', name: 'read_file', args: { path: 'README.md' } }],
        },
      },
    ]);
    const deltas: string[] = [];
    const retries: number[] = [];

    const response = await invokeBoundModel({
      model,
      tools: {
        read_file: {
          inputSchema: z.object({ path: z.string() }),
        },
      } as unknown as ToolSet,
      messages: [humanMessage('inspect')],
      streaming: true,
      onTextDelta: (text) => deltas.push(text),
      onRetry: (attempt) => retries.push(attempt),
      streamRetryOptions: {
        initialDelayMs: 0,
        maxDelayMs: 0,
        jitterMs: 0,
        sleep: async () => {},
      },
    });

    expect(server.getRequestCount()).toBe(2);
    expect(retries).toEqual([1]);
    expect(deltas).toEqual(['Reading ', 'Reading the project', ' now']);
    expect(response.content).toBe('Reading the project now');
    expect(response.tool_calls).toEqual([
      {
        id: 'final-call',
        name: 'read_file',
        args: { path: 'README.md' },
        type: 'tool_call',
      },
    ]);
  });

  test('emits divergent regenerated text as a separate segment', async () => {
    const { server, model } = setup('openai-compatible');
    server.setResponses([
      {
        message: { content_chunks: ['old line one\nold line two'] },
        disconnect_after_content: true,
      },
      { message: { content_chunks: ['new line one\nnew line two'] } },
    ]);
    const deltas: string[] = [];

    const response = await invokeBoundModel({
      model,
      tools: {} as ToolSet,
      messages: [humanMessage('regenerate')],
      streaming: true,
      onTextDelta: (text) => deltas.push(text),
      streamRetryOptions: {
        initialDelayMs: 0,
        maxDelayMs: 0,
        jitterMs: 0,
        sleep: async () => {},
      },
    });

    expect(deltas).toEqual(['old line one\nold line two', 'new line one\nnew line two']);
    expect(response.content).toBe('new line one\nnew line two');
  });
});
