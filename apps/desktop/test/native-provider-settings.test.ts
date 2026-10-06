import { expect, test } from 'bun:test';
import {
  type AgentClient,
  ClientError,
  type HostMutation,
  type ProviderSettingsRequest,
  type ProviderSettingsView,
} from '@kite-ai/client';
import { NativeConfiguration } from '../electron/configuration';
import { decodeNativeRequest } from '../electron/native-ipc';
import { NativeProviderSettings } from '../electron/provider-settings';
import { memoryPrivateData } from './private-data.fixture';

const view: ProviderSettingsView = {
  storeId: 'store',
  readSet: {
    userEtag: 'a'.repeat(64),
    workspaceEtag: null,
    explicitDigest: 'b'.repeat(64),
    effectiveDigest: 'c'.repeat(64),
  },
  errors: [],
  providers: [
    {
      id: 'openai',
      label: 'OpenAI',
      defaultBaseURL: 'https://api.openai.com/v1',
      requiresCredential: true,
      connections: [],
    },
    {
      id: 'deepseek',
      label: 'DeepSeek',
      defaultBaseURL: 'https://api.deepseek.com',
      requiresCredential: true,
      connections: [],
    },
    {
      id: 'compatible',
      label: 'OpenAI-compatible',
      defaultBaseURL: '',
      requiresCredential: false,
      connections: [],
    },
    {
      id: 'ollama',
      label: 'Ollama',
      defaultBaseURL: 'http://localhost:11434/v1',
      requiresCredential: false,
      connections: [],
    },
  ],
};
const operation: ProviderSettingsRequest['operation'] = {
  provider: 'openai',
  connectionId: null,
  baseURL: 'https://api.openai.com/v1',
  modelNames: ['actual-雪🙂'],
  credential: 'replace',
};
function receipt(input: ProviderSettingsRequest): HostMutation {
  return {
    commandId: input.commandId,
    originStoreId: input.expectedStoreId,
    scope: 'user',
    ifMatch: input.expectedReadSet.userEtag,
    kind: 'provider_settings.update',
    providerSettings: { expectedReadSet: input.expectedReadSet, operation: input.operation },
    state: 'applied',
    receipt: {
      status: 'applied',
      etag: 'd'.repeat(64),
      credentialState: 'stored',
      configurationState: 'published',
      opaqueRef: 'credential:00000000-0000-0000-0000-000000000001',
    },
  };
}
async function rejection(work: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code });
}

test('Native Provider exposes only safe facts and its closed IPC cannot inject vault, file or Store authority', async () => {
  const reader = new NativeProviderSettings(
    {
      getProviderSettings: async () => ({
        ...view,
        secret: 'never-render',
        providers: view.providers.map((provider) => ({
          ...provider,
          credentialRef: 'never-render',
        })),
      }),
    } as unknown as AgentClient,
    () => ({ generation: 1, selection: 1, storeId: 'store', sessionId: 's' }),
    () => {},
  );
  const facts = await reader.read();
  expect(facts.providers).toHaveLength(4);
  expect(JSON.stringify(facts)).not.toContain('never-render');
  expect(JSON.stringify(facts)).not.toContain('explicitDigest');
  reader.cancelRead();
  for (const extra of [
    { expectedStoreId: 'foreign' },
    { credentialRef: 'credential:00000000-0000-0000-0000-000000000001' },
    { path: '/private/config' },
  ]) {
    expect(() =>
      decodeNativeRequest({
        method: 'settings.providers.save',
        generation: 1,
        observationId: 1,
        operation,
        secret: 'hot-key',
        ...extra,
      }),
    ).toThrow('invalid_native_request');
  }
  expect(() =>
    decodeNativeRequest({
      method: 'settings.providers.save',
      generation: 1,
      observationId: 1,
      operation: { ...operation, hidden: true },
      secret: 'hot-key',
    }),
  ).toThrow('invalid_native_request');
  expect(() =>
    decodeNativeRequest({
      method: 'settings.providers.save',
      generation: 1,
      observationId: 1,
      operation: { ...operation, credential: 'none' },
      secret: 'hot-key',
    }),
  ).toThrow('invalid_native_request');
  expect(() =>
    reader.submit(
      facts.observationId,
      { ...operation, baseURL: 'https://provider.invalid/v1?key=hidden' },
      'hot-key',
    ),
  ).toThrow('invalid_provider_endpoint');
});

test('Native one hot Provider POST persists non-secret original intent first; cold recovery only GETs it and blocks competing model saves', async () => {
  const data = memoryPrivateData();
  let scope = { generation: 1, selection: 1, storeId: 'store', sessionId: 's' };
  const writes: ProviderSettingsRequest[] = [],
    gets: unknown[] = [];
  let reject!: (error: Error) => void;
  const transport = new Promise<HostMutation>((_, no) => {
    reject = no;
  });
  let foreignReceipt = true;
  const client = {
    serverInfo: { capabilities: ['configuration_management'] },
    getProviderSettings: async () => structuredClone(view),
    getModelSettings: async () => ({
      storeId: 'store',
      scope: 'user',
      readSet: view.readSet,
      defaultModelId: 'a',
      models: [
        { id: 'a', enabled: true, configured: true, diagnostics: [] },
        { id: 'b', enabled: true, configured: true, diagnostics: [] },
      ],
      errors: [],
    }),
    updateProviderSettings: (input: ProviderSettingsRequest) => {
      expect(data.configurations()[0]?.input.commandId).toBe(input.commandId);
      expect(data.configurations()[0]?.state.phase).toBe('submitting');
      expect(JSON.stringify(data.configurations())).not.toContain('hot-key');
      expect(JSON.stringify(data.configurations())).not.toContain('"secret"');
      writes.push(structuredClone(input));
      return transport;
    },
    getHostMutation: async (commandId: string, options: unknown) => {
      gets.push({ commandId, options });
      return { ...receipt(writes[0]!), ...(foreignReceipt ? { originStoreId: 'foreign' } : {}) };
    },
  } as unknown as AgentClient;
  const reader = new NativeProviderSettings(
    client,
    () => scope,
    () => {},
    data,
  );
  const facts = await reader.read();
  reader.cancelRead(); // Closing/reopening the form keeps the same still-valid observation.
  const mutableOperation = structuredClone(operation);
  const first = reader.submit(facts.observationId, mutableOperation, 'hot-key');
  expect(reader.submit(facts.observationId, mutableOperation, 'hot-key')).toBe(first);
  mutableOperation.modelNames[0] = 'later-edit';
  expect(writes[0]?.operation.modelNames).toEqual(operation.modelNames);
  expect(writes).toHaveLength(1);
  const models = new NativeConfiguration(
    client,
    () => scope,
    () => {},
    data,
  );
  const modelFacts = await models.read('user');
  expect(() => models.submit(modelFacts.observationId, { kind: 'default', modelId: 'b' })).toThrow(
    'configuration_mutation_pending',
  );
  reject(new ClientError('network_outcome_unknown'));
  await rejection(first, 'network_outcome_unknown');
  expect(data.configurations()[0]?.state.phase).toBe('unknown');
  scope = { ...scope, generation: 2, selection: 2, storeId: 'other-store', sessionId: 'other' };
  reader.release();
  const cold = new NativeProviderSettings(
    client,
    () => scope,
    () => {},
    data,
  );
  expect(cold.submissions[0]?.phase).toBe('unknown');
  expect(gets).toHaveLength(0);
  const commandId = writes[0]!.commandId;
  await rejection(cold.lookup(commandId), 'network_outcome_unknown');
  expect(data.configurations()).toHaveLength(1);
  foreignReceipt = false;
  expect(await cold.lookup(commandId)).toMatchObject({
    phase: 'applied',
    storeId: 'store',
    credentialState: 'stored',
    configurationState: 'published',
  });
  expect(data.configurations()).toHaveLength(0);
  expect(gets).toEqual(
    Array.from({ length: 2 }, () => ({ commandId, options: { storeId: 'store' } })),
  );
  expect(writes).toHaveLength(1);
  expect(JSON.stringify(cold.submissions)).not.toContain('credential:');
  expect(JSON.stringify(cold.submissions)).not.toContain('hot-key');
});

test('Native Provider retains separate known credential/config outcomes and refuses to POST when private intent persistence fails', async () => {
  const scope = { generation: 1, selection: 1, storeId: 'store', sessionId: 's' };
  let writes = 0;
  const client = {
    getProviderSettings: async () => structuredClone(view),
    updateProviderSettings: async (input: ProviderSettingsRequest) => {
      writes++;
      return {
        ...receipt(input),
        state: 'failed',
        receipt: {
          status: 'failed',
          code: 'configuration_read_set_conflict',
          credentialState: 'stored',
          configurationState: 'not_attempted',
          opaqueRef: 'credential:00000000-0000-0000-0000-000000000001',
        },
      };
    },
  } as unknown as AgentClient;
  const data = memoryPrivateData(),
    reader = new NativeProviderSettings(
      client,
      () => scope,
      () => {},
      data,
    );
  const facts = await reader.read();
  expect(await reader.submit(facts.observationId, operation, 'hot-key')).toMatchObject({
    phase: 'failed',
    credentialState: 'stored',
    configurationState: 'not_attempted',
    error: 'configuration_read_set_conflict',
  });
  expect(data.configurations()).toHaveLength(0);
  expect(JSON.stringify(reader.submissions)).not.toContain('credential:');
  const broken = new NativeProviderSettings(
    client,
    () => scope,
    () => {},
    {
      ...memoryPrivateData(),
      saveConfiguration() {
        throw new ClientError('configuration_storage_unavailable');
      },
    },
  );
  const observed = await broken.read();
  expect(() => broken.submit(observed.observationId, operation, 'hot-key')).toThrow(
    'configuration_storage_unavailable',
  );
  expect(writes).toBe(1);
});
