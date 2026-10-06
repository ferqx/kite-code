import { appendFileSync } from 'node:fs';
import { AgentError } from '@kite-ai/agent';
import { createFixedModel } from '@kite-ai/ai';
import { runServiceProcess } from '@kite-ai/service/main';

const ledger = 'LEDGER_PATH';
await runServiceProcess({
  configure: async () => ({
    modelId: 'fixed',
    configurationManagement(runtime) {
      const readonly = async (): Promise<never> => {
        throw new AgentError('fixture_configuration_readonly');
      };
      return {
        async readModels(input) {
          if (!runtime) throw new AgentError('data_unavailable');
          const { storeId } = await runtime.getMetadata();
          if (input.expectedStoreId !== storeId) throw new AgentError('store_mismatch');
          if (input.scope === 'workspace') {
            if (!input.workspaceId || !(await runtime.getWorkspace(input.workspaceId)))
              throw new AgentError('workspace_missing');
          } else if (input.workspaceId !== undefined)
            throw new AgentError('invalid_configuration_scope');
          return {
            storeId,
            scope: input.scope,
            ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
            readSet: null,
            defaultModelId: 'fixed',
            models: [
              {
                id: 'fixed',
                enabled: true,
                configured: true,
                provider: 'fixture',
                model: 'fixed',
                diagnostics: [],
              },
            ],
            errors: [],
          };
        },
        read: readonly,
        updateModels: readonly,
        readProviders: readonly,
        updateProviders: readonly,
        patch: readonly,
        repair: readonly,
        putCredential: readonly,
        revokeCredential: readonly,
        getMutation: readonly,
      };
    },
    model: createFixedModel([
      [
        { type: 'tool_call', id: 'question', name: 'fixture.question', arguments: '{}' },
        { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
      [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
    ]),
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'policy' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.question',
            version: '1',
            description: 'Owned original answer effect',
            inputSchema: { type: 'object' },
            async execute(_input, ctx) {
              const answer = await ctx.requestInteraction({
                kind: 'question',
                request: {
                  schema: {
                    type: 'object',
                    required: ['full'],
                    properties: { full: { type: 'string' } },
                    additionalProperties: false,
                  },
                },
              });
              appendFileSync(
                ledger,
                JSON.stringify({ executionId: ctx.executionId, answer }) + '\n',
              );
              return { outcome: 'succeeded', content: 'original answer saved' };
            },
          },
        ],
      },
    ],
  }),
});
