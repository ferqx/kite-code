import { AgentError } from '@kite-ai/agent';
import { createConfigurationSnapshot } from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import type { ModelAdapter } from '@kite-ai/ai';
import { runServiceProcess } from '@kite-ai/service/main';

declare const TRAJECTORY_ONLINE_FIXTURE_CONTROL: string;
const control = TRAJECTORY_ONLINE_FIXTURE_CONTROL;
let calls = 0;
const model: ModelAdapter = {
  async *stream(request, { signal }) {
    calls++;
    await fetch(`${control}/model-start`, {
      method: 'POST',
      body: JSON.stringify({ calls, requestId: request.requestId }),
      signal,
    });
    const prefix = `STREAM_PREFIX_ONE\n${'original saved content 雪 '.repeat(5000)}`;
    for (let offset = 0; offset < prefix.length; offset += 16000)
      yield { type: 'text_delta', text: prefix.slice(offset, offset + 16000) };
    // The generator is resumed only after Core has awaited its real partial commit.
    await fetch(`${control}/prefix-saved`, { method: 'POST', signal });
    await fetch(`${control}/model-gate`, { signal });
    yield { type: 'text_delta', text: '\nSTREAM_FINAL_TAIL' };
    yield {
      type: 'finish',
      reason: 'stop',
      usage: { inputTokens: 2, outputTokens: 3 },
      continuation: { privateFixtureContinuation: 'NEVER_PUBLIC_CONTINUATION' },
    };
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
        return { allowed: true, revision: 'isolated-fixture' };
      },
    },
  }),
});
