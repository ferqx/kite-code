import { appendFileSync } from 'node:fs';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { Extension } from '@kite-ai/agent/extensions';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
export function resumeBinding(input: { ledger: string; changed?: boolean; denied?: boolean }) {
  const model: ModelAdapter = {
    async *stream(request) {
      const completed = request.messages.at(-1)?.role === 'tool';
      appendFileSync(input.ledger, completed ? 'model-completion\n' : 'model-decision\n');
      if (completed) {
        yield { type: 'text_delta', text: 'Original effect finished once' };
        yield finish;
      } else {
        yield {
          type: 'tool_call',
          id: 'original-call',
          name: 'fixture.effect',
          arguments: '{"exact":"original"}',
        };
        yield { ...finish, reason: 'tool_calls' };
      }
    },
  };
  const permissions: Parameters<typeof createRuntime>[0]['permissions'] = {
    async authorize(request) {
      if (input.denied)
        return { allowed: false, revision: 'denied', reason: 'current_recovery_denied' };
      return request.kind === 'model'
        ? { allowed: true, revision: 'original-permission' }
        : {
            allowed: false,
            revision: 'original-permission',
            approval: { request: { title: 'Approve the exact original effect' } },
          };
    },
  };
  const extension: Extension = {
    id: 'fixture.resume',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture.effect',
        version: '1',
        description: 'Owned append-only effect',
        inputSchema: {
          type: 'object',
          properties: { exact: { type: 'string' } },
          required: ['exact'],
          additionalProperties: false,
        },
        async execute(value) {
          appendFileSync(input.ledger, `tool-effect:${JSON.stringify(value)}\n`);
          return { outcome: 'succeeded', content: 'Original effect confirmed' };
        },
      },
    ],
  };
  return {
    model,
    modelId: 'fixed-resume',
    permissions,
    extensions: [extension],
    snapshot: { fixture: input.changed ? 'changed' : 'original', modelId: 'fixed-resume' },
  };
}
export function createResumeRuntime(input: {
  store: Parameters<typeof createRuntime>[0]['store'];
  profile: { dataRoot: string; profile: string };
  ledger: string;
}) {
  return createRuntime({
    store: input.store,
    artifacts: createArtifactStore({ profile: input.profile, store: input.store }),
    permissions: resumeBinding(input).permissions,
    resolveRunConfiguration: async () => resumeBinding(input),
  });
}
