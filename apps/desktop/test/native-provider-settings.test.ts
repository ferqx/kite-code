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
    {
      id: 'codex',
      label: 'ChatGPT / Codex',
      defaultBaseURL: 'https://chatgpt.com/backend-api/codex',
      requiresCredential: false,
      connections: [],
    },
  ],
};
const operation: ProviderSettingsRequest['operation'] = {
  provider: 'openai',
  protocol: 'responses',
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
  expect(facts.providers).toHaveLength(5);
  expect(
    decodeNativeRequest({
      method: 'settings.providers.save',
      generation: 1,
      observationId: 1,
      operation,
      secret: 'hot-key',
    }),
  ).toMatchObject({ operation: { protocol: 'responses' } });
  for (const protocol of ['automatic', null, ['responses']])
    expect(() =>
      decodeNativeRequest({
        method: 'settings.providers.save',
        generation: 1,
        observationId: 1,
        operation: { ...operation, protocol },
        secret: 'hot-key',
      }),
    ).toThrow('invalid_native_request');
  for (const provider of ['deepseek', 'ollama'])
    expect(() =>
      decodeNativeRequest({
        method: 'settings.providers.save',
        generation: 1,
        observationId: 1,
        operation: { ...operation, provider },
        secret: 'hot-key',
      }),
    ).toThrow('invalid_native_request');
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

test('Native local Codex facts stay read-only and cannot submit a manual credential or endpoint', async () => {
  const source = structuredClone(view);
  source.providers.find((provider) => provider.id === 'codex')!.connections = [
    {
      id: 'e'.repeat(64),
      name: 'ChatGPT / Codex（本机）',
      baseURL: 'https://chatgpt.com/backend-api/codex',
      protocol: 'responses',
      hasCredential: true,
      modelNames: ['fixture-codex-model'],
      modelIds: ['local-codex-model'],
      defaultModelIds: [],
      // Main enforces source ownership even if malformed facts claim the source is writable.
      canWrite: true,
    },
  ];
  let writes = 0;
  const reader = new NativeProviderSettings(
    {
      getProviderSettings: async () => structuredClone(source),
      updateProviderSettings: async () => {
        writes++;
        throw Error('unexpected_codex_write');
      },
    } as unknown as AgentClient,
    () => ({ generation: 1, selection: 1, storeId: 'store', sessionId: 's' }),
    () => {},
  );
  const facts = await reader.read();
  const codex = facts.providers.find((provider) => provider.id === 'codex')!;
  expect(codex.connections[0]).toMatchObject({
    protocol: 'responses',
    canWrite: false,
    modelNames: ['fixture-codex-model'],
  });
  const intent: ProviderSettingsRequest['operation'] = {
    provider: 'codex',
    protocol: 'responses',
    connectionId: codex.connections[0]!.id,
    baseURL: 'https://chatgpt.com/backend-api/codex',
    modelNames: ['fixture-codex-model'],
    credential: 'none',
  };
  expect(
    decodeNativeRequest({
      method: 'settings.providers.save',
      generation: 1,
      observationId: facts.observationId,
      operation: intent,
    }),
  ).toMatchObject({ operation: { provider: 'codex', protocol: 'responses' } });
  for (const protocol of [undefined, 'chat-completions'])
    expect(() =>
      decodeNativeRequest({
        method: 'settings.providers.save',
        generation: 1,
        observationId: facts.observationId,
        operation: { ...intent, protocol },
      }),
    ).toThrow('invalid_native_request');
  for (const edit of [
    intent,
    { ...intent, baseURL: 'https://other.invalid/v1' },
    { ...intent, kind: 'remove' as const, modelNames: [] },
  ])
    expect(() => reader.submit(facts.observationId, edit)).toThrow('provider_settings_override');
  expect(() =>
    reader.submit(facts.observationId, { ...intent, credential: 'replace' }, 'fixture-private'),
  ).toThrow('provider_settings_override');
  expect(writes).toBe(0);
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
  const modelFacts = await models.read();
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

test('Native Provider deletion protects fresh default, scheduled and unfinished-run references and never includes a secret', async () => {
  const data = memoryPrivateData();
  const currentView = structuredClone(view);
  const connection = {
    id: 'e'.repeat(64),
    name: 'Local daily models',
    baseURL: 'http://localhost:11434/v1',
    protocol: 'chat-completions' as const,
    hasCredential: false,
    modelNames: ['local'],
    modelIds: ['local-model'],
    defaultModelIds: [] as string[],
    canWrite: true,
  };
  currentView.providers.find((p) => p.id === 'ollama')!.connections.push(connection);
  const writes: ProviderSettingsRequest[] = [];
  const manager = new NativeProviderSettings(
    {
      getProviderSettings: async () => structuredClone(currentView),
      updateProviderSettings: async (input: ProviderSettingsRequest) => {
        writes.push(input);
        return {
          ...receipt(input),
          receipt: {
            status: 'applied',
            credentialState: 'unchanged',
            configurationState: 'published',
          },
        };
      },
    } as unknown as AgentClient,
    () => ({ generation: 1, selection: 1, storeId: 'store' }),
    () => {},
    data,
  );
  const remove: ProviderSettingsRequest['operation'] = {
    kind: 'remove',
    provider: 'ollama',
    connectionId: connection.id,
    baseURL: connection.baseURL,
    modelNames: [],
    credential: 'none',
  };
  let facts = await manager.read();
  expect(facts.providers[3]!.connections[0]).toMatchObject({
    name: connection.name,
    scheduledTaskNames: [],
  });
  const task = data.saveScheduledTask({
    name: 'Morning report',
    storeId: 'store',
    workspaceId: 'work',
    modelId: 'local-model',
    prompt: 'test-only',
    enabled: false,
    schedule: { frequency: 'daily', time: '09:00', timeZone: 'UTC' },
  });
  expect(() => manager.submit(facts.observationId, remove)).toThrow(
    'provider_scheduled_model_in_use',
  );
  facts = await manager.read();
  expect(facts.providers[3]!.connections[0]?.scheduledTaskNames).toEqual(['Morning report']);
  const run = data.claimScheduledTask(task.id, Date.now(), { manual: true, storeId: 'store' })!;
  data.saveScheduledTask({
    id: task.id,
    name: task.name,
    storeId: task.storeId,
    workspaceId: task.workspaceId,
    modelId: 'other-model',
    prompt: task.prompt,
    enabled: false,
    schedule: task.schedule,
  });
  expect(() => manager.submit(facts.observationId, remove)).toThrow(
    'provider_scheduled_model_in_use',
  );
  data.updateScheduledTaskRun(run.id, { status: 'cancelled', settlementVersion: 1 });
  data.deleteScheduledTask(task.id);
  connection.defaultModelIds = ['local-model'];
  facts = await manager.read();
  expect(() => manager.submit(facts.observationId, remove)).toThrow(
    'provider_default_model_in_use',
  );
  connection.defaultModelIds = [];
  facts = await manager.read();
  expect(() => manager.submit(facts.observationId, remove, 'must-never-transmit')).toThrow(
    'invalid_request',
  );
  expect(await manager.submit(facts.observationId, remove)).toMatchObject({
    phase: 'applied',
    credentialState: 'unchanged',
  });
  expect(writes).toHaveLength(1);
  expect(writes[0]).not.toHaveProperty('secret');
  expect(writes[0]?.operation).toEqual(remove);
  expect(data.scheduledTasks()).toHaveLength(0);
});

test('Native Provider delete persists its original identity, locks scheduling on unknown and cold lookup sends no second mutation', async () => {
  const data = memoryPrivateData();
  const currentView = structuredClone(view);
  currentView.providers[3]!.connections.push({
    id: 'e'.repeat(64),
    name: 'Local',
    baseURL: 'http://localhost:11434/v1',
    protocol: 'chat-completions',
    hasCredential: false,
    modelNames: ['local'],
    modelIds: ['local-model'],
    defaultModelIds: [],
    canWrite: true,
  });
  const writes: ProviderSettingsRequest[] = [];
  const gets: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = {
    getProviderSettings: async () => structuredClone(currentView),
    updateProviderSettings: async (input: ProviderSettingsRequest) => {
      writes.push(structuredClone(input));
      await gate;
      throw new ClientError('network_outcome_unknown');
    },
    getHostMutation: async (id: string) => {
      gets.push(id);
      return {
        ...receipt(writes[0]!),
        receipt: {
          status: 'applied',
          credentialState: 'unchanged',
          configurationState: 'published',
        },
      };
    },
  } as unknown as AgentClient;
  const scope = () => ({ generation: 1, selection: 1, storeId: 'store' });
  const manager = new NativeProviderSettings(client, scope, () => {}, data);
  const facts = await manager.read();
  const remove: ProviderSettingsRequest['operation'] = {
    kind: 'remove',
    name: 'Local',
    provider: 'ollama',
    connectionId: 'e'.repeat(64),
    baseURL: 'http://localhost:11434/v1',
    modelNames: [],
    credential: 'none',
  };
  expect(
    decodeNativeRequest({
      method: 'settings.providers.save',
      generation: 1,
      observationId: 1,
      operation: remove,
    }),
  ).toMatchObject({ operation: remove });
  for (const operation of [
    { ...remove, connectionId: null },
    { ...remove, credential: 'keep' },
    { ...remove, kind: 'purge' },
    { ...remove, name: 'bad\nname' },
  ])
    expect(() =>
      decodeNativeRequest({
        method: 'settings.providers.save',
        generation: 1,
        observationId: 1,
        operation,
      }),
    ).toThrow('invalid_native_request');
  const first = manager.submit(facts.observationId, remove);
  expect(manager.submit(facts.observationId, remove)).toBe(first);
  expect(() => manager.assertSchedulingAllowed()).toThrow('configuration_mutation_pending');
  release();
  await rejection(first, 'network_outcome_unknown');
  const cold = new NativeProviderSettings(client, scope, () => {}, data);
  expect(() => cold.assertSchedulingAllowed()).toThrow('configuration_mutation_pending');
  expect(gets).toHaveLength(0);
  expect(await cold.lookup(writes[0]!.commandId)).toMatchObject({ phase: 'applied' });
  expect(() => cold.assertSchedulingAllowed()).not.toThrow();
  expect(gets).toEqual([writes[0]!.commandId]);
  expect(writes).toHaveLength(1);
});
