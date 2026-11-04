import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createCanvas } from '@napi-rs/canvas';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import { createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import type { ToolDefinition } from '../../../src/extensions';
import { createViewImagesTool } from '../../../src/files';
import { openSqliteStore } from '../../../src/sqlite';
import { processImage } from '../../../src/tools/images/processor';

test('local-image history fails before expanding the image that would exceed 32 MiB and never silently drops prior images', async () => {
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
  const prepared = await processImage(
    async () => ({ bytes: await canvas.encode('webp', 90) }),
    new AbortController().signal,
  );
  const count = Math.floor((32 * 1024 * 1024) / prepared.png.length) + 1;
  expect(count).toBeLessThanOrEqual(10);
  const finish: ModelEvent = {
    type: 'finish',
    reason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const model = createFixedModel([
    [
      ...Array.from(
        { length: count },
        (_, index): ModelEvent => ({
          type: 'tool_call',
          id: `image-${index}`,
          name: 'view_images',
          arguments: '{"path":"synthetic"}',
        }),
      ),
      finish,
    ],
    [finish],
  ]);
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
  // The codec result is real and fully checked above; this fixture publishes it under each real Execution.
  const tool: ToolDefinition = {
    ...createViewImagesTool(async () => {
      throw Error('unused');
    }),
    async execute(_input, context) {
      const reference = await context.artifacts!.publish({
        key: 'image',
        mediaType: 'image/png',
        content: prepared.png,
      });
      return {
        outcome: 'succeeded',
        content: JSON.stringify(prepared.metadata),
        artifactRefs: [reference],
        modelImages: [reference],
      };
    },
  };
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
      status: 'failed',
      reason: 'image_context_too_large',
    });
    expect(model.requests).toHaveLength(1);
    expect(imageReads).toBe(count - 1);
    const executions = await store.listExecutions('s');
    expect(
      executions.filter((x) => x.definitionId === 'files.view_images' && x.status === 'succeeded'),
    ).toHaveLength(count);
  } finally {
    await runtime.close();
    removeTemporaryDirectory(root);
  }
}, 45000);
