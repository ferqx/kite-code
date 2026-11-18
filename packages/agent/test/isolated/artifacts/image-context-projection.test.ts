import { expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  type ModelAdapter,
  ModelAttemptError,
  type ModelEvent,
  type ModelRequest,
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

for (const delivered of [true, false])
  test(`image context read-only projection and manual compaction: delivered=${delivered}`, async () => {
    const root = temporaryDirectory('kite-image-projection-');
    const profile = { dataRoot: join(root, 'data'), profile: 'test' };
    const store = await openSqliteStore(profile);
    const artifacts = createArtifactStore({ profile, store });
    const png = await createCanvas(8, 8).encode('png');
    let pngReads = 0,
      first = true,
      compactions = 0,
      resetChecks = 0;
    const requests: ModelRequest[] = [];
    const finish: ModelEvent = {
      type: 'finish',
      reason: 'stop',
      usage: { inputTokens: 100, outputTokens: 10 },
    };
    const model: ModelAdapter = {
      describeRequest() {
        return {
          adapterId: 'fixed',
          adapterVersion: '1',
          provider: { availability: 'available', family: 'fixture', modelId: 'fixed' },
          settings: { maxRetries: 0, maxSteps: 1, allowSystemInMessages: true },
          transformation: { id: 'fixture', version: '1' },
        };
      },
      async *stream(request) {
        requests.push(request);
        if (first) {
          first = false;
          yield {
            type: 'tool_call',
            id: 'image',
            name: 'view_images',
            arguments: '{"path":"synthetic"}',
          };
          yield { ...finish, reason: 'tool_calls' };
        } else {
          if (!delivered && request.messages.some((m) => m.images?.length))
            throw new ModelAttemptError('connection_failed', 'connection_interrupted');
          yield {
            type: 'text_delta',
            text: compactions ? 'Source-labeled summary.' : 'Original visual answer.',
          };
          yield finish;
        }
      },
    };
    const runtime = createRuntime({
      store,
      model,
      modelId: 'fixed',
      artifacts: {
        ...artifacts,
        async readReference(input) {
          if (input.reference.mediaType === 'image/png') pngReads++;
          return artifacts.readReference(input);
        },
      },
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'test' };
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
                throw Error('not used');
              }),
              async execute(_input, ctx) {
                const reference = await ctx.artifacts!.publish({
                  key: 'image',
                  mediaType: 'image/png',
                  content: png,
                });
                return {
                  outcome: 'succeeded',
                  content: 'Original image metadata.',
                  artifactRefs: [reference],
                  modelImages: [reference],
                };
              },
            },
          ],
        },
      ],
      compressor: {
        id: 'fixture',
        version: '1',
        async prepare(input) {
          compactions++;
          expect(input.messages.flatMap((m) => m.images ?? [])).toHaveLength(0);
          expect(
            input.messages.some((m) => m.content.includes('Archived image availability')),
          ).toBe(true);
          return {
            instructions: 'Summarize sources without changing their authority.',
            snapshot: {},
          };
        },
        async validateSummary() {
          return true;
        },
        async validateExpanded(input) {
          resetChecks++;
          expect(input.messages.flatMap((m) => m.images ?? [])).toHaveLength(0);
          expect(
            input.messages.some((m) => m.content.includes('Archived image availability')),
          ).toBe(true);
          return true;
        },
      },
    });
    try {
      const base = {
        expectedStoreId: (await store.getMetadata()).storeId,
        sessionId: 's',
        subjectId: 'owner',
      };
      await runtime.createWorkspace({
        expectedStoreId: base.expectedStoreId,
        id: 'w',
        name: 'fixture',
        rootUri: 'file:///fixture',
      });
      await runtime.createSession({
        ...base,
        commandId: 'create',
        workspaceId: 'w',
        title: 'images',
      });
      await runtime.submitCommand({
        ...base,
        commandId: 'work',
        request: { kind: 'run.start', content: 'Inspect the image' },
      });
      await runtime.waitForCommand('work');
      const requestsBefore = requests.length,
        readsBefore = pngReads;
      if (delivered) {
        const projection = await runtime.readContextEstimate({
          ...base,
          executionId: requests.at(-1)!.requestId,
        });
        expect(projection.modelInputExecutionId).toBe(requests.at(-1)!.requestId);
        expect(pngReads).toBe(readsBefore);
        expect(requests.length).toBe(requestsBefore);
      } else {
        // This earlier request did not contain the later image. Do not estimate it as zero pixels.
        const err = await runtime
          .readContextEstimate({ ...base, executionId: requests[0]!.requestId })
          .then(
            () => null,
            (e) => e,
          );
        expect(err?.code).toBe('context_estimate_unavailable');
        expect(requests.length).toBe(requestsBefore);
      }
      const selection = (await runtime.getView('s')).session.contextSelectionId;
      await runtime.compressContext({
        ...base,
        commandId: 'compact',
        expectedContextSelectionId: selection,
      });
      await runtime.waitForCommand('compact');
      const compactRun = (await store.getView('s')).runs.find(
        (r) => r.originCommandId === 'compact',
      );
      expect(compactRun).toMatchObject(
        delivered
          ? { status: 'completed' }
          : { status: 'failed', reason: 'image_delivery_pending' },
      );
      expect(compactions).toBe(delivered ? 1 : 0);
      expect(pngReads).toBe(readsBefore);
      expect(requests.length).toBe(requestsBefore + (delivered ? 1 : 0));
      if (delivered) {
        const context = await store.getSelectedContext({
          expectedStoreId: base.expectedStoreId,
          sessionId: 's',
        });
        expect(context.compression).toBeDefined();
        await runtime.resetCompressionContext({
          ...base,
          commandId: 'reset',
          expectedContextSelectionId: selection,
          expectedCompressionId: context.compression!.id,
        });
        await runtime.waitForCommand('reset');
        expect(resetChecks).toBe(1);
        expect(
          (
            await store.getSelectedContext({
              expectedStoreId: base.expectedStoreId,
              sessionId: 's',
            })
          ).compression,
        ).toBeUndefined();
        expect(requests.length).toBe(requestsBefore + 1);
        expect(pngReads).toBe(readsBefore);
      }
    } finally {
      await runtime.close();
      removeTemporaryDirectory(root);
    }
  }, 30000);
