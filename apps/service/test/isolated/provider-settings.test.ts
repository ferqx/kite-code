import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import type { JsonObject } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { createClient, type ProviderSettingsRequest } from '@kite-ai/client';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { startService } from '../../src/index';

async function fixture(hostConfiguration?: JsonObject) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-provider-settings-')));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  privateDirectory(profile.profilePath);
  const file = join(profile.profilePath, 'config.jsonc');
  writeFileSync(
    file,
    '// preserve this comment\n{"unknown":"preserved","modelId":null,"models":[]}\n',
    { mode: 0o600 },
  );
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const keys = new Map<string, string>();
  let puts = 0;
  let onPut: (() => void) | undefined;
  let failPut = false;
  const host = createDefaultProcessConfiguration({
    userConfigurationPath: profile.profilePath + '/config.jsonc',
    ...(hostConfiguration ? { hostConfiguration: { configuration: hostConfiguration } } : {}),
    profile,
    credentialBackend: {
      kind: 'temporary',
      async put(id, secret) {
        puts++;
        keys.set(id, secret);
        onPut?.();
        if (failPut) throw Error('controlled_backend_failure');
      },
      async resolve(id) {
        return keys.get(id) ?? null;
      },
      async remove(id) {
        keys.delete(id);
      },
    },
  });
  const runtime = createRuntime({
    store,
    permissions: host.permissions!,
    resolveRunConfiguration: host.resolveRunConfiguration,
  });
  const manager = host.configurationManagement!(runtime);
  const service = await startService({
    runtime,
    configurationManagement: manager,
    buildId: 'provider-settings-test',
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
  });
  const storeId = (await runtime.getMetadata()).storeId;
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['configuration_management'],
    },
  });
  await client.connect();
  const input = async (
    commandId: string,
    operation: ProviderSettingsRequest['operation'],
    secret?: string,
  ): Promise<ProviderSettingsRequest> => ({
    expectedStoreId: storeId,
    commandId,
    expectedReadSet: (await client.getProviderSettings({ storeId })).readSet!,
    operation,
    ...(secret ? { secret } : {}),
  });
  return {
    root,
    profile,
    file,
    store,
    runtime,
    manager,
    service,
    client,
    storeId,
    keys,
    input,
    get puts() {
      return puts;
    },
    onPut(action?: () => void) {
      onPut = action;
    },
    failPut() {
      failPut = true;
    },
    async close() {
      await service.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const manual = (
  provider: ProviderSettingsRequest['operation']['provider'],
  baseURL = 'http://127.0.0.1:1234/v1',
): ProviderSettingsRequest['operation'] => ({
  provider,
  connectionId: null,
  baseURL,
  modelNames: [`actual-${provider}`],
  credential: provider === 'openai' || provider === 'deepseek' ? 'replace' : 'none',
});

test('four explicit provider families save actual names, protect default and retain other endpoint connections without read effects', async () => {
  const f = await fixture();
  try {
    expect(
      (await f.client.getProviderSettings({ storeId: f.storeId })).providers.map(
        (provider) => provider.id,
      ),
    ).toEqual(['openai', 'deepseek', 'compatible', 'ollama', 'codex']);
    for (const provider of ['openai', 'deepseek', 'compatible', 'ollama'] as const) {
      const request = await f.input(
        `save-${provider}`,
        manual(provider),
        provider === 'openai' || provider === 'deepseek' ? `fixture-${provider}-key` : undefined,
      );
      const result = await f.client.updateProviderSettings(request);
      expect(result.state).toBe('applied');
      expect(result.providerSettings?.operation).toEqual(request.operation);
      expect(result.receipt).toMatchObject({
        status: 'applied',
        configurationState: 'published',
        credentialState: request.secret ? 'stored' : 'unchanged',
      });
      expect(await f.client.getHostMutation(request.commandId, { storeId: f.storeId })).toEqual(
        result,
      );
      expect(await f.client.updateProviderSettings(request)).toEqual(result);
    }
    expect(f.puts).toBe(2);
    const view = await f.client.getModelSettings('user', { storeId: f.storeId });
    expect(view.models).toHaveLength(4);
    expect(view.models.every((model) => !model.enabled && model.configured)).toBe(true);
    for (const model of view.models) {
      expect(model.reasoningEffortSupport).toBe('compatible_wire');
      expect(model.reasoningEffortChoices).toContain('high');
      expect(model.reasoningEffortChoices).toContain('ultar');
      expect(model.reasoningEffortChoices).not.toContain('none');
      const fresh = await f.client.getModelSettings('user', { storeId: f.storeId });
      await f.client.updateModelSettings('user', {
        expectedStoreId: f.storeId,
        commandId: `effort-${model.id}`,
        expectedReadSet: fresh.readSet!,
        operation: { kind: 'effort', modelId: model.id, reasoningEffort: 'ultar' },
      });
      const saved = await f.client.getModelSettings('user', { storeId: f.storeId });
      expect(saved.models.find((entry) => entry.id === model.id)!.reasoningEffort).toBe('ultar');
    }
    const model = view.models[0]!;
    const update = async (kind: 'enabled' | 'default', commandId: string, enabled = true) => {
      const fresh = await f.client.getModelSettings('user', { storeId: f.storeId });
      return f.client.updateModelSettings('user', {
        expectedStoreId: f.storeId,
        commandId,
        expectedReadSet: fresh.readSet!,
        operation:
          kind === 'default' ? { kind, modelId: model.id } : { kind, modelId: model.id, enabled },
      });
    };
    await expect(update('default', 'disabled-default')).rejects.toMatchObject({
      code: 'model_settings_model_disabled',
    });
    await update('enabled', 'enable');
    await update('default', 'default');
    expect(await update('enabled', 'disable-default', false)).toMatchObject({ state: 'applied' });
    const disabledDefault = await f.client.getModelSettings('user', { storeId: f.storeId });
    expect(disabledDefault.defaultModelId).toBe(model.id);
    expect(disabledDefault.models.find((entry) => entry.id === model.id)!.enabled).toBe(false);
    await f.client.updateProviderSettings(
      await f.input('second-endpoint', manual('compatible', 'http://127.0.0.1:1235/v1')),
    );
    expect(
      (await f.client.getProviderSettings({ storeId: f.storeId })).providers.find(
        (provider) => provider.id === 'compatible',
      )!.connections,
    ).toHaveLength(2);
    expect(readFileSync(f.file, 'utf8')).toContain('// preserve this comment');
    expect(readFileSync(f.file, 'utf8')).toContain('"unknown":"preserved"');
    expect(readFileSync(f.file, 'utf8')).not.toContain('fixture-openai-key');
    expect(f.puts).toBe(2);
  } finally {
    await f.close();
  }
});

test('blank-name discovery is explicit, complete beyond 512 models and same original command never repeats network or vault effects', async () => {
  const f = await fixture();
  let discoveries = 0;
  const names = Array.from({ length: 520 }, (_, index) => `discovered-${index}`);
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      expect(new URL(request.url).pathname).toBe('/v1/models');
      expect(request.headers.get('authorization')).toBe('Bearer discovery-fixture-key');
      discoveries++;
      return Response.json({ object: 'list', data: names.map((id) => ({ id })) });
    },
  });
  try {
    const request = await f.input(
      'discover',
      { ...manual('openai', `${provider.url.origin}/v1`), modelNames: [] },
      'discovery-fixture-key',
    );
    const result = await f.client.updateProviderSettings(request);
    expect(result.state).toBe('applied');
    expect(await f.client.updateProviderSettings(request)).toEqual(result);
    await f.client.getProviderSettings({ storeId: f.storeId });
    await f.client.getModelSettings('user', { storeId: f.storeId });
    await f.client.getHostMutation('discover', { storeId: f.storeId });
    expect(discoveries).toBe(1);
    expect(f.puts).toBe(1);
    expect(
      (await f.client.getModelSettings('user', { storeId: f.storeId })).models.map(
        (model) => model.model,
      ),
    ).toEqual(names);
    const record = await f.store.getHostMutation({
      expectedStoreId: f.storeId,
      commandId: 'discover',
      subjectId: 'local-user',
    });
    expect(JSON.stringify(record)).not.toContain('discovery-fixture-key');
    // Await the real Worker/HTTP result before Bun's synchronous matcher examines it.
    let conflict: unknown;
    try {
      await f.client.updateProviderSettings({ ...request, secret: 'different-key' });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toMatchObject({ code: 'host_mutation_conflict', status: 409 });
    expect(discoveries).toBe(1);
    expect(f.puts).toBe(1);
  } finally {
    provider.stop(true);
    await f.close();
  }
});

test('vault storage and JSONC CAS have distinct durable outcomes and known unpublished credential retains an exact revoke handle', async () => {
  const f = await fixture();
  try {
    const stale = await f.input('stale', manual('openai'), 'never-stored-key');
    writeFileSync(f.file, readFileSync(f.file, 'utf8') + '// external before publication\n');
    const rejected = await f.client.updateProviderSettings(stale);
    expect(rejected.receipt).toMatchObject({
      status: 'failed',
      code: 'configuration_read_set_conflict',
      credentialState: 'unchanged',
      configurationState: 'not_attempted',
    });
    expect(f.puts).toBe(0);
    const original = await f.input('split', manual('openai'), 'stored-unpublished-key');
    f.onPut(() =>
      writeFileSync(
        f.file,
        readFileSync(f.file, 'utf8') + '// external during vault publication\n',
      ),
    );
    const split = await f.client.updateProviderSettings(original);
    expect(split.state).toBe('failed');
    expect(split.receipt).toMatchObject({
      status: 'failed',
      credentialState: 'stored',
      configurationState: 'not_attempted',
    });
    const receipt = split.receipt as { opaqueRef: string };
    expect(receipt.opaqueRef).toMatch(/^credential:/);
    expect(f.keys.get(receipt.opaqueRef)).toBe('stored-unpublished-key');
    expect(await f.client.getHostMutation(original.commandId, { storeId: f.storeId })).toEqual(
      split,
    );
    expect(await f.client.updateProviderSettings(original)).toEqual(split);
    expect(f.puts).toBe(1);
    expect(readFileSync(f.file, 'utf8')).toContain('// external during vault publication');
    expect(readFileSync(f.file, 'utf8')).not.toContain(receipt.opaqueRef);
    expect(
      JSON.stringify(
        await f.store.getHostMutation({
          expectedStoreId: f.storeId,
          commandId: original.commandId,
          subjectId: 'local-user',
        }),
      ),
    ).not.toContain(original.secret!);
    await f.client.revokeCredential(receipt.opaqueRef, {
      expectedStoreId: f.storeId,
      commandId: 'revoke-unused',
    });
    expect(f.keys.has(receipt.opaqueRef)).toBe(false);
  } finally {
    await f.close();
  }
});

test('uncertain vault write remains original outcome_unknown and no configuration or automatic repeat occurs', async () => {
  const f = await fixture();
  try {
    f.failPut();
    const request = await f.input('uncertain', manual('openai'), 'uncertain-fixture-key');
    const result = await f.client.updateProviderSettings(request);
    expect(result.state).toBe('outcome_unknown');
    expect(result.receipt).toEqual({
      status: 'outcome_unknown',
      code: 'credential_unavailable',
      credentialState: 'outcome_unknown',
      configurationState: 'not_attempted',
    });
    expect(await f.client.updateProviderSettings(request)).toEqual(result);
    expect(await f.client.getHostMutation(request.commandId, { storeId: f.storeId })).toEqual(
      result,
    );
    expect(f.puts).toBe(1);
    expect((await f.client.getModelSettings('user', { storeId: f.storeId })).models).toEqual([]);
  } finally {
    await f.close();
  }
});

test('public discovery reads the actual provider once, writes no credential/configuration/mutation, then publishes exact discovered names without another RPC', async () => {
  const f = await fixture();
  let requests = 0;
  const secret = 'hot-discovery-key';
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      requests++;
      expect(request.headers.get('authorization')).toBe(`Bearer ${secret}`);
      return Response.json({ data: [{ id: 'alpha' }, { id: 'beta' }] });
    },
  });
  try {
    const beforeFile = readFileSync(f.file, 'utf8');
    const beforeCursor = (await f.runtime.getMetadata()).lastChangeCursor;
    const expectedReadSet = (await f.client.getProviderSettings({ storeId: f.storeId })).readSet!;
    const operation = {
      provider: 'compatible' as const,
      connectionId: null,
      baseURL: `${provider.url.origin}/v1`,
      credential: 'replace' as const,
    };
    const result = await f.client.discoverProviderSettings({
      expectedStoreId: f.storeId,
      expectedReadSet,
      operation,
      secret,
    });
    expect(result.modelNames).toEqual(['alpha', 'beta']);
    expect(result.storeId).toBe(f.storeId);
    expect(result.readSet).toEqual(expectedReadSet);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(readFileSync(f.file, 'utf8')).toBe(beforeFile);
    expect((await f.runtime.getMetadata()).lastChangeCursor).toBe(beforeCursor);
    expect(f.puts).toBe(0);
    expect(f.keys.size).toBe(0);
    expect(requests).toBe(1);
    const saved = await f.client.updateProviderSettings({
      expectedStoreId: f.storeId,
      expectedReadSet,
      commandId: 'publish-discovered',
      operation: { ...operation, modelNames: result.modelNames },
      secret,
    });
    expect(saved.state).toBe('applied');
    expect(requests).toBe(1);
    expect(f.puts).toBe(1);
    expect(readFileSync(f.file, 'utf8')).toContain('alpha');
    expect(readFileSync(f.file, 'utf8')).toContain('beta');
    expect(readFileSync(f.file, 'utf8')).not.toContain(secret);
    const current = await f.client.getProviderSettings({ storeId: f.storeId });
    const connection = current.providers.find((entry) => entry.id === 'compatible')!
      .connections[0]!;
    const keep = {
      expectedStoreId: f.storeId,
      expectedReadSet: current.readSet!,
      operation: {
        provider: 'compatible' as const,
        connectionId: connection.id,
        baseURL: connection.baseURL,
        credential: 'keep' as const,
      },
    };
    expect((await f.client.discoverProviderSettings(keep)).modelNames).toEqual(['alpha', 'beta']);
    expect(requests).toBe(2);
    expect(f.puts).toBe(1);
    await expect(
      f.client.discoverProviderSettings({
        ...keep,
        operation: { ...keep.operation, baseURL: `${provider.url.origin}/different-endpoint` },
      }),
    ).rejects.toMatchObject({ code: 'provider_discovery_endpoint_mismatch' });
    expect(requests).toBe(2);
  } finally {
    provider.stop(true);
    await f.close();
  }
});

test('public read-only discovery returns accurate HTTP classes, cancels its source, and rejects stale metadata before contacting a provider', async () => {
  const f = await fixture();
  let status = 401,
    requests = 0;
  let entered!: () => void, released!: () => void;
  const cancelledSource = new Promise<void>((resolve) => {
    released = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests++;
      if (status === 200) {
        entered();
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) {
            released();
            resolve();
          } else
            request.signal.addEventListener(
              'abort',
              () => {
                released();
                resolve();
              },
              { once: true },
            );
        });
        return Response.json({ data: [{ id: 'late' }] });
      }
      return new Response('provider body is private', { status });
    },
  });
  try {
    const input = {
      expectedStoreId: f.storeId,
      expectedReadSet: (await f.client.getProviderSettings({ storeId: f.storeId })).readSet!,
      operation: {
        provider: 'compatible' as const,
        connectionId: null,
        baseURL: `${provider.url.origin}/v1`,
        credential: 'none' as const,
      },
    };
    await expect(f.client.discoverProviderSettings(input)).rejects.toMatchObject({
      code: 'provider_discovery_auth_failed',
    });
    status = 403;
    await expect(f.client.discoverProviderSettings(input)).rejects.toMatchObject({
      code: 'provider_discovery_auth_failed',
    });
    status = 500;
    await expect(f.client.discoverProviderSettings(input)).rejects.toMatchObject({
      code: 'provider_discovery_failed',
    });
    const cancelled = new AbortController();
    status = 200;
    const pending = f.client.discoverProviderSettings(input, { signal: cancelled.signal });
    await started;
    cancelled.abort();
    await expect(pending).rejects.toThrow();
    expect(
      await Promise.race([
        cancelledSource.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
      ]),
    ).toBe(true);
    expect(f.puts).toBe(0);
    expect(f.keys.size).toBe(0);
    const before = requests;
    writeFileSync(f.file, '// changed original configuration\n{"models":[]}');
    await expect(f.client.discoverProviderSettings(input)).rejects.toMatchObject({
      code: 'configuration_read_set_conflict',
    });
    expect(requests).toBe(before);
  } finally {
    provider.stop(true);
    await f.close();
  }
}, 10_000);

test('explicit protocol separates connections, survives settings reads and rejects unsupported families before credentials', async () => {
  const f = await fixture();
  try {
    const chat = await f.input('protocol-chat', manual('compatible'));
    expect((await f.client.updateProviderSettings(chat)).state).toBe('applied');
    const responses = await f.input('protocol-responses', {
      ...manual('compatible'),
      protocol: 'responses',
    });
    expect((await f.client.updateProviderSettings(responses)).state).toBe('applied');
    const facts = await f.client.getProviderSettings({ storeId: f.storeId });
    const connections = facts.providers.find((entry) => entry.id === 'compatible')!.connections;
    expect(connections.map((entry) => entry.protocol)).toEqual(['chat-completions', 'responses']);
    expect(new Set(connections.map((entry) => entry.id)).size).toBe(2);
    const models = await f.client.getModelSettings('user', { storeId: f.storeId });
    expect(models.models.map((entry) => entry.protocol)).toEqual(['chat-completions', 'responses']);
    expect(models.models.every((entry) => entry.configured)).toBe(true);
    const change = await f.input('protocol-change', {
      ...manual('compatible'),
      connectionId: connections[1]!.id,
      protocol: 'chat-completions',
    });
    expect((await f.client.updateProviderSettings(change)).state).toBe('applied');
    expect(
      (
        JSON.parse(readFileSync(f.file, 'utf8').replace('// preserve this comment\n', ''))
          .models as { protocol: string }[]
      ).every((entry) => entry.protocol === 'chat-completions'),
    ).toBe(true);
    for (const provider of ['deepseek', 'ollama'] as const) {
      const invalid = await f.input(
        `protocol-invalid-${provider}`,
        {
          ...manual(provider),
          protocol: 'responses',
        },
        provider === 'deepseek' ? 'owned-key-must-not-be-stored' : undefined,
      );
      const result = await f.client.updateProviderSettings(invalid);
      expect(result.state).toBe('failed');
      expect(result.receipt).toMatchObject({
        code: 'model_protocol_unsupported',
        credentialState: 'unchanged',
        configurationState: 'not_attempted',
      });
    }
    expect(f.puts).toBe(0);
  } finally {
    await f.close();
  }
});

test('connection CRUD keeps identical endpoints separate, survives edits, protects defaults and never revokes vault secrets', async () => {
  const f = await fixture();
  const connections = async () =>
    (await f.client.getProviderSettings({ storeId: f.storeId })).providers.find(
      (entry) => entry.id === 'openai',
    )!.connections;
  try {
    for (const name of ['Work account', 'Personal account']) {
      const result = await f.client.updateProviderSettings(
        await f.input(
          name.startsWith('Work') ? 'create-work' : 'create-personal',
          { ...manual('openai'), kind: 'upsert', name },
          `owned-${name}`,
        ),
      );
      expect(result.state).toBe('applied');
    }
    const before = await connections();
    expect(before.map((entry) => entry.name)).toEqual(['Work account', 'Personal account']);
    expect(before[0]!.id).not.toBe(before[1]!.id);
    expect(before[0]!.modelIds![0]).not.toBe(before[1]!.modelIds![0]);
    const edit = await f.input(
      'edit-work',
      {
        ...manual('openai', 'http://127.0.0.1:1222/v1'),
        connectionId: before[0]!.id,
        kind: 'upsert',
        name: 'Renamed work',
        protocol: 'responses',
      },
      'owned-replacement-key',
    );
    expect((await f.client.updateProviderSettings(edit)).state).toBe('applied');
    const edited = await connections();
    expect(edited[0]).toMatchObject({
      id: before[0]!.id,
      name: 'Renamed work',
      modelIds: before[0]!.modelIds,
      protocol: 'responses',
      baseURL: 'http://127.0.0.1:1222/v1',
    });
    expect(edited[1]).toEqual(before[1]);
    let models = await f.client.getModelSettings('user', { storeId: f.storeId });
    await f.client.updateModelSettings('user', {
      expectedStoreId: f.storeId,
      commandId: 'enable-work',
      expectedReadSet: models.readSet!,
      operation: { kind: 'enabled', modelId: before[0]!.modelIds![0]!, enabled: true },
    });
    models = await f.client.getModelSettings('user', { storeId: f.storeId });
    await f.client.updateModelSettings('user', {
      expectedStoreId: f.storeId,
      commandId: 'default-work',
      expectedReadSet: models.readSet!,
      operation: { kind: 'default', modelId: before[0]!.modelIds![0]! },
    });
    const remove = (id: string): ProviderSettingsRequest['operation'] => ({
      ...manual('openai'),
      kind: 'remove',
      connectionId: id,
      modelNames: [],
      credential: 'none',
    });
    const file = readFileSync(f.file, 'utf8');
    expect((await connections())[0]!.defaultModelIds).toEqual(before[0]!.modelIds);
    const refused = await f.client.updateProviderSettings(
      await f.input('remove-default', remove(before[0]!.id)),
    );
    expect(refused.receipt).toMatchObject({
      code: 'provider_default_model_in_use',
      configurationState: 'not_attempted',
      credentialState: 'unchanged',
    });
    expect(readFileSync(f.file, 'utf8')).toBe(file);
    const request = await f.input('remove-personal', remove(before[1]!.id));
    const removed = await f.client.updateProviderSettings(request);
    expect(removed.receipt).toMatchObject({
      status: 'applied',
      credentialState: 'unchanged',
      configurationState: 'published',
    });
    expect(await f.client.updateProviderSettings(request)).toEqual(removed);
    expect(await f.client.getHostMutation(request.commandId, { storeId: f.storeId })).toEqual(
      removed,
    );
    expect((await connections()).map((entry) => entry.id)).toEqual([before[0]!.id]);
    expect(f.keys.size).toBe(3);
    expect(f.puts).toBe(3);
    const final = await f.client.getModelSettings('user', { storeId: f.storeId });
    expect(final.models.map((entry) => entry.id)).toEqual(before[0]!.modelIds!);
    expect(final.defaultModelId).toBe(before[0]!.modelIds![0]!);
    expect(readFileSync(f.file, 'utf8')).toContain('// preserve this comment');
    expect(readFileSync(f.file, 'utf8')).not.toContain('owned-');
  } finally {
    await f.close();
  }
});

test('user aliases, empty declarations and unknown providers are preserved without read-time migration; remove deletes exactly one raw provider', async () => {
  const f = await fixture();
  const source =
    '// retain this JSONC comment\n' +
    JSON.stringify(
      {
        theme: 'dark',
        unknown: { untouched: true },
        provider: {
          alpha: {
            name: 'Alpha',
            type: 'openai-compatible',
            baseURL: 'http://127.0.0.1:1234/v1',
            apiKey: 'OWNED_ALPHA_SECRET',
            models: [{ name: 'same', maxOutputTokens: 2000 }],
            extra: 'retain',
          },
          beta: {
            name: 'Beta',
            type: 'openai-compatible',
            baseURL: 'http://127.0.0.1:1234/v1',
            apiKey: 'OWNED_BETA_SECRET',
            models: ['same'],
          },
          empty: {
            name: 'Empty account',
            type: 'ollama',
            models: [],
            extra: 'remove-with-connection',
          },
          future: { type: 'future-family', model: 'future-one', futureOptions: { keep: true } },
          incomplete: { models: [] },
        },
        model: 'alpha:same',
        disabledModels: [
          { provider: 'beta', name: 'same' },
          { provider: 'unrelated', name: 'retained' },
        ],
      },
      null,
      2,
    );
  try {
    writeFileSync(f.file, source);
    const all = async () =>
      (await f.client.getProviderSettings({ storeId: f.storeId })).providers.flatMap((entry) =>
        entry.connections.map((connection) => ({ ...connection, family: entry.id })),
      );
    const initial = await all();
    expect(initial).toHaveLength(5);
    expect(initial.find((entry) => entry.name === 'future')!.canWrite).toBe(false);
    expect(initial.find((entry) => entry.name === 'incomplete')!.canWrite).toBe(false);
    expect(initial.find((entry) => entry.name === 'Empty account')!.modelIds).toEqual([]);
    expect(readFileSync(f.file, 'utf8')).toBe(source);
    expect(JSON.stringify(initial)).not.toContain('OWNED_');
    const alpha = initial.find((entry) => entry.name === 'Alpha')!;
    const beta = initial.find((entry) => entry.name === 'Beta')!;
    expect(alpha.id).not.toBe(beta.id);
    const edit = await f.input('rename-alias', {
      ...manual('compatible', 'http://127.0.0.1:1236/v1'),
      kind: 'upsert',
      connectionId: alpha.id,
      name: 'New Alpha label',
      credential: 'keep',
      modelNames: ['same'],
    });
    expect((await f.client.updateProviderSettings(edit)).state).toBe('applied');
    expect((await all()).find((entry) => entry.id === alpha.id)).toMatchObject({
      name: 'New Alpha label',
      modelIds: alpha.modelIds,
    });
    for (const target of [beta, initial.find((entry) => entry.name === 'Empty account')!]) {
      const removed = await f.client.updateProviderSettings(
        await f.input(`remove-${target.name!.split(' ')[0]}`, {
          kind: 'remove',
          provider: target.family,
          connectionId: target.id,
          baseURL: target.baseURL,
          modelNames: [],
          credential: 'none',
        }),
      );
      expect(removed.state).toBe('applied');
    }
    const savedText = readFileSync(f.file, 'utf8');
    const saved = JSON.parse(savedText.slice(savedText.indexOf('{')));
    expect(Object.keys(saved.provider)).toEqual(['alpha', 'future', 'incomplete']);
    expect(saved.provider.alpha.name).toBe('New Alpha label');
    expect(saved.provider.alpha.apiKey).toBe('OWNED_ALPHA_SECRET');
    expect(saved.provider.alpha.extra).toBe('retain');
    expect(saved.provider.alpha.models).toEqual([{ name: 'same', maxOutputTokens: 2000 }]);
    expect(saved.provider.future).toEqual({
      type: 'future-family',
      model: 'future-one',
      futureOptions: { keep: true },
    });
    expect(saved.provider.incomplete).toEqual({ models: [] });
    expect(saved.disabledModels).toEqual([{ provider: 'unrelated', name: 'retained' }]);
    expect(saved.unknown).toEqual({ untouched: true });
    expect(saved.model).toBe('alpha:same');
    expect(savedText).toContain('// retain this JSONC comment');
    expect(savedText).not.toContain('OWNED_BETA_SECRET');
    expect(savedText).not.toContain('_providerConnections');
    expect(f.puts).toBe(0);
  } finally {
    await f.close();
  }
});

test('legacy assembly adopts stable connection metadata only on edit without replacing model identities', async () => {
  const f = await fixture();
  try {
    const source = JSON.stringify({
      modelId: null,
      models: [
        {
          id: 'legacy-one',
          provider: 'compatible',
          model: 'one',
          baseURL: 'http://127.0.0.1:1234/v1',
          enabled: false,
          unknown: 'keep',
        },
        {
          id: 'legacy-two',
          provider: 'compatible',
          model: 'two',
          baseURL: 'http://127.0.0.1:1234/v1',
          enabled: false,
        },
      ],
    });
    writeFileSync(f.file, source);
    const before = (await f.client.getProviderSettings({ storeId: f.storeId })).providers.find(
      (entry) => entry.id === 'compatible',
    )!.connections[0]!;
    expect(before.modelIds).toEqual(['legacy-one', 'legacy-two']);
    expect(readFileSync(f.file, 'utf8')).toBe(source);
    expect(
      (
        await f.client.updateProviderSettings(
          await f.input('legacy-edit', {
            ...manual('compatible', 'http://127.0.0.1:1444/v1'),
            kind: 'upsert',
            name: 'Stable legacy',
            connectionId: before.id,
            modelNames: ['one', 'two'],
          }),
        )
      ).state,
    ).toBe('applied');
    const after = (await f.client.getProviderSettings({ storeId: f.storeId })).providers.find(
      (entry) => entry.id === 'compatible',
    )!.connections[0]!;
    expect(after).toMatchObject({
      id: before.id,
      modelIds: before.modelIds,
      name: 'Stable legacy',
    });
    const saved = JSON.parse(readFileSync(f.file, 'utf8'));
    expect(saved.models.map((model: { connectionId: string }) => model.connectionId)).toEqual([
      before.id,
      before.id,
    ]);
    expect(saved.models[0].unknown).toBe('keep');
  } finally {
    await f.close();
  }
});

test('delete uses the exact connection ID and read-set; stale, unknown and secret-bearing requests cannot mutate it', async () => {
  const f = await fixture();
  try {
    await f.client.updateProviderSettings(
      await f.input('prepare-delete', { ...manual('compatible'), name: 'Target' }),
    );
    const connection = (await f.client.getProviderSettings({ storeId: f.storeId })).providers.find(
      (entry) => entry.id === 'compatible',
    )!.connections[0]!;
    const operation: ProviderSettingsRequest['operation'] = {
      ...manual('compatible'),
      kind: 'remove',
      connectionId: connection.id,
      modelNames: [],
      credential: 'none',
    };
    const stale = await f.input('stale-delete', operation);
    writeFileSync(f.file, `${readFileSync(f.file, 'utf8')}// external change\n`);
    const baseline = readFileSync(f.file, 'utf8');
    expect((await f.client.updateProviderSettings(stale)).receipt).toMatchObject({
      code: 'configuration_read_set_conflict',
      credentialState: 'unchanged',
      configurationState: 'not_attempted',
    });
    expect(
      (
        await f.client.updateProviderSettings(
          await f.input('unknown-delete', { ...operation, connectionId: 'f'.repeat(64) }),
        )
      ).receipt,
    ).toMatchObject({ code: 'provider_settings_override' });
    expect(
      (
        await f.client.updateProviderSettings(
          await f.input('secret-delete', operation, 'must-not-store'),
        )
      ).receipt,
    ).toMatchObject({ code: 'invalid_request' });
    expect(readFileSync(f.file, 'utf8')).toBe(baseline);
    expect(f.puts).toBe(0);
    const exact = await f.input('exact-delete', {
      ...operation,
      baseURL: 'http://127.0.0.1:9999/v1',
    });
    const result = await f.client.updateProviderSettings(exact);
    expect(result.state).toBe('applied');
    expect((await f.client.getModelSettings('user', { storeId: f.storeId })).models).toEqual([]);
    expect(await f.client.updateProviderSettings(exact)).toEqual(result);
    await expect(
      f.client.updateProviderSettings({
        ...exact,
        operation: { ...exact.operation, connectionId: 'e'.repeat(64) },
      }),
    ).rejects.toMatchObject({ code: 'host_mutation_conflict' });
  } finally {
    await f.close();
  }
});

test('a lost deletion response is resolved by the original command without a second POST or credential revocation', async () => {
  const f = await fixture();
  let posts = 0;
  const relay = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = { ...request.headers };
      delete headers.host;
      delete headers.connection;
      const downstream = await fetch(`${f.service.endpoint}${request.url}`, {
        method: request.method,
        headers: headers as Record<string, string>,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      const body = await downstream.text();
      if (request.method === 'POST') {
        posts++;
        request.socket.destroy();
        return;
      }
      response.writeHead(downstream.status, { 'content-type': 'application/json' });
      response.end(body);
    } catch {
      response.destroy();
    }
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const address = relay.address();
  if (!address || typeof address === 'string') throw Error('missing-relay');
  const client = createClient({
    endpoint: `http://127.0.0.1:${address.port}`,
    token: f.service.bootstrap.token,
    expected: {
      profile: f.service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['configuration_management'],
    },
  });
  try {
    await f.client.updateProviderSettings(
      await f.input('create-secret-delete', manual('openai'), 'owned-retained-secret'),
    );
    const connection = (await f.client.getProviderSettings({ storeId: f.storeId })).providers.find(
      (entry) => entry.id === 'openai',
    )!.connections[0]!;
    await client.connect();
    const input = await f.input('delete-lost-response', {
      ...manual('openai'),
      kind: 'remove',
      connectionId: connection.id,
      modelNames: [],
      credential: 'none',
    });
    await expect(client.updateProviderSettings(input)).rejects.toMatchObject({
      code: 'network_outcome_unknown',
    });
    expect(posts).toBe(1);
    const result = await client.getHostMutation(input.commandId, { storeId: f.storeId });
    expect(result.state).toBe('applied');
    expect(result.providerSettings?.operation).toEqual(input.operation);
    expect(
      (await client.getProviderSettings({ storeId: f.storeId })).providers.every(
        (entry) => entry.connections.length === 0,
      ),
    ).toBe(true);
    expect(posts).toBe(1);
    expect(f.keys.size).toBe(1);
    expect(f.puts).toBe(1);
  } finally {
    relay.closeAllConnections();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    await f.close();
  }
});

test('an empty legacy provider can add models while keeping its existing inline credential resolvable', async () => {
  const f = await fixture();
  try {
    writeFileSync(
      f.file,
      JSON.stringify({
        provider: {
          legacy: { type: 'openai', name: 'Empty OpenAI', apiKey: 'OWNED_EMPTY_KEY', models: [] },
        },
      }),
    );
    const before = (await f.client.getProviderSettings({ storeId: f.storeId })).providers.find(
      (entry) => entry.id === 'openai',
    )!.connections[0]!;
    expect(before.modelIds).toEqual([]);
    const result = await f.client.updateProviderSettings(
      await f.input('fill-empty-legacy', {
        ...manual('openai', before.baseURL),
        connectionId: before.id,
        credential: 'keep',
        name: 'Filled OpenAI',
      }),
    );
    expect(result.state).toBe('applied');
    const saved = JSON.parse(readFileSync(f.file, 'utf8'));
    expect(saved.provider.legacy.apiKey).toBe('OWNED_EMPTY_KEY');
    expect(saved.provider.legacy.credentialRef).toBeUndefined();
    expect(Object.keys(saved.provider)).toEqual(['legacy']);
    const after = (await f.client.getProviderSettings({ storeId: f.storeId })).providers.find(
      (entry) => entry.id === 'openai',
    )!.connections[0]!;
    expect(after).toMatchObject({
      id: before.id,
      name: 'Filled OpenAI',
      hasCredential: true,
      canWrite: true,
    });
    expect(after.modelIds).toHaveLength(1);
    expect(f.puts).toBe(0);
  } finally {
    await f.close();
  }
});

test('invalid custom declarations remain visible and read-only without exposing URL secrets or changing bytes', async () => {
  const f = await fixture();
  try {
    const source = JSON.stringify({
      provider: {
        invalid: {
          baseURL: 'https://user:PRIVATE_PASSWORD@invalid.example/v1?key=PRIVATE_QUERY',
          models: ['one'],
        },
        empty: { type: 'ollama', models: [] },
        malformed: 'future-format',
      },
    });
    writeFileSync(f.file, source);
    const view = await f.client.getProviderSettings({ storeId: f.storeId });
    expect(view.readSet).toBeNull();
    expect(view.errors.length).toBeGreaterThan(0);
    const connections = view.providers.flatMap((provider) => provider.connections);
    expect(connections.map((connection) => connection.name).sort()).toEqual([
      'empty',
      'invalid',
      'malformed',
    ]);
    expect(connections.every((connection) => !connection.canWrite)).toBe(true);
    expect(JSON.stringify(view)).not.toContain('PRIVATE_');
    expect(readFileSync(f.file, 'utf8')).toBe(source);
    expect(f.puts).toBe(0);
  } finally {
    await f.close();
  }
});

test('conflicting hand-edited stable connection IDs cannot authorize deleting a second provider family', async () => {
  const f = await fixture();
  try {
    const source = JSON.stringify({
      modelId: null,
      models: [
        {
          id: 'compatible-model',
          provider: 'compatible',
          connectionId: 'c'.repeat(64),
          baseURL: 'http://127.0.0.1:1234/v1',
          model: 'one',
          enabled: false,
        },
        {
          id: 'ollama-model',
          provider: 'ollama',
          connectionId: 'c'.repeat(64),
          baseURL: 'http://127.0.0.1:1234/v1',
          model: 'two',
          enabled: false,
        },
      ],
    });
    writeFileSync(f.file, source);
    const view = await f.client.getProviderSettings({ storeId: f.storeId });
    expect(
      view.providers
        .flatMap((provider) => provider.connections)
        .every((connection) => !connection.canWrite),
    ).toBe(true);
    const removal = await f.client.updateProviderSettings(
      await f.input('conflicting-delete', {
        ...manual('compatible'),
        kind: 'remove',
        connectionId: 'c'.repeat(64),
        modelNames: [],
        credential: 'none',
      }),
    );
    expect(removal.receipt).toMatchObject({
      code: 'provider_settings_override',
      configurationState: 'not_attempted',
    });
    expect(readFileSync(f.file, 'utf8')).toBe(source);
  } finally {
    await f.close();
  }
});

test('deleted user aliases are never recycled and a saved old route cannot bind to a newly added account', async () => {
  const f = await fixture();
  try {
    writeFileSync(f.file, '{"provider":{}}');
    const operation = {
      ...manual('compatible'),
      kind: 'upsert' as const,
      name: 'Original account',
    };
    expect(
      (await f.client.updateProviderSettings(await f.input('create-original-user', operation)))
        .state,
    ).toBe('applied');
    const original = (await f.client.getProviderSettings({ storeId: f.storeId })).providers.find(
      (provider) => provider.id === 'compatible',
    )!.connections[0]!;
    const originalModelId = original.modelIds![0]!;
    await f.client.updateProviderSettings(
      await f.input('delete-original-user', {
        ...operation,
        kind: 'remove',
        connectionId: original.id,
        modelNames: [],
        credential: 'none',
      }),
    );
    expect(
      (
        await f.client.updateProviderSettings(
          await f.input('create-replacement-user', {
            ...operation,
            name: 'Different account',
            baseURL: 'http://127.0.0.1:1666/v1',
          }),
        )
      ).state,
    ).toBe('applied');
    const replacement = (await f.client.getProviderSettings({ storeId: f.storeId })).providers.find(
      (provider) => provider.id === 'compatible',
    )!.connections[0]!;
    expect(replacement.id).not.toBe(original.id);
    expect(replacement.modelIds![0]).not.toBe(originalModelId);
    const modelView = await f.client.getModelSettings('user', { storeId: f.storeId });
    expect(modelView.models.some((model) => model.id === originalModelId)).toBe(false);
    await f.client.updateModelSettings('user', {
      expectedStoreId: f.storeId,
      commandId: 'enable-replacement-user',
      expectedReadSet: modelView.readSet!,
      operation: { kind: 'enabled', modelId: replacement.modelIds![0]!, enabled: true },
    });
    await f.runtime.createWorkspace({
      expectedStoreId: f.storeId,
      id: 'old-route-workspace',
      name: 'Owned test',
      rootUri: pathToFileURL(f.root).href,
    });
    await f.runtime.createSession({
      expectedStoreId: f.storeId,
      subjectId: 'local-user',
      commandId: 'create-old-route-session',
      sessionId: 'old-route-session',
      workspaceId: 'old-route-workspace',
      title: 'Saved old route',
    });
    await f.client.startRun('old-route-session', {
      expectedStoreId: f.storeId,
      commandId: 'run-deleted-route',
      kind: 'run.start',
      content: 'Owned test, unavailable route',
      modelId: originalModelId,
    });
    const deadline = Date.now() + 5000;
    let command = await f.client.getCommand('run-deleted-route');
    while (command.status !== 'rejected' && command.status !== 'applied') {
      if (Date.now() > deadline) throw Error('old_route_command_timeout');
      await Bun.sleep(5);
      command = await f.client.getCommand('run-deleted-route');
    }
    expect(command).toMatchObject({ status: 'rejected', receipt: { reason: 'model_unavailable' } });
    expect((await f.client.getView('old-route-session')).runs).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('the user provider directory omits host-only routes and retains overridden local assembly connections read-only', async () => {
  const f = await fixture({
    models: [
      {
        id: 'host-only',
        provider: 'compatible',
        baseURL: 'http://127.0.0.1:1555/v1',
        model: 'host-model',
      },
      { id: 'local-route', remove: true },
    ],
  });
  try {
    const empty = await f.client.getProviderSettings({ storeId: f.storeId });
    expect(empty.providers.every((provider) => provider.connections.length === 0)).toBe(true);
    const source = JSON.stringify({
      modelId: null,
      models: [
        {
          id: 'local-route',
          provider: 'ollama',
          model: 'local-model',
          baseURL: 'http://127.0.0.1:11434/v1',
          enabled: false,
        },
      ],
    });
    writeFileSync(f.file, source);
    const view = await f.client.getProviderSettings({ storeId: f.storeId });
    const connections = view.providers.flatMap((provider) => provider.connections);
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      modelIds: ['local-route'],
      modelNames: ['local-model'],
      canWrite: false,
    });
    expect(readFileSync(f.file, 'utf8')).toBe(source);
  } finally {
    await f.close();
  }
});

test('assembly model tombstones do not create phantom provider rows or invalid model names', async () => {
  const f = await fixture();
  try {
    const source = JSON.stringify({
      modelId: null,
      models: [
        { id: 'removed-model', remove: true },
        {
          id: 'visible-model',
          provider: 'ollama',
          model: 'visible',
          baseURL: 'http://127.0.0.1:11434/v1',
          enabled: false,
        },
      ],
    });
    writeFileSync(f.file, source);
    const view = await f.client.getProviderSettings({ storeId: f.storeId });
    expect(view.errors).toEqual([]);
    const connections = view.providers.flatMap((provider) => provider.connections);
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      modelIds: ['visible-model'],
      modelNames: ['visible'],
      canWrite: true,
    });
    expect(readFileSync(f.file, 'utf8')).toBe(source);
  } finally {
    await f.close();
  }
});
