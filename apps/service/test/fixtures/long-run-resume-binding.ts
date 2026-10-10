import { appendFileSync, readFileSync } from 'node:fs';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { Extension } from '@kite-ai/agent/extensions';
import { createProjectSources } from '@kite-ai/agent/sources';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';

export const rounds = 32;
export const batchSize = 128;
export const toolCount = rounds * batchSize;
export const sourceText =
  'LONG_RUN_ROOT_INSTRUCTIONS: preserve every original effect and finish once.';
export const ancestorText =
  'LONG_RUN_DISCOVERED_ANCESTOR: preserve this original nested provenance.';
export function ledgerLines(ledger: string) {
  return readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean);
}
export function longRunBinding(input: { ledger: string; workspace: string }) {
  const finish: ModelEvent = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const model: ModelAdapter = {
    async *stream(request) {
      const lines = ledgerLines(input.ledger);
      const index = lines.filter((line) => line.startsWith('model:')).length;
      if (!JSON.stringify(request.messages).includes(sourceText))
        throw Error('long_run_original_source_missing');
      appendFileSync(input.ledger, `model:${index}\n`);
      const completed = lines.filter((line) => line.startsWith('tool:')).length;
      if (completed === toolCount) {
        yield { type: 'text_delta', text: 'LONG_RUN_COMPLETED_ORIGINAL_EFFECTS' };
        yield finish;
        return;
      }
      if (index > rounds + 2) throw Error('long_run_model_replayed');
      for (let offset = 0; offset < Math.min(batchSize, toolCount - completed); offset++)
        yield {
          type: 'tool_call',
          id: `effect-${index * batchSize + offset}`,
          name: 'fixture.long_effect',
          arguments: '{"filePath":"nested/value.txt"}',
        };
      yield { ...finish, reason: 'tool_calls' };
    },
  };
  const extension: Extension = {
    id: 'fixture.long_resume',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture.long_effect',
        version: '1',
        description: 'Record the original call once',
        inputSchema: {
          type: 'object',
          properties: { filePath: { type: 'string' } },
          required: ['filePath'],
          additionalProperties: false,
        },
        async execute(_value, context) {
          appendFileSync(input.ledger, `tool:${context.executionId}\n`);
          return { outcome: 'succeeded', content: 'LONG_RUN_ORIGINAL_TOOL_RESULT' };
        },
      },
    ],
  };
  return {
    model,
    modelId: 'long-resume-fixed',
    extensions: [extension],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'long-resume-policy' };
      },
    },
    sources: createProjectSources({
      async workspaceRoot() {
        return input.workspace;
      },
      targetPaths(request) {
        return request.definitionId === 'fixture.long_effect' ? ['nested/value.txt'] : [];
      },
    }),
    snapshot: { fixture: 'long-resume-original', modelId: 'long-resume-fixed' },
  };
}
export function longRunRuntime(input: {
  store: Parameters<typeof createRuntime>[0]['store'];
  profile: { dataRoot: string; profile: string };
  ledger: string;
  workspace: string;
  cold?: boolean;
}) {
  const binding = () => longRunBinding(input);
  return createRuntime({
    store: input.store,
    artifacts: createArtifactStore({ profile: input.profile, store: input.store }),
    permissions: binding().permissions,
    ...(input.cold
      ? { resolveRecoveryRunConfiguration: async () => binding() }
      : { resolveRunConfiguration: async () => binding() }),
  });
}
