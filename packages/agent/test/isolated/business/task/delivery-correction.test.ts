import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../../src/artifacts';
import { createTaskExtension } from '../../../../src/extensions/task';
import { createFileTools, createWorkspaceFiles } from '../../../../src/files';
import { agentContractSource } from '../../../../src/model-context';
import { createRuntime } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string, input: unknown): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { ...finish, reason: 'tool_calls' },
];
const stop = (text: string): ModelEvent[] => [{ type: 'text_delta', text }, finish];
function feedback(request: ModelRequest) {
  const content = request.messages.filter((m) => m.role === 'tool').at(-1)!.content;
  if (!content.startsWith('Read ')) return JSON.parse(content);
  const match = /\nContent \((\d+) UTF-8 bytes; starts on next line\):\n/.exec(content)!;
  const body = content.slice(match.index + match[0].length);
  expect(Buffer.byteLength(body)).toBe(Number(match[1]));
  return { content: body, baseline: JSON.parse(/^baseline=(.*)$/m.exec(content)![1]!) };
}

// The Provider decisions below are controlled. Actual Runtime, SQLite, native Files,
// mailbox, authorization and HTTP effects prove the available correction path, not LLM judgment.
for (const scenario of ['correctable', 'complete', 'denied', 'unknown'] as const)
  test(`delivery feedback ${scenario}: preserve original effects and ordinary stop boundaries`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-delivery-correction-')));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const source = 'opaque-source-α-b44f-1053😀\n';
    writeFileSync(join(workspace, 'source.txt'), source);
    const target = join(workspace, 'delivery.json');
    const methods: string[] = [];
    const response = 'original-service-response';
    const service = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        methods.push(request.method);
        return new Response(response);
      },
    });
    const expected = JSON.stringify({ source: source.slice(0, -1), service: response });
    const wrong = JSON.stringify({
      source: 'opaque-source-α-bb44f1053😀',
      service_response: response,
    });
    const assignment =
      'Read source.txt and GET the registered service exactly once. Save delivery.json with exactly the keys source and service; source is its complete original text with only the final newline removed. Do not delegate. Do not retry denied or unknown effects.';
    const correction = `Correct only delivery.json: use the exact keys source and service and the original source text with only its final newline removed. Its current source and service_response key are wrong. The GET already succeeded exactly once; preserve that result and do not request the service again. Read the existing file for its real baseline, replace the report, then read it back. No other work is requested.`;
    const profile = { dataRoot: join(root, 'data'), profile: 'test' };
    const store = await openSqliteStore(profile);
    const storeId = (await store.getMetadata()).storeId;
    const files = createWorkspaceFiles({ root: workspace });
    const artifacts = createArtifactStore({ profile, store });
    const parentRequests: ModelRequest[] = [],
      childRequests: ModelRequest[] = [];
    let childId = '',
      cursor = '0',
      firstCarrierId = '',
      firstRun = '';
    let getCalls = 0,
      writeCalls = 0,
      parentStep = 0,
      childStep = 0;
    let releaseCorrection!: () => void;
    const correctionGate = new Promise<void>((resolve) => {
      releaseCorrection = resolve;
    });
    const nativeTools = createFileTools(files).map((tool) =>
      tool.id !== 'files.write'
        ? tool
        : {
            ...tool,
            async execute(
              input: Parameters<typeof tool.execute>[0],
              context: Parameters<typeof tool.execute>[1],
            ) {
              writeCalls++;
              const result = await tool.execute(input, context);
              return scenario === 'unknown' && result.outcome === 'succeeded'
                ? {
                    outcome: 'outcome_unknown' as const,
                    content:
                      'Publication may have occurred; its outcome could not be confirmed. Do not repeat the write.',
                    details: { code: 'file_publish_outcome_unknown' },
                  }
                : result;
            },
          },
    );
    const child: ModelAdapter = {
      async *stream(request) {
        childRequests.push(structuredClone(request));
        let events: ModelEvent[];
        switch (childStep++) {
          case 0:
            expect(
              request.messages.some((m) => m.role === 'user' && m.content === assignment),
            ).toBe(true);
            events = call('read_file', { path: 'source.txt' });
            break;
          case 1:
            expect(feedback(request).content).toBe(source);
            events = call('read_service', {});
            break;
          case 2:
            expect(feedback(request).body).toBe(response);
            events = call('write_file', {
              path: 'delivery.json',
              base: null,
              content: scenario === 'complete' ? expected : wrong,
            });
            break;
          case 3: {
            const original = request.messages.filter((m) => m.role === 'tool').at(-1)!.content;
            if (scenario === 'denied') {
              expect(original).toContain('The current permissions do not allow this request');
              expect(original).toContain('This request was not executed');
            }
            if (scenario === 'unknown') expect(original).toContain('unknown');
            events = stop(
              scenario === 'denied'
                ? 'The delivery was denied; do not bypass it.'
                : scenario === 'unknown'
                  ? 'The delivery outcome is unknown; no repeat was attempted.'
                  : 'The requested delivery is complete.',
            );
            break;
          }
          case 4:
            expect(
              request.messages.some((m) => m.role === 'user' && m.content === correction),
            ).toBe(true);
            expect(methods).toEqual(['GET']);
            await correctionGate;
            events = call('read_file', { path: 'delivery.json' });
            break;
          case 5:
            expect(feedback(request).content).toBe(wrong);
            events = call('write_file', {
              path: 'delivery.json',
              base: feedback(request).baseline,
              content: expected,
            });
            break;
          case 6:
            events = call('read_file', { path: 'delivery.json' });
            break;
          default:
            expect(feedback(request).content).toBe(expected);
            events = stop(
              'The original delivery target now has the exact required source and service; the original GET was not repeated.',
            );
        }
        for (const event of events) yield event;
      },
    };
    const parent: ModelAdapter = {
      async *stream(request) {
        parentRequests.push(structuredClone(request));
        let events: ModelEvent[];
        const body = parentStep ? feedback(request) : null;
        switch (parentStep++) {
          case 0:
            events = call('spawn_agent', { prompt: assignment });
            break;
          case 1:
            childId = body.agent_id;
            events = call('wait_agent_events', { wait_ms: 10000 });
            break;
          case 2: {
            cursor = body.next_seq;
            const first = (await store.listExecutions('root')).find(
              (e) => e.childSessionId === childId,
            )!;
            expect(first.status).toBe(scenario === 'unknown' ? 'outcome_unknown' : 'succeeded');
            firstCarrierId = first.id;
            firstRun = (first.result as { details: { runId?: string } }).details.runId ?? '';
            const input = request.messages.map((m) => m.content).join('\n');
            if (scenario !== 'unknown') {
              expect(input).toContain('reportVerification');
              expect(input).toContain('not_verified');
            }
            if (scenario === 'denied' || scenario === 'unknown') {
              expect(input).toContain(scenario === 'denied' ? 'denied' : 'unknown');
              events = stop(
                scenario === 'denied'
                  ? 'Delivery remains blocked by the actual denial; the successful GET was not repeated.'
                  : 'Delivery remains unverified because publication is unknown; no retry or fallback was attempted.',
              );
            } else events = call('read_file', { path: 'delivery.json' });
            break;
          }
          case 3:
            if (scenario === 'complete') {
              expect(feedback(request).content).toBe(expected);
              events = stop(
                'The exact original target and required content were read back and verified.',
              );
            } else {
              expect(feedback(request).content).toBe(wrong);
              // A message to an idle child does not initiate correction.
              events = call('send_agent_message', {
                agent_id: childId,
                content: 'A correction is needed; wait for the explicit follow-up.',
              });
            }
            break;
          case 4:
            expect(
              (await store.listExecutions('root')).filter((e) => e.childSessionId),
            ).toHaveLength(1);
            expect(childRequests).toHaveLength(4);
            events = call('follow_up_agent', { agent_id: childId, content: correction });
            break;
          case 5:
            expect(body).toMatchObject({ accepted: true, agent_id: childId, mode: 'new_turn' });
            events = call('list_agents', { agent_ids: [childId] });
            break;
          case 6:
            expect(body.items[0]).toMatchObject({
              agent_id: childId,
              current_work_source: { content: correction },
            });
            expect(body.items[0].state).not.toBe('idle');
            expect(body.items[0].last_result_source.content).toBe(
              'The requested delivery is complete.',
            );
            // The earlier successful carrier is still an old result, not this pending correction.
            expect((await store.getExecution(firstCarrierId))?.status).toBe('succeeded');
            releaseCorrection();
            events = call('wait_agent_events', { after_seq: cursor, wait_ms: 10000 });
            break;
          case 7: {
            const carriers = (await store.listExecutions('root')).filter((e) => e.childSessionId);
            expect(carriers).toHaveLength(2);
            expect(carriers.every((e) => e.childSessionId === childId)).toBe(true);
            const next = carriers.find((e) => e.id !== firstCarrierId)!;
            expect(next.status).toBe('succeeded');
            expect((next.result as { details: { runId: string } }).details.runId).not.toBe(
              firstRun,
            );
            events = call('read_file', { path: 'delivery.json' });
            break;
          }
          default:
            expect(feedback(request).content).toBe(expected);
            events = stop(
              'The original report was corrected by the same child and read back. The source and exact service key match the original request; the GET occurred once.',
            );
        }
        for (const event of events) yield event;
      },
    };
    const sources = { capture: async () => [agentContractSource(workspace)] };
    const runtime = createRuntime({
      store,
      artifacts,
      model: parent,
      modelId: 'parent',
      modelConcurrency: 2,
      sources,
      extensions: [
        { id: 'builtin.files', version: '1', apiMajor: 1, tools: nativeTools },
        {
          id: 'fixture.service',
          version: '1',
          apiMajor: 1,
          tools: [
            {
              id: 'fixture.service.get',
              version: '1',
              model: { name: 'read_service' },
              description: 'GET the single registered owned service.',
              inputSchema: { type: 'object', additionalProperties: false },
              async execute() {
                getCalls++;
                return {
                  outcome: 'succeeded',
                  content: JSON.stringify({ body: await (await fetch(service.url)).text() }),
                };
              },
            },
          ],
        },
        createTaskExtension({
          roles: [
            {
              id: 'worker',
              configurationId: 'worker',
              description: 'Complete the exact report without repeating successful effects.',
            },
          ],
        }),
      ],
      permissions: {
        async authorize(request) {
          return scenario === 'denied' &&
            request.kind === 'tool' &&
            request.definitionId === 'files.write'
            ? { allowed: false, reason: 'fixture_write_denied', revision: 'controlled' }
            : { allowed: true, revision: 'controlled' };
        },
      },
      childConfigurations: [
        {
          id: 'worker',
          version: '1',
          model: child,
          modelId: 'child',
          sources,
          toolIds: ['files.read', 'files.write', 'fixture.service.get'],
          snapshot: {},
        },
      ],
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId: storeId,
        id: 'w',
        name: 'owned',
        rootUri: pathToFileURL(workspace).href,
      });
      await runtime.createSession({
        expectedStoreId: storeId,
        sessionId: 'root',
        commandId: 'create',
        workspaceId: 'w',
        subjectId: 'owner',
        title: 'delivery correction',
      });
      await runtime.submitCommand({
        expectedStoreId: storeId,
        sessionId: 'root',
        commandId: 'work',
        subjectId: 'owner',
        request: {
          kind: 'run.start',
          content: `Delegate exactly one child. ${assignment} Parent verifies the original delivery and only follows up on concrete safe remaining work.`,
        },
      });
      await runtime.waitForCommand('work', { timeoutMs: 15000 });
      expect((await store.getView('root')).runs.every((run) => run.status === 'completed')).toBe(
        true,
      );
      const executions = await store.listExecutions('root');
      expect(executions.filter((e) => e.definitionId === 'task.spawn')).toHaveLength(1);
      expect(executions.filter((e) => e.definitionId === 'task.follow_up')).toHaveLength(
        scenario === 'correctable' ? 1 : 0,
      );
      expect(getCalls).toBe(1);
      expect(methods).toEqual(['GET']);
      expect(writeCalls).toBe(scenario === 'denied' ? 0 : scenario === 'correctable' ? 2 : 1);
      if (scenario === 'denied') {
        const denied = (await store.listExecutions(childId)).find(
          (execution) => execution.definitionId === 'files.write',
        )!;
        expect(denied).toMatchObject({
          status: 'failed',
          authorization: { dispatched: false },
          result: {
            details: {
              code: 'permission_denied',
              reason: 'fixture_write_denied',
              adapterAttempted: false,
            },
          },
        });
        const received = childRequests[3]!.messages.find(
          (message) => message.toolCallId === denied.callId,
        )!;
        expect(received.sourceIds).toEqual([denied.id]);
      }
      expect(existsSync(target)).toBe(scenario !== 'denied');
      if (scenario !== 'denied')
        expect(readFileSync(target, 'utf8')).toBe(scenario === 'unknown' ? wrong : expected);
      expect(
        parentRequests.every((q) =>
          q.messages.some((m) => m.sourceIds?.includes('agent:contract')),
        ),
      ).toBe(true);
      expect(
        childRequests.every((q) => q.messages.some((m) => m.sourceIds?.includes('agent:contract'))),
      ).toBe(true);
      expect(readFileSync(join(workspace, 'source.txt'), 'utf8')).toBe(source);
    } finally {
      releaseCorrection();
      await runtime.close();
      await artifacts.close();
      await files.close();
      await store.close();
      service.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
