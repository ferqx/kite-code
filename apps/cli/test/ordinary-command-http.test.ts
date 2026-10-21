import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import type { ModelEvent } from '@kite-ai/ai';
import { createClient, readOrdinaryCommandApplication } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { observeCommand, run } from '../src';

test('real HTTP ordinary business lineage and saved progress Model terminate CLI without replay', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cli-ordinary-')));
  const selected = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(selected);
  const storeId = (await store.getMetadata()).storeId;
  const requests: string[] = [];
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile: selected, store }),
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
    modelId: 'fixture',
    model: {
      async *stream(input) {
        const body = input.messages.map((message) => message.content ?? '').join('\n');
        requests.push(body);
        const identity = body.match(/Original input identity: (\{[^\n]+\})/);
        if (identity) {
          const ids = JSON.parse(identity[1]!);
          yield {
            type: 'text_delta',
            text: JSON.stringify({
              ...ids,
              relation: 'same_work',
              purpose: 'progress',
              target_root_work_command_id: 'next',
              selection_effect: 'keep',
              answer: '准确的已保存进度',
              clarification: null,
            }),
          } as ModelEvent;
        } else yield { type: 'text_delta', text: 'actual work answer' } as ModelEvent;
        yield {
          type: 'finish',
          reason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1 },
        } as ModelEvent;
      },
    },
  });
  const profile = {
    dataRoot: realpathSync(selected.dataRoot),
    name: selected.profile,
    accessKey: resolveProfile(selected).profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile,
    buildId: 'ordinary-client',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: { profile, apiMajor: 1, requiredCapabilities: ['commands'] },
    bootstrap: service.bootstrap,
  });
  try {
    await client.connect();
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'fixture',
      rootUri: pathToFileURL(root).href,
    });
    await client.createSession({
      expectedStoreId: storeId,
      sessionId: 's',
      workspaceId: 'w',
      commandId: 'session',
      title: 'fixture',
    });
    const result = await run(
      's',
      {
        kind: 'run.start',
        expectedStoreId: storeId,
        commandId: 'work',
        content: 'complete fixture work',
      },
      { client, write() {}, pollIntervalMs: 5 },
    );
    expect(result.exitCode).toBe(0);
    const original = await client.getCommand('work');
    const actual = await readOrdinaryCommandApplication(client, original);
    expect(actual?.run?.originCommandId).toBe('work');
    const additional = await run(
      's',
      {
        kind: 'run.start',
        expectedStoreId: storeId,
        commandId: 'next',
        content: '另外 complete second fixture work',
      },
      { client, write() {}, pollIntervalMs: 5 },
    );
    expect(additional.exitCode).toBe(0);
    const next = await client.getCommand('next');
    const nextApplication = await readOrdinaryCommandApplication(client, next);
    expect(nextApplication?.run?.originCommandId).not.toBe('next');
    expect(nextApplication?.sourceCommandId).toBe(nextApplication?.run?.originCommandId);
    const raw = await store.getCommand(
      (next.receipt as { humanInputCommandId: string }).humanInputCommandId,
    );
    expect(raw?.kind).toBe('human.input');
    const lines: string[] = [];
    const progress = await run(
      's',
      { kind: 'run.start', expectedStoreId: storeId, commandId: 'progress', content: '进度 next' },
      { client, write: (line) => lines.push(line), pollIntervalMs: 5 },
    );
    expect(progress.exitCode).toBe(0);
    const saved = await client.getCommand('progress');
    expect(saved.status).toBe('applied');
    expect((saved.receipt as { runId: null }).runId).toBeNull();
    const observed = await readOrdinaryCommandApplication(client, saved);
    expect(observed?.observation?.answer).toBe('准确的已保存进度');
    expect((await store.getExecution(observed!.observation!.executionId))?.status).toBe(
      'succeeded',
    );
    expect(requests).toHaveLength(3);
    expect(lines).toEqual(['accepted progress', 'terminal progress succeeded']);
  } finally {
    client.disposeNetwork();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('real HTTP unresolved input returns its sealed clarification and cold GET-only observation preserves the accepted original invocation', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cli-unresolved-')));
  const selected = { dataRoot: join(root, 'data'), profile: 'test' };
  let store = await openSqliteStore(selected);
  const storeId = (await store.getMetadata()).storeId;
  const profile = {
    dataRoot: realpathSync(selected.dataRoot),
    name: selected.profile,
    accessKey: resolveProfile(selected).profileAccessKey,
  };
  const clarification = '请说明这条输入属于哪项工作。\n完整问题 😀，保留结尾空格  ';
  let providerCalls = 0;
  const makeRuntime = () =>
    createRuntime({
      store,
      artifacts: createArtifactStore({ profile: selected, store }),
      modelId: 'fixture',
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'fixture' };
        },
      },
      model: {
        async *stream(input) {
          providerCalls++;
          const instruction = input.messages.find((message) =>
            message.content.includes('Original input identity:'),
          );
          if (instruction) {
            expect(input.tools).toHaveLength(0);
            const identity = JSON.parse(
              instruction.content
                .split('\n')
                .find((line) => line.startsWith('Original input identity: '))!
                .slice('Original input identity: '.length),
            );
            yield {
              type: 'text_delta' as const,
              text: JSON.stringify({
                ...identity,
                relation: 'unresolved',
                purpose: 'clarify',
                target_root_work_command_id: null,
                selection_effect: 'keep',
                answer: null,
                clarification,
              }),
            };
          } else yield { type: 'text_delta' as const, text: 'Original A completed.' };
          yield {
            type: 'finish' as const,
            reason: 'stop' as const,
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
    });
  const launch = () =>
    startService({
      runtime: makeRuntime(),
      profile,
      buildId: 'unresolved-cli',
      subjectId: 'owner',
    });
  let service = await launch();
  const wire: { method: string; path: string }[] = [];
  const proxy = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      wire.push({ method: request.method, path: url.pathname });
      const forwarded = new Request(`${service.endpoint}${url.pathname}${url.search}`, request);
      forwarded.headers.delete('host');
      return fetch(forwarded);
    },
  });
  const createConnection = () =>
    createClient({
      endpoint: proxy.url.href.replace(/\/$/, ''),
      token: service.bootstrap.token,
      expected: { profile, apiMajor: 1, requiredCapabilities: ['commands'] },
      bootstrap: service.bootstrap,
    });
  let client = createConnection();
  try {
    await client.connect();
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'fixture',
      rootUri: pathToFileURL(root).href,
    });
    await client.createSession({
      expectedStoreId: storeId,
      sessionId: 's',
      workspaceId: 'w',
      commandId: 'create',
      title: 'fixture',
    });
    expect(
      (
        await run(
          's',
          { kind: 'run.start', expectedStoreId: storeId, commandId: 'A', content: 'Original A' },
          { client, write() {}, pollIntervalMs: 5, timeoutMs: 1000 },
        )
      ).exitCode,
    ).toBe(0);
    const invocation = {
      kind: 'run.start' as const,
      expectedStoreId: storeId,
      commandId: 'ambiguous',
      content: '先处理一下',
    };
    const lines: string[] = [];
    const result = await run('s', invocation, {
      client,
      write: (line) => lines.push(line),
      pollIntervalMs: 5,
      timeoutMs: 1000,
    });
    expect(result.status).toBe('needs_clarification');
    expect(result.exitCode).toBe(3);
    const output = lines.join('\n');
    expect(output.includes(clarification) || output.includes(JSON.stringify(clarification))).toBe(
      true,
    );
    expect(output).toContain('ambiguous');
    expect(output).not.toContain('terminal ambiguous succeeded');
    const command = await client.getCommand('ambiguous');
    expect(command).toMatchObject({
      status: 'accepted',
      receipt: { outcome: 'human_input_unresolved', runId: null, businessCommandId: null },
    });
    const rawId = (command.receipt as { humanInputCommandId: string }).humanInputCommandId;
    const raw = (await store.getCommand(rawId))!;
    expect(raw).toMatchObject({
      kind: 'human.input',
      request: { content: invocation.content, originalRequest: { content: invocation.content } },
      receipt: { state: 'unresolved' },
    });
    const decision = await store.getCommand(
      (raw.receipt as { decisionCommandId: string }).decisionCommandId,
    );
    expect(decision?.receipt).toMatchObject({ businessCommandId: null });
    const application = await readOrdinaryCommandApplication(client, command);
    expect(application?.observation?.clarification).toBe(clarification);
    expect(application?.observation).toEqual(result.clarification);
    expect(Object.hasOwn(JSON.parse(JSON.stringify(result)), 'run')).toBe(false);
    expect(application?.run?.originCommandId).not.toBe('ambiguous');
    expect(providerCalls).toBe(2);
    const deadline = Date.now() + 1000;
    while ((await store.getView('s')).runs.some((run) => run.isActive)) {
      if (Date.now() > deadline) throw Error('unresolved_processing_did_not_settle');
      await Bun.sleep(5);
    }
    expect((await store.getView('s')).runs).toHaveLength(2);
    expect((await store.listExecutions('s')).every((execution) => execution.kind === 'model')).toBe(
      true,
    );
    expect(
      wire.filter((event) => event.method === 'POST' && event.path === '/v1/sessions/s/commands'),
    ).toHaveLength(2);
    client.disposeNetwork();
    await service.close();
    await store.close();
    store = await openSqliteStore(selected);
    service = await launch();
    client = createConnection();
    await client.connect();
    const coldCursor = (await store.getMetadata()).lastChangeCursor;
    const boundary = wire.length;
    const coldLines: string[] = [];
    const cold = await observeCommand('s', invocation, {
      client,
      write: (line) => coldLines.push(line),
      pollIntervalMs: 5,
      timeoutMs: 1000,
    });
    expect(cold.status).toBe('needs_clarification');
    expect(cold.exitCode).toBe(3);
    expect(cold.clarification).toEqual(result.clarification);
    const coldOutput = coldLines.join('\n');
    expect(
      coldOutput.includes(clarification) || coldOutput.includes(JSON.stringify(clarification)),
    ).toBe(true);
    expect(wire.slice(boundary).length).toBeGreaterThan(0);
    expect(wire.slice(boundary).every((event) => event.method === 'GET')).toBe(true);
    expect(providerCalls).toBe(2);
    expect((await store.getMetadata()).lastChangeCursor).toBe(coldCursor);
    expect(await client.getCommand('ambiguous')).toEqual(command);
    expect(await store.getCommand(rawId)).toEqual(raw);
    expect(await store.getCommand(decision!.id)).toEqual(decision);
  } finally {
    client.disposeNetwork();
    proxy.stop(true);
    await service.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
