import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { authorizationCheckAnswer } from '../../../src/authorization-check-output';
import { grantDigest } from '../../../src/permission-grants';
import type { RuntimeOptions } from '../../../src/runtime';
import type { TrustedToolBehavior } from '../../../src/tool-behavior';

export function authorizationClockBinding(
  directory: string,
  allowCheck: boolean,
  counts: { checks: number; models: number; effects: number },
  includeContext = false,
) {
  const finish = {
    type: 'finish' as const,
    reason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const effect = {
    id: 'effect',
    version: '1',
    description: 'Owned effect',
    inputSchema: {
      type: 'object' as const,
      properties: { value: { type: 'string' as const } },
      required: ['value'],
    },
    async execute() {
      counts.effects++;
      appendFileSync(join(directory, 'effects'), 'effect\n');
      return { outcome: 'succeeded' as const, content: 'effect' };
    },
  };
  const behavior: TrustedToolBehavior = {
    definition: effect,
    capability: { kind: 'tool', definitionId: effect.id, definitionVersion: effect.version },
    contractRef: 'fixture.recovery.check',
    configurationDigest: grantDigest({ behavior: 'recovery-clock', includeContext }),
    autoReview: 'check',
    async prepareReview(request) {
      return {
        instructions: 'Return the exact permit and explanation object. No tools.',
        material: {
          input: request.input,
          ...(includeContext ? { task: 'frozen fixture task' } : {}),
        },
        fingerprint: grantDigest(request.input),
        reusable: false,
      };
    },
    interpretReview(content) {
      if (!allowCheck) throw Error('settled_check_must_not_be_reinterpreted');
      appendFileSync(join(directory, 'interpretations'), 'interpret\n');
      try {
        const value = JSON.parse(content);
        const answer = authorizationCheckAnswer({
          decision: value.permit === 'yes' ? 'approve_once' : 'reject',
          reason: value.explanation,
        });
        return answer ? { answer } : null;
      } catch {
        return null;
      }
    },
  };
  const {
    definition: _definition,
    prepareReview: _prepare,
    interpretReview: _interpret,
    ...behaviorBinding
  } = behavior;
  // Only the exact serializable identity is part of the permission's selected checker contract.
  const binding = {
    capability: behaviorBinding.capability,
    contractRef: behaviorBinding.contractRef,
    configurationDigest: behaviorBinding.configurationDigest,
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
      timeoutMs: 3000,
      model: {
        async *stream() {
          counts.checks++;
          if (!allowCheck) throw Error('settled_check_must_not_replay');
          appendFileSync(join(directory, 'checks'), 'check\n');
          yield {
            type: 'text_delta',
            text: '{"permit":"yes","explanation":"original exact operation"}',
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
                behavior: binding,
                requireApproval: true,
                request: {
                  definitionId: 'effect',
                  input: { value: 'exact' },
                  ...(includeContext ? { context: { task: { availability: 'available' } } } : {}),
                },
              },
            }
          : { allowed: true, revision: 'trusted' };
      },
    },
    extensions: [{ id: 'fixture', version: '1', apiMajor: 1, tools: [effect] }],
    toolBehaviors: [behavior],
  } satisfies Pick<
    RuntimeOptions,
    'modelId' | 'model' | 'authorizationCheck' | 'permissions' | 'extensions' | 'toolBehaviors'
  >;
}
