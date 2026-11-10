import { AgentError } from '@kite-ai/agent';
import { createConfigurationSnapshot } from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import type { ModelAdapter } from '@kite-ai/ai';
import { runServiceProcess } from '@kite-ai/service/main';

declare const TRAJECTORY_ONLINE_FIXTURE_CONTROL: string;
const control = TRAJECTORY_ONLINE_FIXTURE_CONTROL;
const model: ModelAdapter = {
  // biome-ignore lint/correctness/useYield: Any Model entry fails this read-only fixture before producing a token.
  async *stream(_request, { signal }) {
    await fetch(`${control}/unexpected-model`, { method: 'POST', signal });
    throw new AgentError('fixture_readonly_model_forbidden');
  },
};
await runServiceProcess({
  configure: async () => ({
    model,
    modelId: 'fixed',
    resolveRunConfiguration: async () => ({
      model,
      modelId: 'fixed',
      snapshot: createConfigurationSnapshot({
        models: [{ id: 'fixed', provider: 'compatible', model: 'fixed' }],
      }) as unknown as Json,
    }),
    configurationManagement(runtime) {
      const readonly = async (): Promise<never> => {
        throw new AgentError('fixture_configuration_readonly');
      };
      return {
        async readModels(input) {
          if (!runtime) throw new AgentError('data_unavailable');
          const { storeId } = await runtime.getMetadata();
          if (input.expectedStoreId !== storeId) throw new AgentError('store_mismatch');
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
                provider: 'compatible',
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
        discoverProviders: readonly,
        updateProviders: readonly,
        patch: readonly,
        repair: readonly,
        putCredential: readonly,
        revokeCredential: readonly,
        getMutation: readonly,
      };
    },
    permissions: {
      async authorize() {
        await fetch(`${control}/unexpected-permission`, { method: 'POST' });
        return { allowed: true, revision: 'isolated-fixture' };
      },
    },
  }),
});
