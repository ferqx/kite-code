import { describe, expect, test } from 'bun:test';
import type { KiteAppControlClient, ProviderModelSnapshot } from '@kite-ai/kite-app-contract';
import {
  connectProviderWithKey,
  type FirstRunProviderClients,
  saveManualProviderModel,
} from '../src/tui/components/first-run/connect-provider';
import { PROVIDERS } from '../src/tui/components/first-run/types';

const provider = PROVIDERS[0]!;
const workspace = {
  canonicalPath: '/tmp/kite-first-run-test',
  projectId: 'project-test',
  workspaceDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
} as const;

function snapshot(readiness: 'ready' | 'not_configured' = 'ready'): ProviderModelSnapshot {
  return {
    schema: 'kite.app.provider-model.snapshot-response.v1',
    workspace,
    revision: 'revision-1',
    providers: [
      {
        provider: provider.type,
        type: provider.type,
        readiness,
        models: [{ provider: provider.type, name: 'gpt-test', isDefault: true }],
        ...(readiness === 'ready' ? { selectedModel: 'gpt-test' } : {}),
      },
    ],
    ...(readiness === 'ready' ? { selected: { provider: provider.type, name: 'gpt-test' } } : {}),
  };
}

function clients(
  response: 'applied' | 'outcome_unknown' = 'applied',
  queried: ProviderModelSnapshot = snapshot(),
): FirstRunProviderClients & { requests: unknown[]; queries: number } {
  const requests: unknown[] = [];
  let queries = 0;
  const credentialClient = {
    writeProviderCredential: async (request: unknown) => {
      requests.push(request);
      return {
        schema: 'kite.local-runtime-credential-result.v1' as const,
        mutationId: 'mutation-1',
        operation: 'write_provider_api_key' as const,
        outcome: response,
        ...(response === 'applied' ? { credentialPresent: true } : {}),
      };
    },
  };
  const appControl = {
    getProviderModelSnapshot: async () => {
      queries += 1;
      return queried;
    },
  } as Pick<KiteAppControlClient, 'getProviderModelSnapshot'> as KiteAppControlClient;
  return {
    credentialClient,
    appControl,
    workspace,
    requests,
    get queries() {
      return queries;
    },
  };
}

describe('first-run client orchestration', () => {
  test('writes through the injected Native client then confirms through App Control', async () => {
    const injected = clients();
    const result = await connectProviderWithKey(
      provider,
      'sk-test-secret',
      provider.defaultBaseURL,
      injected,
    );
    expect(result).toEqual({ status: 'connected', modelName: 'gpt-test' });
    expect(injected.queries).toBe(1);
    expect(injected.requests[0]).toMatchObject({
      operation: 'write_provider_api_key',
      providerId: provider.type,
      apiKey: 'sk-test-secret',
    });
  });

  test('queries once after an unknown outcome and requires explicit continuation', async () => {
    const injected = clients('outcome_unknown');
    const result = await connectProviderWithKey(
      provider,
      'sk-test-secret',
      provider.defaultBaseURL,
      injected,
    );
    expect(result).toMatchObject({ status: 'outcome-unknown', modelName: 'gpt-test' });
    expect(injected.queries).toBe(1);
    expect(injected.requests).toHaveLength(1);
  });

  test('treats a lost Native response as unknown and queries without replaying the write', async () => {
    let requests = 0;
    let queries = 0;
    const injected: FirstRunProviderClients = {
      credentialClient: {
        writeProviderCredential: async () => {
          requests += 1;
          throw new Error('transport closed');
        },
      },
      appControl: {
        getProviderModelSnapshot: async () => {
          queries += 1;
          return snapshot();
        },
      } as Pick<KiteAppControlClient, 'getProviderModelSnapshot'> as KiteAppControlClient,
      workspace,
    };
    const result = await connectProviderWithKey(
      provider,
      'sk-test-secret',
      provider.defaultBaseURL,
      injected,
    );
    expect(result).toMatchObject({ status: 'outcome-unknown', modelName: 'gpt-test' });
    expect(requests).toBe(1);
    expect(queries).toBe(1);
  });

  test('manual model is an explicit Native request and still requires App Control confirmation', async () => {
    const injected = clients();
    const result = await saveManualProviderModel(
      provider,
      'sk-test-secret',
      'https://api.deepseek.com/v1',
      'deepseek-custom',
      injected,
    );
    expect(result).toEqual({ status: 'connected', modelName: 'gpt-test' });
    expect(injected.requests[0]).toMatchObject({ modelName: 'deepseek-custom' });
    expect(injected.queries).toBe(1);
  });
});
