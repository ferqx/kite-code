// tests/mock-model.ts
// AI SDK-compatible mock model for tests.
// Replaces the old StreamingMockModel that extended BaseChatModel.

import type { LanguageModel } from 'ai';
import type { AIMessage, BaseMessage } from '../src/core/messages';
import type { SupportedChatModel } from '../src/core/model/factory';

export interface MockResponse {
  message?: AIMessage;
  delay?: number;
  error?: string;
}

type MockModelFixture = SupportedChatModel & {
  _responses: MockResponse[];
  callCount: { count: number };
};

/**
 * Create a mock model compatible with SupportedChatModel.
 * Returns a governed transport binding with explicit fixture capabilities.
 *
 * The mock cycles through pre-configured responses, supports delays,
 * and error injection — same semantics as the old StreamingMockModel.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- internal mock shape
export function createMockModel(responses: MockResponse[]): MockModelFixture {
  const callCount = { count: 0 };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock model implements doGenerate via any cast
  const model = {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},

    async doGenerate(): Promise<unknown> {
      const idx = callCount.count % responses.length;
      callCount.count++;
      const response = responses[idx];

      if (!response?.message) {
        return {
          content: [],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: {}, outputTokens: {}, totalTokens: 0 },
        };
      }

      if (response.delay && response.delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, response.delay));
      }

      if (response.error) {
        throw new Error(response.error);
      }

      const msg = response.message;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const content: Array<unknown> = [];

      // Text content
      const text = typeof msg.content === 'string' ? msg.content : '';
      if (text) {
        content.push({ type: 'text', text });
      }

      // Tool calls
      const toolCalls = msg.tool_calls ?? [];
      for (const tc of toolCalls) {
        content.push({
          type: 'tool-call',
          toolCallId: tc.id ?? crypto.randomUUID(),
          toolName: tc.name,
          input: tc.args as Record<string, unknown>,
        });
      }

      return {
        content,
        finishReason: {
          unified: toolCalls.length > 0 ? 'tool-calls' : 'stop',
          raw: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 50 },
          totalTokens: 150,
        },
      };
    },

    async doStream(): Promise<never> {
      throw new Error('Streaming not supported in mock model');
    },
  };

  return {
    model: model as unknown as LanguageModel,
    // This legacy fixture implements doGenerate only. Advertise that boundary
    // explicitly so production's default-on streaming does not call doStream.
    capabilityMetadata: { streaming: false },
    _responses: responses,
    get callCount() {
      return callCount;
    },
  };
}

// Keep the old class-based name as a backward-compatible re-export
// for tests that haven't been updated yet.

/** @deprecated Use createMockModel() instead */
export class StreamingMockModel {
  // Delegate to createMockModel for AI SDK compatibility
  private _binding: MockModelFixture;

  constructor(params: { responses: MockResponse[] }) {
    // Reuse shared counter if provided (for multi-turn tests)
    const sharedCounter = (params as Record<string, unknown>)._sharedCounter as
      | { count: number }
      | undefined;
    this._binding = createMockModel(params.responses);
    if (sharedCounter) {
      // Override call count with shared counter
      (this._binding as Record<string, unknown>)._callCount = sharedCounter;
    }
  }

  /** Access the underlying LanguageModel for use with generateText/doGenerate */
  get model(): LanguageModel {
    return this._binding.model;
  }

  get responses(): BaseMessage[] {
    return this._binding._responses
      .map((response) => response.message)
      .filter((message): message is AIMessage => message != null);
  }

  get callCount(): number {
    return this._binding.callCount.count;
  }
}
