import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { privateDirectory } from '@kite-ai/agent/windows-path-security';
import { createClient, type ProviderSettingsRequest } from '@kite-ai/client';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { startService } from '../../src/index';

async function fixture() {
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
    ).toEqual(['openai', 'deepseek', 'compatible', 'ollama']);
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
    expect(
      view.models.find((model) => model.provider === 'deepseek')!.reasoningEffortChoices,
    ).toEqual([]);
    expect(
      view.models.find((model) => model.provider === 'openai')!.reasoningEffortChoices,
    ).toContain('high');
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
    await expect(update('enabled', 'disable-default', false)).rejects.toMatchObject({
      code: 'model_settings_default_disable_denied',
    });
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
