import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type AgentRuntime, createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createCredentialVault, createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import {
  privateDirectory,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { createUserConfiguration } from '../../src/user-configuration';
import {
  createWebSearchTest,
  type WebSearchTestRoute,
  webSearchTestExtensionId,
} from '../../src/web-search-test';

const set = {
  userEtag: '1'.repeat(64),
  workspaceEtag: null,
  explicitDigest: '2'.repeat(64),
  effectiveDigest: '3'.repeat(64),
};
const binding = '4'.repeat(64);
const obj = (v: unknown): Record<string, Json> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Json>) : {};

async function fixture() {
  const root = temporaryDirectory('kite-search-test-action-');
  const profile = selectProfile({ dataRoot: root, profile: 'owned' });
  privateDirectory(profile.profilePath);
  let runtime: AgentRuntime;
  let current = set;
  let mode: 'native' | 'provider' = 'native';
  let observed = true;
  let permitted = true;
  const calls: string[] = [];
  let resolutions = 0;
  let onResolve: (() => void) | undefined;
  let deferred = false;
  let cancelled = false;
  const action = createWebSearchTest({
    runtime: () => runtime,
    async readSettings(storeId) {
      return {
        storeId,
        readSet: current,
        webSearch: { mode: 'auto' },
        searchProviders: [],
        errors: [],
      };
    },
    async resolveRoute(input): Promise<WebSearchTestRoute> {
      expect(input.subjectId).toBe('owner');
      expect(input.workspaceId).toBe('w');
      resolutions++;
      onResolve?.();
      return {
        route: mode,
        provider: 'owned',
        bindingDigest: binding,
        async search(query, signal, id) {
          expect(query).toBe('Kite web search connectivity test');
          calls.push(id);
          if (deferred) {
            await new Promise<void>((_, reject) => {
              signal.addEventListener(
                'abort',
                () => {
                  cancelled = true;
                  reject(Error('fixture-abort'));
                },
                { once: true },
              );
            });
          }
          return {
            observed,
            sources:
              mode === 'native'
                ? [
                    { url: 'https://example.test/article', title: 'A source' },
                    { url: 'file:///fixture-secret-path', title: 'invalid' },
                  ]
                : [],
          };
        },
      };
    },
  });
  const open = async () =>
    createRuntime({
      store: await openSqliteStore(profile),
      extensions: [action.extension],
      permissions: {
        authorize: async () => ({
          allowed: permitted,
          revision: 'owned',
          reason: permitted ? undefined : 'denied',
        }),
      },
    });
  runtime = await open();
  const expectedStoreId = (await runtime.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'test',
    rootUri: pathToFileURL(root).href,
  });
  for (const sessionId of ['s', 'other'])
    await runtime.createSession({
      expectedStoreId,
      sessionId,
      workspaceId: 'w',
      commandId: `create-${sessionId}`,
      subjectId: 'owner',
      title: 'test',
    });
  const identity = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  const run = (commandId: string, expectedReadSet = set) =>
    action.run({ ...identity, commandId, expectedReadSet, signal: new AbortController().signal });
  async function result(id: string) {
    await runtime.waitForCommand(id, { timeoutMs: 5000 });
    const command = await runtime.getCommand(id);
    const executionId = obj(command?.receipt).executionId;
    if (typeof executionId !== 'string') throw Error('fixture_missing_execution');
    return (await runtime.getExecution(executionId))!;
  }
  return {
    identity,
    action,
    run,
    result,
    calls,
    get resolutions() {
      return resolutions;
    },
    get cancelled() {
      return cancelled;
    },
    qualify: (options: Partial<typeof identity & { bindingDigest: string }> = {}) =>
      action.isNativeQualified({ ...identity, bindingDigest: binding, ...options }),
    provider() {
      mode = 'provider';
      observed = false;
    },
    unobserved() {
      observed = false;
    },
    deny() {
      permitted = false;
    },
    change() {
      current = { ...set, userEtag: 'a'.repeat(64) };
    },
    driftBeforeSend() {
      onResolve = () => {
        if (resolutions === 2) current = { ...set, userEtag: 'a'.repeat(64) };
      };
    },
    pause() {
      deferred = true;
    },
    async cancel(id: string) {
      await runtime.cancelExecution({ ...identity, commandId: 'cancel', executionId: id });
    },
    async reopen() {
      await runtime.close();
      runtime = await open();
    },
    async close() {
      await runtime.close();
      removeTemporaryDirectory(root);
    },
  };
}

test('explicit native search qualifies only its original observed binding, across restart and retry', async () => {
  const f = await fixture();
  try {
    expect(await f.qualify()).toBe(false);
    const foreign = await f.action
      .run({
        ...f.identity,
        subjectId: 'foreign',
        commandId: 'unauthorized',
        expectedReadSet: set,
        signal: new AbortController().signal,
      })
      .catch((e: Error) => e);
    expect(foreign instanceof Error && foreign.message === 'host_control_scope_denied').toBe(true);
    expect(f.resolutions).toBe(0);
    await f.run('one');
    const execution = await f.result('one');
    expect(execution.status).toBe('succeeded');
    expect(f.calls).toEqual([execution.id]);
    expect(obj(execution.result).details).toEqual({
      route: 'native',
      provider: 'owned',
      observed: true,
      sources: [{ url: 'https://example.test/article', title: 'A source' }],
    });
    await f.reopen();
    f.change();
    expect((await f.run('one')).id).toBe('one');
    expect(f.calls).toEqual([execution.id]);
    expect(await f.qualify()).toBe(true);
    for (const mismatch of [
      { bindingDigest: 'a'.repeat(64) },
      { sessionId: 'other' },
      { subjectId: 'someone-else' },
    ])
      expect(await f.qualify(mismatch)).toBe(false);
    const conflict = await f
      .run('one', { ...set, userEtag: 'a'.repeat(64) })
      .catch((e: Error) => e);
    expect(conflict instanceof Error && conflict.message === 'command_conflict').toBe(true);
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('empty provider result succeeds; native response without observed search is unqualified', async () => {
  const f = await fixture();
  try {
    f.unobserved();
    await f.run('native');
    const unobserved = await f.result('native');
    expect(unobserved.status).toBe('failed');
    expect(obj(unobserved.result).content).toBe('search_not_performed');
    expect(await f.qualify()).toBe(false);
    f.provider();
    await f.run('provider');
    const provider = await f.result('provider');
    expect(provider.status).toBe('succeeded');
    expect(obj(provider.result).details).toEqual({
      route: 'provider',
      provider: 'owned',
      observed: false,
      sources: [],
    });
    expect(await f.qualify()).toBe(false);
    expect(f.calls).toEqual([unobserved.id, provider.id]);
  } finally {
    await f.close();
  }
});

test('policy denial and last-moment configuration drift each stop the explicit request before sending', async () => {
  const f = await fixture();
  try {
    f.deny();
    await f.run('denied');
    expect((await f.result('denied')).status).toBe('failed');
    expect(f.calls).toEqual([]);
    expect(await f.qualify()).toBe(false);
  } finally {
    await f.close();
  }
  const drift = await fixture();
  try {
    drift.driftBeforeSend();
    await drift.run('drift');
    const result = await drift.result('drift');
    expect(result.status).toBe('failed');
    expect(obj(result.result).content).toBe('configuration_read_set_conflict');
    expect(drift.calls).toEqual([]);
    expect(await drift.qualify()).toBe(false);
  } finally {
    await drift.close();
  }
});

test('cancelling an in-flight explicit search does not prove an effect or replay the request', async () => {
  const f = await fixture();
  try {
    f.pause();
    await f.run('slow');
    const end = Date.now() + 4000;
    while (!f.calls.length && Date.now() < end) await Bun.sleep(5);
    expect(f.calls).toHaveLength(1);
    await f.cancel(f.calls[0]!);
    const result = await f.result('slow');
    expect(['outcome_unknown', 'cancelled']).toContain(result.status);
    expect(f.cancelled).toBe(true);
    expect(await f.qualify()).toBe(false);
    await f.run('slow');
    expect(f.calls).toEqual([result.id]);
  } finally {
    await f.close();
  }
});

test('the Service sends the test probe only to an explicitly selected DeepSeek account when two accounts are eligible', async () => {
  const root = temporaryDirectory('kite-search-test-accounts-');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  privateDirectory(profile.profilePath);
  const file = join(profile.profilePath, 'config.jsonc');
  const credentialBackend = createTemporaryCredentialBackend();
  const vault = createCredentialVault({ backend: credentialBackend });
  const accounts = ['primary', 'secondary'] as const;
  type Account = (typeof accounts)[number];
  const aliases = new Map<string, Account>();
  const providers: Record<string, { type: string; credentialRef: string; models: string[] }> = {};
  for (const account of accounts) {
    const value = crypto.randomUUID();
    aliases.set(`Bearer ${value}`, account);
    providers[account] = {
      type: 'deepseek',
      credentialRef: (await vault.put(value)).id,
      models: ['deepseek-flash'],
    };
  }
  const configure = (selected?: Account) =>
    writeFileSync(
      file,
      JSON.stringify({
        provider: providers,
        ...(selected ? { model: `${selected}:deepseek-flash` } : {}),
        tools: [],
        skills: [],
      }),
      { mode: 0o600 },
    );
  configure();
  const wire: Account[] = [];
  const host = createDefaultProcessConfiguration({
    profile,
    userConfigurationPath: file,
    credentialBackend,
    localCodex: false,
    permissions: { authorize: async () => ({ allowed: true, revision: 'fixture' }) },
    webSearchFetch: Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        const account = aliases.get(request.headers.get('authorization') ?? '');
        if (
          !account ||
          request.url !== 'https://api.deepseek.com/v1/tools/search' ||
          request.method !== 'POST'
        )
          throw Error('unexpected_fixture_search_request');
        wire.push(account);
        expect((await request.json()).query).toBe('Kite web search connectivity test');
        return Response.json({ results: [] });
      },
      {
        preconnect() {
          throw Error('unexpected_fixture_preconnect');
        },
      },
    ),
  });
  const finish = {
    type: 'finish' as const,
    reason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const store = await openSqliteStore(profile);
  const fixed = createFixedModel([
    [{ type: 'text_delta', text: 'First business reply' }, finish],
    [{ type: 'text_delta', text: 'Second business reply' }, finish],
  ]);
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    extensions: host.extensions?.filter((extension) => extension.id === webSearchTestExtensionId),
    permissions: { authorize: async () => ({ allowed: true, revision: 'fixture' }) },
    async resolveRunConfiguration(input) {
      const selected = await host.resolveRunConfiguration!(input);
      // The real host selects the business model. This fixture records that selection
      // using a fixed reply without exposing any business tools or model transport.
      return {
        modelId: selected.modelId,
        snapshot: selected.snapshot,
        dispose: selected.dispose,
        toolIds: [],
        model: fixed,
      };
    },
  });
  host.permissionManagement!(runtime);
  const expectedStoreId = (await runtime.getMetadata()).storeId;
  const owner = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  const service = await startService({
    runtime,
    subjectId: 'owner',
    buildId: 'search-test-account',
    profile: {
      dataRoot: profile.dataRoot,
      name: profile.profile,
      accessKey: profile.profileAccessKey,
    },
    configurationManagement: host.configurationManagement!(runtime),
    webSearchTest: host.webSearchTest!(runtime),
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      apiMajor: 1,
      profile: service.bootstrap.profile,
      requiredCapabilities: ['web_search_settings', 'web_search_test', 'commands'],
    },
  });
  async function probe(commandId: string) {
    const settings = await client.getWebSearchSettings({ storeId: expectedStoreId });
    return client.testWebSearch({
      expectedStoreId,
      sessionId: 's',
      commandId,
      expectedReadSet: settings.readSet!,
    });
  }
  async function unavailable(commandId: string) {
    const failure = await probe(commandId).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'web_search_route_unavailable' });
    expect(await runtime.getCommand(commandId)).toBeNull();
    expect(wire).toEqual([]);
  }
  async function checked(commandId: string, account: Account) {
    const count = wire.length;
    await probe(commandId);
    const command = await runtime.waitForCommand(commandId, { timeoutMs: 5000 });
    const execution = await runtime.getExecution(String(obj(command.receipt).executionId));
    expect(execution?.status).toBe('succeeded');
    expect(obj(execution?.result).details).toMatchObject({ route: 'provider', provider: account });
    expect(wire.slice(count)).toEqual([account]);
  }
  async function run(commandId: string, modelId?: string) {
    await client.startRun('s', {
      expectedStoreId,
      commandId,
      kind: 'run.start',
      content: 'New task: reply with a word.',
      ...(modelId ? { modelId } : {}),
    });
    const command = await runtime.waitForCommand(commandId, { timeoutMs: 10000 });
    expect({ status: command.status, reason: obj(command.receipt).reason }).toEqual({
      status: 'applied',
      reason: undefined,
    });
    expect((await runtime.getRun(String(obj(command.receipt).runId)))?.status).toBe('completed');
    return runtime.readLatestBusinessModelPreference(owner);
  }
  try {
    await client.connect();
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(root).href,
    });
    await client.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Owned',
    });
    const user = createUserConfiguration(file).read().value;
    const models = Array.isArray(user.models) ? user.models.map(obj) : [];
    const modelId = (alias: Account) =>
      String(models.find((model) => model.providerName === alias)!.id);
    expect(await runtime.readLatestBusinessModelPreference(owner)).toBeNull();
    await unavailable('fresh');
    expect(await run('implicit')).toMatchObject({ modelId: modelId('primary') });
    expect(obj((await runtime.getCommand('implicit'))?.request)).not.toHaveProperty('modelId');
    await unavailable('implicit-probe');
    configure('secondary');
    await checked('current-selection', 'secondary');
    configure();
    expect(await run('explicit', modelId('primary'))).toMatchObject({
      modelId: modelId('primary'),
    });
    await checked('previous-selection', 'primary');
    await probe('previous-selection');
    expect(wire).toEqual(['secondary', 'primary']);
    expect(fixed.requests).toHaveLength(2);
  } finally {
    client.disposeNetwork();
    await service.close();
    removeTemporaryDirectory(root);
  }
}, 30000);
