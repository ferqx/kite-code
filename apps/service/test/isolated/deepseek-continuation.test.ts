import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime, type ModelBodyReference } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createWebFetchExtension, type WebHop } from '@kite-ai/agent/web-fetch';
import { createCompatibleModelBinding } from '@kite-ai/ai/sdk';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import { createRunModelAdapters } from '../../src/authorization-check-model';
import { SessionExportPageSchema, schemas } from '../../src/http/schema';
import { modelInputResponse, modelOutputResponse } from '../../src/model-input-response';
import { providerConnectionId } from '../../src/model-providers';
import { TraceConsumerStore } from '../../src/trace-extensions/consumer-store';
import { engineDigest } from '../../src/trace-extensions/engine/assets';
import { createTrajectorySource } from '../../src/trajectory';

const providerModel = 'deepseek-v4-flash';
const modelId = 'research.flash';
const pageUrl = 'https://fixture.invalid/source';
const callId = 'owned-fetch-call';
const privateToken = 'PRIVATE_DS_FIXTURE_';
const privateFormat = 'deepseek-chat-reasoning-v1';
const firstReason = `  ${privateToken}first 🦊\n`;
const secondReason = `${privateToken}second 源 `;

type ChatMessage = {
  role: string;
  content: string | null;
  reasoning_content?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};
type ChatRequest = { model: string; messages: ChatMessage[]; reasoning_effort?: string };

function reply(index: number) {
  const frame = (delta: object, finish_reason: string | null = null) =>
    'data: ' +
    JSON.stringify({
      id: `fixture-reply-${index}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: providerModel,
      choices: [{ index: 0, delta, finish_reason }],
    }) +
    '\n\n';
  const reason = index === 0 ? firstReason : index === 1 ? secondReason : '';
  const content =
    index === 0
      ? 'I will read the source.'
      : index === 1
        ? 'The page is ready.'
        : 'The follow-up is complete.';
  return new Response(
    frame({ role: 'assistant' }) +
      (reason ? frame({ reasoning_content: reason }) : '') +
      frame({ content }) +
      (index === 0
        ? frame({
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: 'function',
                function: { name: 'web_fetch', arguments: JSON.stringify({ url: pageUrl }) },
              },
            ],
          })
        : '') +
      frame({}, index === 0 ? 'tool_calls' : 'stop') +
      'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

test('DeepSeek Chat uses private reasoning across one real web_fetch and a cold SQLite turn while public observers see only visible content', async () => {
  const root = temporaryDirectory('kite-deepseek-continuation-');
  const profile = { dataRoot: join(root, 'data'), profile: 'owned' };
  const requests: ChatRequest[] = [];
  const hops: WebHop[] = [];
  const fixtureKey = 'owned-fixture-key';
  const visibleDeltas: string[] = [];
  const trace = new TraceConsumerStore(join(root, 'trace.db'));
  const source = 'defineTraceExtension({onEvents(){}})';
  const traceId = trace.install(
    {
      apiVersion: 1,
      name: 'fixture-general-trace',
      history: true,
      eventKinds: ['model', 'tool'],
      evidenceKinds: [],
      origins: [],
      settings: {},
    },
    { apiVersion: 1, source, sha256: engineDigest(source) },
  );

  async function open() {
    const store = await openSqliteStore(profile);
    const expectedStoreId = (await store.getMetadata()).storeId;
    const scope = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
    const binding = createCompatibleModelBinding({
      name: 'deepseek',
      protocol: 'chat-completions',
      modelId: providerModel,
      baseURL: 'https://api.deepseek.com/v1',
      accountId: providerConnectionId({ provider: 'deepseek', providerName: 'research' }),
      apiKey: fixtureKey,
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = input instanceof Request ? input.url : String(input);
          expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
          expect(new Headers(init?.headers).get('authorization') === `Bearer ${fixtureKey}`).toBe(
            true,
          );
          const body = JSON.parse(String(init?.body)) as ChatRequest;
          const index = requests.push(body) - 1;
          if (index > 2) throw Error('unexpected_fixture_model_attempt');
          return reply(index);
        },
        {
          preconnect: () => {
            throw Error('unexpected_fixture_preconnect');
          },
        },
      ),
    });
    const { model } = createRunModelAdapters({
      modelId,
      models: new Map([[modelId, binding]]),
      preset: {},
      limitCheckOutput: true,
      supportsCheckReasoning: false,
    });
    const web = createWebFetchExtension({
      extractor: {
        async extract() {
          throw Error('unexpected_html');
        },
      },
      networkPort: {
        async request(hop, options) {
          expect(hop.url).toBe(
            hop.resource === 'robots' ? 'https://fixture.invalid/robots.txt' : pageUrl,
          );
          const facts = {
            addresses: [{ address: '192.0.2.8', family: 4 as const }],
            admissionRevision: 'owned',
          };
          hops.push(hop);
          await options.beforeConnect?.(facts);
          options.startTransport?.().throwIfAborted();
          return {
            ...facts,
            status: 200,
            contentType: 'text/plain',
            body: new Response(
              hop.resource === 'robots' ? 'User-agent: *\nAllow: /' : 'Fixture page text.',
            ).body!,
          };
        },
      },
    });
    const runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      model: {
        ...model,
        async *stream(request, options) {
          for await (const event of model.stream(request, options)) {
            if (event.type === 'text_delta' || event.type === 'reasoning_delta') {
              expect(event.text.includes(privateToken)).toBe(false);
              if (event.type === 'text_delta') visibleDeltas.push(event.text);
            }
            yield event;
          }
        },
      },
      modelId,
      permissions: { authorize: async () => ({ allowed: true, revision: 'owned' }) },
      extensions: [web],
    });
    async function run(commandId: string, content: string) {
      await runtime.submitCommand({ ...scope, commandId, request: { kind: 'run.start', content } });
      const command = await runtime.waitForCommand(commandId, { timeoutMs: 10000 });
      expect(command.status).toBe('applied');
      const runId = (command.receipt as { runId: string }).runId;
      expect(await runtime.getRun(runId)).toMatchObject({
        status: 'completed',
        originCommandId: commandId,
      });
    }
    return { store, runtime, scope, run };
  }

  let host = await open();
  try {
    const scope = host.scope;
    const route = { storeId: scope.expectedStoreId, sessionId: scope.sessionId };
    trace.authorize(traceId, {
      scopes: [route],
      eventKinds: ['model', 'tool'],
      evidenceKinds: [],
      origins: [],
      metadata: [],
      originalIdentity: false,
      allowHistory: true,
    });
    trace.enable(traceId);
    await host.runtime.createWorkspace({
      expectedStoreId: scope.expectedStoreId,
      id: 'w',
      name: 'fixture',
      rootUri: pathToFileURL(root).href,
    });
    await host.runtime.createSession({
      ...scope,
      commandId: 'create',
      workspaceId: 'w',
      title: 'Test',
    });
    await host.run('first', 'Read the specified fixture page.');
    expect(requests).toHaveLength(2);
    expect(hops.map((hop) => hop.resource)).toEqual(['robots', 'page']);
    const firstModels = await host.runtime.listModelInputs(scope);
    expect(firstModels.items).toHaveLength(2);
    const firstExecution = firstModels.items[0]!.executionId;
    const answerExecution = firstModels.items[1]!.executionId;
    const assertFetchHistory = (request: ChatRequest) => {
      const assistant = request.messages.find((m) => m.tool_calls?.some((c) => c.id === callId));
      expect(assistant?.content).toBe('I will read the source.');
      expect(assistant?.reasoning_content === firstReason).toBe(true);
      expect(assistant?.tool_calls).toEqual([
        {
          id: callId,
          type: 'function',
          function: { name: 'web_fetch', arguments: JSON.stringify({ url: pageUrl }) },
        },
      ]);
      expect(request.messages.filter((m) => m.tool_call_id === callId)).toHaveLength(1);
      expect(request.messages.find((m) => m.tool_call_id === callId)?.content).toContain(
        'Fixture page text.',
      );
    };
    assertFetchHistory(requests[1]!);
    await host.runtime.close();
    host = await open();
    expect(host.scope).toEqual(scope);
    expect(requests).toHaveLength(2);
    expect(hops).toHaveLength(2);
    await host.run(
      'second',
      'New task: summarize the previous answer without reading the page again.',
    );
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.model).toBe(providerModel);
      expect(request).not.toHaveProperty('reasoning_effort');
      expect(
        request.messages
          .filter((m) => m.role !== 'assistant')
          .some((m) => m.reasoning_content !== undefined),
      ).toBe(false);
    }
    assertFetchHistory(requests[2]!);
    expect(
      requests[2]!.messages.filter((m) => m.role === 'assistant').map((m) => m.content),
    ).toEqual(['I will read the source.', 'The page is ready.']);
    expect(
      requests[2]!.messages.find((m) => m.content === 'The page is ready.')?.reasoning_content ===
        secondReason,
    ).toBe(true);
    expect(visibleDeltas.join('')).toBe(
      'I will read the source.The page is ready.The follow-up is complete.',
    );
    const signal = new AbortController().signal;
    const allModels = await host.runtime.listModelInputs(scope);
    expect(allModels.items.map((item) => item.executionId).slice(0, 2)).toEqual([
      firstExecution,
      answerExecution,
    ]);
    expect(allModels.items).toHaveLength(3);
    for (const { executionId } of allModels.items) {
      if (executionId !== firstExecution) {
        const stored = await host.store.getExecution(executionId);
        const intent = stored!.input as { body?: ModelBodyReference };
        expect(intent.body).toMatchObject({
          kind: 'model_body',
          version: 1,
          reference: {
            storeId: scope.expectedStoreId,
            sessionId: scope.sessionId,
            subjectId: scope.subjectId,
            scope: { kind: 'session', id: scope.sessionId },
          },
        });
        expect(Number(intent.body!.reference.size)).toBeGreaterThan(0);
        expect(Number(intent.body!.reference.size)).toBeLessThan(64 * 1024);
        const row = JSON.stringify(stored);
        expect(row.includes(privateToken) || row.includes(privateFormat)).toBe(false);
      }
      const input = await host.runtime.readModelInput({ ...scope, executionId });
      const output = await host.runtime.readModelOutput({ ...scope, executionId });
      expect((await modelInputResponse(input, signal).text()).includes(privateToken)).toBe(false);
      expect((await modelOutputResponse(output, signal).text()).includes(privateToken)).toBe(false);
      expect(output.output.reasoning).toBe('');
      expect(input.request.messages.some((m) => Object.hasOwn(m, 'continuation'))).toBe(false);
      if (executionId === allModels.items[2]!.executionId) {
        const prior = input.request.messages.filter((m) => m.role === 'assistant');
        expect(prior.map((m) => m.sourceIds)).toEqual([[firstExecution], [answerExecution]]);
      }
    }
    expect(
      JSON.stringify(await host.runtime.listMessages(scope.sessionId)).includes(privateToken),
    ).toBe(false);
    let after = '0',
      changes = 0;
    for (;;) {
      const page = await host.runtime.getChanges({
        after,
        limit: 100,
        sessionIds: [scope.sessionId],
      });
      for (const change of page.events) {
        expect(JSON.stringify(schemas.Change.parse(change)).includes(privateToken)).toBe(false);
        after = change.cursor;
        changes++;
      }
      if (page.events.length < 100) break;
    }
    expect(changes).toBeGreaterThan(0);
    const manifest = await host.runtime.beginSessionExport(scope);
    const exportedExecutions = new Set<string>();
    for (const { section } of manifest.sections) {
      let afterSeq: string | undefined;
      do {
        const page = SessionExportPageSchema.parse(
          await host.runtime.readSessionExportPage({
            ...scope,
            manifest,
            section,
            afterSeq,
          }),
        );
        const exported = JSON.stringify(page);
        expect(exported.includes(privateToken) || exported.includes(privateFormat)).toBe(false);
        if (section === 'executions')
          for (const record of page.records) exportedExecutions.add(record.id);
        afterSeq = page.nextAfterSeq ?? undefined;
      } while (afterSeq);
    }
    expect(allModels.items.every(({ executionId }) => exportedExecutions.has(executionId))).toBe(
      true,
    );
    expect((await host.runtime.verifySessionExport({ ...scope, manifest })).verified).toBe(true);
    const trajectory = createTrajectorySource(host.store);
    const snapshot = await trajectory.open(
      { ...route, subjectId: scope.subjectId, eventKinds: ['model', 'tool'] },
      { signal },
    );
    const partition = trace.createPartition(
      traceId,
      route,
      ['model', 'tool'],
      snapshot.upperCursor,
      { exportId: 'history', fromCursor: '0' },
    );
    const generation = trace.nextGeneration(traceId);
    let queued = 0;
    for (;;) {
      const page = await trajectory.readEvents(
        { ...trace.requestFor(partition), subjectId: scope.subjectId },
        { signal },
      );
      const stored = trace.enqueuePage(partition, page);
      expect(stored.accepted).toBe(true);
      queued += stored.queued;
      if (page.exhausted) break;
    }
    const batch = trace.lease(partition, generation);
    expect(batch?.events.length).toBe(queued);
    expect(batch?.events.some((e) => e.kind === 'model' && e.phase === 'completed')).toBe(true);
    expect(batch?.events.some((e) => e.kind === 'tool' && e.phase === 'completed')).toBe(true);
    expect(JSON.stringify(batch).includes(privateToken)).toBe(false);
    expect(
      hops.every(
        (hop) => hop.originStoreId === scope.expectedStoreId && hop.sessionId === scope.sessionId,
      ),
    ).toBe(true);
    const view = await host.store.getView(scope.sessionId);
    const toolExecutions = view.executions.filter((e) => e.kind === 'tool');
    expect(toolExecutions).toHaveLength(1);
    expect(toolExecutions[0]).toMatchObject({
      id: hops[1]!.executionId,
      callId,
      status: 'succeeded',
    });
    expect(hops).toHaveLength(2);
    expect(requests).toHaveLength(3);
  } finally {
    await host.runtime.close();
    trace.close();
    removeTemporaryDirectory(root);
  }
}, 30000);
