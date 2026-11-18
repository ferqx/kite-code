import { expect, test } from 'bun:test';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { type AgentRuntime, createRuntime } from '../../../src';
import { createArtifactStore } from '../../../src/artifacts';
import type { ContextCompressor } from '../../../src/context';
import { createReinspectImagesTool, createViewImagesTool } from '../../../src/files';
import type { ImageSourceLocator } from '../../../src/model-body/selected-image-source';
import { openSqliteStore } from '../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 100, outputTokens: 10 },
};
const call = (id: string, name: string, args: unknown): ModelEvent => ({
  type: 'tool_call',
  id,
  name,
  arguments: JSON.stringify(args),
});
const note = 'OBSERVER_ONLY_DO_NOT_TRANSFER';
const summary = 'Historical images are archived. No source locations supplied.';
const pixels = (r: ModelRequest) => r.messages.flatMap((m) => m.images ?? []);
const permissions = {
  async authorize() {
    return { allowed: true, revision: 'test' };
  },
};

for (const condition of ['complete', 'missing-fourth', 'mixed-direct'] as const)
  test('manual text-only compaction after authorized transport change: ' + condition, async () => {
    const complete = condition !== 'missing-fourth';
    const root = temporaryDirectory('kite-text-transport-'),
      profile = { dataRoot: join(root, 'data'), profile: 'test' };
    let store = await openSqliteStore(profile),
      runtime: AgentRuntime;
    const base = {
      expectedStoreId: (await store.getMetadata()).storeId,
      sessionId: 's',
      subjectId: 'owner',
    };
    const names = ['a', 'b', 'c', 'd'].map((n) => join(root, n + '.png'));
    for (const [i, p] of names.entries()) {
      const c = createCanvas(16, 16),
        g = c.getContext('2d');
      g.fillStyle = ['red', 'green', 'blue', 'orange'][i]!;
      g.fillRect(0, 0, 16, 16);
      writeFileSync(p, c.toBuffer('image/png'));
    }
    let route: 'A' | 'B' = 'A',
      step: 'source' | 'none' | 'list' | 'choose' = 'source',
      opens = 0,
      pngReads = 0;
    let auto = false,
      trusted = true,
      lookup: ImageSourceLocator | undefined,
      nextBefore: string | undefined,
      callNumber = 0;
    const raw: { route: string; r: ModelRequest }[] = [],
      preparations: { trigger: string; messages: unknown }[] = [];
    let originalPixels: ReturnType<typeof pixels> = [];
    const validated: { summary: string; renderedSummary?: string }[] = [];
    const reported: { summary: string; renderedSummary?: string }[] = [];
    const prepareMark = 'Text-only compression instruction.';
    const compressor: ContextCompressor = {
      id: 'fixture',
      version: '1',
      async prepare(input) {
        preparations.push({ trigger: input.trigger, messages: input.messages });
        return { instructions: prepareMark, snapshot: {} };
      },
      async shouldCompress() {
        return auto;
      },
      async validateSummary({ summary, renderedSummary }) {
        validated.push({ summary, renderedSummary });
        return true;
      },
      async validateSummaryReport({ summary, renderedSummary }) {
        reported.push({ summary, renderedSummary });
        return { accepted: true };
      },
      async validateExpanded() {
        return true;
      },
    };
    const model: ModelAdapter = {
      describeRequest() {
        return {
          adapterId: 'same-authorized-provider',
          adapterVersion: '1',
          provider: { availability: 'available', family: 'fixture', modelId: 'same-destination' },
          settings: { maxRetries: 0, maxSteps: 1, allowSystemInMessages: true },
          transformation: { id: 'transport', version: route },
        };
      },
      async *stream(r) {
        raw.push({ route, r });
        if (r.messages.some((m) => m.content.includes(prepareMark))) {
          yield { type: 'text_delta', text: summary };
          yield finish;
          return;
        }
        if (step === 'source') {
          step = 'none';
          yield call('original', 'view_images', { paths: names });
          yield { ...finish, reason: 'tool_calls' };
          return;
        }
        if (route === 'A' && pixels(r).length) {
          if (!originalPixels.length) originalPixels = pixels(r);
          // The receiver rejects all multi-image requests; real Runtime retries only
          // after definitive 413, producing singleton observer receipts.
          if (pixels(r).length > 1) throw new ModelRequestLimitError();
          if (!complete && pixels(r)[0]?.data === originalPixels[3]?.data)
            throw new ModelAttemptError('connection_failed', 'connection_interrupted');
          yield { type: 'text_delta', text: note };
          yield finish;
          return;
        }
        if (step === 'list') {
          step = 'choose';
          yield call('list-' + ++callNumber, 'reinspect_images', { list: true });
          yield { ...finish, reason: 'tool_calls' };
          return;
        }
        if (step === 'choose') {
          const item = r.messages.find((m) => m.toolCallId === 'list-' + callNumber);
          if (!item) throw Error('missing listing');
          const outer = JSON.parse(item.content.slice(item.content.indexOf('{'))),
            result = typeof outer.content === 'string' ? JSON.parse(outer.content) : outer;
          if (!result.sources?.length) {
            nextBefore = result.nextBeforeSeq;
            if (!nextBefore || callNumber >= 10) throw Error('archive was not discoverable');
            yield call('list-' + ++callNumber, 'reinspect_images', {
              list: true,
              beforeSeq: nextBefore,
            });
          } else {
            lookup = result.sources[0].locator;
            step = 'none';
            yield call('read-fourth', 'reinspect_images', { locator: lookup, ordinals: [4] });
          }
          yield { ...finish, reason: 'tool_calls' };
          return;
        }
        if (!complete && route === 'B' && pixels(r).length)
          throw new ModelAttemptError('connection_failed', 'connection_interrupted');
        yield { type: 'text_delta', text: 'Task complete.' };
        yield finish;
      },
    };
    const view = createViewImagesTool(async (path) => {
      opens++;
      return { path, bytes: readFileSync(path) };
    });
    const reread = createReinspectImagesTool(
      (ctx, locator, ordinals) =>
        runtime.readSelectedImageMembers(
          { ...base, runId: ctx.runId!, locator, ordinals },
          ctx.signal,
        ),
      (ctx, beforeSeq) =>
        runtime.listSelectedImageSources({ ...base, runId: ctx.runId!, beforeSeq }, ctx.signal),
    );
    const extensions = [
      { id: 'builtin.files', version: '1', apiMajor: 1 as const, tools: [view, reread] },
    ];
    const open = () => {
      const artifacts = createArtifactStore({ profile, store });
      return createRuntime({
        store,
        extensions,
        permissions,
        artifacts: {
          ...artifacts,
          async readReference(input) {
            if (input.reference.mediaType === 'image/png') pngReads++;
            return artifacts.readReference(input);
          },
        },
        resolveRunConfiguration: async ({ command }) => ({
          model,
          modelId: 'fixed',
          compressor,
          permissions,
          toolIds: extensions[0]!.tools.map((t) => t.id),
          ...(command.kind === 'context.compress' && trusted
            ? { verifiedSessionCompressionTarget: true as const }
            : {}),
          snapshot: { destination: 'same' },
        }),
      });
    };
    runtime = open();
    const run = async (id: string, body: string) => {
      await runtime.submitCommand({
        ...base,
        commandId: id,
        request: { kind: 'run.start', content: body },
      });
      await runtime.waitForCommand(id);
      return (await store.getView('s')).runs.find((r) => r.originCommandId === id)!;
    };
    const compact = async (id: string) => {
      await runtime.compressContext({
        ...base,
        commandId: id,
        expectedContextSelectionId: (await runtime.getSession('s'))!.contextSelectionId,
      });
      await runtime.waitForCommand(id);
      return (await store.getView('s')).runs.find((r) => r.originCommandId === id)!;
    };
    try {
      await runtime.createWorkspace({
        expectedStoreId: base.expectedStoreId,
        id: 'w',
        name: 'fixtures',
        rootUri: 'file:///fixture',
      });
      await runtime.createSession({
        ...base,
        workspaceId: 'w',
        commandId: 'init',
        title: 'transport',
      });
      expect((await run('seed', 'Inspect the initial images.')).status).toBe(
        complete ? 'completed' : 'failed',
      );
      expect(opens).toBe(4);
      expect(originalPixels).toHaveLength(4);
      expect(new Set(originalPixels.map((m) => m.data)).size).toBe(4);
      const seed = await store.listExecutions('s'),
        origin = seed.find((e) => e.definitionId === 'files.view_images')!;
      function windowOf(source: unknown) {
        return (
          source as {
            imageWindow?: { kind: string; route: string; members: { ordinal: number }[] };
          }
        ).imageWindow;
      }
      const confirmed = seed.filter(
        (e) => e.kind === 'model' && e.status === 'succeeded' && windowOf(e.decisionSource),
      );
      expect(
        confirmed.flatMap((e) => windowOf(e.decisionSource)!.members.map((m) => m.ordinal)).sort(),
      ).toEqual(complete ? [1, 2, 3, 4] : [1, 2, 3]);
      expect(
        confirmed.every(
          (e) =>
            windowOf(e.decisionSource)?.kind === 'observation' &&
            (e.result as { observation: { note: string } }).observation.note === note,
        ),
      ).toBe(true);
      if (condition === 'mixed-direct') {
        const image = await runtime.uploadInputImage({
          ...base,
          id: 'mixed',
          name: 'pasted.png',
          mediaType: 'image/png',
          data: readFileSync(names[0]!).toString('base64'),
        });
        await runtime.submitCommand({
          ...base,
          commandId: 'attach',
          request: { kind: 'run.start', content: 'Direct image.', images: [image] },
        });
        await runtime.waitForCommand('attach');
        expect(
          (await store.getView('s')).runs.find((r) => r.originCommandId === 'attach')?.status,
        ).toBe('completed');
        expect(raw.at(-1)!.r.messages.some((m) => m.role === 'user' && m.images?.length)).toBe(
          true,
        );
      }
      for (const p of names) unlinkSync(p);
      route = 'B';
      const mark = raw.length,
        reads = pngReads;
      // Estimation uses archived input, not a new visual request or a transfer across routes.
      await runtime.readContextEstimate({ ...base, executionId: raw.at(-1)!.r.requestId }).then(
        () => true,
        () => false,
      );
      if (condition !== 'mixed-direct') expect(pngReads).toBe(reads);
      expect(raw).toHaveLength(mark);
      trusted = false;
      const refused = await compact('without-confirmed-target');
      expect(refused.reason).toBe('image_delivery_pending');
      expect(raw).toHaveLength(mark);
      if (condition !== 'mixed-direct') expect(pngReads).toBe(reads);
      trusted = true;
      const result = await compact('manual');
      if (condition === 'mixed-direct') {
        expect(result).toMatchObject({ status: 'failed', reason: 'image_delivery_pending' });
        expect(raw).toHaveLength(mark);
        expect(preparations).toHaveLength(0);
        return;
      }
      if (!complete) {
        expect(result).toMatchObject({ status: 'failed', reason: 'image_delivery_pending' });
        expect(raw).toHaveLength(mark);
        expect(pngReads).toBe(reads);
        expect(preparations).toHaveLength(0);
        // An ordinary explicit Run may send its own business request; no separate
        // automatic compression/observer should be scheduled to make it compressible.
        auto = true;
        await run('ordinary', 'New business question');
        const after = raw.slice(mark);
        expect(after).toHaveLength(1);
        expect(after[0]!.r.tools.length).toBeGreaterThan(0);
        expect(preparations).toHaveLength(0);
        return;
      }
      expect(result.status).toBe('completed');
      const first = raw.slice(mark);
      expect(first).toHaveLength(1);
      const req = first[0]!.r;
      expect(pixels(req)).toHaveLength(0);
      expect(JSON.stringify(req)).not.toContain(note);
      expect(pngReads).toBe(reads);
      expect(preparations.map((x) => x.trigger)).toEqual(['manual']);
      expect(JSON.stringify(preparations)).not.toContain(note);
      const projected = await store.getExecution(req.requestId);
      expect(windowOf(projected!.decisionSource)).toBeUndefined();
      expect(projected!.decisionSource).toMatchObject({ imageArchiveDirectory: true });
      const bRoute = (projected!.decisionSource as { imageAvailabilityRoute: string })
        .imageAvailabilityRoute;
      expect(typeof bRoute).toBe('string');
      expect(bRoute).not.toBe(windowOf(confirmed[0]!.decisionSource)!.route);
      const selection = (await runtime.getSession('s'))!.contextSelectionId;
      const facts = () =>
        store.readImageWindowFacts({
          ...base,
          runId: result.id,
          selectionId: selection,
          route: bRoute,
          executionIds: [origin.id],
        });
      expect((await facts()).confirmed).toEqual([]);
      await runtime.close();
      store = await openSqliteStore(profile);
      runtime = open();
      const sel = await store.getSelectedContext({
        expectedStoreId: base.expectedStoreId,
        sessionId: 's',
      });
      expect(sel.compression).toBeDefined();
      const resetMark = raw.length;
      await runtime.resetCompressionContext({
        ...base,
        commandId: 'reset',
        expectedCompressionId: sel.compression!.id,
        expectedContextSelectionId: selection,
      });
      await runtime.waitForCommand('reset');
      expect(raw.length).toBe(resetMark);
      expect(pngReads).toBe(reads);
      expect(
        (await store.getView('s')).runs.find((r) => r.originCommandId === 'reset')?.reason,
      ).toBe('compression_reset_unsafe');
      // A fresh ordinary text round adds a new compression boundary. Repeating the
      // command with no new messages is correctly refused by the preexisting contract.
      expect((await run('text', 'A short unrelated text question.')).status).toBe('completed');
      expect(raw.length).toBe(resetMark + 1);
      expect(pixels(raw.at(-1)!.r)).toEqual([]);
      expect(JSON.stringify(raw.at(-1)!.r)).toContain(summary);
      expect(
        raw.at(-1)!.r.messages.some((m) => m.content.includes('archive directory retained')),
      ).toBe(true);
      const durable = raw
        .at(-1)!
        .r.messages.find(
          (m) => m.role === 'user' && m.content.includes('archive directory retained'),
        )!.content;
      expect(durable).toContain('reinspect_images');
      expect(durable.endsWith('\n' + summary)).toBe(true);
      expect(validated).toEqual([{ summary, renderedSummary: durable }]);
      expect(reported).toEqual(validated);
      const secondMark = raw.length;
      // The summary deliberately omitted every locator. A second summary must not
      // invent any delivery, and later discovery must consult original selected history.
      expect((await compact('second')).status).toBe('completed');
      expect(raw.length).toBe(secondMark + 1);
      expect(pixels(raw.at(-1)!.r)).toHaveLength(0);
      expect(JSON.stringify(raw.at(-1)!.r)).not.toContain(note);
      expect((await facts()).confirmed).toEqual([]);
      expect((await store.getExecution(raw.at(-1)!.r.requestId))!.decisionSource).toMatchObject({
        imageArchiveDirectory: true,
      });
      expect(pngReads).toBe(reads);
      const later = raw.length;
      step = 'list';
      expect(
        (
          await run(
            'detail',
            'Find the first archived batch and revisit its fourth original image.',
          )
        ).status,
      ).toBe('completed');
      const twice = raw[later]!.r.messages.find(
        (m) => m.role === 'user' && m.content.includes('archive directory retained'),
      )!.content;
      expect(twice).toBe(durable);
      expect(validated).toEqual([
        { summary, renderedSummary: durable },
        { summary, renderedSummary: twice },
      ]);
      expect(reported).toEqual(validated);
      expect(lookup?.executionId).toBe(origin.id);
      expect(raw.slice(later).flatMap((x) => pixels(x.r))).toEqual([originalPixels[3]!]);
      const rereadMsg = raw.at(-1)!.r.messages.find((m) => m.toolCallId === 'read-fourth')!;
      expect(JSON.parse(rereadMsg.content).imageAvailability).toMatchObject({
        locator: lookup,
        ordinals: [4],
        sourceCount: 4,
      });
      expect(opens).toBe(4);
    } finally {
      await runtime.close();
      removeTemporaryDirectory(root);
    }
  }, 60000);
