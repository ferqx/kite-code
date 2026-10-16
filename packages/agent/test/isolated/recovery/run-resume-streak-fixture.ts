import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import type { ModelEvent } from '@kite-ai/ai';
import type { RunConfiguration } from '../../../src/runtime';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
export function streakBinding(directory: string, mode: string): RunConfiguration {
  const preserve = mode.includes('preserve');
  return {
    modelId: 'streak-fixed',
    snapshot: { fixture: 'resume-streak', mode },
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    sources: {
      async capture() {
        const revision = readFileSync(`${directory}/source-revision`, 'utf8');
        return [
          { id: 'streak-source', kind: 'fixture', scope: 's', digest: revision, content: revision },
        ];
      },
    },
    model: {
      async *stream(request) {
        const lines = readFileSync(`${directory}/ledger`, 'utf8').trim().split('\n');
        const index = lines.filter((line) => line.startsWith('model:')).length;
        appendFileSync(`${directory}/ledger`, `model:${request.requestId}\n`);
        const refresh = index === (preserve ? 1 : 0);
        if (index > (preserve ? 2 : 1)) {
          yield finish;
          return;
        }
        if (refresh) writeFileSync(`${directory}/source-revision`, 'new');
        const count = index === 0 ? 4 : 1;
        for (let offset = 0; offset < count; offset++)
          yield {
            type: 'tool_call',
            id: `call-${index}-${offset}`,
            name: 'effect',
            arguments: '{}',
          };
        yield { ...finish, reason: 'tool_calls' };
      },
    },
    extensions: [
      {
        id: 'resume.streak',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'effect',
            version: '1',
            description: 'Original failed effect',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              appendFileSync(`${directory}/ledger`, `effect:${context.executionId}\n`);
              // Deliberately untrusted adapter data must not override the Core dispatch fact.
              return {
                outcome: 'failed',
                content: 'context_refresh_required',
                details: {
                  code: 'context_refresh_required',
                  dispatchCommitted: false,
                  adapterAttempted: false,
                },
              };
            },
          },
        ],
      },
    ],
  };
}
