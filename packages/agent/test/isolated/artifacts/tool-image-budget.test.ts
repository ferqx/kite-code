import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type ModelAdapter,
  ModelAttemptError,
  type ModelEvent,
  type ModelRequest,
  ModelRequestLimitError,
} from '@kite-ai/ai';
import { createCanvas } from '@napi-rs/canvas';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import { createViewImagesTool } from '../../../src/files';
import { openSqliteStore } from '../../../src/sqlite';
import { processImage } from '../../../src/tools/images/processor';

for (const scenario of ['window', 'provider-413', 'unknown'] as const)
  test('local-image history over 32 MiB: ' + scenario, async () => {
    const root = temporaryDirectory('kite-tool-image-budget-'),
      profile = { dataRoot: join(root, 'data'), profile: 'test' };
    const canvas = createCanvas(2048, 2048),
      ctx = canvas.getContext('2d'),
      pixels = ctx.createImageData(2048, 2048);
    let state = 12345;
    for (let at = 0; at < pixels.data.length; at++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      pixels.data[at] = at % 4 === 3 ? 255 : state & 255;
    }
    ctx.putImageData(pixels, 0, 0);
    const sample = await canvas.encode('webp', 90);
    const prepared = await processImage(
      async () => ({ bytes: sample }),
      new AbortController().signal,
    );
    const count = Math.floor((32 * 1024 * 1024) / prepared.png.length) + 1;
    expect(count).toBeLessThanOrEqual(10);
    const finish: ModelEvent = {
      type: 'finish',
      reason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const requests: ModelRequest[] = [];
    let first = true,
      injected = false;
    const failedRequests = new Set<string>();
    const model: ModelAdapter = {
      async *stream(request) {
        requests.push(request);
        if (first) {
          first = false;
          for (let index = 0; index < count; index++)
            yield {
              type: 'tool_call',
              id: 'image-' + index,
              name: 'view_images',
              arguments: '{"path":"synthetic"}',
            } as const;
          yield { ...finish, reason: 'tool_calls' } as const;
        } else {
          if (
            !injected &&
            scenario !== 'window' &&
            request.messages.flatMap((m) => m.images ?? []).length >=
              (scenario === 'provider-413' ? 2 : 1)
          ) {
            injected = true;
            failedRequests.add(request.requestId);
            if (scenario === 'provider-413') throw new ModelRequestLimitError();
            throw new ModelAttemptError('connection_failed', 'connection_interrupted');
          }
          yield {
            type: 'text_delta',
            text: request.tools.length
              ? 'Business complete.'
              : 'Observed the supplied original source images.',
          } as const;
          // Genuine Responses finish events may carry opaque continuation even
          // on a short no-tool observer. This activates the private output journal.
          yield request.tools.length
            ? finish
            : { ...finish, continuation: { provider: 'fixture', body: 'opaque-observation-only' } };
        }
      },
    };
    const store = await openSqliteStore(profile),
      artifacts = createArtifactStore({ profile, store });
    let imageReads = 0;
    const wrapped = {
      ...artifacts,
      async readReference(input: Parameters<typeof artifacts.readReference>[0]) {
        if (input.reference.mediaType === 'image/png') imageReads++;
        return artifacts.readReference(input);
      },
    };
    let opens = 0;
    const tool = createViewImagesTool(async (path) => {
      opens++;
      return { path, bytes: sample };
    });
    const runtime = createRuntime({
      store,
      artifacts: wrapped,
      model,
      modelId: 'fixed',
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'test' };
        },
      },
      extensions: [{ id: 'builtin.files', version: '1', apiMajor: 1, tools: [tool] }],
    });
    try {
      const scope = {
        expectedStoreId: (await store.getMetadata()).storeId,
        sessionId: 's',
        subjectId: 'owner',
      };
      await runtime.createWorkspace({
        expectedStoreId: scope.expectedStoreId,
        id: 'w',
        name: 'fixture',
        rootUri: 'file:///fixture',
      });
      await runtime.createSession({
        ...scope,
        commandId: 'create',
        workspaceId: 'w',
        title: 'budget',
      });
      await runtime.submitCommand({
        ...scope,
        commandId: 'run',
        request: { kind: 'run.start', content: 'Read synthetic images' },
      });
      const command = await runtime.waitForCommand('run', { timeoutMs: 30000 });
      expect(await store.getRun((command.receipt as { runId: string }).runId)).toMatchObject({
        status: scenario === 'unknown' ? 'failed' : 'completed',
        ...(scenario === 'unknown' ? {} : { reason: null }),
      });
      expect(opens).toBe(count);
      if (scenario === 'unknown') {
        expect(requests).toHaveLength(2);
        expect(injected).toBe(true);
        const failed = await store.getExecution(requests[1]!.requestId);
        expect(failed?.status).toBe('failed');
        expect(
          (await store.listExecutions('s')).filter(
            (x) => x.kind === 'model' && x.status === 'succeeded',
          ),
        ).toHaveLength(1);
        return;
      }
      expect(requests.length).toBeGreaterThan(2);
      const deliveries = requests
        .filter((r) => !failedRequests.has(r.requestId))
        .flatMap((r) => r.messages.flatMap((m) => m.images ?? []));
      expect(deliveries).toHaveLength(count);
      for (const r of requests) {
        const imgs = r.messages.flatMap((m) => m.images ?? []);
        expect(
          imgs.reduce((n, i) => n + Buffer.byteLength(i.data, 'base64'), 0),
        ).toBeLessThanOrEqual(32 * 1024 * 1024);
        for (const image of imgs)
          expect(Buffer.from(image.data, 'base64').equals(prepared.png)).toBe(true);
      }
      expect(imageReads).toBeGreaterThanOrEqual(count);
      expect(requests.filter((r) => !r.tools.length)).not.toHaveLength(0);
      const view = await runtime.getView('s');
      expect(
        view.messages
          .filter((m) => m.role === 'assistant')
          .map((m) => m.content)
          .join(''),
      ).not.toContain('Observed the supplied');

      const executions = await store.listExecutions('s');
      for (const r of requests) {
        const saved = await store.getExecution(r.requestId);
        expect(saved?.status).toBe(failedRequests.has(r.requestId) ? 'failed' : 'succeeded');
        if (!failedRequests.has(r.requestId) && !r.tools.length)
          expect(
            (saved?.decisionSource as { imageWindow?: { kind?: string } }).imageWindow?.kind,
          ).toBe('observation');
      }
      if (scenario === 'provider-413') expect(failedRequests.size).toBe(1);
      expect(
        executions.filter(
          (x) => x.definitionId === 'files.view_images' && x.status === 'succeeded',
        ),
      ).toHaveLength(count);
    } finally {
      await runtime.close();
      removeTemporaryDirectory(root);
    }
  }, 45000);

test('archived image observer receives applied human steering without copying private context', async () => {
  const root = temporaryDirectory('kite-steered-image-window-');
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const scope = {
    expectedStoreId: (await store.getMetadata()).storeId,
    sessionId: 's',
    subjectId: 'owner',
  };
  const task = 'Describe the logo in the image.';
  const superseded = 'Instead read the invoice number.';
  const guide = 'Read only the invoice total, not the logo.';
  const privateHost = 'PRIVATE-HOST-NOTE: unrelated context, not human guidance.';
  const source = await createCanvas(12, 12).encode('webp');
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let opens = 0;
  const tool = createViewImagesTool(async (path) => {
    opens++;
    entered.resolve();
    await release.promise;
    return { path, bytes: source };
  });
  const requests: ModelRequest[] = [];
  let steerAtObservation: Awaited<ReturnType<typeof store.getCommand>> | undefined;
  const finish = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  } as const;
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    modelId: 'fixed',
    // Host material is presented as user-role data in business calls, even with a
    // colliding source id. It must not become the quoted human task in an observer.
    sources: {
      capture: async () => [
        {
          id: 'guide',
          kind: 'audit_host',
          scope: 'owned',
          role: 'user',
          placement: 'after_history',
          digest: createHash('sha256').update(privateHost).digest('hex'),
          content: privateHost,
        },
      ],
    },
    model: {
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield {
            type: 'tool_call',
            id: 'view',
            name: 'view_images',
            arguments: '{"path":"fixture.webp"}',
          };
          yield { ...finish, reason: 'tool_calls' };
          return;
        }
        // A rich single-image 413 forces a detached observer for the same pixels,
        // without a large fixture or a second tool call.
        if (request.tools.length && request.messages.some((m) => m.images?.length))
          throw new ModelRequestLimitError();
        if (!request.tools.length) steerAtObservation = await store.getCommand('guide');
        yield { type: 'text_delta', text: 'Fixture response.' };
        yield finish;
      },
    },
    permissions: { authorize: async () => ({ allowed: true, revision: 'test' }) },
    extensions: [{ id: 'builtin.files', version: '1', apiMajor: 1, tools: [tool] }],
  });
  try {
    await runtime.createWorkspace({
      expectedStoreId: scope.expectedStoreId,
      id: 'w',
      name: 'fixture',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      ...scope,
      commandId: 'create',
      workspaceId: 'w',
      title: 'steer',
    });
    await runtime.submitCommand({
      ...scope,
      commandId: 'work',
      request: { kind: 'run.start', content: task },
    });
    await entered.promise;
    const run = (await store.getView('s')).runs.find((r) => r.isActive)!;
    for (const [commandId, content] of [
      ['superseded', superseded],
      ['guide', guide],
    ] as const)
      await runtime.submitCommand({
        ...scope,
        commandId,
        request: {
          kind: 'input.steer',
          targetRunId: run.id,
          contextSelectionId: run.contextSelectionId,
          content,
        },
      });
    release.resolve();
    await runtime.waitForCommand('work', { timeoutMs: 8000 });
    expect(await store.getRun(run.id)).toMatchObject({ status: 'completed' });
    expect(steerAtObservation).toMatchObject({
      id: 'guide',
      kind: 'input.steer',
      status: 'applied',
      receipt: { outcome: 'input_applied', runId: run.id },
    });
    const messageId = (steerAtObservation!.receipt as { messageId: string }).messageId;
    expect((await store.listMessages('s')).find((m) => m.id === messageId)).toMatchObject({
      role: 'user',
      runId: run.id,
      inputKind: 'input.steer',
      originCommandId: 'guide',
      content: guide,
    });
    expect(opens).toBe(1);
    const rejected = requests.find(
      (r) => r.tools.length && r.messages.some((m) => m.images?.length),
    )!;
    for (const text of [superseded, guide, privateHost])
      expect(rejected.messages.some((m) => m.role === 'user' && m.content === text)).toBe(true);
    const observers = requests.filter((r) => !r.tools.length);
    expect(observers).toHaveLength(1);
    const observer = observers[0]!;
    expect(observer.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(observer.messages[1]!.images).toHaveLength(1);
    const observerText = observer.messages.map((m) => m.content).join('');
    expect(observerText).not.toContain(privateHost);
    expect(observerText).not.toContain(superseded);
    expect(JSON.parse(observer.messages[1]!.content)).toMatchObject({
      quotedTask: task,
      quotedGuidance: guide,
    });
  } finally {
    release.resolve();
    await runtime.close();
    await store.close();
    removeTemporaryDirectory(root);
  }
}, 12000);

test('mislabeled historical PNG with exact recorded hash and size rejects whole frame before provider dispatch', async () => {
  const root = temporaryDirectory('kite-invalid-image-frame-');
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile),
    artifacts = createArtifactStore({ profile, store });
  const requests: ModelRequest[] = [];
  let publications = 0;
  let forged: { id: string; hash: string; size: string } | undefined;
  // Mimic an old publisher with a mislabelled second member. Byte identity and all
  // registration, original tool call and authorization checks remain genuine.
  const source = await createCanvas(12, 12).encode('webp');
  const wrapped = {
    ...artifacts,
    async publish(input: Parameters<typeof artifacts.publish>[0]) {
      if (
        input.mediaType !== 'image/png' ||
        input.scope.kind !== 'execution' ||
        ++publications !== 2
      )
        return artifacts.publish(input);
      const bytes = Buffer.from(input.content);
      bytes.write('JUNK', 12, 'ascii'); // correct PNG signature, invalid IHDR
      const ref = await artifacts.publish({ ...input, content: bytes });
      forged = {
        id: ref.id,
        hash: createHash('sha256').update(bytes).digest('hex'),
        size: String(bytes.length),
      };
      expect(ref).toMatchObject(forged);
      return ref;
    },
  };
  const tool = createViewImagesTool(async (path) => ({ path, bytes: source }));
  const runtime = createRuntime({
    store,
    artifacts: wrapped,
    modelId: 'fixed',
    model: {
      async *stream(req) {
        requests.push(req);
        if (requests.length === 1) {
          yield {
            type: 'tool_call',
            id: 'two',
            name: 'view_images',
            arguments: JSON.stringify({ paths: ['one.webp', 'two.webp'] }),
          };
          yield {
            type: 'finish',
            reason: 'tool_calls',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        } else {
          yield { type: 'text_delta', text: 'should be unreachable' };
          yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
        }
      },
    },
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'test' };
      },
    },
    extensions: [{ id: 'builtin.files', version: '1', apiMajor: 1, tools: [tool] }],
  });
  try {
    const scope = {
      expectedStoreId: (await store.getMetadata()).storeId,
      sessionId: 's',
      subjectId: 'owner',
    };
    await runtime.createWorkspace({
      expectedStoreId: scope.expectedStoreId,
      id: 'w',
      name: 'fixture',
      rootUri: 'file:///fixture',
    });
    await runtime.createSession({
      ...scope,
      commandId: 'create',
      workspaceId: 'w',
      title: 'invalid image fixture',
    });
    await runtime.submitCommand({
      ...scope,
      commandId: 'run',
      request: { kind: 'run.start', content: 'Open two synthetic images' },
    });
    const c = await runtime.waitForCommand('run', { timeoutMs: 10000 });
    expect(publications).toBe(2);
    expect(forged).toBeDefined();
    const executions = await store.listExecutions('s');
    const output = executions.find((x) => x.kind === 'tool');
    expect(output?.status).toBe('succeeded');
    expect(
      (output?.result as { modelImages: { id: string; size: string }[] }).modelImages[1],
    ).toMatchObject({ id: forged!.id, size: forged!.size });
    // The initial text-only request planned the archival tool. The first good
    // member cannot leak just because the second member failed admission.
    expect(requests.flatMap((r) => r.messages.flatMap((m) => m.images ?? []))).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(await store.getRun((c.receipt as { runId: string }).runId)).toMatchObject({
      status: 'failed',
      reason: 'tool_images_invalid',
    });
  } finally {
    await runtime.close();
    await artifacts.close();
    await store.close();
    removeTemporaryDirectory(root);
  }
});
