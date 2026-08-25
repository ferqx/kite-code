import { afterEach, describe, expect, test } from 'bun:test';
import {
  type BaseMessage,
  compileModelSurface,
  createChatModel,
  createModelContextSummaryGenerator,
  humanMessage,
  type ModelProviderOptions,
  normalizedModelResponseToAIMessage,
  type SupportedChatModel,
} from '@kite-ai/builtin-runtime/model';
import { jsonSchema, type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { AgentConfig } from '#app/config';
import { createTestModelInvocationHarness } from './helpers/model-invocation';
import { createMockModelServer } from './tui-system/harness/fixtures';

const servers: Array<ReturnType<typeof createMockModelServer>> = [];
const modelConfigs = new WeakMap<object, AgentConfig>();

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

function setup(providerType: 'deepseek' | 'openai-compatible' = 'deepseek') {
  const server = createMockModelServer();
  servers.push(server);
  const config: AgentConfig = {
    apiKey: 'test-key',
    baseURL: server.baseURL,
    modelName: 'mock-model',
    providerName: 'mock',
    providerType,
    sandbox: { enabled: true },
  };
  const model = createChatModel(config);
  modelConfigs.set(model, config);
  return {
    server,
    config,
    model,
  };
}

async function invokeGatewayModel(params: {
  model: SupportedChatModel;
  tools: ToolSet;
  messages: BaseMessage[];
  signal?: AbortSignal;
  maxOutputTokens?: number;
  providerOptions?: ModelProviderOptions;
  streaming?: boolean;
  onTextDelta?: (text: string) => void;
  onReasoningDelta?: (text: string, segmentId: string) => void;
  onReasoningCompleted?: (text: string, segmentId: string) => void;
  onRetry?: (attempt: number, maxAttempts: number, error: unknown, delayMs: number) => void;
  streamRetryOptions?: {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    jitterMs?: number;
    sleep?: (delayMs: number) => Promise<void>;
  };
}) {
  const config = modelConfigs.get(params.model);
  if (!config) throw new Error('Model test config is unavailable.');
  const tools = Object.fromEntries(
    Object.entries(params.tools).map(([name, definition]) => {
      const carrier = definition.inputSchema as unknown;
      const schema =
        carrier && typeof carrier === 'object' && 'jsonSchema' in carrier
          ? (carrier as { jsonSchema: unknown }).jsonSchema
          : z.toJSONSchema(carrier as z.ZodType);
      return [
        name,
        tool({
          ...(definition.description ? { description: definition.description } : {}),
          inputSchema: jsonSchema(schema as Record<string, unknown>),
        }),
      ];
    }),
  ) as ToolSet;
  const compiled = compileModelSurface({
    purpose: 'primary_agent',
    config,
    model: params.model,
    tools,
    messages: params.messages,
    maxOutputTokens: params.maxOutputTokens,
    providerOptions: params.providerOptions,
    transport: params.streaming ? 'stream' : 'generate',
  });
  const harness = createTestModelInvocationHarness({ workspace: process.cwd() });
  const pending = await harness.gateway.invoke({
    model: params.model,
    compiled,
    persistence: harness.persistence,
    provenance: {
      promptContractVersion: 'model-invoke-test-v1',
      projectionEnvironmentDigest: `sha256:${'1'.repeat(64)}`,
      capabilityBindingDigest: `sha256:${'2'.repeat(64)}`,
    },
    resourceKind: 'model',
    limits: { maxAttempts: params.streamRetryOptions?.maxAttempts ?? 5 },
    signal: params.signal,
    emitEphemeral: (event) => {
      if (event.type === 'model.text_delta') params.onTextDelta?.(event.text);
      if (event.type === 'model.reasoning_delta') {
        params.onReasoningDelta?.(event.text, event.segmentId ?? 'reasoning');
      }
      if (event.type === 'model.reasoning_completed') {
        params.onReasoningCompleted?.(event.text, event.segmentId);
      }
    },
  });
  const response = normalizedModelResponseToAIMessage(await pending.commit());
  for (const event of harness.events) {
    if (event.type === 'model.retry') {
      params.onRetry?.(event.attempt, event.maxAttempts, event.error, event.delayMs);
    }
  }
  return response;
}

describe('ModelInvocationGateway transport', () => {
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

    const response = await invokeGatewayModel({
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

    const response = await invokeGatewayModel({
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

    const response = await invokeGatewayModel({
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

  test('disables DeepSeek V4 thinking for bounded internal compaction summaries', async () => {
    const { server, config, model } = setup('deepseek');
    model.compactionProviderOptions = { deepseek: { thinking: { type: 'disabled' } } };
    server.setResponses([{ message: { content: 'bounded summary' } }]);

    const harness = createTestModelInvocationHarness({ workspace: process.cwd() });
    const generate = createModelContextSummaryGenerator({
      config,
      model,
      gateway: harness.gateway,
      persistence: harness.persistence,
      state: harness.getState(),
      projectionEnvironmentDigest: 'compaction-test',
    });
    await expect(
      generate({ systemPrompt: 'summarize', input: 'settled history', maxOutputTokens: 600 }),
    ).resolves.toMatchObject({ summary: 'bounded summary' });

    expect(server.getRequests()[0]?.body).toMatchObject({
      model: 'mock-model',
      max_tokens: 600,
      thinking: { type: 'disabled' },
    });
    expect(server.getRequests()[0]?.body.stream).not.toBe(true);
  });

  test('propagates a streamed provider failure without emitting deltas', async () => {
    const { server, model } = setup('openai-compatible');
    server.setResponses([{ error: 'stream failed' }]);
    const deltas: string[] = [];

    await expect(
      invokeGatewayModel({
        model,
        tools: {} as ToolSet,
        messages: [humanMessage('hello')],
        streaming: true,
        streamRetryOptions: { maxAttempts: 1 },
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
      invokeGatewayModel({
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

  test('ignores empty chunks while retaining cumulative text', async () => {
    const { server, model } = setup('openai-compatible');
    server.setResponses([{ message: { content_chunks: ['', 'answer'] } }]);
    const deltas: string[] = [];

    const response = await invokeGatewayModel({
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
      invokeGatewayModel({
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

    const response = await invokeGatewayModel({
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

  test('does not repeat a replayed reasoning prefix in completed retry segments', async () => {
    const { server, model } = setup();
    server.setResponses([
      {
        message: {
          reasoning_chunks: ['inspect'],
          content_chunks: ['partial'],
        },
        disconnect_after_content: true,
      },
      {
        message: {
          reasoning_chunks: ['inspect', ' more'],
          content_chunks: ['partial', ' answer'],
        },
      },
    ]);
    const reasoningDeltas: string[] = [];
    const completedReasoning: string[] = [];

    await invokeGatewayModel({
      model,
      tools: {} as ToolSet,
      messages: [humanMessage('inspect')],
      streaming: true,
      onReasoningDelta: (text) => reasoningDeltas.push(text),
      onReasoningCompleted: (text) => completedReasoning.push(text),
      streamRetryOptions: {
        initialDelayMs: 0,
        maxDelayMs: 0,
        jitterMs: 0,
        sleep: async () => {},
      },
    });

    expect(reasoningDeltas).toEqual(['inspect', ' more']);
    expect(completedReasoning).toEqual(['inspect', ' more']);
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

    const response = await invokeGatewayModel({
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
