import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { AgentClient } from '@kite-ai/client';
import { startService } from '../../src';

test('authenticated Client uploads image bytes and submits only immutable metadata through HTTP', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-http-input-image-'))),
    profile = { dataRoot: join(root, 'data'), profile: 'fixture' };
  const store = await openSqliteStore(profile),
    paths = resolveProfile(profile);
  const model = createFixedModel([
    [{ type: 'finish', reason: 'stop', usage: { inputTokens: 10, outputTokens: 1 } }],
    [{ type: 'finish', reason: 'stop', usage: { inputTokens: 10, outputTokens: 1 } }],
  ]);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    artifacts: createArtifactStore({ profile, store }),
  });
  const service = await startService({
    runtime,
    profile: {
      dataRoot: realpathSync(profile.dataRoot),
      name: profile.profile,
      accessKey: paths.profileAccessKey,
    },
    buildId: 'fixture',
    subjectId: 'owner',
  });
  try {
    const client = new AgentClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      expected: {
        profile: {
          dataRoot: realpathSync(profile.dataRoot),
          name: profile.profile,
          accessKey: paths.profileAccessKey,
        },
        apiMajor: 1,
        requiredCapabilities: ['commands'],
      },
    });
    await client.connect();
    const expectedStoreId = (await store.getMetadata()).storeId;
    await client.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'fixture',
      rootUri: 'file:///fixture',
    });
    await client.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'fixture',
    });
    const data =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1eIAAAAASUVORK5CYII=';
    const image = await client.uploadInputImage('s', {
      expectedStoreId,
      id: 'image',
      name: 'original.png',
      mediaType: 'image/png',
      data,
    });
    expect(image.reference.mediaType).toBe('image/png');
    const overCount = await fetch(`${service.endpoint}/v1/sessions/s/commands`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${service.bootstrap.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        expectedStoreId,
        commandId: 'too-many',
        kind: 'run.start',
        content: '',
        images: Array(11).fill(image),
      }),
    });
    expect(overCount.status).toBe(400);
    expect(model.requests).toHaveLength(0);
    const images = Array(10).fill(image);
    await client.startRun('s', {
      expectedStoreId,
      commandId: 'run',
      kind: 'run.start',
      content: '',
      images,
    });
    await runtime.waitForCommand('run', { timeoutMs: 5000 });
    expect(
      model.requests[0]?.messages.find((message) => message.role === 'user')?.images?.[0]?.data,
    ).toBe(data);
    expect(
      model.requests[0]?.messages.find((message) => message.role === 'user')?.images,
    ).toHaveLength(10);
    const history = await client.listMessages('s');
    expect(history.find((message) => message.role === 'user')?.images).toEqual(images);
    expect(JSON.stringify(history)).not.toContain(data);
    const files = [{ name: '外部 附件.ini', uri: 'file:///E:/outside%20attachment.ini' }];
    await client.startRun('s', {
      expectedStoreId,
      commandId: 'files-only',
      kind: 'run.start',
      content: '',
      files,
    });
    await runtime.waitForCommand('files-only', { timeoutMs: 5000 });
    const fileInput = model.requests[1]?.messages
      .filter((message) => message.role === 'user')
      .at(-1);
    expect(fileInput?.content).toContain(files[0]!.uri);
    expect(fileInput?.content).toContain('user-provided data');
    expect(fileInput?.images).toBeUndefined();
    const fileMessage = (await client.listMessages('s'))
      .filter((message) => message.role === 'user')
      .at(-1);
    expect(fileMessage?.content).toBe('');
    expect(fileMessage?.files).toEqual(files);
    expect(() =>
      client.startRun('s', {
        expectedStoreId,
        commandId: 'not-a-file',
        kind: 'run.start',
        content: 'test',
        files: [{ name: 'remote', uri: 'https://example.invalid/file' }],
      }),
    ).toThrow();
    const invalid = await fetch(`${service.endpoint}/v1/sessions/s/input-images`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${service.bootstrap.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        expectedStoreId,
        id: 'bad',
        name: 'bad',
        mediaType: 'image/png',
        data: 'https://invalid/image',
      }),
    });
    expect(invalid.status).toBe(400);
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
