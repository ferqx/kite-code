import { expect, test } from 'bun:test';
import type { AgentClient, ModelSettingsRequest, ProviderSettingsRequest } from '@kite-ai/client';
import { ClientError } from '@kite-ai/client';
import { createTuiOnboardingPort } from '../host/tui-onboarding';

function fixture() {
  const writes: string[] = [],
    mutations = new Map<string, unknown>();
  let enabled = false,
    defaultModelId: string | null = null,
    hasModel = false;
  let failRead = false;
  const readSet = { userEtag: 'u', workspaceEtag: 'w', explicitDigest: 'e', effectiveDigest: 'd' };
  const client = {
    getWorkspaceTrust: async () => ({
      trusted: true,
      readScopes: [],
      revision: '1',
      canonicalIdentity: 'workspace',
      externalReadScopeDigest: 'scope',
    }),
    getProviderSettings: async () => ({
      readSet: { ...readSet, workspaceEtag: null },
      errors: [],
      providers: [
        {
          id: 'deepseek',
          connections: hasModel
            ? [{ id: 'exact-connection', baseURL: 'https://api.deepseek.com/v1', canWrite: true }]
            : [],
        },
      ],
    }),
    getModelSettings: async () => ({
      readSet,
      errors: [],
      defaultModelId,
      models: hasModel
        ? [
            {
              id: 'new-model',
              model: 'discovered',
              provider: 'deepseek',
              connectionId: 'exact-connection',
              configured: true,
              enabled,
            },
          ]
        : [],
    }),
    discoverProviderSettings: async (
      request: import('@kite-ai/client').ProviderDiscoveryRequest,
      options: { signal?: AbortSignal } = {},
    ) => {
      options.signal?.throwIfAborted();
      expect(request.secret).toBe('secret-only-memory');
      expect(request.expectedReadSet).toEqual({ ...readSet, workspaceEtag: null });
      expect(writes).toEqual([]);
      return {
        storeId: request.expectedStoreId,
        readSet: request.expectedReadSet,
        operation: request.operation,
        modelNames: ['discovered'],
      };
    },
    updateProviderSettings: async (request: ProviderSettingsRequest) => {
      writes.push('provider');
      expect(request.secret).toBe('secret-only-memory');
      expect(request.operation.modelNames).toEqual(['discovered']);
      hasModel = true;
      mutations.set(request.commandId, {
        commandId: request.commandId,
        kind: 'provider_settings.update',
        state: 'applied',
        originStoreId: 'store',
        scope: 'user',
        ifMatch: request.expectedReadSet.userEtag,
        providerSettings: {
          expectedReadSet: request.expectedReadSet,
          operation: request.operation,
        },
        receipt: {
          status: 'applied',
          etag: 'published',
          credentialState: 'stored',
          configurationState: 'published',
        },
      });
    },
    updateModelSettings: async (_scope: string, request: ModelSettingsRequest) => {
      expect(request.expectedReadSet).toEqual(readSet);
      expect(request.operation.modelId).toBe('new-model');
      writes.push(request.operation.kind);
      if (request.operation.kind === 'enabled') enabled = true;
      else defaultModelId = 'new-model';
      mutations.set(request.commandId, {
        commandId: request.commandId,
        kind: 'model_settings.update',
        state: 'applied',
        originStoreId: 'store',
        scope: 'user',
        ifMatch: request.expectedReadSet.userEtag,
        modelSettings: { expectedReadSet: request.expectedReadSet, operation: request.operation },
        receipt: { status: 'applied', etag: 'published' },
      });
    },
    getHostMutation: async (id: string) => {
      if (failRead) throw Error('lost');
      return mutations.get(id);
    },
  };
  return {
    client: client as unknown as AgentClient,
    writes,
    setExistingConnection() {
      hasModel = true;
    },
    setFailRead(value: boolean) {
      failRead = value;
    },
  };
}
test('first run publishes provider then enables and selects the exact new model using fresh read sets', async () => {
  const source = fixture(),
    port = createTuiOnboardingPort(source.client, 'store');
  const result = await port.connect('workspace', {
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: 'secret-only-memory',
  });
  expect(result).toEqual({ status: 'ready', modelName: 'discovered' });
  expect(source.writes).toEqual(['provider', 'enabled', 'default']);
  expect(JSON.stringify(result)).not.toContain('secret-only-memory');
});
test('lost original response blocks resubmission; recover is GET only, explicit resume continues remaining legs', async () => {
  const source = fixture(),
    port = createTuiOnboardingPort(source.client, 'store');
  source.setFailRead(true);
  const input = {
    provider: 'deepseek' as const,
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: 'secret-only-memory',
  };
  expect(await port.connect('workspace', input)).toEqual({ status: 'unknown' });
  expect(await port.connect('workspace', input)).toEqual({ status: 'unknown' });
  expect(await port.recover('other-workspace')).toEqual({ status: 'unknown' });
  expect(source.writes).toEqual(['provider']);
  source.setFailRead(false);
  expect(await port.recover('workspace')).toEqual({ status: 'unknown', canContinue: true });
  expect(source.writes).toEqual(['provider']);
  expect(await port.resume('workspace')).toEqual({ status: 'ready', modelName: 'discovered' });
  expect(source.writes).toEqual(['provider', 'enabled', 'default']);
});
test('untrusted read never loads model configuration and a failed trust original never grants readiness', async () => {
  let modelReads = 0,
    writes = 0;
  const client = {
    getWorkspaceTrust: async () => ({
      trusted: false,
      readScopes: [{ kind: 'home', description: 'read HOME' }],
      revision: '2',
      canonicalIdentity: 'exact',
      externalReadScopeDigest: 'digest',
    }),
    getModelSettings: async () => {
      modelReads++;
      throw Error('must not read');
    },
    setWorkspaceTrust: async (
      _id: string,
      request: {
        commandId: string;
        ifRevision: string;
        canonicalIdentity: string;
        externalReadScopeDigest: string;
      },
    ) => {
      writes++;
      expect(request.ifRevision).toBe('2');
      expect(request.canonicalIdentity).toBe('exact');
      expect(request.externalReadScopeDigest).toBe('digest');
      return {};
    },
    getPermissionMutation: async (id: string) => ({
      commandId: id,
      kind: 'workspace.trust',
      state: 'failed',
      receipt: { status: 'failed' },
    }),
  } as unknown as AgentClient;
  const port = createTuiOnboardingPort(client, 'store');
  expect(await port.read('workspace')).toEqual({
    trusted: false,
    hasModels: false,
    readScopes: [{ kind: 'home', description: 'read HOME' }],
  });
  expect(await port.trust('workspace')).toEqual({
    status: 'failed',
    code: 'configuration_write_failed',
  });
  expect(writes).toBe(1);
  expect(modelReads).toBe(0);
});

test('an existing connection selects its exact model identity despite an earlier same-name provider model', async () => {
  const source = fixture();
  source.setExistingConnection();
  const original = source.client.getModelSettings.bind(source.client);
  source.client.getModelSettings = async (...args) => {
    const state = await original(...args);
    return {
      ...state,
      models: [
        {
          id: 'wrong-model',
          model: 'discovered',
          provider: 'deepseek',
          connectionId: 'other-connection',
          enabled: false,
          configured: true,
          diagnostics: [],
        },
        ...state.models,
      ],
    };
  };
  const result = await createTuiOnboardingPort(source.client, 'store').connect('workspace', {
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: 'secret-only-memory',
  });
  expect(result).toEqual({ status: 'ready', modelName: 'discovered' });
  expect(source.writes).toEqual(['provider', 'enabled', 'default']);
});

test('existing disabled model can be enabled and selected without a provider or credential write', async () => {
  const source = fixture();
  source.setExistingConnection();
  const port = createTuiOnboardingPort(source.client, 'store');
  const observed = await port.read('workspace');
  expect(observed.modelName).toBeUndefined();
  expect(observed.models?.[0]).toEqual({
    id: 'new-model',
    name: 'discovered',
    enabled: false,
    configured: true,
  });
  expect(await port.selectModel('workspace', 'new-model')).toEqual({
    status: 'ready',
    modelName: 'discovered',
  });
  expect(source.writes).toEqual(['enabled', 'default']);
});
test('an applied response for another model marker remains unknown until the exact original GET is verified', async () => {
  const source = fixture(),
    original = source.client.getHostMutation.bind(source.client);
  let wrong = true;
  source.client.getHostMutation = async (...args) => {
    const state = await original(...args);
    return wrong && state.kind === 'model_settings.update'
      ? {
          ...state,
          modelSettings: {
            ...state.modelSettings!,
            operation: { kind: 'enabled', modelId: 'other-model', enabled: true },
          },
        }
      : state;
  };
  const port = createTuiOnboardingPort(source.client, 'store');
  expect(
    await port.connect('workspace', {
      provider: 'deepseek',
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'secret-only-memory',
    }),
  ).toEqual({ status: 'unknown' });
  expect(source.writes).toEqual(['provider', 'enabled']);
  expect(await port.resume('workspace')).toEqual({ status: 'unknown' });
  wrong = false;
  expect(await port.recover('workspace')).toEqual({ status: 'unknown', canContinue: true });
  expect(source.writes).toEqual(['provider', 'enabled']);
  expect(await port.resume('workspace')).toEqual({ status: 'ready', modelName: 'discovered' });
  expect(source.writes).toEqual(['provider', 'enabled', 'default']);
});

test('a known input rejection remains editable rather than an unresolvable unknown mutation', async () => {
  const source = fixture(),
    write = source.client.updateProviderSettings.bind(source.client);
  source.client.updateProviderSettings = async () => {
    throw new ClientError('invalid_provider_endpoint', 'Invalid endpoint', 400);
  };
  const port = createTuiOnboardingPort(source.client, 'store');
  const input = {
    provider: 'deepseek' as const,
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: 'secret-only-memory',
  };
  expect(await port.connect('workspace', input)).toEqual({
    status: 'failed',
    code: 'invalid_provider_endpoint',
  });
  expect(source.writes).toEqual([]);
  source.client.updateProviderSettings = write;
  expect(await port.connect('workspace', input)).toEqual({
    status: 'ready',
    modelName: 'discovered',
  });
  expect(source.writes).toEqual(['provider', 'enabled', 'default']);
});

test('cancelling explicit discovery creates no pending write and a later explicit connection can publish once', async () => {
  const source = fixture();
  let discoveries = 0;
  const original = source.client.discoverProviderSettings.bind(source.client);
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  source.client.discoverProviderSettings = async (_request, options = {}) => {
    discoveries++;
    started();
    return new Promise((_, reject) => {
      options.signal!.addEventListener(
        'abort',
        () => reject(new ClientError('network_outcome_unknown')),
        { once: true },
      );
    });
  };
  const port = createTuiOnboardingPort(source.client, 'store');
  const controller = new AbortController();
  const phases: string[] = [];
  const input = {
    provider: 'deepseek' as const,
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: 'secret-only-memory',
  };
  const pending = port.connect('workspace', input, controller.signal, (phase) =>
    phases.push(phase),
  );
  await entered;
  controller.abort();
  expect(await pending).toEqual({ status: 'cancelled' });
  expect(source.writes).toEqual([]);
  expect(phases).toEqual(['discovering']);
  expect(await port.recover('workspace')).toEqual({ status: 'model-required' });
  source.client.discoverProviderSettings = original;
  expect(await port.connect('workspace', input, undefined, (phase) => phases.push(phase))).toEqual({
    status: 'ready',
    modelName: 'discovered',
  });
  expect(phases).toEqual(['discovering', 'discovering', 'publishing']);
  expect(discoveries).toBe(1);
  expect(source.writes).toEqual(['provider', 'enabled', 'default']);
});
