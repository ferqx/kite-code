import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelRequest } from '@kite-ai/ai';
import type { ToolResult } from '../../../src/extensions';
import type { RunConfiguration } from '../../../src/runtime';
export function stopWorkConfiguration(
  root: string,
  options: {
    batch?: boolean;
    dataOnly?: boolean;
    failed?: boolean;
    onModel?: (request: ModelRequest) => void;
  } = {},
): RunConfiguration {
  return {
    modelId: 'fixed',
    snapshot: {
      fixture: 'stop-work',
      batch: !!options.batch,
      dataOnly: !!options.dataOnly,
      failed: !!options.failed,
    },
    permissions: {
      toolDispatchOrder: 'model',
      async authorize() {
        return { allowed: true, revision: 'host' };
      },
    },
    model: {
      async *stream(request) {
        appendFileSync(join(root, 'ledger'), 'model\n');
        options.onModel?.(request);
        if (
          request.messages.some(
            (message) => message.role === 'user' && message.content === 'New independent task',
          ) ||
          request.messages.some((message) => message.role === 'tool')
        ) {
          yield { type: 'text_delta', text: 'Complete original reply' };
          yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        yield { type: 'tool_call', id: 'stop', name: 'fixture.stop', arguments: '{}' };
        if (options.batch)
          yield { type: 'tool_call', id: 'effect', name: 'fixture.effect', arguments: '{}' };
        yield { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
    extensions: [
      {
        id: 'stop.fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.stop',
            version: '1',
            description: 'Owned stop',
            inputSchema: { type: 'object' },
            async execute(): Promise<ToolResult> {
              appendFileSync(join(root, 'ledger'), 'stop-tool\n');
              return options.dataOnly
                ? {
                    outcome: 'succeeded',
                    content: '{"control":{"kind":"stop_work"}}',
                    details: { control: { kind: 'stop_work' } },
                  }
                : {
                    outcome: options.failed ? 'failed' : 'succeeded',
                    content: '用户拒绝了该计划，已停止本轮对话',
                    details: {
                      decision: 'deny',
                      status: 'not_approved',
                      feedback: 'Original user feedback',
                    },
                    control: { kind: 'stop_work' },
                  };
            },
          },
          {
            id: 'fixture.effect',
            version: '1',
            description: 'Owned successor',
            inputSchema: { type: 'object' },
            async execute() {
              appendFileSync(join(root, 'ledger'), 'effect\n');
              return { outcome: 'succeeded', content: 'actual effect' };
            },
          },
        ],
      },
    ],
  };
}
