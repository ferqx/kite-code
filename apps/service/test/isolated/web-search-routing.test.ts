import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createCredentialVault, createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import {
  privateDirectory,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import { startService } from '../../src';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { createPermissionManagement } from '../../src/permission-management';
import { createSearchBindings } from '../../src/web-search-bindings';
import {
  inheritedSearchRoute,
  nativeSearchIdentity,
  type SearchRoute,
  savedSearchRoute,
  selectSearchRoute,
} from '../../src/web-search-route';

const model = {
  id: 'm',
  provider: 'openai' as const,
  protocol: 'responses' as const,
  model: 'gpt-5',
  baseURL: 'https://api.openai.com/v1',
  credentialRef: 'credential:12345678-1234-1234-1234-123456789abc',
};
const provider: Extract<SearchRoute, { kind: 'provider' }> = {
  kind: 'provider',
  adapter: 'deepseek-search',
  providerId: 'papers',
  bindingDigest: 'a'.repeat(64),
};
const native = nativeSearchIdentity(model, 'profile', 'owner')!;
test('search freezes exactly one route before dispatch, observes policy and narrows child accounts', () => {
  const options = {
    settings: { mode: 'auto' as const, providerId: 'papers' },
    enabled: true,
    provider,
    native,
  };
  expect(selectSearchRoute(options)).toEqual(native);
  expect(selectSearchRoute({ ...options, native: undefined })).toEqual(provider);
  expect(
    selectSearchRoute({ ...options, settings: { mode: 'provider', providerId: 'papers' } }),
  ).toEqual(native);
  expect(
    selectSearchRoute({
      ...options,
      native: undefined,
      provider: { ...provider, adapter: 'perplexity-search' },
    }),
  ).toEqual({ kind: 'none', reason: 'unavailable' });
  expect(selectSearchRoute({ ...options, settings: { mode: 'disabled' } })).toEqual({
    kind: 'none',
    reason: 'disabled',
  });
  expect(selectSearchRoute({ ...options, enabled: false })).toEqual({
    kind: 'none',
    reason: 'policy',
  });
  for (const parent of [null, { kind: 'none', reason: 'disabled' } as const])
    expect(selectSearchRoute({ ...options, parent })).toEqual({ kind: 'none', reason: 'parent' });
  expect(selectSearchRoute({ ...options, parent: provider })).toEqual(provider);
  expect(
    selectSearchRoute({ ...options, parent: { ...provider, bindingDigest: 'b'.repeat(64) } }),
  ).toEqual({ kind: 'none', reason: 'parent' });
  expect(
    selectSearchRoute({ ...options, parent: { ...native, accountDigest: 'c'.repeat(64) } }),
  ).toEqual({ kind: 'none', reason: 'parent' });
  const child = nativeSearchIdentity(
    { ...model, id: 'child', model: 'gpt-5-mini' },
    'profile',
    'owner',
  )!;
  expect(child.accountDigest).toBe(native.accountDigest);
  expect(child.bindingDigest).not.toBe(native.bindingDigest);
  expect(selectSearchRoute({ ...options, native: child, parent: native })).toEqual(child);
});

test('native eligibility and parent reconstruction keep official account bindings and reject forged or incomplete digests', () => {
  expect(
    nativeSearchIdentity({ ...model, baseURL: 'https://fixture.test/v1' }, 'profile', 'owner'),
  ).toBeUndefined();
  expect(
    nativeSearchIdentity({ ...model, provider: 'compatible' }, 'profile', 'owner'),
  ).toBeUndefined();
  const { credentialRef, ...withoutCredential } = model;
  expect(nativeSearchIdentity(withoutCredential, 'profile', 'owner')).toBeUndefined();
  expect(nativeSearchIdentity(model, 'elsewhere', 'owner')?.accountDigest).not.toBe(
    native.accountDigest,
  );
  expect(
    inheritedSearchRoute({ snapshot: { roleId: 'child', configuration: { webSearch: provider } } }),
  ).toEqual(provider);
  expect(
    inheritedSearchRoute({
      snapshot: { kind: 'human_input_processing', originalConfiguration: { webSearch: native } },
    }),
  ).toEqual(native);
  expect(
    inheritedSearchRoute({ snapshot: { webSearch: { ...provider, bindingDigest: 'invalid' } } }),
  ).toBeNull();
  expect(savedSearchRoute({ kind: 'native', provider: 'openai' })).toBeUndefined();
  expect(JSON.stringify(native)).not.toContain(credentialRef);
});

test('a default Service Run derives DeepSeek from the user model provider, sends once and exposes original evidence through the Client', async () => {
  const root = temporaryDirectory('kite-search-default-');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  privateDirectory(profile.profilePath);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const credentialBackend = createTemporaryCredentialBackend();
  const vault = createCredentialVault({ backend: credentialBackend });
  const secret = `fixture-${crypto.randomUUID()}`;
  const credential = await vault.put(secret);
  type Chat = {
    messages: { role: string; content: string }[];
    tools?: { function: { name: string; parameters: unknown } }[];
  };
  const chats: Chat[] = [];
  const main = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const chat = (await req.json()) as Chat;
      chats.push(chat);
      const hasResult = chat.messages.some((m) => m.role === 'tool');
      const delta = hasResult
        ? { content: 'Found owned search result' }
        : {
            tool_calls: [
              {
                index: 0,
                id: 'lookup',
                type: 'function',
                function: { name: 'web_search', arguments: '{"query":"local integration"}' },
              },
            ],
          };
      const chunk = (delta: unknown, reason: string | null) =>
        `data: ${JSON.stringify({ id: 'main', object: 'chat.completion.chunk', created: 1, model: 'local', choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
      return new Response(
        [chunk(delta, null), chunk({}, hasResult ? 'stop' : 'tool_calls'), 'data: [DONE]\n\n'].join(
          '',
        ),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    },
  });
  const path = join(profile.profilePath, 'config.jsonc');
  writeFileSync(
    path,
    JSON.stringify({
      model: 'local:local',
      provider: {
        local: {
          type: 'openai-compatible',
          models: ['local'],
          baseURL: `http://127.0.0.1:${main.port}/v1`,
        },
        research: {
          type: 'deepseek',
          name: 'Research',
          baseURL: 'https://api.deepseek.com',
          credentialRef: credential.id,
        },
      },
      tools: [{ id: 'web.search', definitionVersion: '1' }],
    }),
    { mode: 0o600 },
  );
  const wire: { url: string; body: unknown; authorized: boolean }[] = [];
  const webSearchFetch = async (input: RequestInfo | URL, options?: RequestInit) => {
    wire.push({
      url: String(input),
      body: JSON.parse(String(options?.body)),
      authorized: new Headers(options?.headers).get('authorization') === `Bearer ${secret}`,
    });
    return Response.json({
      results: [
        {
          url: 'https://research.example/result',
          title: 'Verified result',
          snippet: 'Original source material.',
        },
      ],
    });
  };
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const host = createDefaultProcessConfiguration({
    profile,
    credentialBackend,
    userConfigurationPath: path,
    webSearchFetch: webSearchFetch as typeof fetch,
    permissions: {
      authorize: async () => ({ allowed: true, revision: 'fixture-authorizes-tool' }),
    },
  });
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    permissions: host.permissions!,
    extensions: host.extensions,
    resolveRunConfiguration: host.resolveRunConfiguration,
  });
  host.permissionManagement?.(runtime);
  const serverProfile = {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile: serverProfile,
    subjectId: 'owner',
    buildId: 'search-test',
  });
  try {
    const client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: {
        profile: serverProfile,
        apiMajor: 1,
        requiredCapabilities: ['commands', 'sessions', 'web_search_evidence'],
      },
    });
    await client.connect();
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: pathToFileURL(workspace).href,
      name: 'fixture',
    });
    await client.createSession({
      expectedStoreId,
      commandId: 'new',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Search',
    });
    const controls = createPermissionManagement({ runtime, profile });
    const scope = { expectedStoreId, subjectId: 'owner' };
    const mode = await controls.readMode({ ...scope, sessionId: 's' });
    await controls.setMode({
      ...scope,
      sessionId: 's',
      commandId: 'full',
      mode: 'full',
      ifRevision: mode.revision,
      ifDefaultRevision: mode.defaultRevision,
      makeDefault: false,
    });
    const trust = await controls.readTrust({ ...scope, workspaceId: 'w' });
    await controls.setTrust({
      ...scope,
      workspaceId: 'w',
      commandId: 'trust',
      trusted: true,
      ifRevision: trust.revision,
      canonicalIdentity: trust.canonicalIdentity,
      externalReadScopeDigest: trust.externalReadScopeDigest,
    });
    await client.startRun('s', {
      expectedStoreId,
      commandId: 'work',
      kind: 'run.start',
      content: 'Search the local integration fixture',
    });
    const command = await runtime.waitForCommand('work', { timeoutMs: 15000 });
    expect(command.status).toBe('applied');
    const tool = (await store.listExecutions('s')).find((e) => e.kind === 'tool');
    expect(tool).toMatchObject({ definitionId: 'web.search', status: 'succeeded' });
    expect(wire).toEqual([
      {
        url: 'https://api.deepseek.com/v1/tools/search',
        body: { query: 'local integration', count: 5, need_content: false },
        authorized: true,
      },
    ]);
    expect(chats).toHaveLength(2);
    expect(chats[0]!.tools?.filter((t) => t.function.name === 'web_search')).toHaveLength(1);
    expect(chats[1]!.messages.find((m) => m.role === 'tool')?.content).toContain(
      'Original source material.',
    );
    const evidence = await client.getWebSearchEvidence(tool!.id, {
      storeId: expectedStoreId,
      sessionId: 's',
    });
    expect(evidence).toMatchObject({
      executionId: tool!.id,
      blocks: [
        {
          route: 'provider',
          provider: 'research',
          status: 'completed',
          query: 'local integration',
          sources: [{ url: 'https://research.example/result', title: 'Verified result' }],
          citations: [],
          usage: { providerRequests: 1 },
        },
      ],
    });
    expect(JSON.stringify([chats, evidence, command, tool])).not.toContain(secret);
  } finally {
    await service.close();
    main.stop(true);
    removeTemporaryDirectory(root);
  }
}, 25000);

test('derived routes bind without probing, and a changed credential or disabled account cannot reopen a frozen Run', async () => {
  const vault = createCredentialVault({ backend: createTemporaryCredentialBackend() });
  const original = await vault.put('fixture-original');
  const replacement = await vault.put('fixture-replacement');
  const readIds: string[] = [];
  const sent: boolean[] = [];
  const binding = createSearchBindings({
    runtime() {
      throw Error('unexpected model dispatch');
    },
    profileAccessKey: 'fixture-profile',
    modelVault: {
      resolve: async (ref) => {
        readIds.push(typeof ref === 'string' ? ref : ref.id);
        return vault.resolve(ref);
      },
    },
    allowNative: async () => true,
    qualified: async () => true,
    fetch: Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        sent.push(new Headers(init?.headers).get('authorization') === 'Bearer fixture-replacement');
        return Response.json({ results: [] });
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const scope = { expectedStoreId: 'store', subjectId: 'owner', sessionId: 's', workspaceId: 'w' };
  const legacy = {
    webSearch: { mode: 'provider', providerId: 'old' },
    searchProviders: [
      {
        id: 'old',
        name: 'Legacy',
        adapter: 'deepseek-search',
        connection: {
          kind: 'dedicated',
          baseURL: 'https://api.deepseek.com',
          credentialRef: original.id,
        },
      },
    ],
  };
  const input = (ref: string, enabled = true) => {
    const model = {
      id: 'alias:model',
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      providerName: 'alias',
      baseURL: 'https://api.deepseek.com',
      credentialRef: ref,
      enabled,
    };
    return {
      user: { ...legacy, modelId: model.id, models: [model] },
      model,
      scope,
      enabled: true,
      nativeAllowed: false,
    };
  };
  const first = input(original.id);
  const originalRun = await binding.bind(first);
  expect(originalRun.route).toMatchObject({
    kind: 'provider',
    providerId: 'alias',
    adapter: 'deepseek-search',
  });
  expect(originalRun.extension).toBeDefined();
  const restore = { route: originalRun.route };
  expect((await binding.bind({ ...first, restore })).route).toEqual(originalRun.route);
  const eligibleOpenAI = { ...model, providerName: 'official' };
  const reopened = await binding.bind({
    ...first,
    model: eligibleOpenAI,
    nativeAllowed: true,
    restore,
    user: { ...first.user, models: [...first.user.models, eligibleOpenAI] },
  });
  expect(reopened.route).toEqual(originalRun.route);
  expect(reopened.nativeWebSearch).toBeUndefined();
  const initialProbe = binding.test(first.user, first.model, scope);
  const next = input(replacement.id);
  const rotated = await binding.bind(next);
  expect(rotated.route).toMatchObject({ kind: 'provider', providerId: 'alias' });
  expect(rotated.route).not.toEqual(originalRun.route);
  await expect(binding.bind({ ...next, restore })).rejects.toThrow('Original binding changed');
  await expect(binding.bind({ ...input(original.id, false), restore })).rejects.toThrow(
    'Original binding changed',
  );
  const off = await binding.bind({ ...next, enabled: false });
  expect(off.route).toEqual({ kind: 'none', reason: 'policy' });
  expect(
    (await binding.bind({ ...next, restore: { route: off.route } })).extension,
  ).toBeUndefined();
  expect((await binding.bind({ ...next, parent: originalRun.route })).extension).toBeUndefined();
  expect((await binding.bind({ ...next, user: legacy })).extension).toBeUndefined();
  expect(readIds).toEqual([]);
  expect(sent).toEqual([]);

  await vault.revoke(original);
  const signal = new AbortController().signal;
  await expect(initialProbe.search('fixture query', signal, 'old-test')).rejects.toThrow(
    'search_credential_unavailable',
  );
  const nextProbe = binding.test(next.user, next.model, scope);
  await expect(
    nextProbe.search('fixture query', AbortSignal.abort(), 'cancelled-test'),
  ).rejects.toThrow('search_cancelled');
  expect(readIds).toEqual([original.id]);
  expect(sent).toEqual([]);
  await nextProbe.search('fixture query', signal, 'new-test');
  expect(readIds).toEqual([original.id, replacement.id]);
  expect(sent).toEqual([true]);
});
