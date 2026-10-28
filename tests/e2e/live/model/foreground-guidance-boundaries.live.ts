import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { createSummaryCompressor } from '@kite-ai/service/configuration';
import { NativeCallerJournal } from '../../../../apps/desktop/electron/caller-journal';
import { NativeInputQueue } from '../../../../apps/desktop/electron/native-input-queue';
import { memoryPrivateData } from '../../../../apps/desktop/test/private-data.fixture';
import { agentContractSource } from '../../../../packages/agent/src/model-context';
import { temporaryDirectory } from '../../../fixtures/test-filesystem';
import { createLiveModelFixture } from './live-model-fixture';

if (process.env.KITE_RUN_LIVE_COLLABORATION !== '1') throw Error('live_opt_in_required');
const output = resolve(process.argv[2] ?? 'dist/acceptance/foreground-guidance-boundaries');
mkdirSync(output, { recursive: true });
const live = await createLiveModelFixture({
  requestLimit: 30,
  timeoutMs: 600_000,
  captureWireRequests: true,
});
const summary = (request: ModelRequest) =>
  request.tools.length === 0 &&
  request.messages.some((message) =>
    message.content.startsWith('Summarize the preceding recorded conversation'),
  );
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function until(check: () => boolean, signal: AbortSignal) {
  while (!check()) {
    signal.throwIfAborted();
    await Bun.sleep(20);
  }
}
const results: unknown[] = [];
for (const scenario of [
  'continue-tools',
  'before-automatic-compression',
  'during-automatic-compression',
] as const) {
  const root = temporaryDirectory('kite-live-guidance-boundary-');
  const profile = { dataRoot: join(root, 'data'), profile: 'live' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const reads = gate(),
    summaryGate = gate();
  const events: { event: string; at: number; requestId?: string; text?: string; part?: number }[] =
    [];
  const requests: ModelRequest[] = [];
  const streamEvents: { requestId: string; event: ModelEvent }[] = [];
  const effects: { part: number; finished?: number; started: number; aborted?: boolean }[] = [];
  let summaryEntered = false,
    summaryHeld = false,
    verified = 0;
  const model: ModelAdapter = {
    async *stream(request, options) {
      requests.push(structuredClone(request));
      const compressing = summary(request);
      events.push({
        event: compressing ? 'summary_started' : 'model_started',
        at: Date.now(),
        requestId: request.requestId,
      });
      for await (const event of live.model.stream(request, options)) {
        streamEvents.push({ requestId: request.requestId, event: structuredClone(event) });
        if (
          compressing &&
          scenario === 'during-automatic-compression' &&
          !summaryHeld &&
          event.type === 'text_delta'
        ) {
          summaryHeld = true;
          summaryEntered = true;
          events.push({
            event: 'actual_summary_delta_held',
            at: Date.now(),
            requestId: request.requestId,
          });
          await summaryGate.promise;
        }
        yield event;
      }
      events.push({
        event: compressing ? 'summary_finished' : 'model_finished',
        at: Date.now(),
        requestId: request.requestId,
      });
    },
  };
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model,
    modelId: live.modelId,
    sources: {
      async capture() {
        return [agentContractSource(root)];
      },
    },
    ...(scenario === 'continue-tools'
      ? {}
      : { compressor: createSummaryCompressor({ automatic: { thresholdTokens: 7000 } }) }),
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.read_section',
            version: '1',
            description:
              'Read a synthetic report section exactly once. Sections are independent and read-only.',
            inputSchema: {
              type: 'object',
              properties: { part: { type: 'integer', enum: [1, 2, 3] } },
              required: ['part'],
              additionalProperties: false,
            },
            async execute(input, context) {
              const part = (input as { part: number }).part;
              const effect = { part, started: Date.now() } as (typeof effects)[number];
              effects.push(effect);
              events.push({ event: 'read_started', at: Date.now(), part });
              await reads.promise;
              effect.aborted = context.signal.aborted;
              context.signal.throwIfAborted();
              effect.finished = Date.now();
              events.push({ event: 'read_finished', at: Date.now(), part });
              const material =
                scenario === 'continue-tools'
                  ? ''
                  : Array.from(
                      { length: 650 },
                      (_, index) =>
                        `Record ${part}-${index}: archived independent inspection log; this row adds no pending action, permission, or requirement.\n`,
                    ).join('');
              return {
                outcome: 'succeeded',
                content: `Section ${part}: completed ${[0, 12, 8, 10][part]} checks; pending ${[0, 0, 2, 1][part]} reviews.\n${material}\nEnd of section ${part}; use the exact aggregate facts above and do not repeat this read.`,
              };
            },
          },
          {
            id: 'fixture.verify_report',
            version: '1',
            description:
              'After all three report sections have been read, independently verify the aggregate and obtain its final confirmation code. Required to finish the report; never call before reading all sections.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            async execute() {
              assert.deepEqual(
                effects
                  .filter((effect) => effect.finished)
                  .map((effect) => effect.part)
                  .sort(),
                [1, 2, 3],
              );
              verified++;
              events.push({ event: 'verification_tool', at: Date.now() });
              return {
                outcome: 'succeeded',
                content:
                  'Independent verification: 30 completed checks, 3 pending reviews. Final confirmation code: REVIEW-30-3-CEDAR. Report this actual confirmation with the summary.',
              };
            },
          },
        ],
      },
    ],
  });
  const service = await startService({
    runtime,
    profile: { dataRoot: profile.dataRoot, name: profile.profile, accessKey: 'guidance-boundary' },
    subjectId: 'owner',
    buildId: 'private-guidance-boundary',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['commands', 'inputs', 'pending_input_queue'],
    },
  });
  let failure: unknown;
  try {
    await client.connect();
    await client.createWorkspace({
      expectedStoreId,
      id: 'workspace',
      rootUri: pathToFileURL(root).href,
      name: 'synthetic',
    });
    await client.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 'root',
      workspaceId: 'workspace',
      title: scenario,
    });
    await client.startRun('root', {
      expectedStoreId,
      commandId: 'original',
      kind: 'run.start',
      content:
        '请先读取三份独立报告章节 part 1、2、3（允许同一批次并行），然后必须调用 verify_report 独立核实总数并取得确认码，最后用中文给出简短报告及真实确认码。每个章节只读取一次，不要将尚未核实的结果当作完成。',
    });
    await until(() => effects.length > 0, live.signal);
    const view = await client.getView('root');
    const run = view.runs.find((run) => run.isActive)!;
    const body =
      '现在进度怎样？请先直接回答我目前完成到哪一步，然后继续原任务、完成尚未进行的独立核实和最终报告。';
    const data = memoryPrivateData();
    const journal = new NativeCallerJournal(client, data);
    const scope = {
      generation: 1,
      viewSelection: 1,
      historyEpoch: 0,
      storeId: expectedStoreId,
      sessionId: 'root',
      workspaceId: 'workspace',
      subjectId: 'owner',
    };
    const queue = new NativeInputQueue(
      client,
      () => scope,
      () => data,
      () => {},
    );
    const guide = async () => {
      await journal.prepare('root', {
        expectedStoreId,
        commandId: 'queued-question',
        kind: 'input.follow_up',
        content: body,
        afterRunId: run.id,
        contextSelectionId: view.session.contextSelectionId!,
        modelId: live.modelId,
      });
      await journal.submit('queued-question');
      events.push({ event: 'question_queued', at: Date.now() });
      const observed = await queue.read({
        method: 'input.queue.read',
        generation: 1,
        viewSelection: 1,
        historyEpoch: 0,
        readId: 'guide',
      });
      const prepared = await queue.prepareSteer({
        method: 'input.queue.steer',
        generation: 1,
        observationId: observed.observationId,
        targetCommandId: 'queued-question',
      });
      await journal.prepare('root', prepared.intent);
      await journal.submit(prepared.intent.commandId);
      events.push({ event: 'guidance_accepted', at: Date.now(), text: prepared.intent.commandId });
      return prepared.intent.commandId;
    };
    let guideId: string;
    if (scenario === 'during-automatic-compression') {
      reads.release();
      await until(() => summaryEntered, live.signal);
      guideId = await guide();
      summaryGate.release();
    } else {
      guideId = await guide();
      reads.release();
    }
    await runtime.waitForCommand('original', { timeoutMs: 180_000, signal: live.signal });
    const finalView = await client.getView('root');
    assert.equal(finalView.runs.length, 1);
    assert.equal(finalView.runs[0]!.status, 'completed');
    assert.deepEqual(effects.map((effect) => effect.part).sort(), [1, 2, 3]);
    assert.ok(effects.every((effect) => effect.finished && !effect.aborted));
    assert.equal(verified, 1);
    const guided = requests.filter(
      (request) =>
        !summary(request) &&
        request.messages.some((message) => message.sourceIds?.includes(guideId)),
    );
    assert.ok(guided.length >= 2, 'guidance must precede more tools and a later final response');
    for (const request of guided)
      assert.equal(
        request.messages.filter(
          (message) => message.role === 'user' && message.sourceIds?.includes('original'),
        ).length,
        1,
      );
    for (const request of guided)
      assert.equal(
        request.messages.filter(
          (message) =>
            message.role === 'user' &&
            message.content === body &&
            message.sourceIds?.includes(guideId),
        ).length,
        1,
      );
    const responseEvents = streamEvents
      .filter((item) => item.requestId === guided[0]!.requestId)
      .map((item) => item.event);
    const textIndex = responseEvents.findIndex(
      (event) => event.type === 'text_delta' && event.text.trim(),
    );
    const toolIndex = responseEvents.findIndex((event) => event.type === 'tool_call');
    assert.ok(
      textIndex >= 0 && toolIndex > textIndex,
      'actual model must answer before continuing tools',
    );
    const context = await store.getModelContext({
      expectedStoreId,
      sessionId: 'root',
      messageLimit: 1,
      sourceLimit: 1,
    });
    if (scenario !== 'continue-tools') assert.equal(context.compression?.trigger, 'automatic');
    if (scenario === 'during-automatic-compression') {
      const summaries = requests.filter(summary);
      assert.ok(summaries.length >= 2, 'old summary must not publish over the accepted guide');
      assert.notEqual(context.compression?.modelExecutionId, summaries[0]!.requestId);
      for (const request of requests.slice(requests.indexOf(summaries[0]!) + 1))
        assert.ok(
          !request.messages.some((message) => message.sourceIds?.includes(summaries[0]!.requestId)),
          'unpublished summary cannot enter the next request',
        );
    }
    const coldBefore = requests.length;
    await client.listMessages('root');
    await client.getView('root');
    assert.equal(requests.length, coldBefore);
    const record = {
      scenario,
      status: 'mechanical_passed_semantic_review_required',
      model: live.metadata,
      effects,
      events,
      guideId,
      requests,
      streamEvents,
      context,
      messages: await client.listMessages('root'),
      verificationCalls: verified,
    };
    writeFileSync(join(output, `${scenario}.json`), JSON.stringify(record, null, 2));
    results.push({
      scenario,
      status: record.status,
      requests: requests.length,
      summaries: requests.filter(summary).length,
    });
    console.log(JSON.stringify(results.at(-1)));
    await queue.close();
  } catch (error) {
    failure = error;
    writeFileSync(
      join(output, `${scenario}-failed.json`),
      JSON.stringify(
        { scenario, error: String(error), events, effects, requests, streamEvents },
        null,
        2,
      ),
    );
    console.error(scenario, String(error));
  } finally {
    reads.release();
    summaryGate.release();
    client.disposeNetwork();
    await service.close();
  }
  if (failure) {
    process.exitCode = 1;
    break;
  }
}
writeFileSync(
  join(output, 'summary.json'),
  JSON.stringify({ results, wire: live.wire, model: live.metadata }, null, 2),
);
