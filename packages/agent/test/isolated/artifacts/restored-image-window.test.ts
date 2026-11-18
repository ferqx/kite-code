import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createCanvas } from '@napi-rs/canvas';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import { createArtifactStore } from '../../../src/artifacts';
import type { ArtifactRef, Extension } from '../../../src/extensions';
import { createViewImagesTool } from '../../../src/files';
import { createProfileBackup, restoreProfileBackup } from '../../../src/maintenance';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

for (const originalBinding of [true, false])
  test(`restored local-image archive preserves provenance and refuses unbound legacy sources: binding=${originalBinding}`, async () => {
    const root = temporaryDirectory('kite-restored-image-window-');
    const profile = { dataRoot: join(root, 'data'), profile: 'test' };
    let store = await openSqliteStore(profile);
    const old = (await store.getMetadata()).storeId;
    const base = { expectedStoreId: old, sessionId: 's', subjectId: 'owner' };
    const png = await createCanvas(8, 8).encode('png');
    let first = true,
      effects = 0;
    let ref: ArtifactRef | undefined;
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
            id: 'original-image',
            name: 'view_images',
            arguments: '{"path":"synthetic"}',
          };
          yield { ...finish, reason: 'tool_calls' };
        } else {
          yield { type: 'text_delta', text: 'Completed with original pixels.' };
          yield finish;
        }
      },
    };
    const extensions: Extension[] = [
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
              effects++;
              ref = await ctx.artifacts!.publish({
                key: 'image',
                mediaType: 'image/png',
                content: png,
              });
              return {
                outcome: 'succeeded',
                content: 'Original synthetic image.',
                artifactRefs: [ref],
                modelImages: [ref],
              };
            },
          },
        ],
      },
    ];
    const permissions = {
      async authorize() {
        return { allowed: true, revision: 'test' };
      },
    };
    const compressor = {
      id: 'fixture',
      version: '1',
      async prepare() {
        return { instructions: 'Summarize known sources.', snapshot: {} };
      },
    };
    let runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      model,
      modelId: 'fixed',
      permissions,
      extensions,
      compressor,
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId: old,
        id: 'w',
        name: 'fixture',
        rootUri: 'file:///fixture',
      });
      await runtime.createSession({
        ...base,
        commandId: 'create',
        workspaceId: 'w',
        title: 'archive',
      });
      await runtime.submitCommand({
        ...base,
        commandId: 'original',
        request: { kind: 'run.start', content: 'Inspect the synthetic image.' },
      });
      await runtime.waitForCommand('original');
      expect((await runtime.getView('s')).runs[0]?.status).toBe('completed');
      expect(effects).toBe(1);
      expect(requests).toHaveLength(2);
      const originalInputId = requests[1]!.requestId;
      const originalInput = await runtime.readModelInput({ ...base, executionId: originalInputId });
      const originalRef = (
        await runtime.readArtifact({ ...base, refId: ref!.id, scope: ref!.scope! })
      ).reference;
      await runtime.close();
      if (!originalBinding) {
        // Legacy-shape fixture: the archived decision does not prove the builtin tool
        // binding. A current registration must not fill in that missing old authority.
        const db = new Database(join(profile.dataRoot, profile.profile, 'core.db'));
        try {
          db.query(
            "UPDATE execution SET decision_source_json=json_set(decision_source_json,'$.toolBindings',json('[]')) WHERE id=?",
          ).run(requests[0]!.requestId);
        } finally {
          db.close();
        }
      }
      const backup = await createProfileBackup({ profile, destinationRoot: join(root, 'backup') });
      const restored = await restoreProfileBackup({
        profile,
        expectedStoreId: old,
        backup,
        intent: 'replace_with_selected_backup',
      });
      expect(restored.storeId).not.toBe(old);
      const current = { ...base, expectedStoreId: restored.storeId };
      store = await openSqliteStore(profile);
      runtime = createRuntime({
        store,
        artifacts: createArtifactStore({ profile, store }),
        model,
        modelId: 'fixed',
        permissions,
        extensions,
        compressor,
      });
      expect(
        (await runtime.readArtifact({ ...current, refId: ref!.id, scope: ref!.scope! })).reference,
      ).toEqual(originalRef);
      expect(originalRef.storeId).toBe(old);
      expect(
        (await runtime.readModelInput({ ...current, executionId: originalInputId })).request,
      ).toEqual(originalInput.request);
      expect(requests).toHaveLength(2);
      const selection = (await runtime.getView('s')).session.contextSelectionId;
      // Restored old receipts are not silently promoted into new Store authority.
      await runtime.compressContext({
        ...current,
        commandId: 'before-redelivery',
        expectedContextSelectionId: selection,
      });
      await runtime.waitForCommand('before-redelivery');
      expect(
        (await store.getView('s')).runs.find((r) => r.originCommandId === 'before-redelivery'),
      ).toMatchObject({
        status: 'failed',
        reason: originalBinding ? 'image_delivery_pending' : 'image_source_unverified',
      });
      expect(requests).toHaveLength(2);
      await runtime.submitCommand({
        ...current,
        commandId: 'fresh',
        request: {
          kind: 'run.start',
          content: 'Use the selected original image to answer this new task.',
        },
      });
      await runtime.waitForCommand('fresh');
      if (!originalBinding) {
        expect(
          (await store.getView('s')).runs.find((r) => r.originCommandId === 'fresh'),
        ).toMatchObject({ status: 'failed', reason: 'image_source_unverified' });
        expect(requests).toHaveLength(2);
        expect(effects).toBe(1);
        return;
      }
      expect(
        (await store.getView('s')).runs.find((r) => r.originCommandId === 'fresh'),
      ).toMatchObject({ status: 'completed' });
      expect(effects).toBe(1);
      expect(requests).toHaveLength(3);
      const sent = requests[2]!.messages.flatMap((m) => m.images ?? []);
      expect(sent).toHaveLength(1);
      expect(Buffer.from(sent[0]!.data, 'base64').equals(png)).toBe(true);
      // Current receipt can now support compaction without resending the pixels.
      await runtime.compressContext({
        ...current,
        commandId: 'after-redelivery',
        expectedContextSelectionId: selection,
      });
      await runtime.waitForCommand('after-redelivery');
      expect(
        (await store.getView('s')).runs.find((r) => r.originCommandId === 'after-redelivery'),
      ).toMatchObject({ status: 'completed' });
      expect(requests).toHaveLength(4);
      expect(requests[3]!.messages.flatMap((m) => m.images ?? [])).toHaveLength(0);
      expect(effects).toBe(1);
      const denied = await runtime
        .readArtifact({ ...current, subjectId: 'someone-else', refId: ref!.id, scope: ref!.scope! })
        .then(
          () => false,
          () => true,
        );
      expect(denied).toBe(true);
    } finally {
      await runtime.close();
      removeTemporaryDirectory(root);
    }
  }, 30000);
