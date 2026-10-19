import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import { openSqliteStore } from '../../../src/sqlite';

async function errorCode(work: Promise<unknown>, code: string) {
  let actual = '';
  try {
    await work;
  } catch (error) {
    actual = (error as { code?: string }).code ?? '';
  }
  expect(actual).toBe(code);
}
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1eIAAAAASUVORK5CYII=';
const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 20, outputTokens: 1 },
};
test('image-only input persists scoped references, resolves original bytes on later turns and rejects forged references', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-input-images-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'fixture' };
  let store = await openSqliteStore(profile);
  const model = createFixedModel([[finish], [finish], [finish]]);
  const permissions = {
    async authorize() {
      return { allowed: true, revision: '1' };
    },
  };
  let runtime = createRuntime({
    permissions,
    store,
    model,
    modelId: 'fixed',
    artifacts: createArtifactStore({ profile, store }),
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'fixture',
      rootUri: 'file:///fixture',
    });
    for (const sessionId of ['s', 'other'])
      await runtime.createSession({
        expectedStoreId,
        sessionId,
        workspaceId: 'w',
        commandId: `create-${sessionId}`,
        subjectId: 'owner',
        title: 'fixture',
      });
    const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
    const image = await runtime.uploadInputImage({
      ...scope,
      id: 'image',
      name: '粘贴.png',
      mediaType: 'image/png',
      data: png,
    });
    expect(image.reference.size).toBe(String(Buffer.from(png, 'base64').length));
    await errorCode(
      runtime.submitCommand({
        ...scope,
        commandId: 'too-many',
        request: { kind: 'run.start', content: '', images: Array(11).fill(image) },
      }),
      'input_image_invalid',
    );
    await errorCode(
      runtime.submitCommand({
        ...scope,
        commandId: 'oversized',
        request: {
          kind: 'run.start',
          content: '',
          images: [
            { ...image, reference: { ...image.reference, size: String(16 * 1024 * 1024 + 1) } },
          ],
        },
      }),
      'input_image_invalid',
    );
    expect(
      await runtime.uploadInputImage({
        ...scope,
        id: 'image',
        name: '粘贴.png',
        mediaType: 'image/png',
        data: png,
      }),
    ).toEqual(image);
    await errorCode(
      runtime.uploadInputImage({
        ...scope,
        subjectId: 'intruder',
        id: 'bad',
        name: 'bad',
        mediaType: 'image/png',
        data: png,
      }),
      'artifact_scope_denied',
    );
    await errorCode(
      runtime.uploadInputImage({
        ...scope,
        id: 'url',
        name: 'bad',
        mediaType: 'image/png',
        data: 'https://example.invalid/image.png',
      }),
      'input_image_invalid',
    );
    await errorCode(
      runtime.submitCommand({
        ...scope,
        sessionId: 'other',
        commandId: 'foreign',
        request: { kind: 'run.start', content: '', images: [image] },
      }),
      'input_image_scope_mismatch',
    );
    await errorCode(
      runtime.submitCommand({
        ...scope,
        commandId: 'forged',
        request: {
          kind: 'run.start',
          content: '',
          images: [{ ...image, reference: { ...image.reference, hash: 'f'.repeat(64) } }],
        },
      }),
      'input_image_scope_mismatch',
    );
    await runtime.submitCommand({
      ...scope,
      commandId: 'first',
      request: {
        kind: 'run.start',
        content: '',
        images: [image],
        files: [{ name: '外部.ini', uri: 'file:///E:/outside.ini' }],
      },
    });
    await runtime.waitForCommand('first', { timeoutMs: 5000 });
    expect(model.requests[0]?.messages.find((message) => message.role === 'user')?.images).toEqual([
      { mediaType: 'image/png', data: png },
    ]);
    const page = await store.listMessages(scope.sessionId);
    expect(page.find((message) => message.role === 'user')).toMatchObject({
      content: '',
      images: [image],
      files: [{ name: '外部.ini', uri: 'file:///E:/outside.ini' }],
    });
    expect(JSON.stringify(page)).not.toContain(png);
    await runtime.submitCommand({
      ...scope,
      commandId: 'second',
      request: { kind: 'run.start', content: '再看原图' },
    });
    await runtime.waitForCommand('second', { timeoutMs: 5000 });
    expect(model.requests[1]?.messages.find((message) => message.images?.length)?.images).toEqual([
      { mediaType: 'image/png', data: png },
    ]);
    const session = await store.getSession('s');
    await runtime.forkSession({
      expectedStoreId,
      sourceSessionId: 's',
      expectedContextSelectionId: session!.contextSelectionId,
      newSessionId: 'fork',
      commandId: 'fork',
      subjectId: 'owner',
      title: 'fork',
    });
    await runtime.submitCommand({
      ...scope,
      sessionId: 'fork',
      commandId: 'fork-run',
      request: { kind: 'run.start', content: '看来源图片' },
    });
    await runtime.waitForCommand('fork-run', { timeoutMs: 5000 });
    expect(model.requests[2]?.messages.find((message) => message.images?.length)?.images).toEqual([
      { mediaType: 'image/png', data: png },
    ]);
    await runtime.close();
    store = await openSqliteStore(profile);
    const cold = createFixedModel([[finish]]);
    runtime = createRuntime({
      permissions,
      store,
      model: cold,
      modelId: 'fixed',
      artifacts: createArtifactStore({ profile, store }),
    });
    await runtime.submitCommand({
      ...scope,
      commandId: 'cold-run',
      request: { kind: 'run.start', content: '重开后继续' },
    });
    await runtime.waitForCommand('cold-run', { timeoutMs: 5000 });
    expect(cold.requests[0]?.messages.find((message) => message.images?.length)?.images).toEqual([
      { mediaType: 'image/png', data: png },
    ]);
    for (const request of [...model.requests, ...cold.requests])
      expect(request.messages.find((message) => message.images?.length)?.content).toContain(
        'file:///E:/outside.ini',
      );
    expect((await store.listMessages('s')).find((message) => message.files?.length)?.content).toBe(
      '',
    );
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
