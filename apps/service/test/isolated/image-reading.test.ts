import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import { expect, test } from '#kite-test';
import {
  privateDirectory,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import { createDefaultProcessConfiguration } from '../../src/configuration';
import { initializeLivePermissionFixture } from '../fixtures/live-permission-fixture';

function png(reverse = false) {
  const chunk = (name: string, bytes: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(name), bytes]);
    let crc = 0xffffffff;
    for (const value of body) {
      crc ^= value;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    const length = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk(
      'IDAT',
      deflateSync(
        Buffer.from(
          reverse ? [0, 0, 0, 255, 255, 255, 0, 0, 255] : [0, 255, 0, 0, 255, 0, 0, 255, 255],
        ),
      ),
    ),
    chunk('IEND', new Uint8Array()),
  ]);
}
const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
type Call = { id: string; path?: string; paths?: string[] };
async function wireRequest(request: ModelRequest, protocol: 'responses' | 'chat-completions') {
  let wire: Record<string, unknown> = {};
  const fetcher = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    wire = JSON.parse(String(init?.body));
    return new Response(
      protocol === 'responses'
        ? 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'
        : 'data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }, {});
  const binding = createCompatibleModelBinding({
    modelId: 'fixed',
    baseURL: 'https://fixture.invalid/v1',
    apiKey: 'fixture',
    name: 'fixture',
    protocol,
    fetch: fetcher,
  });
  const adapter = createSdkModelAdapter({ models: new Map([['fixed', binding]]) });
  for await (const _event of adapter.stream(request, { signal: new AbortController().signal })) {
  }
  return wire;
}
async function fixture() {
  const root = temporaryDirectory('kite-service-image-'),
    workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'test' });
  privateDirectory(profile.profilePath);
  const user = join(profile.profilePath, 'config.jsonc');
  writeFileSync(
    user,
    JSON.stringify({
      modelId: 'fixed',
      models: [
        { id: 'fixed', provider: 'compatible', model: 'unused', baseURL: 'http://127.0.0.1:9/v1' },
      ],
    }),
  );
  const requests: ModelRequest[] = [];
  let calls: Call[] = [],
    denied = false;
  const model: ModelAdapter = {
    async *stream(request) {
      requests.push(structuredClone(request));
      if (calls.length) {
        const next = calls;
        calls = [];
        for (const call of next)
          yield {
            type: 'tool_call',
            id: call.id,
            name: 'view_images',
            arguments: JSON.stringify({ path: call.path, paths: call.paths }),
          };
        yield { ...finish, reason: 'tool_calls' };
      } else {
        yield { type: 'text_delta', text: 'visual input received' };
        yield finish;
      }
    },
  };
  const createHost = () =>
    createDefaultProcessConfiguration({
      profile,
      userConfigurationPath: user,
      localCodex: false,
      ordinaryHostTools: true,
      credentialBackend: createTemporaryCredentialBackend(),
      permissions: {
        async authorize(request) {
          return {
            allowed: !(
              denied &&
              request.kind === 'tool' &&
              request.definitionId === 'files.view_images'
            ),
            revision: 'fixture',
          };
        },
      },
    });
  let host = createHost();
  let store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
  function open() {
    return createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      extensions: host.extensions,
      permissions: host.permissions!,
      resolveRunConfiguration: async (input) => ({
        ...(await host.resolveRunConfiguration!(input)),
        model,
      }),
    });
  }
  let runtime = open();
  host.permissionManagement?.(runtime);
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'images',
    rootUri: pathToFileURL(workspace).href,
  });
  for (const sessionId of ['s', 'other'])
    await runtime.createSession({
      ...scope,
      sessionId,
      commandId: `create-${sessionId}`,
      workspaceId: 'w',
      title: 'image',
    });
  await initializeLivePermissionFixture({
    runtime,
    profile,
    ...scope,
    workspaceId: 'w',
    mode: 'full',
    trusted: true,
  });
  let counter = 0;
  return {
    root,
    workspace,
    profile,
    scope,
    requests,
    get runtime() {
      return runtime;
    },
    get store() {
      return store;
    },
    deny() {
      denied = true;
    },
    async restart() {
      await runtime.close();
      host = createHost();
      store = await openSqliteStore(profile);
      runtime = open();
      host.permissionManagement?.(runtime);
    },
    async run(next: Call[] = [], sessionId = 's', files?: { name: string; uri: string }[]) {
      calls = next;
      const commandId = `run-${++counter}`,
        start = requests.length;
      await runtime.submitCommand({
        ...scope,
        sessionId,
        commandId,
        request: { kind: 'run.start', content: `Inspect ${counter}`, ...(files ? { files } : {}) },
      });
      const deadline = Date.now() + 15000;
      for (;;) {
        const view = await runtime.getView(sessionId),
          run = view.runs.find((r) => r.originCommandId === commandId);
        if (run && !run.isActive) return { run, requests: requests.slice(start) };
        if (Date.now() > deadline)
          throw Error(
            `image_fixture_deadline:${JSON.stringify(await runtime.getCommand(commandId))}`,
          );
        await sleepTimer(5);
      }
    },
    async close() {
      await runtime.close();
      removeTemporaryDirectory(root);
    },
  };
}

test('default view_images publishes execution PNGs and preserves paired visual history across cold reopen and Fork', async () => {
  const f = await fixture();
  const first = join(f.workspace, 'red-blue.bin'),
    second = join(f.root, 'external.png');
  writeFileSync(first, png());
  writeFileSync(second, png(true));
  try {
    const result = await f.run([
      { id: 'local', path: first },
      { id: 'external', path: second },
    ]);
    expect(result.run.status).toBe('completed');
    expect(result.requests).toHaveLength(2);
    expect(
      result.requests[0]!.tools?.find((tool) => tool.id === 'view_images')?.inputSchema,
    ).toMatchObject({
      additionalProperties: false,
      oneOf: [{ required: ['path'] }, { required: ['paths'] }],
      properties: { paths: { maxItems: 10 } },
    });
    const visuals = result.requests[1]!.messages.filter((message) => message.images?.length);
    expect(visuals).toHaveLength(2);
    expect(visuals[0]!.images![0]!.data).not.toBe(visuals[1]!.images![0]!.data);
    expect(visuals.map((m) => m.toolCallId).sort()).toEqual(['external', 'local']);
    expect(visuals.every((m) => m.role === 'tool' && m.sourceIds?.length === 1)).toBe(true);
    const executions = (await f.store.listExecutions('s')).filter(
      (x) => x.definitionId === 'files.view_images',
    );
    expect(executions).toHaveLength(2);
    for (const visual of visuals) {
      const execution = executions.find((item) => item.callId === visual.toolCallId)!;
      expect(visual.sourceIds).toEqual([execution.id]);
      expect(JSON.parse(visual.content).path).toBe(visual.toolCallId === 'local' ? first : second);
    }
    for (const execution of executions)
      expect(execution.result).toMatchObject({
        outcome: 'succeeded',
        modelImages: [{ scope: { kind: 'execution', id: execution.id }, mediaType: 'image/png' }],
      });
    const persisted = await f.store.listMessages('s');
    expect(persisted.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain(visuals[0]!.images![0]!.data);
    unlinkSync(first);
    unlinkSync(second);
    await f.restart();
    expect((await f.run()).requests[0]!.messages.filter((m) => m.images?.length)).toEqual(visuals);
    const source = await f.runtime.getSession('s');
    await f.runtime.forkSession({
      expectedStoreId: f.scope.expectedStoreId,
      sourceSessionId: 's',
      expectedContextSelectionId: source!.contextSelectionId,
      newSessionId: 'fork',
      commandId: 'fork',
      subjectId: 'owner',
      title: 'fork',
    });
    const forked = await f.run([], 'fork');
    expect(forked.requests[0]!.messages.filter((m) => m.images?.length)).toEqual(visuals);
    for (const protocol of ['responses', 'chat-completions'] as const) {
      const wire = await wireRequest(result.requests[1]!, protocol);
      const serialized = JSON.stringify(wire);
      expect(serialized.split('data:image/png;base64,').length - 1).toBe(2);
      for (const visual of visuals) expect(serialized).toContain(visual.images![0]!.data);
      if (protocol === 'responses') {
        const outputs = (wire.input as Record<string, unknown>[]).filter(
          (item) => item.type === 'function_call_output',
        );
        expect(outputs.map((item) => item.call_id).sort()).toEqual(['external', 'local']);
      } else {
        const messages = wire.messages as Record<string, unknown>[];
        expect(
          messages
            .filter((m) => m.role === 'tool')
            .map((m) => m.tool_call_id)
            .sort(),
        ).toEqual(['external', 'local']);
        expect(
          messages.filter(
            (m) =>
              m.role === 'user' &&
              Array.isArray(m.content) &&
              m.content.some((part: { type: string }) => part.type === 'image_url'),
          ),
        ).toHaveLength(2);
      }
    }
  } finally {
    await f.close();
  }
}, 30000);

test('default one-call ten-image batch reaches both protocols in order and survives cold reopen and Fork', async () => {
  const f = await fixture();
  const paths = Array.from({ length: 10 }, (_, i) => join(f.workspace, `image-${i}.png`));
  paths.forEach((path, i) => {
    writeFileSync(path, png(i % 2 === 1));
  });
  try {
    const rejected = await f.run([
      { id: 'too-many', paths: [...paths, join(f.workspace, 'eleven.png')] },
    ]);
    expect(
      rejected.requests.every((request) =>
        request.messages.every((message) => !message.images?.length),
      ),
    ).toBe(true);
    const rejectedExecution = (await f.store.listExecutions('s')).find(
      (item) => item.callId === 'too-many',
    )!;
    expect(rejectedExecution.status).not.toBe('succeeded');
    expect((rejectedExecution.result as { modelImages?: unknown })?.modelImages).toBeUndefined();
    const result = await f.run([{ id: 'batch', paths }]);
    expect(result.run.status).toBe('completed');
    const visuals = result.requests[1]!.messages.filter((message) => message.images?.length);
    expect(visuals).toHaveLength(1);
    expect(visuals[0]!.toolCallId).toBe('batch');
    expect(visuals[0]!.images).toHaveLength(10);
    expect(
      JSON.parse(visuals[0]!.content).images.map((image: { path: string }) => image.path),
    ).toEqual(paths);
    const execution = (await f.store.listExecutions('s')).find((item) => item.callId === 'batch')!;
    expect(execution.status).toBe('succeeded');
    expect(visuals[0]!.sourceIds).toEqual([execution.id]);
    expect((execution.result as { modelImages: unknown[] }).modelImages).toHaveLength(10);
    for (const protocol of ['responses', 'chat-completions'] as const) {
      const serialized = JSON.stringify(await wireRequest(result.requests[1]!, protocol));
      expect([...(serialized.match(/data:image\/png;base64,[^"]+/g) ?? [])]).toEqual(
        visuals[0]!.images!.map((image) => `data:image/png;base64,${image.data}`),
      );
    }
    paths.forEach((path) => {
      unlinkSync(path);
    });
    await f.restart();
    expect(
      (await f.run()).requests[0]!.messages.filter((message) => message.images?.length),
    ).toEqual(visuals);
    const source = await f.runtime.getSession('s');
    await f.runtime.forkSession({
      expectedStoreId: f.scope.expectedStoreId,
      subjectId: f.scope.subjectId,
      sourceSessionId: 's',
      expectedContextSelectionId: source!.contextSelectionId,
      newSessionId: 'fork-batch',
      commandId: 'fork-batch',
      title: 'batch',
    });
    expect(
      (await f.run([], 'fork-batch')).requests[0]!.messages.filter(
        (message) => message.images?.length,
      ),
    ).toEqual(visuals);
  } finally {
    await f.close();
  }
}, 30000);

test('default assembly binds saved originals and refuses private paths, wrong-session imports and permission denial', async () => {
  const f = await fixture();
  try {
    const saved = await f.runtime.uploadInputFile({
      ...f.scope,
      id: 'original',
      name: 'saved.png',
      mediaType: 'image/png',
      content: [png()],
    });
    const path = fileURLToPath(saved.uri);
    const good = await f.run([{ id: 'original', path }], 's', [saved]);
    expect(
      good.requests
        .at(-1)!
        .messages.some((m) => m.toolCallId === 'original' && m.images?.length === 1),
    ).toBe(true);
    const actual = await f.run([{ id: 'bound', path }]);
    expect(actual.run.status).toBe('completed');
    expect(
      actual.requests
        .at(-1)!
        .messages.some((m) => m.toolCallId === 'bound' && m.images?.length === 1),
    ).toBe(true);
    await f.run([{ id: 'foreign', path }], 'other');
    await f.run([{ id: 'private', path: join(f.profile.profilePath, 'config.jsonc') }]);
    f.deny();
    await f.run([{ id: 'denied', path: 'missing.png' }]);
    const failed = (await f.store.listExecutions('s')).filter(
      (x) => x.definitionId === 'files.view_images' && x.status !== 'succeeded',
    );
    expect(failed.length).toBeGreaterThanOrEqual(2);
    expect(failed.every((x) => !(x.result as { modelImages?: unknown }).modelImages)).toBe(true);
    expect(
      (await f.store.listExecutions('other')).find((x) => x.definitionId === 'files.view_images')
        ?.status,
    ).toBe('failed');
    expect(good.requests.length).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
}, 30000);
