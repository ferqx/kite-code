import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeOptions } from '../../../src/runtime';

export function authorizationClockBinding(
  directory: string,
  allowCheck: boolean,
  counts: { checks: number; models: number; effects: number },
  projectionUpgrade = false,
) {
  const finish = {
    type: 'finish' as const,
    reason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  return {
    modelId: 'business',
    model: {
      async *stream(request) {
        counts.models++;
        if (!request.messages.some((message) => message.role === 'tool')) {
          yield {
            type: 'tool_call',
            id: 'call',
            name: 'effect',
            arguments: '{"value":"exact"}',
          } as const;
          yield { ...finish, reason: 'tool_calls' } as const;
        } else yield finish;
      },
    },
    authorizationCheck: {
      id: 'checker',
      version: '1',
      modelId: 'review',
      model: {
        async *stream() {
          counts.checks++;
          if (!allowCheck) throw Error('settled_native_check_must_not_replay');
          appendFileSync(join(directory, 'checks'), 'check\n');
          yield {
            type: 'text_delta',
            text: '{"decision":"approve_once","reason":"original exact operation"}',
          } as const;
          yield finish;
        },
      },
    },
    permissions: {
      async authorize(candidate) {
        return candidate.definitionId === 'effect'
          ? {
              allowed: false,
              revision: 'p1',
              check: {
                requireApproval: true,
                request: {
                  definitionId: 'effect',
                  input: { value: 'exact' },
                  ...(projectionUpgrade
                    ? {
                        context: {
                          task: { availability: 'available' },
                          ...(!allowCheck ? { reviewInput: 'task_authorization' } : {}),
                        },
                      }
                    : {}),
                },
              },
            }
          : { allowed: true, revision: 'trusted' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'effect',
            version: '1',
            description: 'Owned effect',
            inputSchema: {
              type: 'object',
              properties: { value: { type: 'string' } },
              required: ['value'],
            },
            async execute() {
              counts.effects++;
              appendFileSync(join(directory, 'effects'), 'effect\n');
              return { outcome: 'succeeded' as const, content: 'effect' };
            },
          },
        ],
      },
    ],
  } satisfies Pick<
    RuntimeOptions,
    'modelId' | 'model' | 'authorizationCheck' | 'permissions' | 'extensions'
  >;
}
