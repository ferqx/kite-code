import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { createCanvas } from '@napi-rs/canvas';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import { type AgentRuntime, createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import { createReinspectImagesTool, createViewImagesTool } from '../../../src/files';
import type { ImageSourceLocator } from '../../../src/model-body/selected-image-source';
import { openSqliteStore } from '../../../src/sqlite';

const done = (tool = false): ModelEvent => ({
  type: 'finish',
  reason: tool ? 'tool_calls' : 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
});
const call = (id: string, name: string, v: unknown): ModelEvent => ({
  type: 'tool_call',
  id,
  name,
  arguments: JSON.stringify(v),
});
test('scoped archive discovery and exact ordinal selection read no user paths, retain duplicates, fail closed for unrelated provenance and missing blobs', async () => {
  const root = temporaryDirectory('kite-selected-img-'),
    profile = { dataRoot: join(root, 'data'), profile: 'test' };
  let store = await openSqliteStore(profile);
  const scope = {
    expectedStoreId: (await store.getMetadata()).storeId,
    sessionId: 's',
    subjectId: 'owner',
  };
  let runtime: AgentRuntime,
    lookup: ImageSourceLocator | undefined,
    stage = 0,
    openCount = 0,
    problem: unknown;
  let actual: string[] = [];
  const h = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
  const src = ['a.png', 'b.png', 'a-copy.png'];
  for (const [i, n] of src.entries()) {
    const c = createCanvas(8, 8),
      g = c.getContext('2d');
    g.fillStyle = i === 1 ? '#39da30' : '#1278ee';
    g.fillRect(0, 0, 8, 8);
    writeFileSync(join(root, n), c.toBuffer('image/png'));
  }
  const view = {
    ...createViewImagesTool(async () => {
      throw Error('unused codec');
    }),
    async execute(_v: unknown, ctx: import('../../../src/extensions').ToolContext) {
      const refs = [];
      for (const [i, n] of src.entries()) {
        openCount++;
        refs.push(
          await ctx.artifacts!.publish({
            key: `image-${i + 1}`,
            mediaType: 'image/png',
            content: readFileSync(join(root, n)),
          }),
        );
      }
      return {
        outcome: 'succeeded' as const,
        content: 'Original ordered test PNGs',
        artifactRefs: refs,
        modelImages: refs,
      };
    },
  };
  const tool = createReinspectImagesTool(
    (ctx, locator, ordinals) =>
      runtime.readSelectedImageMembers(
        { ...scope, sessionId: ctx.sessionId, runId: ctx.runId!, locator, ordinals },
        ctx.signal,
      ),
    (ctx, beforeSeq) =>
      runtime.listSelectedImageSources(
        {
          ...scope,
          sessionId: ctx.sessionId,
          runId: ctx.runId!,
          ...(beforeSeq ? { beforeSeq } : {}),
        },
        ctx.signal,
      ),
  );
  const model: ModelAdapter = {
    async *stream(r) {
      try {
        if (stage++ === 0) {
          yield call('src', 'view_images', { paths: src });
          yield done(true);
          return;
        }
        if (stage === 2) {
          const m = r.messages.find((m) => m.toolCallId === 'src');
          actual = (m?.images ?? []).map((i) => h(Buffer.from(i.data, 'base64')));
          if (actual.length !== 3)
            throw Error(
              'fixture image failure: ' +
                JSON.stringify(
                  r.messages.map((x) => [x.role, x.toolCallId, x.content.slice(0, 300)]),
                ),
            );
          expect(actual[0]).toBe(actual[2]);
          expect(actual[1]).not.toBe(actual[0]);
          for (const n of src) unlinkSync(join(root, n));
          yield call('ls', 'reinspect_images', { list: true });
          yield done(true);
          return;
        }
        if (stage === 3) {
          const ls = r.messages.find((m) => m.toolCallId === 'ls');
          const j = JSON.parse(ls!.content.slice(ls!.content.indexOf('{')));
          expect(j.sources).toHaveLength(1);
          expect(j.sources[0].sourceCount).toBe(3);
          lookup = j.sources[0].locator;
          const run = (await store.getExecution(r.requestId))!.runId!;
          const input = { ...scope, runId: run, locator: lookup!, ordinals: [2, 3] };
          for (const bad of [
            { ...input, subjectId: 'unknown' },
            { ...input, sessionId: 'sibling' },
            { ...input, expectedStoreId: 'wrong' },
            { ...input, locator: { ...lookup!, seq: '1' } },
            { ...input, locator: { ...lookup!, messageId: 'forged' } },
            { ...input, ordinals: [2, 2] },
            { ...input, ordinals: [4] },
          ]) {
            let code: string | undefined;
            try {
              await runtime.readSelectedImageMembers(bad);
            } catch (e) {
              code = (e as Error).message;
            }
            expect(code).toBe('image_source_unverified');
          }
          const hash = actual[1]!,
            blob = join(profile.dataRoot, 'test', 'blobs', hash.slice(0, 2), hash);
          renameSync(blob, `${blob}.held`);
          try {
            expect(await runtime.readSelectedImageMembers(input)).toEqual({
              kind: 'partial_resource_unavailable',
              missing: [2],
              available: [3],
            });
          } finally {
            renameSync(`${blob}.held`, blob);
          }
          yield call('again', 'reinspect_images', { locator: lookup, ordinals: [1, 3] });
          yield done(true);
          return;
        }
        if (stage === 5) {
          yield call('cold-list', 'reinspect_images', { list: true });
          yield done(true);
          return;
        }
        if (stage === 6) {
          const ls = r.messages.find((m) => m.toolCallId === 'cold-list')!,
            j = JSON.parse(ls.content.slice(ls.content.indexOf('{')));
          expect(j.sources).toHaveLength(1);
          expect(j.sources[0].locator.executionId).toBe(lookup!.executionId);
          const forkScope = {
            ...scope,
            sessionId: 'branch',
            runId: (await store.getExecution(r.requestId))!.runId!,
          };
          expect(
            (
              await runtime.listSelectedImageSources({
                ...forkScope,
                beforeSeq: j.sources[0].locator.seq,
              })
            ).sources,
          ).toEqual([]);
          yield call('cold-again', 'reinspect_images', {
            locator: j.sources[0].locator,
            ordinals: [2],
          });
          yield done(true);
          return;
        }
        if (stage === 7) {
          const m = r.messages.find((m) => m.toolCallId === 'cold-again');
          expect(m?.images?.map((i) => h(Buffer.from(i.data, 'base64')))).toEqual([actual[1]!]);
          yield done();
          return;
        }
        const m = r.messages.find((m) => m.toolCallId === 'again');
        expect(m?.content).toContain('selected_original_images');
        expect(m?.images?.map((i) => h(Buffer.from(i.data, 'base64')))).toEqual([
          actual[0]!,
          actual[2]!,
        ]);
        yield done();
      } catch (e) {
        problem = e;
        yield done();
      }
    },
  };
  const make = () =>
    createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      model,
      modelId: 'fixed',
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'fixture' };
        },
      },
      extensions: [{ id: 'builtin.files', version: '1', apiMajor: 1, tools: [view, tool] }],
    });
  runtime = make();
  try {
    await runtime.createWorkspace({
      expectedStoreId: scope.expectedStoreId,
      id: 'w',
      name: 'fixture',
      rootUri: 'file:///fixture',
    });
    for (const sessionId of ['s', 'sibling'])
      await runtime.createSession({
        ...scope,
        sessionId,
        commandId: `create-${sessionId}`,
        workspaceId: 'w',
        title: 'image',
      });
    await runtime.submitCommand({
      ...scope,
      commandId: 'run',
      request: { kind: 'run.start', content: 'Exercise archival reinspection' },
    });
    const c = await runtime.waitForCommand('run', { timeoutMs: 30000 });
    if (problem) throw problem;
    expect((await store.getRun((c.receipt as { runId: string }).runId))?.status).toBe('completed');
    expect(stage).toBe(4);
    expect(openCount).toBe(3);
    const sess = await store.getSession('s');
    await runtime.forkSession({
      expectedStoreId: scope.expectedStoreId,
      sourceSessionId: 's',
      expectedContextSelectionId: sess!.contextSelectionId,
      newSessionId: 'branch',
      commandId: 'fork',
      subjectId: 'owner',
      title: 'forked archive',
    });
    await runtime.close();
    store = await openSqliteStore(profile);
    runtime = make();
    await runtime.submitCommand({
      ...scope,
      sessionId: 'branch',
      commandId: 'late',
      request: {
        kind: 'run.start',
        content: 'Late detail from the selected original, after restart',
      },
    });
    const late = await runtime.waitForCommand('late', { timeoutMs: 30000 });
    if (problem) throw problem;
    expect((await store.getRun((late.receipt as { runId: string }).runId))?.status).toBe(
      'completed',
    );
    expect(stage).toBe(7);
    expect(openCount).toBe(3);
  } finally {
    await runtime.close();
    removeTemporaryDirectory(root);
  }
}, 40000);
