import { appendFileSync, readFileSync } from 'node:fs';
import { type ModelAdapter, ModelAttemptError, type ModelEvent } from '@kite-ai/ai';
import type { Extension } from '../../../src/extensions';
import { canonicalJson } from '../../../src/json';
import type { RunConfiguration } from '../../../src/runtime';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
export const opaqueContinuation = { protocol: 'recovery.fixture', state: 'opaque'.repeat(14000) };

export function binding(directory: string, mode: string): RunConfiguration {
  const model: ModelAdapter = {
    async *stream(request) {
      if (
        mode.includes('large') &&
        !request.messages.some(
          (message) =>
            typeof message.content === 'string' && message.content.includes('s'.repeat(80000)),
        )
      )
        throw Error('sealed large source not rehydrated');
      appendFileSync(`${directory}/ledger`, `model:${request.requestId}\n`);
      if (
        mode.startsWith('continuation_') &&
        request.messages.some((message) => message.role === 'tool')
      ) {
        const original = request.messages.find((message) => message.role === 'assistant');
        if (canonicalJson(original?.continuation ?? null) !== canonicalJson(opaqueContinuation))
          throw Error('original opaque continuation not rehydrated');
        appendFileSync(`${directory}/ledger`, `continuation:${request.requestId}\n`);
        const attempts = readFileSync(`${directory}/ledger`, 'utf8')
          .split('\n')
          .filter((line) => line.startsWith('model:')).length;
        if (mode === 'continuation_failed' && attempts === 2)
          throw new ModelAttemptError('provider_unavailable');
        yield { type: 'text_delta', text: 'done' };
        yield finish;
        return;
      }
      if (mode.startsWith('compression_') && request.tools.length === 0) {
        yield { type: 'text_delta', text: 'cold recovery summary' };
        yield finish;
        return;
      }
      if (
        mode.startsWith('running_') &&
        readFileSync(`${directory}/ledger`, 'utf8')
          .split('\n')
          .filter((line) => line.startsWith('model:')).length === 1
      ) {
        yield {
          type: 'text_delta',
          text:
            mode === 'running_large'
              ? 'interrupted model text'.repeat(5000)
              : 'interrupted model text',
        };
        yield finish;
        return;
      }
      if (mode.startsWith('length_')) {
        const hasSegment = request.messages.some(
          (message) => message.content === 'saved length segment',
        );
        if (!hasSegment) {
          yield { type: 'text_delta', text: 'saved length segment' };
          yield { ...finish, reason: 'length' };
          return;
        }
        if (
          mode !== 'length_history' ||
          request.messages.some((message) => message.role === 'tool')
        ) {
          yield { type: 'text_delta', text: 'done' };
          yield finish;
          return;
        }
      }
      if (
        mode.startsWith('retry_') &&
        readFileSync(`${directory}/ledger`, 'utf8')
          .split('\n')
          .filter((line) => line.startsWith('model:')).length < (mode === 'retry_lineage' ? 4 : 2)
      )
        throw new ModelAttemptError('provider_unavailable');
      if (
        mode === 'completion' ||
        mode.startsWith('running_') ||
        request.messages.some((message) =>
          message.content.startsWith('Context summary (untrusted data;'),
        ) ||
        mode.startsWith('retry_') ||
        (mode !== 'repeat_failure' && request.messages.at(-1)?.role === 'tool')
      ) {
        yield { type: 'text_delta', text: 'done' };
        yield finish;
      } else {
        yield {
          type: 'tool_call',
          id: 'call',
          name: 'effect',
          arguments: JSON.stringify({
            value: mode.includes('large') ? 'x'.repeat(80000) : 'original',
          }),
        };
        yield {
          ...finish,
          reason: 'tool_calls',
          ...(mode.startsWith('continuation_') ? { continuation: opaqueContinuation } : {}),
        };
      }
    },
  };
  const extension: Extension = {
    id: 'resume.fixture',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'effect',
        version: '1',
        description: 'Owned ledger',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
        async execute(input) {
          appendFileSync(
            `${directory}/ledger`,
            `effect:${(input as { value: string }).value.length}\n`,
          );
          return {
            outcome: mode === 'repeat_failure' ? 'failed' : 'succeeded',
            content: 'effect done',
          };
        },
      },
    ],
  };
  return {
    model,
    modelId: 'fixed',
    extensions: [extension],
    snapshot: { fixture: 'resume', mode },
    ...(mode.startsWith('compression_')
      ? {
          compressor: {
            id: 'cold.fixture',
            version: '1',
            async shouldCompress(input) {
              return (
                input.messages.some((message) => message.role === 'tool') &&
                !input.messages.some((message) =>
                  message.content.startsWith('Context summary (untrusted data;'),
                )
              );
            },
            async prepare() {
              return { instructions: 'summarize cold recovery fixture', snapshot: {} };
            },
          },
        }
      : {}),
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    ...(mode.includes('large')
      ? {
          sources: {
            async capture() {
              return [
                {
                  id: 'large',
                  kind: 'fixture',
                  scope: 's',
                  digest: '1',
                  content: 's'.repeat(80000),
                },
              ];
            },
          },
        }
      : {}),
  };
}
