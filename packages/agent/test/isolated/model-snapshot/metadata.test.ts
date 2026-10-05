import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelAdapter, type ModelEvent } from '@kite-ai/ai';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import { createArtifactStore } from '../../../src/artifacts';
import { artifactPath } from '../../../src/artifacts-files';
import { bodyReference } from '../../../src/model-body';
import { modelInputMetadata } from '../../../src/model-snapshot';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Json } from '../../../src/storage/types';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
async function fixture(
  model: ModelAdapter,
  options: {
    metadataSources?: number;
    child?: ModelAdapter;
    content?: string;
    policy?: () => { revision: string; mode: string };
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-model-metadata-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(profile),
    artifacts = createArtifactStore({ profile, store });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  let childSessionId: string | undefined;
  const runtime = createRuntime({
    store,
    artifacts,
    model,
    modelId: 'selected',
    modelConcurrency: 1,
    ...(options.child
      ? {
          childConfigurations: [
            {
              id: 'child',
              version: '1',
              model: options.child,
              modelId: 'child',
              toolIds: [],
              snapshot: { fixture: true },
              permissions: {
                async authorize() {
                  return {
                    allowed: true,
                    revision: 'child-policy',
                    snapshot: {
                      namespace: 'fixture.child',
                      version: '1',
                      data: { mode: 'child-original' },
                    },
                  };
                },
              },
            },
          ],
        }
      : {}),
    permissions: {
      async authorize(request) {
        request.signal.throwIfAborted();
        const current = options.policy?.();
        return {
          allowed: true,
          revision: current?.revision ?? 'external-policy',
          ...(current
            ? {
                snapshot: {
                  namespace: 'fixture.policy',
                  version: '1',
                  data: { mode: current.mode, workspaceTrust: true },
                },
              }
            : {}),
        };
      },
    },
    sources: {
      async capture() {
        return Array.from({ length: options.metadataSources ?? 1 }, (_, i) => ({
          id: options.metadataSources ? `fixture:${i}:${'x'.repeat(4000)}` : 'fixture:original',
          digest: `digest-${i}`,
          kind: 'fixture',
          scope: 'run',
          role: 'user' as const,
          content: i === 0 ? (options.content ?? 'source') : '',
        }));
      },
    },
    extensions: [
      {
        id: 'fixture.extension',
        version: '2',
        apiMajor: 1,
        tools: [
          {
            id: 'metadata.work',
            version: '7',
            description: 'No I/O local result',
            inputSchema: { type: 'object', additionalProperties: false },
            async execute(_input, context) {
              if (options.child) {
                const ref = await context.operations.ensure({
                  key: 'child',
                  request: {
                    kind: 'agent',
                    configurationId: 'child',
                    input: { content: 'verify' },
                  },
                });
                childSessionId = ref.childSessionId;
                await context.operations.wait(ref, { signal: context.signal });
              }
              return { outcome: 'succeeded' as const, content: 'known local result' };
            },
          },
        ],
      },
    ],
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'private',
    rootUri: `file://${root}`,
  });
  await runtime.createSession({
    ...scope,
    commandId: 'create',
    workspaceId: 'w',
    title: 'metadata',
  });
  return {
    root,
    get childSessionId() {
      return childSessionId;
    },
    profile,
    store,
    artifacts,
    runtime,
    scope,
    async start() {
      await runtime.submitCommand({
        ...scope,
        commandId: 'work',
        request: { kind: 'run.start', content: 'original task' },
      });
      await runtime.waitForCommand('work', { timeoutMs: 10000 });
    },
    async snapshots() {
      const page = await runtime.listModelInputs(scope);
      return Promise.all(
        page.items.map((item) =>
          store.getModelInputSnapshot({ ...scope, executionId: item.executionId }),
        ),
      );
    },
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function stream(call: boolean) {
  const chunk = {
    id: 'local',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'remote',
    choices: [
      {
        index: 0,
        delta: call
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: 'call',
                  type: 'function',
                  function: { name: 'metadata.work', arguments: '{}' },
                },
              ],
            }
          : { content: 'done' },
        finish_reason: null,
      },
    ],
  };
  return new Response(
    `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

test('each actual SDK execution seals original settings, exact assembly/source and final policy without private transport data', async () => {
  let mode = 'ask',
    revision = 'policy-1';
  const requests: Record<string, unknown>[] = [];
  const transport = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const first = requests.length === 1;
      if (first) {
        mode = 'full';
        revision = 'policy-2';
      }
      return stream(first);
    },
    { preconnect: fetch.preconnect },
  );
  const preset = { temperature: 0.3, topP: 0.8, maxOutputTokens: 222 };
  const adapter = createSdkModelAdapter({
    models: new Map([
      [
        'selected',
        createCompatibleModelBinding({
          baseURL: 'https://private.invalid/endpoint-secret',
          modelId: 'remote',
          apiKey: 'key-secret',
          headers: { 'x-private': 'header-secret' },
          fetch: transport,
        }),
      ],
    ]),
    presets: new Map([['selected', preset]]),
  });
  preset.temperature = 0.9;
  const full = `start\n${'x'.repeat(17 * 1024 * 1024)}\nexact-tail`;
  const f = await fixture(adapter, { content: full, policy: () => ({ mode, revision }) });
  try {
    await f.start();
    const saved = await f.snapshots();
    expect(saved).toHaveLength(2);
    expect(requests).toHaveLength(2);
    const metadata = saved.map((item) =>
      modelInputMetadata(item.metadata, item.dispatchAuthorization),
    );
    expect(metadata.map((item) => item.authorization)).toMatchObject([
      {
        availability: 'available',
        revision: 'policy-1',
        policy: { namespace: 'fixture.policy', version: '1', data: { mode: 'ask' } },
      },
      { availability: 'available', revision: 'policy-2', policy: { data: { mode: 'full' } } },
    ]);
    for (const item of metadata) {
      expect(item.adapter).toMatchObject({
        availability: 'available',
        provider: { availability: 'available', family: 'openai-compatible', modelId: 'remote' },
        settings: { temperature: 0.3, topP: 0.8, maxOutputTokens: 222 },
      });
      expect(item.assembly?.tools).toEqual([
        { id: 'metadata.work', definitionVersion: '7', extensionId: 'fixture.extension' },
      ]);
      expect(item.context?.sources).toEqual([{ id: 'fixture:original', digest: 'digest-0' }]);
      for (const secret of [
        'private.invalid',
        'endpoint-secret',
        'key-secret',
        'header-secret',
        'x-private',
      ])
        expect(JSON.stringify(item)).not.toContain(secret);
    }
    expect(requests[0]).toMatchObject({ temperature: 0.3, top_p: 0.8, max_tokens: 222 });
    expect(
      (requests[0]!.messages as { content: unknown }[]).some((message) => message.content === full),
    ).toBe(true);
    const input = await f.runtime.readModelInput({
      ...f.scope,
      executionId: saved[0]!.identity.executionId,
    });
    expect(input.request.messages.some((message) => message.content === full)).toBe(true);
    expect(BigInt(input.bodyBytes)).toBeGreaterThan(17n * 1024n * 1024n);
    // Stored copies do not follow a new policy and cannot be mutated by caller projections.
    (metadata[0]!.authorization as { revision: string }).revision = 'changed';
    expect(
      modelInputMetadata(
        (await f.snapshots())[0]!.metadata,
        (await f.snapshots())[0]!.dispatchAuthorization,
      ).authorization,
    ).toMatchObject({ revision: 'policy-1' });
  } finally {
    await f.close();
  }
});

test('opaque adapter metadata does not erase the actual final authorization, and cold readonly input needs no adapter', async () => {
  const model = createFixedModel([[finish]]);
  const f = await fixture(model);
  let readonly: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  try {
    await f.start();
    const [saved] = await f.snapshots();
    expect(modelInputMetadata(saved!.metadata, saved!.dispatchAuthorization)).toMatchObject({
      adapter: { availability: 'unavailable', reason: 'adapter_opaque' },
      authorization: { availability: 'available', revision: 'external-policy', policy: null },
    });
    await f.runtime.close();
    readonly = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    const cold = await readonly.getModelInputSnapshot({
      ...f.scope,
      executionId: saved!.identity.executionId,
    });
    expect(cold.metadata).toEqual(saved!.metadata);
    expect(cold.dispatchAuthorization).toEqual(saved!.dispatchAuthorization);
    expect(model.requests).toHaveLength(1);
  } finally {
    await readonly?.close();
    await f.close();
  }
});

test('missing or future static snapshots remain unavailable while retained dispatch facts stay accurate', () => {
  const authorization: Json = {
    allowed: true,
    revision: 'actual',
    definitionVersion: '1',
    inputDigest: 'a'.repeat(64),
  };
  expect(modelInputMetadata(null, authorization)).toMatchObject({
    adapter: { availability: 'unavailable', reason: 'not_recorded' },
    assembly: null,
    context: null,
    authorization: { availability: 'available', revision: 'actual', policy: null },
  });
  expect(modelInputMetadata({ version: 2, private: 'never expose' }, authorization)).toMatchObject({
    adapter: { availability: 'unavailable', reason: 'unsupported_version' },
    authorization: { revision: 'actual' },
  });
  expect(
    JSON.stringify(modelInputMetadata({ version: 2, private: 'never expose' }, authorization)),
  ).not.toContain('never expose');
  expect(modelInputMetadata(null, null).authorization).toEqual({
    availability: 'unavailable',
    reason: 'not_dispatched',
  });
});

test('metadata larger than 64KiB keeps complete source identities in original Artifact and cold readonly projection', async () => {
  const model = createFixedModel([[finish]]);
  const f = await fixture(model, { metadataSources: 32 });
  let cold: ReturnType<typeof createRuntime> | undefined;
  try {
    await f.start();
    const [stored] = await f.snapshots();
    expect(JSON.stringify(stored!.metadata).length).toBeLessThan(4096);
    expect(stored!.metadata).toMatchObject({
      version: 1,
      body: { kind: 'model_body', version: 1 },
    });
    const original = await f.runtime.readModelInput({
      ...f.scope,
      executionId: stored!.identity.executionId,
    });
    expect(original.metadata.context?.sources).toHaveLength(32);
    expect(original.metadata.context?.sources.map((source) => source.id)).toContain(
      `fixture:31:${'x'.repeat(4000)}`,
    );
    await f.runtime.close();
    const store = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    cold = createRuntime({
      store,
      artifacts: createArtifactStore({ profile: f.profile, store }),
      model: createFixedModel([]),
      permissions: {
        async authorize() {
          throw new Error('readonly must not authorize');
        },
      },
    });
    const reopened = await cold.readModelInput({
      ...f.scope,
      executionId: stored!.identity.executionId,
    });
    expect(reopened.metadata).toEqual(original.metadata);
    expect(reopened.request).toEqual(original.request);
    expect(model.requests).toHaveLength(1);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      cold.readModelInput({
        ...f.scope,
        executionId: stored!.identity.executionId,
        signal: cancelled.signal,
      }),
    ).rejects.toThrow();
    const header = stored!.metadata as { body: Json };
    const reference = bodyReference(header.body)!.reference;
    const path = artifactPath(join(f.profile.dataRoot, f.profile.profile), reference.hash);
    const complete = readFileSync(path);
    chmodSync(path, 0o600);
    try {
      writeFileSync(path, 'corrupt metadata');
      let rejected: unknown;
      try {
        await cold.readModelInput({ ...f.scope, executionId: stored!.identity.executionId });
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toBeDefined();
      expect(model.requests).toHaveLength(1);
    } finally {
      writeFileSync(path, complete);
    }
  } finally {
    await cold?.close();
    await f.close();
  }
});

test('real child final metadata preserves parent and child policy intersection without granting child tools', async () => {
  const child = createFixedModel([[finish]]);
  const parent = createFixedModel([
    [
      { type: 'tool_call', id: 'delegate', name: 'metadata.work', arguments: '{}' },
      { ...finish, reason: 'tool_calls' },
    ],
    [finish],
  ]);
  const f = await fixture(parent, {
    child,
    policy: () => ({ revision: 'parent-policy', mode: 'parent-original' }),
  });
  try {
    await f.start();
    expect(f.childSessionId).toBeDefined();
    const page = await f.runtime.listModelInputs({ ...f.scope, sessionId: f.childSessionId! });
    expect(page.items).toHaveLength(1);
    const snapshot = await f.runtime.readModelInput({
      ...f.scope,
      sessionId: f.childSessionId!,
      executionId: page.items[0]!.executionId,
    });
    expect(snapshot.request.tools).toHaveLength(0);
    expect(snapshot.metadata.authorization).toMatchObject({
      availability: 'available',
      policy: {
        namespace: 'agent.permission-intersection',
        version: '1',
        data: {
          policies: [
            {
              scope: 'parent',
              revision: 'parent-policy',
              allowed: true,
              snapshot: {
                namespace: 'fixture.policy',
                version: '1',
                data: { mode: 'parent-original', workspaceTrust: true },
              },
            },
            {
              scope: 'child',
              revision: 'child-policy',
              allowed: true,
              snapshot: {
                namespace: 'fixture.child',
                version: '1',
                data: { mode: 'child-original' },
              },
            },
          ],
        },
      },
    });
    expect(child.requests).toHaveLength(1);
  } finally {
    await f.close();
  }
});
