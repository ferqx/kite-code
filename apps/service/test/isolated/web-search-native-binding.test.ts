import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createCredentialVault, createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
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
import { inheritedSearchRoute } from '../../src/web-search-route';
import { encodeFrames, responseFrames } from '../fixtures/responses-wire';

const obj = (v: unknown): Record<string, Json> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Json>) : {};
const endpoint = 'https://api.openai.com/v1/responses';
const source = 'https://example.org/kite-search-test';

function response(model: string, count: number, searched: boolean) {
  const frames = responseFrames({
    id: `response-${count}`,
    model,
    text: ['Search fixture completed.'],
  });
  if (searched) {
    const id = `search-${count}`;
    const item = {
      type: 'web_search_call',
      id,
      status: 'completed',
      action: { type: 'search', query: 'fixture', sources: [{ type: 'url', url: source }] },
    };
    const completed = frames.pop()!;
    const output = (completed.response as { output: unknown[] }).output;
    const index = output.length;
    output.push(item);
    frames.push(
      {
        type: 'response.output_item.added',
        output_index: index,
        item: { type: 'web_search_call', id, status: 'in_progress' },
      },
      { type: 'response.output_item.done', output_index: index, item },
      completed,
    );
    frames.forEach((frame, sequence) => {
      frame.sequence_number = sequence;
    });
  }
  return new Response(encodeFrames(frames), { headers: { 'content-type': 'text/event-stream' } });
}

async function verifyNativeBinding(selectedModel: string, effort?: 'high') {
  const root = temporaryDirectory('kite-native-search-binding-');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  privateDirectory(profile.profilePath);
  const workspace = join(root, 'workspace');
  privateDirectory(workspace);
  const credentialBackend = createTemporaryCredentialBackend();
  const vault = createCredentialVault({ backend: credentialBackend });
  const secret = crypto.randomUUID();
  const api = await vault.put(secret);
  const deepseek = await vault.put(crypto.randomUUID());
  const file = join(profile.profilePath, 'config.jsonc');
  const write = (model: string) =>
    writeFileSync(
      file,
      JSON.stringify({
        provider: {
          official: {
            type: 'openai',
            protocol: 'responses',
            baseURL: 'https://api.openai.com/v1',
            credentialRef: api.id,
            ...(effort === undefined ? {} : { effort }),
            models: [selectedModel, 'unqualified-model'],
          },
          fallback: {
            type: 'deepseek',
            baseURL: 'https://api.deepseek.com',
            credentialRef: deepseek.id,
          },
        },
        model: `official:${model}`,
        tools: [],
        skills: [],
        webSearch: { mode: 'auto', providerId: 'fallback-search' },
        searchProviders: [
          {
            id: 'fallback-search',
            name: 'Owned fallback',
            adapter: 'deepseek-search',
            connection: { kind: 'provider', providerAlias: 'fallback' },
          },
        ],
      }),
      { mode: 0o600 },
    );
  write(selectedModel);
  const wire: {
    lane: string;
    model: string;
    effort?: string;
    native: boolean;
    ordinary: boolean;
    forced: boolean;
  }[] = [];
  const peer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      if (req.method !== 'POST' || req.headers.get('authorization') !== `Bearer ${secret}`)
        return new Response(null, { status: 401 });
      const lane = new URL(req.url).pathname;
      const bytes = Buffer.from(await req.arrayBuffer());
      const data = JSON.parse(
        (req.headers.get('content-encoding') === 'zstd'
          ? zstdDecompressSync(bytes)
          : bytes
        ).toString('utf8'),
      );
      const tools = data.tools ?? [];
      const native = tools.some((tool: { type: string }) => tool.type === 'web_search');
      const ordinary = tools.some(
        (tool: { type: string; name?: string }) =>
          tool.type === 'function' && tool.name === 'web_search',
      );
      wire.push({
        lane,
        model: data.model,
        effort: data.reasoning?.effort,
        native,
        ordinary,
        forced: data.tool_choice?.type === 'web_search',
      });
      return response(data.model, wire.length, native);
    },
  });
  const relay = (lane: string): typeof fetch =>
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const req = new Request(input, init);
        if (req.url !== endpoint) throw Error('unexpected_search_fixture_destination');
        return fetch(new URL(lane, peer.url), {
          method: req.method,
          headers: req.headers,
          body: await req.arrayBuffer(),
          signal: req.signal,
        });
      },
      { preconnect: () => fetch.preconnect(peer.url) },
    );
  const host = createDefaultProcessConfiguration({
    profile,
    userConfigurationPath: file,
    credentialBackend,
    webSearchFetch: relay('/test'),
    openAIResponsesFetch: relay('/model'),
  });
  const store = await openSqliteStore(profile);
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    extensions: host.extensions,
    permissions: host.permissions!,
    resolveRunConfiguration: host.resolveRunConfiguration,
  });
  const expectedStoreId = (await runtime.getMetadata()).storeId;
  const owner = { expectedStoreId, subjectId: 'owner' };
  const profileInfo = {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  };
  const permissions = host.permissionManagement!(runtime);
  const service = await startService({
    runtime,
    profile: profileInfo,
    buildId: 'search-test',
    subjectId: owner.subjectId,
    configurationManagement: host.configurationManagement!(runtime),
    permissionManagement: permissions,
    webSearchTest: host.webSearchTest!(runtime),
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      apiMajor: 1,
      profile: profileInfo,
      requiredCapabilities: ['web_search_test', 'web_search_settings', 'web_search_evidence'],
    },
  });
  async function mode(value: 'auto' | 'full', key: string) {
    const old = await permissions.readMode({ ...owner, sessionId: 's' });
    await client.setPermissionMode('s', {
      expectedStoreId,
      commandId: key,
      mode: value,
      makeDefault: false,
      ifRevision: old.revision,
      ifDefaultRevision: old.defaultRevision,
    });
  }
  async function run(id: string) {
    await client.startRun('s', {
      kind: 'run.start',
      commandId: id,
      expectedStoreId,
      content: 'Answer with one sentence.',
    });
    const command = await runtime.waitForCommand(id, { timeoutMs: 10000 });
    const record = await runtime.getRun(String(obj(command.receipt).runId));
    expect(record?.status).toBe('completed');
    return inheritedSearchRoute(record?.configuration);
  }
  try {
    await client.connect();
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'owned',
      rootUri: pathToFileURL(workspace).href,
    });
    await client.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Search',
    });
    const trust = await permissions.readTrust({ ...owner, workspaceId: 'w' });
    await permissions.setTrust({
      ...owner,
      workspaceId: 'w',
      commandId: 'trust',
      trusted: true,
      ifRevision: trust.revision,
      canonicalIdentity: trust.canonicalIdentity,
      externalReadScopeDigest: trust.externalReadScopeDigest,
    });
    await mode('full', 'initial-full');
    expect((await run('unqualified'))?.kind).toBe('provider');
    expect(wire.at(-1)).toMatchObject({ lane: '/model', native: false, ordinary: true });
    const settings = await client.getWebSearchSettings({ storeId: expectedStoreId });
    const input = {
      expectedStoreId,
      sessionId: 's',
      commandId: 'test-connection',
      expectedReadSet: settings.readSet!,
    };
    await client.testWebSearch(input);
    const qualified = await runtime.waitForCommand(input.commandId, { timeoutMs: 10000 });
    const execution = await client.getExecution(String(obj(qualified.receipt).executionId));
    expect(execution.definitionId).toBe('builtin.web-search-test/web_search.test');
    expect(execution.status).toBe('succeeded');
    expect(obj(execution.result).details).toMatchObject({
      route: 'native',
      observed: true,
      sources: [{ url: source }],
    });
    expect(wire.at(-1)).toMatchObject({
      lane: '/test',
      model: selectedModel,
      effort,
      native: true,
      forced: true,
    });
    await client.testWebSearch(input);
    expect(wire.filter((w) => w.lane === '/test')).toHaveLength(1);
    const native = await run('qualified');
    expect(native?.kind).toBe('native');
    expect(wire.at(-1)).toMatchObject({
      lane: '/model',
      model: selectedModel,
      effort,
      native: true,
      ordinary: false,
    });
    const view = await client.getView('s');
    const qualifiedRun = view.runs.find((item) => item.originCommandId === 'qualified')!;
    const modelExecution = view.executions.find(
      (item) => item.kind === 'model' && item.runId === qualifiedRun.id,
    )!;
    const evidence = await client.getWebSearchEvidence(modelExecution.id, {
      storeId: expectedStoreId,
      sessionId: 's',
    });
    expect(evidence.blocks.some((block) => block.sources.some((row) => row.url === source))).toBe(
      true,
    );
    expect(
      view.executions.some(
        (item) => item.runId === qualifiedRun.id && item.definitionId === 'web.search',
      ),
    ).toBe(false);
    await mode('auto', 'tighten');
    expect((await run('auto'))?.kind).toBe('provider');
    expect(wire.at(-1)).toMatchObject({ lane: '/model', native: false, ordinary: true });
    await mode('full', 'restore');
    write('unqualified-model');
    expect((await run('unknown-model'))?.kind).toBe('provider');
    expect(wire.at(-1)).toMatchObject({
      lane: '/model',
      model: 'unqualified-model',
      native: false,
      ordinary: true,
    });
    expect(inheritedSearchRoute((await runtime.getRun(qualifiedRun.id))?.configuration)).toEqual(
      native,
    );
    expect(wire).toHaveLength(5);
    expect(JSON.stringify([execution, native, settings, wire]).includes(secret)).toBe(false);
  } finally {
    try {
      await service.close();
    } finally {
      peer.stop(true);
      removeTemporaryDirectory(root);
    }
  }
}

test(
  'default Service qualifies an exact OpenAI connection using an owned Test command and submits native search only while authorized',
  () => verifyNativeBinding('gpt-5', 'high'),
  60000,
);

test(
  'official Luna with omitted effort keeps the original qualified account and sends no effort for its probe or business request',
  () => verifyNativeBinding('gpt-6-luna'),
  60000,
);
