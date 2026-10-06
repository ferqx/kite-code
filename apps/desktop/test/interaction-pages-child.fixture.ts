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
        { type: 'tool_call', id: 'parent', name: 'fixture.parent', arguments: '{}' },
        { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
      [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
    ]),
    permissions: {
      async authorize(request) {
        return request.kind === 'job'
          ? {
              allowed: false,
              revision: 'policy',
              approval: { request: { title: 'Original Job approval' } },
            }
          : { allowed: true, revision: 'policy' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.parent',
            version: '1',
            description: 'Create owned independent Jobs',
            inputSchema: { type: 'object' },
            async execute(_input, ctx) {
              await Promise.all(
                Array.from({ length: 40 }, (_, i) =>
                  ctx.operations.ensure({
                    key: `job-${i}`,
                    cancellation: 'detached',
                    request: {
                      kind: 'job',
                      definitionId: 'fixture.job',
                      definitionVersion: '1',
                      input: { index: i },
                    },
                  }),
                ),
              );
              return { outcome: 'succeeded', content: 'all original approvals observed' };
            },
          },
        ],
        jobs: [
          {
            id: 'fixture.job',
            version: '1',
            description: 'Harmless explicit counter Job',
            inputSchema: { type: 'object' },
            async start(input) {
              appendFileSync(ledger, 'effect\n');
              return { reference: input };
            },
            async *observe() {
              yield {
                type: 'terminal' as const,
                supervision: 'ended' as const,
                result: { outcome: 'succeeded' as const, content: 'counted' },
              };
            },
            async cancel() {
              return { status: 'stopped' as const };
            },
            async dispose() {},
          },
        ],
      },
    ],
  }),
});
