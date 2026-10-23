import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelEvent, ModelRequest } from '@kite-ai/ai';
import type { RunConfiguration } from '../../../src/runtime';

export const guidance = 'Keep exact original requirements 雪🙂; correction: Blue instead of Red.';
export const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 8, outputTokens: 3 },
} satisfies ModelEvent;
export function compressionSteeringBinding(
  directory: string,
  observe?: (request: ModelRequest) => void,
  afterRead?: () => Promise<void>,
): RunConfiguration {
  return {
    modelId: 'fixed',
    snapshot: { fixture: 'compression-steering-recovery', version: 1 },
    permissions: { authorize: async () => ({ allowed: true, revision: 'owned' }) },
    compressor: {
      id: 'compression-steering-recovery',
      version: '1',
      shouldCompress: async (input) =>
        input.messages.some((message) => message.role === 'tool') &&
        !input.messages.some((message) =>
          message.content.startsWith('Context summary (untrusted data;'),
        ),
      prepare: async () => ({ instructions: 'RECOVERY_STEERING_SUMMARY', snapshot: {} }),
      validateSummary: async () => true,
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.read',
            version: '1',
            description: 'One actual read of the original owned material',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            async execute() {
              const content = readFileSync(join(directory, 'material'), 'utf8');
              appendFileSync(join(directory, 'ledger'), 'read\n');
              await afterRead?.();
              return { outcome: 'succeeded', content };
            },
          },
        ],
      },
    ],
    model: {
      async *stream(request) {
        observe?.(structuredClone(request));
        const summary = request.messages.some(
          (message) => message.content === 'RECOVERY_STEERING_SUMMARY',
        );
        appendFileSync(
          join(directory, 'ledger'),
          `${summary ? 'summary' : 'model'}:${request.requestId}\n`,
        );
        if (summary) {
          yield {
            type: 'text_delta',
            text: 'A finite read completed; guidance intentionally absent from this derived checkpoint.',
          };
          yield finish;
          return;
        }
        const hasCompletedRead = readFileSync(join(directory, 'ledger'), 'utf8')
          .split('\n')
          .includes('read');
        if (!hasCompletedRead) {
          yield { type: 'tool_call', id: 'owned-read-once', name: 'fixture.read', arguments: '{}' };
          yield { ...finish, reason: 'tool_calls' };
          return;
        }
        yield {
          type: 'text_delta',
          text: 'Finite recovery response; semantic model compliance is outside this fixture.',
        };
        yield finish;
      },
    },
  };
}
