import { expect, test } from 'bun:test';
import {
  type AgentClient,
  ClientError,
  type HostMutation,
  type ModelSettingsRequest,
  type ModelSettingsView,
} from '@kite-ai/client';
import { NativeConfiguration } from '../electron/configuration';
import { decodeNativeRequest } from '../electron/native-ipc';

const base: ModelSettingsView = {
  storeId: 'store',
  scope: 'user',
  readSet: {
    userEtag: 'a'.repeat(64),
    workspaceEtag: null,
    explicitDigest: 'b'.repeat(64),
    effectiveDigest: 'c'.repeat(64),
  },
  defaultModelId: 'model-a',
  models: [
    {
      id: 'model-a',
      provider: 'compatible',
      model: 'A',
      enabled: true,
      configured: true,
      diagnostics: [],
    },
    {
      id: 'model-b',
      provider: 'compatible',
      model: 'B',
      enabled: true,
      configured: true,
      diagnostics: [],
    },
    { id: 'model-c', enabled: false, configured: false, diagnostics: ['model_unconfigured'] },
  ],
  errors: [],
};
const receipt = (
  input: ModelSettingsRequest,
  scope: 'user' | 'workspace' = 'user',
): HostMutation => ({
  commandId: input.commandId,
  originStoreId: input.expectedStoreId,
  scope,
  ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  ifMatch: scope === 'user' ? input.expectedReadSet.userEtag : input.expectedReadSet.workspaceEtag!,
  kind: 'model_settings.update',
  modelSettings: {
    expectedReadSet: structuredClone(input.expectedReadSet),
    operation: structuredClone(input.operation),
  },
  state: 'applied',
  receipt: { status: 'applied', etag: 'd'.repeat(64) },
});
test('Native model settings projects safe facts; main derives original project and closed IPC denies injected authority', async () => {
  const calls: unknown[] = [];
  const scope = { generation: 1, selection: 1, storeId: 'store', sessionId: 's' };
  let broken = false;
  const client = {
    serverInfo: { capabilities: ['configuration_management'] },
    getView: async () => ({ storeId: 'store', session: { id: 's', workspaceId: 'w' } }),
    getModelSettings: async (
      location: 'user' | 'workspace',
      options: { storeId: string; workspaceId?: string },
    ) => {
      calls.push({ location, storeId: options.storeId, workspaceId: options.workspaceId });
      return {
        ...base,
        scope: location,
        ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
        privateUnknownField: 'NEVER_IN_RENDERER',
        ...(broken ? { readSet: null, models: [], errors: ['invalid_jsonc'] } : {}),
      };
    },
  } as unknown as AgentClient;
  const reader = new NativeConfiguration(client, () => scope);
  const user = await reader.read('user');
  expect(user.models).toEqual(base.models);
  expect(user.canWrite).toBe(true);
  expect(JSON.stringify(user)).not.toContain('NEVER_IN_RENDERER');
  expect(JSON.stringify(user)).not.toContain('explicitDigest');
  user.models[0]!.enabled = false;
  expect(reader.observation?.models[0]?.enabled).toBe(true);
  await reader.read('workspace');
  expect(calls).toEqual([
    { location: 'user', storeId: 'store', workspaceId: undefined },
    { location: 'workspace', storeId: 'store', workspaceId: 'w' },
  ]);
  broken = true;
  expect(await reader.read('user')).toMatchObject({
    canWrite: false,
    models: [],
    errors: ['invalid_jsonc'],
  });
  for (const input of [
    { method: 'settings.models.read', generation: 1, scope: 'workspace', workspaceId: 'injected' },
    { method: 'settings.models.read', generation: 1, scope: 'foreign' },
    {
      method: 'settings.models.default',
      generation: 1,
      observationId: 1,
      modelId: 'b',
      expectedStoreId: 'other',
    },
    {
      method: 'settings.models.enabled',
      generation: 1,
      observationId: 1,
      modelId: 'b',
      enabled: 'yes',
    },
    { method: 'settings.models.lookup', generation: 1, commandId: 'c', storeId: 'other' },
  ])
    expect(() => decodeNativeRequest(input)).toThrow('invalid_native_request');
  expect(
    decodeNativeRequest({
      method: 'settings.models.default',
      generation: 1,
      observationId: 1,
      modelId: 'model-b',
    }),
  ).toMatchObject({ modelId: 'model-b' });
  reader.release();
});

test('Native model configuration close aborts GET and late selection cannot publish old facts', async () => {
  let release!: () => void, entered!: () => void, signal!: AbortSignal;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let scope = { generation: 1, selection: 1, storeId: 'store', sessionId: 's' };
  const reader = new NativeConfiguration(
    {
      serverInfo: { capabilities: ['configuration_management'] },
      getModelSettings: async (_location: string, options: { signal: AbortSignal }) => {
        signal = options.signal;
        entered();
        await gate;
        return base;
      },
    } as unknown as AgentClient,
    () => scope,
  );
  const reading = reader.read('user').then(
    () => 'unexpected',
    (error) => (error.name === 'AbortError' ? error.name : error.code),
  );
  await ready;
  scope = { ...scope, selection: 2, sessionId: 'other' };
  reader.release();
  expect(signal.aborted).toBe(true);
  release();
  expect(await reading).toBe('AbortError');
  expect(reader.observation).toBeUndefined();
  const unavailable = new NativeConfiguration(
    { serverInfo: { capabilities: [] } } as unknown as AgentClient,
    () => scope,
  );
  await expect(unavailable.read('user')).rejects.toMatchObject({ code: 'capability_unavailable' });
});

test('Native settings lost receipt keeps original read set and command across selection changes; duplicate only sends once', async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise<HostMutation>((_, no) => {
    reject = no;
  });
  let scope = { generation: 1, selection: 1, storeId: 'store', sessionId: 's' };
  const writes: ModelSettingsRequest[] = [],
    gets: unknown[] = [];
  let notifications = 0;
  const reader = new NativeConfiguration(
    {
      serverInfo: { capabilities: ['configuration_management'] },
      getModelSettings: async () => structuredClone(base),
      updateModelSettings: (_scope: string, input: ModelSettingsRequest) => {
        writes.push(structuredClone(input));
        return pending;
      },
      getHostMutation: async (commandId: string, options: unknown) => {
        gets.push({ commandId, options });
        return receipt(writes[0]!);
      },
    } as unknown as AgentClient,
    () => scope,
    () => notifications++,
  );
  const facts = await reader.read('user');
  expect(() =>
    reader.submit(facts.observationId, { kind: 'enabled', modelId: 'model-a', enabled: false }),
  ).toThrow('model_settings_default_disable_denied');
  expect(() => reader.submit(facts.observationId, { kind: 'default', modelId: 'model-c' })).toThrow(
    'model_settings_model_unconfigured',
  );
  const operation = { kind: 'default' as const, modelId: 'model-b' };
  const first = reader.submit(facts.observationId, operation);
  expect(reader.submit(facts.observationId, operation)).toBe(first);
  operation.modelId = 'mutated';
  expect(writes).toHaveLength(1);
  expect(writes[0]?.operation.modelId).toBe('model-b');
  expect(writes[0]?.expectedReadSet).toEqual(base.readSet!);
  scope = { ...scope, storeId: 'other-store', sessionId: 'other', selection: 2 };
  reader.release();
  reject(new ClientError('network_outcome_unknown'));
  await expect(first).rejects.toMatchObject({ code: 'network_outcome_unknown' });
  const original = reader.submissions[0]!;
  expect(original).toMatchObject({
    phase: 'unknown',
    storeId: 'store',
    operation: { kind: 'default', modelId: 'model-b' },
  });
  expect((await reader.lookup(original.commandId)).phase).toBe('applied');
  expect(gets).toEqual([{ commandId: writes[0]!.commandId, options: { storeId: 'store' } }]);
  expect(writes).toHaveLength(1);
  expect(notifications).toBe(3);
  expect(reader.observation).toBeUndefined();
  expect(() => reader.lookup('injected')).toThrow('configuration_intent_missing');
});

test('Native settings pending blocks same scope; mismatched receipts stay unknown; CAS failure requires new observed intent', async () => {
  const scope = { generation: 1, selection: 1, storeId: 'store', sessionId: 's' };
  let writes = 0,
    mismatch = true;
  const reader = new NativeConfiguration(
    {
      serverInfo: { capabilities: ['configuration_management'] },
      getModelSettings: async () => structuredClone(base),
      updateModelSettings: async (_scope: string, input: ModelSettingsRequest) => {
        writes++;
        if (mismatch) return { ...receipt(input), originStoreId: 'foreign' };
        return {
          ...receipt(input),
          state: 'failed',
          receipt: { status: 'failed', code: 'configuration_conflict' },
        };
      },
      getHostMutation: async () => {
        throw new ClientError('store_mismatch');
      },
    } as unknown as AgentClient,
    () => scope,
  );
  const facts = await reader.read('user');
  await expect(
    reader.submit(facts.observationId, { kind: 'default', modelId: 'model-b' }),
  ).rejects.toMatchObject({ code: 'network_outcome_unknown' });
  expect(reader.submissions[0]?.phase).toBe('unknown');
  const refreshed = await reader.read('user');
  expect(() =>
    reader.submit(refreshed.observationId, { kind: 'enabled', modelId: 'model-c', enabled: true }),
  ).toThrow('configuration_mutation_pending');
  await expect(reader.lookup(reader.submissions[0]!.commandId)).rejects.toMatchObject({
    code: 'store_mismatch',
  });
  expect(reader.submissions[0]?.phase).toBe('unknown');
  expect(writes).toBe(1);
  // Independent controller observes a definitive server rejection; it never resends that intent.
  mismatch = false;
  const other = new NativeConfiguration(
    {
      serverInfo: { capabilities: ['configuration_management'] },
      getModelSettings: async () => structuredClone(base),
      updateModelSettings: async (_scope: string, input: ModelSettingsRequest) => ({
        ...receipt(input),
        state: 'failed',
        receipt: { status: 'failed', code: 'configuration_conflict' },
      }),
    } as unknown as AgentClient,
    () => scope,
  );
  const observed = await other.read('user');
  expect(
    await other.submit(observed.observationId, { kind: 'default', modelId: 'model-b' }),
  ).toMatchObject({ phase: 'failed', error: 'configuration_conflict' });
  expect(() =>
    other.submit(observed.observationId, { kind: 'default', modelId: 'model-b' }),
  ).toThrow('configuration_intent_consumed');
});
