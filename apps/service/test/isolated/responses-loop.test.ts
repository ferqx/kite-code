import { expect, test } from 'bun:test';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import type { Permissions, ToolDefinition } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import { type AgentClient, createClient } from '@kite-ai/client';
import { startService } from '../../src';
import { encodeFrames, responseFrames, type WireTurn } from '../fixtures/responses-wire';

type Item = Record<string, unknown>;
interface Body extends Item {
  input: Item[];
  model: string;
}
interface WireRecord {
  path: string;
  request: Body;
  response: Item[] | { status: number };
  effectsAtRequest: number;
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() >= deadline) throw new Error('responses_loop_deadline');
    await Bun.sleep(5);
  }
}
function saveEvidence(name: string, evidence: unknown) {
  const directory = process.env.KITE_RESPONSES_EVIDENCE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${name}.json`), JSON.stringify(evidence, null, 2));
}
function endpoint(
  respond: (body: Body, index: number) => WireTurn | { status: number; hold?: never },
  effects = () => 0,
  held?: ReturnType<typeof barrier>,
) {
  const records: WireRecord[] = [];
  const errors: string[] = [];
  const entered = barrier();
  let abortedRequests = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      request.signal.addEventListener(
        'abort',
        () => {
          abortedRequests++;
        },
        { once: true },
      );
      const body = (await request.json()) as Body;
      const path = new URL(request.url).pathname;
      try {
        expect(request.method).toBe('POST');
        expect(path).toBe('/v1/responses');
        expect(request.headers.get('authorization')).toBeNull();
        expect(body).toMatchObject({
          stream: true,
          store: false,
          include: ['reasoning.encrypted_content'],
        });
        expect(body.messages).toBeUndefined();
        expect(body.previous_response_id).toBeUndefined();
        const names = [
          ...(body.tools as Item[]).map((tool) => tool.name),
          ...body.input.filter((item) => item.type === 'function_call').map((item) => item.name),
        ];
        expect(
          names.every((name) => typeof name === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(name)),
        ).toBe(true);
        const turn = respond(body, records.length);
        const response =
          'status' in turn ? turn : responseFrames({ ...turn, model: body.model }, body);
        records.push({ path, request: body, response, effectsAtRequest: effects() });
        entered.release();
        if ('status' in turn)
          return Response.json(
            { error: { message: 'local fixture rejection' } },
            { status: turn.status },
          );
        const bytes = new TextEncoder().encode(encodeFrames(response as Item[]));
        return new Response(
          new ReadableStream({
            async start(controller) {
              try {
                // Source byte chunks split JSON/SSE fields; HTTP may coalesce them independently of event deltas.
                for (let offset = 0; offset < bytes.length; offset += 137)
                  controller.enqueue(bytes.slice(offset, offset + 137));
                if (held) await held.promise;
                controller.close();
              } catch {
                /* Expected if the original HTTP request was cancelled. */
              }
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      } catch (error) {
        errors.push(String(error));
        records.push({
          path,
          request: body,
          response: { status: 400 },
          effectsAtRequest: effects(),
        });
        entered.release();
        return Response.json(
          { error: { message: 'wire fixture rejected invalid next request' } },
          { status: 400 },
        );
      }
    },
  });
  return {
    records,
    errors,
    entered,
    get abortedRequests() {
      return abortedRequests;
    },
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    close() {
      held?.release();
      server.stop(true);
    },
  };
}
function binding(
  baseURL: string,
  modelId = 'gpt-5',
  protocol: 'responses' | 'chat-completions' = 'responses',
) {
  return createSdkModelAdapter({
    models: new Map([
      [
        'bound',
        createCompatibleModelBinding({
          protocol,
          name: 'openai',
          modelId,
          baseURL,
        }),
      ],
    ]),
  });
}
async function fixture(
  baseURL: string,
  options: {
    root?: string;
    modelId?: string;
    protocol?: 'responses' | 'chat-completions';
    tools?: ToolDefinition[];
    permissions?: Permissions;
  } = {},
) {
  const root = options.root ?? realpathSync(mkdtempSync(join(tmpdir(), 'kite-responses-loop-')));
  const selected = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  const profile = { dataRoot: selected.dataRoot, profile: selected.profile };
  const store = await openSqliteStore(profile);
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    model: binding(baseURL, options.modelId, options.protocol),
    modelId: 'bound',
    permissions: options.permissions ?? {
      authorize: async () => ({ allowed: true, revision: 'local-test-only' }),
    },
    extensions: [{ id: 'fixture', version: '1', apiMajor: 1, tools: options.tools ?? [] }],
  });
  const service = await startService({
    runtime,
    profile: {
      dataRoot: selected.dataRoot,
      name: selected.profile,
      accessKey: selected.profileAccessKey,
    },
    buildId: 'responses-loop-test',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: service.bootstrap.profile,
      apiMajor: 1,
      requiredCapabilities: ['commands', 'history', 'model_inputs', 'model_outputs'],
    },
  });
  await client.connect();
  const storeId = (await store.getMetadata()).storeId;
  if (!options.root) {
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'Local Responses fixture',
      rootUri: pathToFileURL(root).href,
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'Responses',
    });
  }
  return {
    root,
    storeId,
    store,
    runtime,
    client,
    async close(remove = true) {
      client.disposeNetwork();
      await service.close();
      if (remove) rmSync(root, { recursive: true, force: true });
    },
  };
}
async function start(
  f: Awaited<ReturnType<typeof fixture>>,
  commandId = 'work',
  sessionId = 's',
  content = `Execute local fixture ${commandId}`,
) {
  return f.client.startRun(sessionId, {
    expectedStoreId: f.storeId,
    commandId,
    kind: 'run.start',
    content,
  });
}
async function finished(client: AgentClient, commandId = 'work', sessionId = 's') {
  const completed = await until(
    async () => ({
      command: await client.getCommand(commandId),
      view: await client.getView(sessionId),
    }),
    ({ command, view }) => {
      const receipt = command.receipt as { runId?: string } | null;
      return (
        command.status === 'applied' &&
        typeof receipt?.runId === 'string' &&
        view.runs.some((run) => run.id === receipt.runId && !run.isActive)
      );
    },
  );
  const receipt = completed.command.receipt as { runId: string; businessCommandId?: string };
  const commandRun = completed.view.runs.find((run) => run.id === receipt.runId)!;
  expect(commandRun.originCommandId).toBe(receipt.businessCommandId ?? commandId);
  return { ...completed.view, commandRun };
}

function call(id: string, name = 'fixture.record', args: Item = { label: id, value: 1 }) {
  return { id, name: name.replaceAll('.', '_'), arguments: JSON.stringify(args) };
}
function tool(
  counter: { effects: number },
  outcome: 'succeeded' | 'outcome_unknown' = 'succeeded',
): ToolDefinition {
  return {
    id: 'fixture.record',
    version: '1',
    description: 'Disposable local effect counter',
    inputSchema: {
      type: 'object',
      properties: { label: { type: 'string' }, value: { type: 'number' } },
      required: ['label', 'value'],
      additionalProperties: false,
    },
    async execute() {
      counter.effects++;
      return { outcome, content: `effect:${counter.effects}` };
    },
  };
}
function outputs(body: Body) {
  return body.input.filter((item) => item.type === 'function_call_output');
}
function ciphertext(body: Body) {
  return body.input
    .filter((item) => item.type === 'reasoning')
    .map((item) => item.encrypted_content);
}
function validateHistory(
  body: Body,
  expected: { id: string; output: string; name?: string; args?: Item }[],
  encrypted: string[],
) {
  expect(outputs(body)).toEqual(
    expected.map(({ id, output }) => ({ type: 'function_call_output', call_id: id, output })),
  );
  const calls = body.input.filter((item) => item.type === 'function_call');
  expect(calls).toEqual(
    expected.map((item) => ({
      type: 'function_call',
      call_id: item.id,
      name: (item.name ?? 'fixture.record').replaceAll('.', '_'),
      arguments: JSON.stringify(item.args ?? { label: item.id, value: 1 }),
    })),
  );
  expect(ciphertext(body)).toEqual(encrypted);
  for (const item of body.input.filter((row) => row.type === 'reasoning')) {
    expect(item.id).toBeString();
    expect(item.summary).toEqual([]);
  }
  for (const item of expected)
    expect(
      body.input.findIndex((row) => row.type === 'function_call_output' && row.call_id === item.id),
    ).toBeGreaterThan(
      body.input.findIndex((row) => row.type === 'function_call' && row.call_id === item.id),
    );
  for (const item of expected)
    expect(
      body.input
        .filter((row) => row.role === 'assistant')
        .some((row) => JSON.stringify(row).includes(item.output)),
    ).toBe(false);
}

for (const protocol of ['responses', 'chat-completions'] as const) {
  test(`${protocol} mapped Tool output survives public HTTP digest verification and cold private replay`, async () => {
    const records: Item[] = [];
    const errors: string[] = [];
    const counter = { effects: 0 };
    const privateReasoning = 'sealed-mapped-reasoning';
    const text =
      protocol === 'responses' ? 'Read mapped tool.' : 'Chat mapped output 中文🙂 '.repeat(4096);
    const publicArgs = JSON.stringify({ display_label: 'mapped', value: 1 });
    const internalArgs = { label: 'mapped', value: 1 };
    const mapped: ToolDefinition = {
      ...tool(counter),
      model: { name: 'record_item', parameterNames: { label: 'display_label' } },
      async execute(input) {
        expect(input).toEqual({ label: 'mapped', value: 1 });
        counter.effects++;
        return { outcome: 'succeeded', content: 'mapped-effect' };
      },
    };
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as Item;
        const index = records.length;
        records.push(body);
        try {
          expect(new URL(request.url).pathname).toBe(
            protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions',
          );
          if (index > 0) {
            if (protocol === 'responses') {
              expect(body.input).toContainEqual({
                type: 'function_call',
                call_id: 'mapped-call',
                name: 'record_item',
                arguments: publicArgs,
              });
              expect(ciphertext(body as Body)).toContain(privateReasoning);
            } else {
              const calls = (body.messages as Item[]).find((message) =>
                Array.isArray(message.tool_calls),
              )?.tool_calls as Item[];
              expect(calls).toHaveLength(1);
              expect(calls[0]).toMatchObject({
                id: 'mapped-call',
                type: 'function',
                function: { name: 'record_item' },
              });
              expect(JSON.parse((calls[0]!.function as Item).arguments as string)).toEqual(
                JSON.parse(publicArgs),
              );
            }
          }
          if (protocol === 'responses') {
            const turn =
              index === 0
                ? {
                    id: 'mapped-first',
                    encrypted: privateReasoning,
                    text: [text],
                    calls: [{ id: 'mapped-call', name: 'record_item', arguments: publicArgs }],
                  }
                : { id: `mapped-next-${index}`, text: ['Mapped complete.'] };
            return new Response(encodeFrames(responseFrames(turn, body)), {
              headers: { 'content-type': 'text/event-stream' },
            });
          }
          const frame = (delta: Item, finish_reason: string | null = null) =>
            `data: ${JSON.stringify({ id: `chat-mapped-${index}`, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
          const delta =
            index === 0
              ? {
                  content: text,
                  tool_calls: [
                    {
                      index: 0,
                      id: 'mapped-call',
                      type: 'function',
                      function: { name: 'record_item', arguments: publicArgs },
                    },
                  ],
                }
              : { content: 'Mapped complete.' };
          return new Response(
            `${frame(delta)}${frame({}, index === 0 ? 'tool_calls' : 'stop')}data: [DONE]\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          );
        } catch (error) {
          errors.push(String(error));
          return Response.json(
            { error: { message: 'mapped output fixture failed' } },
            { status: 400 },
          );
        }
      },
    });
    let f = await fixture(`http://127.0.0.1:${provider.port}/v1`, { protocol, tools: [mapped] });
    try {
      await start(f);
      const view = await finished(f.client);
      expect(view.commandRun.status).toBe('completed');
      expect(errors).toEqual([]);
      expect(counter.effects).toBe(1);
      const first = view.executions.find(
        (execution) =>
          execution.kind === 'model' && (execution.result as Item).finishReason === 'tool_calls',
      )!;
      const history = await f.client.listMessages('s');
      expect(
        history.find((message) => message.outputBody?.executionId === first.id)?.outputBody
          ?.complete,
      ).toBe(true);
      // The real Client verifies the semantic hash/bytes after Runtime and HTTP projection.
      const output = await f.client.getModelOutput('s', first.id);
      expect(output.output).toEqual({
        content: text,
        reasoning: '',
        complete: true,
        toolCalls: [{ id: 'mapped-call', name: 'fixture.record', arguments: expect.any(String) }],
      });
      expect(JSON.parse(output.output.toolCalls[0]!.arguments)).toEqual(internalArgs);
      expect(JSON.stringify(output)).not.toContain(privateReasoning);
      expect(output.output.toolCalls[0]).not.toHaveProperty('model');
      const root = f.root;
      const originalHash = output.bodyHash;
      await f.close(false);
      f = await fixture(`http://127.0.0.1:${provider.port}/v1`, {
        root,
        protocol,
        tools: [mapped],
      });
      expect((await f.client.getModelOutput('s', first.id)).bodyHash).toBe(originalHash);
      expect(records).toHaveLength(2);
      // A later request must still restore the original Model name/parameter mapping;
      // Responses must also retain its sealed continuation across the cold reopen.
      await start(f, 'cold-mapped', 's', 'New task: check saved mapped history');
      expect((await finished(f.client, 'cold-mapped')).commandRun.status).toBe('completed');
      expect(errors).toEqual([]);
      expect(records).toHaveLength(3);
      expect(counter.effects).toBe(1);
    } finally {
      await f.close();
      provider.stop(true);
    }
  }, 30_000);
}

test('Responses real Client-Service loop: 3 tool rounds, parallel fragmented calls, usage, cold continuation and binding isolation', async () => {
  const counter = { effects: 0 };
  let total = 0;
  const fast = barrier();
  const completionOrder: string[] = [];
  const expected = [
    { id: 'alpha', output: 'record:alpha,total:2', args: { label: 'alpha', value: 2 } },
    { id: 'echo', output: 'echo:parallel-B', name: 'fixture.echo', args: { text: 'parallel-B' } },
    { id: 'beta', output: 'record:beta,total:5', args: { label: 'beta', value: 3 } },
    { id: 'gamma', output: 'record:gamma,total:12', args: { label: 'gamma', value: 7 } },
  ];
  const provider = endpoint(
    (body, n) => {
      expect(body.model).toBe(n === 6 ? 'gpt-5-mini' : 'gpt-5');
      expect((body.tools as Item[]).map((item) => item.name).sort()).toEqual([
        'fixture_echo',
        'fixture_record',
      ]);
      expect(body.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'function',
            name: 'fixture_record',
            parameters: tools[0]!.inputSchema,
          }),
          expect.objectContaining({
            type: 'function',
            name: 'fixture_echo',
            parameters: tools[1]!.inputSchema,
          }),
        ]),
      );
      if (n <= 3)
        validateHistory(
          body,
          expected.slice(0, n === 0 ? 0 : n + 1),
          Array.from({ length: n }, (_, i) => `fixture-cipher-${i + 1}`),
        );
      if (n === 0)
        return {
          id: 'r1',
          encrypted: 'fixture-cipher-1',
          calls: [
            call('alpha', 'fixture.record', { label: 'alpha', value: 2 }),
            call('echo', 'fixture.echo', { text: 'parallel-B' }),
          ],
          inputTokens: 10,
          outputTokens: 4,
        };
      if (n === 1)
        return {
          id: 'r2',
          encrypted: 'fixture-cipher-2',
          calls: [call('beta', 'fixture.record', { label: 'beta', value: 3 })],
          inputTokens: 20,
          outputTokens: 8,
        };
      if (n === 2)
        return {
          id: 'r3',
          encrypted: 'fixture-cipher-3',
          calls: [call('gamma', 'fixture.record', { label: 'gamma', value: 7 })],
          inputTokens: 30,
          outputTokens: 12,
        };
      if (n === 3)
        return {
          id: 'r4',
          encrypted: 'fixture-cipher-4',
          text: ['Total: ', '12. ', 'Loop complete.'],
          inputTokens: 40,
          outputTokens: 16,
        };
      if (n === 4) {
        validateHistory(body, expected, [
          'fixture-cipher-1',
          'fixture-cipher-2',
          'fixture-cipher-3',
          'fixture-cipher-4',
        ]);
        expect(body.input).toContainEqual({
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Total: 12. Loop complete.' }],
          id: 'msg_r4',
        });
        return { id: 'cold', text: ['Cold ', 'continued.'] };
      }
      if (n === 5) {
        validateHistory(body, [], []);
        expect(body.input).toEqual([
          { role: 'user', content: [{ type: 'input_text', text: 'Execute local fixture clean' }] },
        ]);
        return { id: 'other-session', text: ['Clean session.'] };
      }
      if (n === 6) {
        validateHistory(body, expected, []);
        expect(body.model).toBe('gpt-5-mini');
        return { id: 'other-model', text: ['New model binding.'] };
      }
      throw new Error('unexpected extra Provider request');
    },
    () => counter.effects,
  );
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  let other: ReturnType<typeof endpoint> | undefined;
  let ledger = '';
  const tools: ToolDefinition[] = [
    {
      ...tool(counter),
      async execute(input) {
        const args = input as { label: string; value: number };
        if (args.label === 'alpha') await fast.promise;
        counter.effects++;
        total += args.value;
        completionOrder.push(args.label);
        appendFileSync(ledger, `${args.label}:${args.value}\n`);
        return { outcome: 'succeeded', content: `record:${args.label},total:${total}` };
      },
    },
    {
      id: 'fixture.echo',
      version: '1',
      description: 'Read-only local echo',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      async execute(input) {
        completionOrder.push('echo');
        fast.release();
        return { outcome: 'succeeded', content: `echo:${(input as { text: string }).text}` };
      },
    },
  ];
  try {
    f = await fixture(provider.baseURL, { tools });
    ledger = join(f.root, 'effects.txt');
    await start(f);
    const view = await finished(f.client);
    expect(provider.errors).toEqual([]);
    expect(view.runs[0]?.status).toBe('completed');
    expect(provider.records).toHaveLength(4);
    expect(counter.effects).toBe(3);
    expect(readFileSync(ledger, 'utf8')).toBe('alpha:2\nbeta:3\ngamma:7\n');
    expect(completionOrder).toEqual(['echo', 'alpha', 'beta', 'gamma']);
    expect(provider.records.map((r) => r.effectsAtRequest)).toEqual([0, 1, 2, 3]);
    const models = view.executions.filter((execution) => execution.kind === 'model');
    const toolsObserved = view.executions.filter((execution) => execution.kind === 'tool');
    const expectedUsage = [10, 20, 30, 40].map((inputTokens, index) => ({
      inputTokens,
      outputTokens: (index + 1) * 4,
      totalTokens: inputTokens + (index + 1) * 4,
      cachedInputTokens: 2,
      reasoningTokens: 1,
      raw: {
        input_tokens: inputTokens,
        output_tokens: (index + 1) * 4,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
    }));
    expect(models.map((execution) => (execution.result as Item).usage)).toEqual(expectedUsage);
    expect(models.map((execution) => (execution.result as Item).finishReason)).toEqual([
      'tool_calls',
      'tool_calls',
      'tool_calls',
      'stop',
    ]);
    expect(models.map((execution) => execution.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    expect(toolsObserved.map((execution) => execution.toolCallId).sort()).toEqual([
      'alpha',
      'beta',
      'echo',
      'gamma',
    ]);
    expect(toolsObserved.every((execution) => execution.status === 'succeeded')).toBe(true);
    expect(models.map((execution) => execution.result)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: 'Total: 12. Loop complete.',
          finishReason: 'stop',
          usage: expectedUsage.at(-1),
        }),
      ]),
    );
    const messages = await f.client.listMessages('s');
    expect(JSON.stringify(messages)).toContain('Total: 12. Loop complete.');
    expect(JSON.stringify(messages)).not.toContain('fixture-cipher');
    const inspected = await f.client.getModelInput('s', models.at(-1)!.id);
    expect(JSON.stringify(inspected)).not.toContain('fixture-cipher');
    const originalRoot = f.root;
    await f.close(false);
    f = undefined;
    f = await fixture(provider.baseURL, { root: originalRoot, tools });
    expect(provider.records).toHaveLength(4);
    expect(counter.effects).toBe(3);
    await start(f, 'cold', 's', 'New task: Execute local fixture cold');
    expect((await finished(f.client, 'cold')).commandRun.status).toBe('completed');
    await f.client.createSession({
      expectedStoreId: f.storeId,
      commandId: 'create-other',
      sessionId: 'other',
      workspaceId: 'w',
      title: 'Other',
    });
    await start(f, 'clean', 'other');
    expect((await finished(f.client, 'clean', 'other')).runs[0]?.status).toBe('completed');
    await f.close(false);
    f = undefined;
    f = await fixture(provider.baseURL, { root: originalRoot, modelId: 'gpt-5-mini', tools });
    await start(f, 'model-switch', 's', 'New task: Execute local fixture model-switch');
    expect((await finished(f.client, 'model-switch')).commandRun.status).toBe('completed');
    await f.close(false);
    f = undefined;
    other = endpoint(
      (body) => {
        validateHistory(body, expected, []);
        return { id: 'other-endpoint', text: ['New endpoint binding.'] };
      },
      () => counter.effects,
    );
    f = await fixture(other.baseURL, { root: originalRoot, tools });
    await start(f, 'endpoint-switch', 's', 'New task: Execute local fixture endpoint-switch');
    expect((await finished(f.client, 'endpoint-switch')).commandRun.status).toBe('completed');
    expect(provider.errors).toEqual([]);
    expect(other.errors).toEqual([]);
    expect(provider.records).toHaveLength(7);
    expect(other.records).toHaveLength(1);
    expect(counter.effects).toBe(3);
    saveEvidence('happy-loop-and-cold', {
      records: provider.records,
      otherEndpoint: other.records,
      view,
      inspected,
      completionOrder,
      ledger: readFileSync(ledger, 'utf8'),
      effects: counter.effects,
    });
  } finally {
    fast.release();
    await f?.close();
    provider.close();
    other?.close();
  }
}, 30_000);

test('Responses cold SQLite history re-encodes colliding tool names without changing original calls or reasoning', async () => {
  const counter = { effects: 0 };
  let collisionEffects = 0;
  const provider = endpoint(
    (body, index) => {
      const name = index < 2 ? 'fixture_record' : 'fixture_record_1';
      validateHistory(
        body,
        index === 0
          ? []
          : index < 3
            ? [{ id: 'first', output: 'effect:1', name }]
            : [
                { id: 'first', output: 'effect:1', name },
                { id: 'second', output: 'effect:2', name },
              ],
        index === 0 ? [] : ['collision-reasoning'],
      );
      if (index === 0)
        return { id: 'collision-first', encrypted: 'collision-reasoning', calls: [call('first')] };
      if (index === 2) {
        expect((body.tools as Item[]).map((item) => item.name).sort()).toEqual([
          'fixture_record',
          'fixture_record_1',
        ]);
        return { id: 'collision-second', calls: [call('second', name)] };
      }
      return { id: `collision-final-${index}`, text: ['Completed original tool.'] };
    },
    () => counter.effects,
  );
  let f = await fixture(provider.baseURL, { tools: [tool(counter)] });
  try {
    await start(f);
    expect((await finished(f.client)).runs[0]?.status).toBe('completed');
    const root = f.root;
    await f.close(false);
    f = await fixture(provider.baseURL, {
      root,
      tools: [
        tool(counter),
        {
          ...tool(counter),
          id: 'fixture_record',
          async execute() {
            collisionEffects++;
            return { outcome: 'succeeded', content: 'wrong tool' };
          },
        },
      ],
    });
    expect(provider.records).toHaveLength(2);
    await start(f, 'cold-collision', 's', 'New task: Execute local fixture cold-collision');
    const view = await finished(f.client, 'cold-collision');
    expect(view.commandRun.status).toBe('completed');
    expect(provider.errors).toEqual([]);
    expect(counter.effects).toBe(2);
    expect(collisionEffects).toBe(0);
    expect(provider.records).toHaveLength(4);
    expect(
      view.executions
        .filter((execution) => execution.kind === 'tool')
        .map((execution) => [execution.definitionId, execution.toolCallId]),
    ).toEqual([
      ['fixture.record', 'first'],
      ['fixture.record', 'second'],
    ]);
    const models = view.executions.filter((execution) => execution.kind === 'model');
    const inspected = await f.client.getModelInput('s', models.at(-1)!.id);
    expect(JSON.stringify(inspected)).not.toContain('collision-reasoning');
    expect(JSON.stringify(inspected)).toContain('fixture.record');
    expect(JSON.stringify(await f.client.listMessages('s'))).not.toContain('collision-reasoning');
    saveEvidence('cold-tool-name-collision', {
      records: provider.records,
      view,
      inspected,
      effects: counter.effects,
      collisionEffects,
    });
  } finally {
    await f.close();
    provider.close();
  }
}, 15_000);

for (const ending of ['eof', 'partial_call', 'partial_completed'] as const)
  test(`Responses ${ending} is retried only after failed model execution; partial tools have zero effects`, async () => {
    const counter = { effects: 0 };
    const provider = endpoint(
      (body, n) => {
        validateHistory(body, [], []);
        return n === 0
          ? { id: 'interrupted', calls: [call('discarded')], ending }
          : { id: 'recovered', text: ['Recovered ', 'without tools.'] };
      },
      () => counter.effects,
    );
    const f = await fixture(provider.baseURL, { tools: [tool(counter)] });
    try {
      await start(f);
      const view = await finished(f.client);
      expect(provider.errors).toEqual([]);
      expect(view.runs[0]?.status).toBe('completed');
      expect(counter.effects).toBe(0);
      expect(provider.records).toHaveLength(2);
      const models = view.executions.filter((e) => e.kind === 'model');
      expect(models.map((e) => e.status)).toEqual(['failed', 'succeeded']);
      expect(models[1]?.modelRetry).toMatchObject({
        previousExecutionId: models[0]!.id,
        attempt: 2,
        maxAttempts: null,
        reason: 'stream_incomplete',
      });
      expect(view.executions.filter((e) => e.kind === 'tool')).toHaveLength(0);
      saveEvidence(`retry-${ending}`, {
        records: provider.records,
        view,
        effects: counter.effects,
      });
    } finally {
      await f.close();
      provider.close();
    }
  }, 15_000);

for (const failure of [
  'response.failed',
  'error',
  'incomplete',
  'partial_incomplete',
  'http400',
  'http500',
] as const)
  test(`Responses ${failure} respects retry eligibility without tool execution`, async () => {
    const counter = { effects: 0 };
    const retryable = ['http500', 'incomplete', 'partial_incomplete'].includes(failure);
    const failures = 5;
    const provider = endpoint(
      (body, n) => {
        validateHistory(body, [], []);
        if (retryable && n === failures)
          return { id: 'recovered', text: ['Recovered after the old attempt limit.'] };
        return failure.startsWith('http')
          ? { status: failure === 'http400' ? 400 : 500 }
          : {
              id: 'failed',
              encrypted: 'discarded-failed-continuation',
              calls: [call('discarded')],
              ending:
                failure === 'response.failed'
                  ? 'failed'
                  : (failure as 'error' | 'incomplete' | 'partial_incomplete'),
            };
      },
      () => counter.effects,
    );
    const f = await fixture(provider.baseURL, { tools: [tool(counter)] });
    try {
      await start(f);
      const view = await finished(f.client);
      expect(provider.errors).toEqual([]);
      expect(view.runs[0]?.status).toBe(retryable ? 'completed' : 'failed');
      expect(counter.effects).toBe(0);
      expect(provider.records).toHaveLength(retryable ? failures + 1 : 1);
      const models = view.executions.filter((e) => e.kind === 'model');
      expect(models.map((e) => e.status)).toEqual(
        retryable
          ? [...Array.from({ length: failures }, () => 'failed' as const), 'succeeded']
          : ['failed'],
      );
      if (retryable)
        for (let index = 1; index < models.length; index++)
          expect(models[index]!.modelRetry).toEqual({
            previousExecutionId: models[index - 1]!.id,
            attempt: index + 1,
            maxAttempts: null,
            reason: failure === 'http500' ? 'provider_unavailable' : 'stream_incomplete',
          });
      expect(view.executions.filter((e) => e.kind === 'tool')).toHaveLength(0);
      saveEvidence(`failure-${failure}`, {
        records: provider.records,
        view,
        effects: counter.effects,
      });
    } finally {
      await f.close();
      provider.close();
    }
  }, 15_000);

test('Responses live HTTP cancellation cannot execute a fragmented call or retry after cancel', async () => {
  const counter = { effects: 0 };
  const held = barrier();
  const provider = endpoint(
    () => ({ id: 'cancelled', calls: [call('cancelled')], ending: 'partial_call' }),
    () => counter.effects,
    held,
  );
  const f = await fixture(provider.baseURL, { tools: [tool(counter)] });
  try {
    await start(f);
    await provider.entered.promise;
    const active = await until(
      () => f.client.getView('s'),
      (v) => v.runs.some((r) => r.isActive),
    );
    await f.client.cancelRun('s', {
      expectedStoreId: f.storeId,
      commandId: 'cancel',
      kind: 'run.cancel',
      runId: active.runs[0]!.id,
    });
    const view = await finished(f.client);
    expect(view.runs[0]?.status).toBe('cancelled');
    expect(counter.effects).toBe(0);
    expect(provider.records).toHaveLength(1);
    expect(view.executions.filter((e) => e.kind === 'tool')).toHaveLength(0);
    await until(
      async () => provider.abortedRequests,
      (count) => count === 1,
    );
    held.release();
    await f.client.getView('s');
    expect(provider.records).toHaveLength(1);
    saveEvidence('cancel-live-stream', {
      records: provider.records,
      view,
      effects: counter.effects,
      abortedRequests: provider.abortedRequests,
    });
  } finally {
    held.release();
    await f.close();
    provider.close();
  }
}, 15_000);

test('Responses plain-text length continues with sealed reasoning and no tool or retry authority', async () => {
  const counter = { effects: 0 };
  const provider = endpoint((body, index) => {
    validateHistory(body, [], index === 0 ? [] : ['length-continuation']);
    if (index === 0)
      return {
        id: 'length-first',
        text: ['The first part.'],
        encrypted: 'length-continuation',
        ending: 'incomplete',
      };
    expect(JSON.stringify(body.input)).toContain('The first part.');
    return { id: 'length-final', text: ['The final part.'] };
  });
  const f = await fixture(provider.baseURL, { tools: [tool(counter)] });
  try {
    await start(f);
    const view = await finished(f.client);
    expect(provider.errors).toEqual([]);
    expect(provider.records).toHaveLength(2);
    expect(view.runs[0]?.status).toBe('completed');
    expect(counter.effects).toBe(0);
    const models = view.executions.filter((execution) => execution.kind === 'model');
    expect(models.map((execution) => execution.status)).toEqual(['succeeded', 'succeeded']);
    expect(models[1]?.modelRetry).toBeUndefined();
    expect(view.executions.filter((execution) => execution.kind === 'tool')).toHaveLength(0);
    const first = await f.store.getExecution(models[0]!.id);
    expect(first?.result).toMatchObject({ finishReason: 'length' });
    const inspected = await f.client.getModelInput('s', models[1]!.id);
    expect(JSON.stringify(inspected)).not.toContain('length-continuation');
    expect(JSON.stringify(await f.client.listMessages('s'))).not.toContain('length-continuation');
    saveEvidence('plain-text-length-continuation', { records: provider.records, view, inspected });
  } finally {
    await f.close();
    provider.close();
  }
}, 15_000);

test('Responses manual approval waits with zero effects then continues the original call once', async () => {
  const counter = { effects: 0 };
  const provider = endpoint(
    (body, n) => {
      validateHistory(
        body,
        n === 0 ? [] : [{ id: 'approved', output: 'effect:1' }],
        n === 0 ? [] : ['fixture-approval-cipher'],
      );
      return n === 0
        ? { id: 'approval', calls: [call('approved')], encrypted: 'fixture-approval-cipher' }
        : { id: 'approved-final', text: ['Approved ', 'and complete.'] };
    },
    () => counter.effects,
  );
  const f = await fixture(provider.baseURL, {
    tools: [tool(counter)],
    permissions: {
      authorize: async (request) =>
        request.kind === 'tool'
          ? {
              allowed: false,
              revision: 'fixture-approval',
              approval: {
                request: { title: 'One disposable local test effect' },
                grants: ['approve_once'],
              },
            }
          : { allowed: true, revision: 'fixture-approval' },
    },
  });
  try {
    await start(f);
    const waiting = await until(
      () => f.client.listInteractions('s', { storeId: f.storeId, state: 'pending' }),
      (v) => v.interactions.length > 0,
    );
    expect(counter.effects).toBe(0);
    expect(provider.records).toHaveLength(1);
    const interaction = waiting.interactions.find((i) => i.state === 'pending')!;
    await f.client.answerInteraction('s', interaction.id, {
      expectedStoreId: f.storeId,
      commandId: 'approve',
      expectedRevision: interaction.revision,
      answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
    });
    const view = await finished(f.client);
    expect(provider.errors).toEqual([]);
    expect(view.runs[0]?.status).toBe('completed');
    expect(counter.effects).toBe(1);
    expect(provider.records).toHaveLength(2);
    saveEvidence('manual-approval', {
      records: provider.records,
      waiting,
      view,
      effects: counter.effects,
    });
  } finally {
    await f.close();
    provider.close();
  }
}, 15_000);

test('Responses unknown tool effect stops without model continuation or duplicate side effects', async () => {
  const counter = { effects: 0 };
  const provider = endpoint(
    () => ({ id: 'unknown', calls: [call('unknown')] }),
    () => counter.effects,
  );
  let f = await fixture(provider.baseURL, { tools: [tool(counter, 'outcome_unknown')] });
  try {
    await start(f);
    const view = await finished(f.client);
    expect(counter.effects).toBe(1);
    expect(provider.records).toHaveLength(1);
    expect(view.executions.find((e) => e.kind === 'tool')?.status).toBe('outcome_unknown');
    expect(view.runs[0]?.status).not.toBe('completed');
    await f.client.getView('s');
    expect(counter.effects).toBe(1);
    const root = f.root;
    await f.close(false);
    f = await fixture(provider.baseURL, { root, tools: [tool(counter, 'outcome_unknown')] });
    const coldView = await f.client.getView('s');
    expect(counter.effects).toBe(1);
    expect(provider.records).toHaveLength(1);
    expect(coldView.executions.find((e) => e.kind === 'tool')?.status).toBe('outcome_unknown');
    saveEvidence('unknown-tool-effect', {
      coldView,
      records: provider.records,
      view,
      effects: counter.effects,
    });
  } finally {
    await f.close();
    provider.close();
  }
}, 15_000);

test('Responses next-step retry never repeats a previously completed tool side effect', async () => {
  const counter = { effects: 0 };
  const provider = endpoint(
    (body, n) => {
      validateHistory(
        body,
        n === 0
          ? []
          : n < 3
            ? [{ id: 'first', output: 'effect:1' }]
            : [
                { id: 'first', output: 'effect:1' },
                { id: 'second', output: 'effect:2' },
              ],
        [],
      );
      if (n === 0) return { id: 'before-failure', calls: [call('first')] };
      if (n === 1) return { id: 'lost-second', calls: [call('discarded-second')], ending: 'eof' };
      if (n === 2) return { id: 'retry-second', calls: [call('second')] };
      return { id: 'retry-final', text: ['Exactly ', 'two effects.'] };
    },
    () => counter.effects,
  );
  const f = await fixture(provider.baseURL, { tools: [tool(counter)] });
  try {
    await start(f);
    const view = await finished(f.client);
    expect(provider.errors).toEqual([]);
    expect(view.runs[0]?.status).toBe('completed');
    expect(provider.records).toHaveLength(4);
    expect(counter.effects).toBe(2);
    expect(provider.records.map((r) => r.effectsAtRequest)).toEqual([0, 1, 1, 2]);
    expect(view.executions.filter((e) => e.kind === 'tool').map((e) => e.toolCallId)).toEqual([
      'first',
      'second',
    ]);
    expect(view.executions.filter((e) => e.kind === 'model').map((e) => e.status)).toEqual([
      'succeeded',
      'failed',
      'succeeded',
      'succeeded',
    ]);
    saveEvidence('retry-after-effect', {
      records: provider.records,
      view,
      effects: counter.effects,
    });
  } finally {
    await f.close();
    provider.close();
  }
}, 15_000);

test('Responses physical socket loss continues beyond five attempts without dispatching unfinished tools', async () => {
  const counter = { effects: 0 };
  const requests: Body[] = [];
  let destroyed = 0;
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    requests.push(JSON.parse(Buffer.concat(parts).toString('utf8')) as Body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    validateHistory(requests.at(-1)!, [], []);
    if (requests.length === 7) {
      response.end(encodeFrames(responseFrames({ id: 'socket-recovered', text: ['Recovered.'] })));
      return;
    }
    response.write(
      encodeFrames(
        responseFrames({ id: 'socket-lost', calls: [call('socket-discarded')], ending: 'eof' }),
      ),
    );
    await Bun.sleep(25);
    destroyed++;
    request.socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing_local_socket');
  const f = await fixture(`http://127.0.0.1:${address.port}/v1`, { tools: [tool(counter)] });
  try {
    await start(f);
    const view = await finished(f.client);
    expect(counter.effects).toBe(0);
    expect(view.runs[0]?.status).toBe('completed');
    expect(view.executions.filter((e) => e.kind === 'tool')).toHaveLength(0);
    expect(destroyed).toBe(6);
    expect(requests).toHaveLength(7);
    const executions = await f.store.listExecutions('s');
    expect(executions.map((e) => e.status)).toEqual([
      ...Array.from({ length: 6 }, () => 'failed' as const),
      'succeeded',
    ]);
    expect(executions.slice(0, -1).map((e) => e.result)).toEqual(
      Array.from({ length: 6 }, () =>
        expect.objectContaining({
          code: 'MODEL_ATTEMPT_RETRYABLE_FAILURE:connection_failed',
          incomplete: true,
        }),
      ),
    );
    expect(view.executions.at(-1)?.modelRetry).toMatchObject({ attempt: 7, maxAttempts: null });
    saveEvidence('physical-socket-loss', {
      requests,
      destroyed,
      view,
      executions,
      effects: counter.effects,
    });
  } finally {
    await f.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
}, 15_000);

test('Responses permanently lost sockets stop retrying after explicit Run cancellation', async () => {
  const counter = { effects: 0 };
  const requests: Body[] = [];
  const twoFailures = barrier();
  let destroyed = 0;
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    requests.push(JSON.parse(Buffer.concat(parts).toString('utf8')) as Body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    response.write(
      encodeFrames(
        responseFrames({ id: 'permanently-lost', calls: [call('discarded')], ending: 'eof' }),
      ),
    );
    await Bun.sleep(25);
    destroyed++;
    request.socket.destroy();
    if (destroyed === 2) twoFailures.release();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing_local_socket');
  const f = await fixture(`http://127.0.0.1:${address.port}/v1`, { tools: [tool(counter)] });
  try {
    await start(f);
    await twoFailures.promise;
    const active = await until(
      () => f.client.getView('s'),
      (view) => view.executions.filter((execution) => execution.status === 'failed').length === 2,
    );
    await f.client.cancelRun('s', {
      expectedStoreId: f.storeId,
      commandId: 'cancel-retrying',
      kind: 'run.cancel',
      runId: active.runs[0]!.id,
    });
    const view = await finished(f.client);
    expect(view.runs[0]?.status).toBe('cancelled');
    expect(counter.effects).toBe(0);
    expect(view.executions.filter((execution) => execution.kind === 'tool')).toHaveLength(0);
    expect(
      view.executions.filter((execution) => execution.kind === 'model').map((e) => e.status),
    ).toEqual(['failed', 'failed']);
    // The next retry would run after 200ms; cancellation must close that scheduled boundary.
    await Bun.sleep(250);
    expect(requests).toHaveLength(2);
    expect(destroyed).toBe(2);
    saveEvidence('cancel-permanent-socket-loss', {
      requests,
      destroyed,
      view,
      effects: counter.effects,
    });
  } finally {
    await f.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
}, 15_000);
