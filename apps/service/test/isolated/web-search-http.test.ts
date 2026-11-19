import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createCredentialVault, createTemporaryCredentialBackend } from '@kite-ai/agent/config';
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
import { createConfigurationManagement } from '../../src/configuration-management';
import { createUserConfiguration } from '../../src/user-configuration';

test('paired Client reads owned evidence, saves redacted settings and submits only an explicit scoped test', async () => {
  const root = temporaryDirectory('kite-web-search-http-');
  const selected = selectProfile({ dataRoot: root, profile: 'owned' });
  privateDirectory(selected.profilePath);
  const path = join(selected.profilePath, 'config.jsonc');
  writeFileSync(path, '{}', { mode: 0o600 });
  const profile = { dataRoot: root, name: selected.profile, accessKey: selected.profileAccessKey };
  const store = await openSqliteStore(selected);
  const artifacts = createArtifactStore({ store, profile: selected });
  const model = createFixedModel([
    [
      { type: 'text_delta', text: 'answer' },
      { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
  ]);
  const runtime = createRuntime({
    store,
    artifacts,
    model,
    permissions: { authorize: async () => ({ allowed: true, revision: 'fixture' }) },
  });
  const expectedStoreId = (await runtime.getMetadata()).storeId;
  const owner = { expectedStoreId, subjectId: 'owner', sessionId: 'session' };
  const manager = createConfigurationManagement({
    runtime,
    profile: selected,
    userConfiguration: createUserConfiguration(path),
    vault: createCredentialVault({ backend: createTemporaryCredentialBackend() }),
    persistence: 'temporary',
    explicit: () => ({}),
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'workspace',
    name: 'Fixture',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    ...owner,
    commandId: 'create',
    workspaceId: 'workspace',
    title: 'Fixture',
  });
  await runtime.submitCommand({
    ...owner,
    commandId: 'start',
    request: { kind: 'run.start', content: 'offline' },
  });
  await runtime.waitForCommand('start', { timeoutMs: 10000 });
  const executionId = (await runtime.listModelInputs(owner)).items[0]!.executionId;
  const testCalls: string[] = [];
  const service = await startService({
    runtime,
    profile,
    buildId: 'build',
    subjectId: owner.subjectId,
    configurationManagement: manager,
    webSearchTest: {
      async run(input) {
        expect(input.subjectId).toBe(owner.subjectId);
        expect(input.signal).toBeInstanceOf(AbortSignal);
        testCalls.push(input.commandId);
        const template = await runtime.getCommand('create');
        return {
          ...template!,
          id: input.commandId,
          kind: 'extension.invoke',
          request: {
            kind: 'extension.invoke',
            extensionId: 'builtin.web-search-test',
            actionId: 'web_search.test',
          },
          receipt: { state: 'fixture' },
        };
      },
    },
  });
  const capabilities = ['web_search_settings', 'web_search_test', 'web_search_evidence'];
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: { apiMajor: 1, profile, requiredCapabilities: capabilities },
  });
  const evidencePath = `/v1/sessions/session/executions/${executionId}/web-search-evidence`;
  const read = (suffix: string, token = service.bootstrap.token, origin?: string) =>
    fetch(service.endpoint + suffix, {
      headers: { authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) },
    });
  const scope = { storeId: expectedStoreId, sessionId: owner.sessionId };
  try {
    await client.connect();
    expect(await client.getWebSearchEvidence(executionId, scope)).toMatchObject({
      revision: 0,
      blocks: [],
    });
    await runtime.publishWebSearchEvidence(
      { ...owner, executionId },
      {
        callId: 'search',
        route: 'native',
        provider: 'fixture',
        status: 'completed',
        sources: [{ url: 'https://example.test/result', title: 'Example' }],
        citations: [],
        truncated: false,
      },
    );
    expect(await client.getWebSearchEvidence(executionId, scope)).toMatchObject({
      revision: 1,
      blocks: [{ callId: 'search', sources: [{ title: 'Example' }] }],
    });
    expect(
      await client
        .getWebSearchEvidence(executionId, { ...scope, sessionId: 'missing' })
        .catch((e) => e.code),
    ).toBe('web_search_evidence_unavailable');
    for (const [response, status] of [
      [await read(`${evidencePath}?storeId=${expectedStoreId}&subjectId=owner`), 400],
      [await read(`${evidencePath}?storeId=${expectedStoreId}&storeId=${expectedStoreId}`), 400],
      [await read(`${evidencePath}?storeId=wrong`), 409],
      [await read(`${evidencePath}?storeId=${expectedStoreId}`, 'wrong'), 401],
      [
        await read(
          `${evidencePath}?storeId=${expectedStoreId}`,
          service.bootstrap.token,
          service.endpoint,
        ),
        403,
      ],
    ] as const) {
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).not.toContain('Example');
    }
    const before = await client.getWebSearchSettings({ storeId: expectedStoreId });
    const secret = 'synthetic-fixture-key';
    const input = {
      expectedStoreId,
      expectedReadSet: before.readSet!,
      commandId: 'save',
      webSearch: { mode: 'provider' as const, providerId: 'example' },
      searchProviders: [
        {
          id: 'example',
          name: 'Example',
          adapter: 'perplexity-search' as const,
          connection: { kind: 'dedicated' as const, baseURL: 'https://api.perplexity.ai' },
        },
      ],
      credential: { providerId: 'example', secret },
    };
    const invalidProvider = {
      ...input.searchProviders[0]!,
      connection: { kind: 'dedicated' as const, baseURL: 'http://127.0.0.1/' },
    };
    await expect(
      client.saveWebSearchSettings({
        ...input,
        commandId: 'invalid-endpoint',
        searchProviders: [invalidProvider],
      }),
    ).rejects.toMatchObject({
      code: 'web_search_connection_invalid',
      status: 400,
    });
    expect(testCalls).toEqual([]);
    const saved = await client.saveWebSearchSettings(input);
    expect(saved.state).toBe('applied');
    expect(await client.saveWebSearchSettings(input)).toEqual(saved);
    const after = await client.getWebSearchSettings({ storeId: expectedStoreId });
    expect(after.searchProviders[0]?.connection).toMatchObject({
      kind: 'dedicated',
      credentialRef: expect.stringMatching(/^credential:/),
    });
    expect(JSON.stringify([saved, after])).not.toContain(secret);
    const testInput = {
      commandId: 'explicit-test',
      expectedStoreId,
      sessionId: owner.sessionId,
      expectedReadSet: after.readSet!,
    };
    const invalid = await fetch(`${service.endpoint}/v1/config/user/web-search/test`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${service.bootstrap.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...testInput, url: 'https://example.test', subjectId: 'other' }),
    });
    expect(invalid.status).toBe(400);
    expect(testCalls).toEqual([]);
    expect(await client.testWebSearch(testInput)).toMatchObject({
      id: 'explicit-test',
      subjectId: 'owner',
      sessionId: 'session',
      kind: 'extension.invoke',
    });
    expect(testCalls).toEqual(['explicit-test']);
    expect(model.requests).toHaveLength(1);
    const outsider = await startService({
      runtime,
      profile,
      buildId: 'foreign',
      capabilities,
      subjectId: 'other',
    });
    try {
      expect(outsider.bootstrap.capabilities).toContain('web_search_evidence');
      expect(outsider.bootstrap.capabilities).not.toContain('web_search_settings');
      expect(outsider.bootstrap.capabilities).not.toContain('web_search_test');
      const denied = await fetch(`${outsider.endpoint + evidencePath}?storeId=${expectedStoreId}`, {
        headers: { authorization: `Bearer ${outsider.bootstrap.token}` },
      });
      expect(denied.status).toBe(404);
      expect(await denied.text()).not.toContain('Example');
    } finally {
      await outsider.close();
    }
  } finally {
    client.disposeNetwork();
    await service.close();
    await runtime.close();
    await store.close();
    removeTemporaryDirectory(root);
  }
}, 20000);

test('unbound authorities cannot be advertised by startup capability strings', async () => {
  const claimed = ['web_search_settings', 'web_search_test', 'web_search_evidence'];
  const service = await startService({
    buildId: 'fixture',
    profile: { dataRoot: '/unused', name: 'owned', accessKey: 'fixture' },
    capabilities: claimed,
  });
  try {
    for (const capability of claimed)
      expect(service.bootstrap.capabilities).not.toContain(capability);
  } finally {
    await service.close();
  }
});
