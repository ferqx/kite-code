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
import { NativeModelToggleQueue } from '../src/native-model-toggle-queue';

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
      protocol: 'chat-completions',
      model: 'A',
      enabled: true,
      configured: true,
      diagnostics: [],
    },
    {
      id: 'model-b',
      provider: 'compatible',
      protocol: 'responses',
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
test('Native model settings always read user facts and closed IPC denies project scope or injected authority', async () => {
  const calls: unknown[] = [];
  const scope = { generation: 1, selection: 1, storeId: 'store', sessionId: 's' };
  let broken = false;
  const client = {
    serverInfo: { capabilities: ['configuration_management'] },
    getView: async () => {
      throw Error('models_must_not_read_workspace');
    },
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
  const user = await reader.read();
  expect(user.models).toEqual(base.models);
  expect(user.canWrite).toBe(true);
  expect(JSON.stringify(user)).not.toContain('NEVER_IN_RENDERER');
  expect(JSON.stringify(user)).not.toContain('explicitDigest');
  user.models[0]!.enabled = false;
  expect(reader.observation?.models[0]?.enabled).toBe(true);
  await reader.read();
  expect(calls).toEqual([
    { location: 'user', storeId: 'store', workspaceId: undefined },
    { location: 'user', storeId: 'store', workspaceId: undefined },
  ]);
  broken = true;
  expect(await reader.read()).toMatchObject({
    canWrite: false,
    models: [],
    errors: ['invalid_jsonc'],
  });
  for (const input of [
    { method: 'settings.models.read', generation: 1, scope: 'workspace' },
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
  const reading = reader.read().then(
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
  await expect(unavailable.read()).rejects.toMatchObject({ code: 'capability_unavailable' });
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
  const facts = await reader.read();
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
  const facts = await reader.read();
  await expect(
    reader.submit(facts.observationId, { kind: 'default', modelId: 'model-b' }),
  ).rejects.toMatchObject({ code: 'network_outcome_unknown' });
  expect(reader.submissions[0]?.phase).toBe('unknown');
  const refreshed = await reader.read();
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
  const observed = await other.read();
  expect(
    await other.submit(observed.observationId, { kind: 'default', modelId: 'model-b' }),
  ).toMatchObject({ phase: 'failed', error: 'configuration_conflict' });
  expect(() =>
    other.submit(observed.observationId, { kind: 'default', modelId: 'model-b' }),
  ).toThrow('configuration_intent_consumed');
});

function successorReceipt(
  input: ModelSettingsRequest,
  postReadSet: NonNullable<ModelSettingsView['readSet']>,
): HostMutation {
  return {
    commandId: input.commandId,
    originStoreId: input.expectedStoreId,
    scope: 'user',
    ifMatch: input.expectedReadSet.userEtag,
    kind: 'model_settings.update',
    modelSettings: {
      expectedReadSet: structuredClone(input.expectedReadSet),
      operation: structuredClone(input.operation),
    },
    state: 'applied',
    receipt: {
      status: 'applied',
      etag: postReadSet.userEtag,
      postReadSet: structuredClone(postReadSet),
    },
  };
}
function continuationFixture() {
  let scope: { generation: number; selection: number; storeId: string; sessionId?: string } = {
    generation: 1,
    selection: 1,
    storeId: 'store',
    sessionId: 's',
  };
  let configuration = structuredClone(base);
  const writes: ModelSettingsRequest[] = [];
  const reads: { storeId: string; signal: AbortSignal }[] = [];
  const originalReceipts = new Map<string, HostMutation>();
  let readGate: Promise<ModelSettingsView> | undefined;
  let transformReceipt = (value: HostMutation) => value;
  const client = {
    serverInfo: { capabilities: ['configuration_management'] },
    getModelSettings: async (_scope: string, input: { storeId: string; signal: AbortSignal }) => {
      reads.push(input);
      return readGate ?? { ...structuredClone(configuration), storeId: input.storeId };
    },
    updateModelSettings: async (_scope: string, input: ModelSettingsRequest) => {
      writes.push(structuredClone(input));
      configuration = {
        ...configuration,
        readSet: {
          ...configuration.readSet!,
          userEtag: String(writes.length + 3).repeat(64),
          effectiveDigest: String(writes.length + 6).repeat(64),
        },
        models: configuration.models.map((model) =>
          input.operation.kind === 'enabled' && model.id === input.operation.modelId
            ? { ...model, enabled: input.operation.enabled }
            : model,
        ),
      };
      const applied = transformReceipt(successorReceipt(input, configuration.readSet!));
      originalReceipts.set(input.commandId, applied);
      return applied;
    },
    getHostMutation: async (commandId: string) => originalReceipts.get(commandId),
  } as unknown as AgentClient;
  const reader = new NativeConfiguration(client, () => scope);
  return {
    reader,
    client,
    writes,
    reads,
    originalReceipts,
    get scope() {
      return scope;
    },
    set scope(value) {
      scope = value;
    },
    get configuration() {
      return configuration;
    },
    set configuration(value) {
      configuration = value;
    },
    set readGate(value: Promise<ModelSettingsView> | undefined) {
      readGate = value;
    },
    set transformReceipt(value: (value: HostMutation) => HostMutation) {
      transformReceipt = value;
    },
  };
}

test('Native model continuation admits two own serial saves only from each exact successor and keeps proof private', async () => {
  const f = continuationFixture();
  const first = await f.reader.read();
  const one = await f.reader.submit(first.observationId, {
    kind: 'enabled',
    modelId: 'model-b',
    enabled: false,
  });
  const second = await f.reader.read(one.commandId);
  expect(second.models.find((model) => model.id === 'model-b')?.enabled).toBe(false);
  const two = await f.reader.submit(second.observationId, {
    kind: 'enabled',
    modelId: 'model-b',
    enabled: true,
  });
  const third = await f.reader.read(two.commandId);
  expect(third.models.find((model) => model.id === 'model-b')?.enabled).toBe(true);
  expect(f.writes).toHaveLength(2);
  expect(f.writes[0]!.expectedReadSet).toEqual(base.readSet!);
  expect(f.writes[1]!.expectedReadSet).toEqual(
    (
      f.originalReceipts.get(one.commandId)!.receipt as {
        postReadSet: NonNullable<ModelSettingsView['readSet']>;
      }
    ).postReadSet,
  );
  expect(f.reads).toHaveLength(3);
  expect(second.observationId).toBeGreaterThan(first.observationId);
  for (const value of [one, two, first, second, third, f.reader.submissions]) {
    const body = JSON.stringify(value);
    for (const privateField of [
      'postReadSet',
      'userEtag',
      'explicitDigest',
      'effectiveDigest',
      'readSet',
    ])
      expect(body).not.toContain(privateField);
  }
});

for (const field of [
  'userEtag',
  'workspaceEtag',
  'explicitDigest',
  'effectiveDigest',
  'missing',
] as const) {
  test(`Native continuation refuses ${field} drift even with identical public model rows and never rebinds old clicks`, async () => {
    const f = continuationFixture();
    const first = await f.reader.read();
    const saved = await f.reader.submit(first.observationId, {
      kind: 'enabled',
      modelId: 'model-b',
      enabled: false,
    });
    const originalModels = structuredClone(f.configuration.models);
    f.configuration = {
      ...f.configuration,
      readSet:
        field === 'missing' ? null : { ...f.configuration.readSet!, [field]: 'f'.repeat(64) },
    };
    expect(f.configuration.models).toEqual(originalModels);
    await expect(f.reader.read(saved.commandId)).rejects.toMatchObject({
      code: 'configuration_continuation_changed',
    });
    expect(f.reader.observation).toBeUndefined();
    expect(() =>
      f.reader.submit(first.observationId, { kind: 'enabled', modelId: 'model-b', enabled: true }),
    ).toThrow('configuration_observation_changed');
    expect(f.writes).toHaveLength(1);
    expect(f.reads).toHaveLength(2);
  });
}

test('missing, old and foreign continuation commands are rejected before touching a fresh observation or active GET', async () => {
  const f = continuationFixture();
  f.transformReceipt = (value) => ({
    ...value,
    receipt: { status: 'applied', etag: 'd'.repeat(64) },
  });
  const first = await f.reader.read();
  const old = await f.reader.submit(first.observationId, {
    kind: 'enabled',
    modelId: 'model-b',
    enabled: false,
  });
  expect(old.phase).toBe('applied');
  const fresh = await f.reader.read();
  for (const commandId of ['not-observed', old.commandId]) {
    await expect(f.reader.read(commandId)).rejects.toMatchObject({
      code: 'configuration_continuation_changed',
    });
    expect(f.reader.observation).toEqual(fresh);
  }
  expect(f.reads).toHaveLength(2);
  let resolve!: (value: ModelSettingsView) => void;
  f.readGate = new Promise((done) => {
    resolve = done;
  });
  const reading = f.reader.read();
  const signal = f.reads.at(-1)!.signal;
  await expect(f.reader.read(old.commandId)).rejects.toMatchObject({
    code: 'configuration_continuation_changed',
  });
  expect(signal.aborted).toBe(false);
  resolve(f.configuration);
  expect((await reading).models).toEqual(f.configuration.models);
  expect(f.writes).toHaveLength(1);
});

for (const field of ['generation', 'selection', 'storeId', 'sessionId'] as const) {
  test(`a prior ${field} scope cannot continue or cancel the new scope observation`, async () => {
    const f = continuationFixture();
    const first = await f.reader.read();
    const saved = await f.reader.submit(first.observationId, {
      kind: 'enabled',
      modelId: 'model-b',
      enabled: false,
    });
    f.scope = { ...f.scope, [field]: typeof f.scope[field] === 'number' ? 2 : 'other' };
    const next = await f.reader.read();
    await expect(f.reader.read(saved.commandId)).rejects.toMatchObject({
      code: 'configuration_continuation_changed',
    });
    expect(f.reader.observation).toEqual(next);
    expect(f.writes).toHaveLength(1);
    expect(f.reads).toHaveLength(2);
  });
}

test('cold lookup may confirm an original applied result but cannot create hot continuation scope', async () => {
  const f = continuationFixture();
  const first = await f.reader.read();
  const saved = await f.reader.submit(first.observationId, {
    kind: 'enabled',
    modelId: 'model-b',
    enabled: false,
  });
  const cold = new NativeConfiguration(
    f.client,
    () => f.scope,
    () => {},
    {
      configurations: () => [
        { kind: 'model', input: f.writes[0]!, state: { ...saved, phase: 'unknown' } },
      ],
      saveConfiguration() {},
      modelRoute: () => undefined,
      rememberModelRoute() {},
    },
  );
  expect((await cold.lookup(saved.commandId)).phase).toBe('applied');
  const fresh = await cold.read();
  await expect(cold.read(saved.commandId)).rejects.toMatchObject({
    code: 'configuration_continuation_changed',
  });
  expect(cold.observation).toEqual(fresh);
  expect(f.writes).toHaveLength(1);
});

test('malformed or foreign successor evidence stays unknown and cannot be silently treated as proof-less applied', async () => {
  for (const bad of [
    null,
    {},
    { ...base.readSet, userEtag: 'f'.repeat(64) },
    { ...base.readSet, userEtag: '4'.repeat(64), explicitDigest: 'f'.repeat(64) },
    { ...base.readSet, userEtag: '4'.repeat(64), workspaceEtag: 'f'.repeat(64) },
    { ...base.readSet, userEtag: '4'.repeat(64), extra: 'hidden' },
  ]) {
    const f = continuationFixture();
    f.transformReceipt = (value) =>
      ({ ...value, receipt: { ...value.receipt, postReadSet: bad } }) as HostMutation;
    const facts = await f.reader.read();
    await expect(
      f.reader.submit(facts.observationId, { kind: 'enabled', modelId: 'model-b', enabled: false }),
    ).rejects.toMatchObject({ code: 'network_outcome_unknown' });
    expect(f.reader.submissions[0]!.phase).toBe('unknown');
    await expect(f.reader.read(f.reader.submissions[0]!.commandId)).rejects.toMatchObject({
      code: 'configuration_continuation_changed',
    });
    expect(f.writes).toHaveLength(1);
    expect(f.reads).toHaveLength(1);
  }
});

test('closed continuation IPC admits only a bounded original command reference, never read sets or Store authority', () => {
  const input = { method: 'settings.models.read', generation: 1, scope: 'user' } as const;
  expect(decodeNativeRequest({ ...input, afterCommandId: 'own-command_1' })).toEqual({
    ...input,
    afterCommandId: 'own-command_1',
  });
  expect(decodeNativeRequest({ ...input, afterCommandId: 'a'.repeat(128) })).toEqual({
    ...input,
    afterCommandId: 'a'.repeat(128),
  });
  for (const extra of [
    { afterCommandId: '' },
    { afterCommandId: null },
    { afterCommandId: 1 },
    { afterCommandId: 'a'.repeat(129) },
    { afterCommandId: 'foreign/path' },
    { afterCommandId: '雪' },
    { afterCommandId: 'own', readSet: base.readSet },
    { afterCommandId: 'own', expectedReadSet: base.readSet },
    { afterCommandId: 'own', storeId: 'other' },
    { afterCommandId: 'own', postReadSet: base.readSet },
  ])
    expect(() => decodeNativeRequest({ ...input, ...extra })).toThrow('invalid_native_request');
});

for (const state of ['failed', 'outcome_unknown'] as const) {
  test(`a ${state} model receipt never supplies automatic continuation or releases the current observation`, async () => {
    const f = continuationFixture();
    f.transformReceipt = (value) => ({
      ...value,
      state,
      receipt: { status: state, code: 'configuration_conflict' },
    });
    const facts = await f.reader.read();
    const result = await f.reader.submit(facts.observationId, {
      kind: 'enabled',
      modelId: 'model-b',
      enabled: false,
    });
    await expect(f.reader.read(result.commandId)).rejects.toMatchObject({
      code: 'configuration_continuation_changed',
    });
    expect(f.reader.observation).toEqual(facts);
    expect(f.reads).toHaveLength(1);
    expect(f.writes).toHaveLength(1);
  });
}

test('a still-running original POST cannot be used for continuation and no read or second write is dispatched', async () => {
  const f = continuationFixture();
  const update = f.client.updateModelSettings.bind(f.client);
  let resolve!: () => void;
  const gate = new Promise<void>((done) => {
    resolve = done;
  });
  f.client.updateModelSettings = async (...args) => {
    const result = await update(...args);
    await gate;
    return result;
  };
  const facts = await f.reader.read();
  const saving = f.reader.submit(facts.observationId, {
    kind: 'enabled',
    modelId: 'model-b',
    enabled: false,
  });
  const commandId = f.reader.submissions[0]!.commandId;
  await expect(f.reader.read(commandId)).rejects.toMatchObject({
    code: 'configuration_continuation_changed',
  });
  expect(f.reader.observation).toEqual(facts);
  expect(f.reads).toHaveLength(1);
  expect(f.writes).toHaveLength(1);
  resolve();
  expect((await saving).phase).toBe('applied');
});

test('General model read and close preserve a healthy background queue observation through another accepted toggle', async () => {
  const f = continuationFixture();
  const general = new NativeConfiguration(
    f.client,
    () => f.scope,
    () => {},
    undefined,
    true,
  );
  let resolve!: () => void;
  const flush = new Promise<void>((done) => {
    resolve = done;
  });
  const bridge = {
    watch: () => () => {},
    request: async (input: import('../src/native-bridge').NativeRequest) => {
      if (input.method === 'settings.models.read') return f.reader.read(input.afterCommandId);
      if (input.method === 'settings.models.enabled')
        return f.reader.submit(input.observationId, {
          kind: 'enabled',
          modelId: input.modelId,
          enabled: input.enabled,
        });
      if (input.method === 'settings.models.close') {
        f.reader.release();
        return null;
      }
      if (input.method === 'settings.general.models.read') return general.read();
      if (input.method === 'settings.general.models.close') {
        general.release();
        return null;
      }
      throw Error('unexpected_test_request');
    },
  } satisfies import('../src/native-bridge').NativeBridge;
  const queue = new NativeModelToggleQueue(bridge, 1, 'general-lease-test', 'store');
  queue.update({
    blocked: false,
    pending: false,
    unknown: false,
    foreignPending: false,
    hardBlocked: false,
    onSaved: () => flush,
  });
  queue.start();
  const tick = () => new Promise((done) => setTimeout(done, 0));
  try {
    await tick();
    queue.toggle({
      method: 'settings.models.enabled',
      generation: 1,
      observationId: queue.getSnapshot().facts!.observationId,
      modelId: 'model-b',
      enabled: false,
    });
    await tick();
    expect(queue.getSnapshot().writing).toBe(true);
    expect(queue.getSnapshot().healthy).toBe(true);
    const own = f.reader.observation!;
    const displayed = await bridge.request({
      method: 'settings.general.models.read',
      generation: 1,
    });
    expect(displayed).toMatchObject({ kind: 'settings.models', canWrite: false });
    expect(f.reader.observation).toEqual(own);
    await bridge.request({ method: 'settings.general.models.close', generation: 1 });
    expect(f.reader.observation).toEqual(own);
    queue.toggle({
      method: 'settings.models.enabled',
      generation: 1,
      observationId: own.observationId,
      modelId: 'model-b',
      enabled: true,
    });
    resolve();
    await tick();
    await tick();
    expect(f.writes.map((input) => input.operation)).toEqual([
      { kind: 'enabled', modelId: 'model-b', enabled: false },
      { kind: 'enabled', modelId: 'model-b', enabled: true },
    ]);
    expect(queue.getSnapshot().error).toBe('');
    expect(queue.getSnapshot().writing).toBe(false);
    expect(queue.getSnapshot().facts?.canWrite).toBe(true);
    expect(queue.getSnapshot().facts?.models.find((model) => model.id === 'model-b')?.enabled).toBe(
      true,
    );
  } finally {
    resolve();
    queue.detach(true);
    general.release();
  }
});

test('General owns an independent readonly lease: closing it aborts only its GET, never the model continuation reader', async () => {
  const f = continuationFixture();
  const general = new NativeConfiguration(
    f.client,
    () => f.scope,
    () => {},
    undefined,
    true,
  );
  const facts = await f.reader.read();
  const saved = await f.reader.submit(facts.observationId, {
    kind: 'enabled',
    modelId: 'model-b',
    enabled: false,
  });
  let resolve!: (value: ModelSettingsView) => void;
  f.readGate = new Promise((done) => {
    resolve = done;
  });
  const continuation = f.reader.read(saved.commandId);
  const modelSignal = f.reads.at(-1)!.signal;
  const displaying = general.read().catch((cause: unknown) => cause);
  const generalSignal = f.reads.at(-1)!.signal;
  expect(modelSignal === generalSignal).toBe(false);
  general.release();
  expect(generalSignal.aborted).toBe(true);
  expect(modelSignal.aborted).toBe(false);
  resolve(f.configuration);
  expect((await continuation).canWrite).toBe(true);
  expect(((await displaying) as Error).name).toBe('AbortError');
  expect(f.reader.observation?.canWrite).toBe(true);
  f.readGate = undefined;
  const readOnly = await general.read();
  expect(readOnly.canWrite).toBe(false);
  expect(general.observation?.canWrite).toBe(false);
  expect(() =>
    general.submit(readOnly.observationId, { kind: 'enabled', modelId: 'model-b', enabled: true }),
  ).toThrow('configuration_unavailable');
  expect(f.writes).toHaveLength(1);
  const modelObservation = f.reader.observation!;
  await general.read();
  expect(f.reader.observation).toEqual(modelObservation);
});

test('General closed IPC accepts no model write, scope, Store or continuation authority', () => {
  for (const method of ['settings.general.models.read', 'settings.general.models.close'] as const) {
    const request = { method, generation: 1 };
    expect(decodeNativeRequest(request)).toEqual(request);
    for (const injected of [
      { scope: 'user' },
      { storeId: 'store' },
      { afterCommandId: 'old' },
      { observationId: 1 },
      { readOnly: false },
      { readSet: base.readSet },
    ])
      expect(() => decodeNativeRequest({ ...request, ...injected })).toThrow(
        'invalid_native_request',
      );
  }
  expect(() =>
    decodeNativeRequest({
      method: 'settings.general.models.enabled',
      generation: 1,
      observationId: 1,
      modelId: 'model-b',
      enabled: true,
    }),
  ).toThrow('invalid_native_request');
});

test('Native model settings can disable the configured default and every model, then re-enable it without rewriting the default', async () => {
  const current = structuredClone(base);
  const writes: ModelSettingsRequest[] = [];
  const reader = new NativeConfiguration(
    {
      serverInfo: { capabilities: ['configuration_management'] },
      getModelSettings: async () => structuredClone(current),
      updateModelSettings: async (_scope: string, input: ModelSettingsRequest) => {
        expect(input.expectedReadSet).toEqual(current.readSet!);
        writes.push(structuredClone(input));
        if (input.operation.kind !== 'enabled') throw Error('unexpected_default_rewrite');
        current.models.find((model) => model.id === input.operation.modelId)!.enabled =
          input.operation.enabled;
        return receipt(input);
      },
    } as unknown as AgentClient,
    () => ({ generation: 1, selection: 1, storeId: 'store', sessionId: 's' }),
  );
  let observed = await reader.read();
  expect(
    (
      await reader.submit(observed.observationId, {
        kind: 'enabled',
        modelId: 'model-a',
        enabled: false,
      })
    ).phase,
  ).toBe('applied');
  observed = await reader.read();
  expect(observed.defaultModelId).toBe('model-a');
  expect(observed.models.find((model) => model.id === 'model-a')!.enabled).toBe(false);
  // Explicitly assigning a default still requires a usable enabled model.
  expect(() =>
    reader.submit(observed.observationId, { kind: 'default', modelId: 'model-a' }),
  ).toThrow('model_settings_model_unconfigured');
  await reader.submit(observed.observationId, {
    kind: 'enabled',
    modelId: 'model-b',
    enabled: false,
  });
  observed = await reader.read();
  expect(observed.models.every((model) => !model.enabled)).toBe(true);
  expect(observed.defaultModelId).toBe('model-a');
  expect(observed.canWrite).toBe(true);
  await reader.submit(observed.observationId, {
    kind: 'enabled',
    modelId: 'model-a',
    enabled: true,
  });
  observed = await reader.read();
  expect(observed.models.find((model) => model.id === 'model-a')!.enabled).toBe(true);
  expect(observed.defaultModelId).toBe('model-a');
  expect(writes.map((input) => input.operation)).toEqual([
    { kind: 'enabled', modelId: 'model-a', enabled: false },
    { kind: 'enabled', modelId: 'model-b', enabled: false },
    { kind: 'enabled', modelId: 'model-a', enabled: true },
  ]);
});

test('a lost default-disable receipt keeps the original unknown guard and settles by ID without repeating its write', async () => {
  const current = structuredClone(base);
  const writes: ModelSettingsRequest[] = [];
  const lookups: string[] = [];
  const reader = new NativeConfiguration(
    {
      serverInfo: { capabilities: ['configuration_management'] },
      getModelSettings: async () => structuredClone(current),
      updateModelSettings: async (_scope: string, input: ModelSettingsRequest) => {
        writes.push(structuredClone(input));
        current.models[0]!.enabled = false;
        throw new ClientError('network_outcome_unknown');
      },
      getHostMutation: async (commandId: string) => {
        lookups.push(commandId);
        return receipt(writes[0]!);
      },
    } as unknown as AgentClient,
    () => ({ generation: 1, selection: 1, storeId: 'store', sessionId: 's' }),
  );
  const observed = await reader.read();
  const operation = { kind: 'enabled' as const, modelId: 'model-a', enabled: false };
  await expect(reader.submit(observed.observationId, operation)).rejects.toMatchObject({
    code: 'network_outcome_unknown',
  });
  const original = reader.submissions[0]!;
  expect(original).toMatchObject({ phase: 'unknown', operation });
  expect(() => reader.submit(observed.observationId, operation)).toThrow(
    'configuration_intent_consumed',
  );
  expect(() =>
    reader.submit(observed.observationId, {
      kind: 'enabled',
      modelId: 'model-b',
      enabled: false,
    }),
  ).toThrow('configuration_mutation_pending');
  expect((await reader.lookup(original.commandId)).phase).toBe('applied');
  expect(lookups).toEqual([original.commandId]);
  expect(writes).toHaveLength(1);
  const fresh = await reader.read();
  expect(fresh.defaultModelId).toBe('model-a');
  expect(fresh.models[0]!.enabled).toBe(false);
});
