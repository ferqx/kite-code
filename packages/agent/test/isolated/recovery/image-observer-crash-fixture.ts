import { randomFillSync } from 'node:crypto';
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { createArtifactStore } from '../../../src/artifacts';
import { createViewImagesTool } from '../../../src/files';
import { createRuntime, type RunConfiguration } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
export function binding(dir: string): RunConfiguration {
  return {
    modelId: 'fixed',
    snapshot: { fixture: 'image-cold', version: 1 },
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixed' };
      },
    },
    model: {
      describeRequest() {
        return {
          adapterId: 'fixed',
          adapterVersion: '1',
          provider: { availability: 'available', family: 'fixture', modelId: 'fixed' },
          settings: { maxRetries: 0, maxSteps: 1, allowSystemInMessages: true },
          transformation: { id: 'fixture', version: '1' },
        };
      },
      async *stream(r) {
        appendFileSync(
          join(dir, 'calls'),
          JSON.stringify({
            id: r.requestId,
            tools: r.tools.map((t) => t.id),
            pixels: r.messages.flatMap((m) => m.images ?? []).length,
          }) + '\n',
        );
        const finish = {
          type: 'finish' as const,
          reason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
        if (!r.tools.length) {
          yield { type: 'text_delta', text: 'private observer note' };
          yield finish;
          return;
        }
        if (!r.messages.some((m) => m.role === 'tool')) {
          for (let i = 0; i < 3; i++)
            yield {
              type: 'tool_call',
              id: 'pictures-' + i,
              name: 'view_images',
              arguments: JSON.stringify({ paths: ['a', 'b'] }),
            };
          yield { ...finish, reason: 'tool_calls' };
          return;
        }
        yield { type: 'text_delta', text: 'final business answer' };
        yield finish;
      },
    },
    extensions: [
      {
        id: 'builtin.files',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            ...createViewImagesTool(async () => {
              throw Error('unused');
            }),
            async execute(_, ctx) {
              appendFileSync(join(dir, 'effects'), 'images\n');
              const refs = [];
              for (let i = 0; i < 2; i++)
                refs.push(
                  await ctx.artifacts!.publish({
                    key: 'i' + i,
                    mediaType: 'image/png',
                    content: readFileSync(join(dir, 'source.png')),
                  }),
                );
              return {
                outcome: 'succeeded',
                content: 'pictures',
                artifactRefs: refs,
                modelImages: refs,
              };
            },
          },
        ],
      },
    ],
  };
}
if (import.meta.main) {
  const dir = process.argv[2]!;
  writeFileSync(join(dir, 'calls'), '');
  writeFileSync(join(dir, 'effects'), '');
  const canvas = createCanvas(1400, 1100);
  const rgba = randomFillSync(new Uint8ClampedArray(1400 * 1100 * 4));
  canvas.getContext('2d').putImageData(new ImageData(rgba, 1400, 1100), 0, 0);
  writeFileSync(join(dir, 'source.png'), await canvas.encode('png'));
  const profile = { dataRoot: join(dir, 'data'), profile: 'test' },
    store = await openSqliteStore(profile);
  const raw = store.markDispatching.bind(store);
  store.markDispatching = async (input) => {
    const e = await store.getExecution(input.executionId);
    if ((e?.decisionSource as any)?.imageWindow?.kind === 'observation') {
      const session = await store.getSession('s');
      writeFileSync(
        join(dir, 'ready.tmp'),
        JSON.stringify({
          execution: e,
          expectedStoreId: (await store.getMetadata()).storeId,
          runId: e!.runId,
          expectedOwnerGeneration: session!.ownerGeneration,
        }),
      );
      renameSync(join(dir, 'ready.tmp'), join(dir, 'ready.json'));
      await new Promise(() => {});
    }
    return raw(input);
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    resolveRunConfiguration: async () => binding(dir),
    permissions: binding(dir).permissions!,
  });
  const id = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId: id,
    id: 'w',
    name: 'w',
    rootUri: 'file://' + dir,
  });
  await runtime.createSession({
    expectedStoreId: id,
    subjectId: 'owner',
    sessionId: 's',
    commandId: 'create',
    workspaceId: 'w',
    title: 'test',
  });
  await runtime.submitCommand({
    expectedStoreId: id,
    subjectId: 'owner',
    sessionId: 's',
    commandId: 'work',
    request: { kind: 'run.start', content: 'read all images' },
  });
  await new Promise(() => {});
}
