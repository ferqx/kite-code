import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import type { AgentClient, InputImage, StartCommandRequest } from '@kite-ai/client';
import { NativeCallerJournal, nativeDraftProof } from '../../electron/caller-journal';
import { composeBrowserDraft } from '../../src/browser-annotation-content';
import { annotationFixture } from '../browser-annotation.fixture';
import { memoryPrivateData } from '../private-data.fixture';

async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw Error('annotation_input_timeout');
    await Bun.sleep(5);
  }
}
test('Main recomputes both send/steer proof, rejects altered content/image order and never accepts renderer raw-prompt proof', async () => {
  const { saved } = annotationFixture(),
    document = {
      id: 'a'.repeat(64),
      revision: 1,
      storeId: 'store',
      workspaceId: 'w',
      rootSessionId: 's',
      content: '原文\r\n',
      browserAnnotations: [saved],
      annotationImageOffset: 0,
    };
  const data = memoryPrivateData();
  data.readId = () => document;
  const image: InputImage = {
    name: 'snapshot.jpg',
    reference: {
      id: 'image',
      storeId: 'store',
      sessionId: 's',
      subjectId: 'owner',
      scope: { kind: 'session', id: 's' },
      hash: saved.imageHash,
      size: String(saved.frame.byteLength),
      mediaType: 'image/jpeg',
    },
  };
  const client = {
    serverInfo: { storeId: 'store', subjectId: 'owner' },
    async getView() {
      return {
        storeId: 'store',
        session: {
          id: 's',
          workspaceId: 'w',
          parentSessionId: null,
          deletedAt: null,
          contextSelectionId: 'context',
        },
      };
    },
    async getRun() {
      return { id: 'run', originStoreId: 'store', sessionId: 's' };
    },
  } as unknown as AgentClient;
  const journal = new NativeCallerJournal(client, data),
    content = composeBrowserDraft(document),
    proof = nativeDraftProof(document);
  try {
    for (const kind of ['run.start', 'input.steer'] as const) {
      const request = {
        kind,
        expectedStoreId: 'store',
        commandId: kind.replaceAll('.', '-'),
        content,
        images: [image],
        ...(kind === 'input.steer' ? { targetRunId: 'run', contextSelectionId: 'context' } : {}),
      } as StartCommandRequest;
      expect((await journal.prepare('s', request, proof)).intent.draft).toEqual(proof);
      await expect(
        journal.prepare(
          's',
          { ...request, commandId: `${kind.replaceAll('.', '-')}-text`, content: document.content },
          proof,
        ),
      ).rejects.toThrow('caller_draft_unavailable');
      await expect(
        journal.prepare(
          's',
          {
            ...request,
            commandId: `${kind.replaceAll('.', '-')}-bytes`,
            images: [{ ...image, reference: { ...image.reference, hash: 'f'.repeat(64) } }],
          },
          proof,
        ),
      ).rejects.toThrow('caller_draft_unavailable');
      await expect(
        journal.prepare(
          's',
          { ...request, commandId: `${kind.replaceAll('.', '-')}-missing`, images: [] },
          proof,
        ),
      ).rejects.toThrow('caller_draft_unavailable');
    }
    expect(data.callers()).toHaveLength(2);
  } finally {
    data.close();
  }
});
test('first real Runtime ModelInput and SDK Provider request contain exact prompt, complete note and original pixels; running steer does too, without read_file', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-note-input-'))),
    profile = { dataRoot: join(root, 'data'), profile: 'fixture' };
  const store = await openSqliteStore(profile),
    bodies: { messages: { role: string; content: unknown }[] }[] = [],
    requests: ModelRequest[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transport = Object.assign(
    async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        'data: {"id":"note","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"content":"Recorded reply"},"finish_reason":null}]}\n\ndata: {"id":"note","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
    { preconnect: fetch.preconnect },
  );
  const sdk = createSdkModelAdapter({
    models: new Map([
      [
        'fixture',
        createCompatibleModelBinding({
          modelId: 'fixture',
          baseURL: 'https://fixture.invalid/v1',
          apiKey: 'test-only',
          protocol: 'chat-completions',
          name: 'openai-compatible',
          fetch: transport,
        }),
      ],
    ]),
  });
  const model: ModelAdapter = {
    async *stream(request, context) {
      requests.push(structuredClone(request));
      const first = requests.length === 1;
      for await (const event of sdk.stream(request, context)) {
        if (first && event.type === 'finish') await barrier;
        yield event;
      }
    },
  };
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixture',
    artifacts: createArtifactStore({ profile, store }),
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'fixture',
      rootUri: 'file:///fixture',
    });
    await runtime.createSession({
      expectedStoreId,
      workspaceId: 'w',
      sessionId: 's',
      subjectId: 'owner',
      commandId: 'create',
      title: 'fixture',
    });
    const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' },
      { saved, input } = annotationFixture();
    const image = await runtime.uploadInputImage({
      ...scope,
      id: 'frozen',
      name: 'snapshot.jpg',
      mediaType: 'image/jpeg',
      data: input.frame.data,
    });
    const prompt = '用户自己的完整提示词\r\n',
      content = composeBrowserDraft({ content: prompt, browserAnnotations: [saved] });
    await runtime.submitCommand({
      ...scope,
      commandId: 'send',
      request: { kind: 'run.start', content, images: [image] },
    });
    await until(() => bodies.length === 1);
    const run = (await runtime.getView('s')).runs.find((item) => item.isActive)!;
    expect(run).toBeDefined();
    const contextSelectionId = (await runtime.getView('s')).session.contextSelectionId!;
    const steer = composeBrowserDraft({
      content: '运行中补充',
      browserAnnotations: [{ ...saved, id: 'steer-note', note: '运行中的注释全文' }],
    });
    await runtime.submitCommand({
      ...scope,
      commandId: 'steer',
      request: {
        kind: 'input.steer',
        targetRunId: run.id,
        contextSelectionId,
        content: steer,
        images: [image],
      },
    });
    release();
    await runtime.waitForCommand('send', { timeoutMs: 5000 });
    await runtime.waitForCommand('steer', { timeoutMs: 5000 });
    await until(() => bodies.length >= 2);
    for (const [index, expected] of [content, steer].entries()) {
      const message = [...requests[index]!.messages].reverse().find((item) => item.role === 'user');
      expect(message?.content).toContain(expected);
      expect(message?.images).toEqual([{ mediaType: 'image/jpeg', data: input.frame.data }]);
      const user = [...bodies[index]!.messages].reverse().find((item) => item.role === 'user');
      expect(user?.content).toEqual([
        { type: 'text', text: message!.content },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${input.frame.data}` } },
      ]);
    }
    expect(String(requests[0]!.messages.find((item) => item.role === 'user')?.content)).toContain(
      prompt,
    );
    expect(
      requests.every((request) => request.messages.every((message) => message.role !== 'tool')),
    ).toBe(true);
    expect(bodies).toHaveLength(2);
  } finally {
    release();
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
