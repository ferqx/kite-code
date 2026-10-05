import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentError, createRuntime } from '@kite-ai/agent';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { createDesktopController } from '@kite-ai/desktop';
import { startService } from '@kite-ai/service';
import { observeCommand } from '../../src';

test('actual 40 sibling Job approvals: CLI exhausts original pending pages and Desktop reads/answers bounded window', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-interaction-pages-')));
  const selected = { dataRoot: join(root, 'data'), profile: 'owned' };
  const store = await openSqliteStore(selected),
    storeId = (await store.getMetadata()).storeId;
  let effects = 0;
  const runtime = createRuntime({
    store,
    modelId: 'fixed',
    model: createFixedModel([
      [
        { type: 'tool_call', id: 'parent', name: 'fixture.parent', arguments: '{}' },
        { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
      [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
    ]),
    permissions: {
      async authorize(request) {
        return request.kind === 'job'
          ? {
              allowed: false,
              revision: 'policy',
              approval: { request: { title: 'Original Job approval' } },
            }
          : { allowed: true, revision: 'policy' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.parent',
            version: '1',
            description: 'Create owned independent Jobs',
            inputSchema: { type: 'object' },
            async execute(_input, ctx) {
              const operations = await Promise.all(
                Array.from({ length: 40 }, (_, i) =>
                  ctx.operations.ensure({
                    key: `job-${i}`,
                    cancellation: 'detached',
                    request: {
                      kind: 'job',
                      definitionId: 'fixture.job',
                      definitionVersion: '1',
                      input: { index: i },
                    },
                  }),
                ),
              );
              for (;;) {
                ctx.signal.throwIfAborted();
                try {
                  await ctx.operations.wait(operations.at(-1)!, {
                    signal: ctx.signal,
                    timeoutMs: 100,
                  });
                  break;
                } catch (error) {
                  if (!(error instanceof AgentError) || error.code !== 'wait_timeout') throw error;
                  await ctx.operations.get(operations.at(-1)!);
                }
              }
              return { outcome: 'succeeded', content: 'all original approvals observed' };
            },
          },
        ],
        jobs: [
          {
            id: 'fixture.job',
            version: '1',
            description: 'Harmless explicit counter Job',
            inputSchema: { type: 'object' },
            async start(input) {
              effects++;
              return { reference: input };
            },
            async *observe() {
              yield {
                type: 'terminal' as const,
                supervision: 'ended' as const,
                result: { outcome: 'succeeded' as const, content: 'counted' },
              };
            },
            async cancel() {
              return { status: 'stopped' as const };
            },
            async dispose() {},
          },
        ],
      },
    ],
  });
  const profile = {
    dataRoot: realpathSync(selected.dataRoot),
    name: selected.profile,
    accessKey: resolveProfile(selected).profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile,
    buildId: 'interaction-pages',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    bootstrap: service.bootstrap,
    expected: { profile, apiMajor: 1, requiredCapabilities: ['interactions', 'commands'] },
  });
  await client.connect();
  try {
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'owned',
      rootUri: `file://${root}`,
    });
    for (const id of ['s', 'other'])
      await client.createSession({
        expectedStoreId: storeId,
        commandId: `create-${id}`,
        sessionId: id,
        workspaceId: 'w',
        title: id,
      });
    const intent = {
      kind: 'run.start' as const,
      expectedStoreId: storeId,
      commandId: 'original-run',
      content: '40 Job approvals',
    };
    await client.startRun('s', intent);
    const deadline = Date.now() + 5000;
    let directory = await client.listInteractions('s', { storeId, state: 'pending', limit: 20 });
    let tail = directory.nextAfterId
      ? await client.listInteractions('s', {
          storeId,
          state: 'pending',
          limit: 20,
          afterId: directory.nextAfterId,
        })
      : undefined;
    while (tail?.interactions.length !== 20) {
      if (Date.now() > deadline) {
        console.error(JSON.stringify({ directory, tail, view: await client.getView('s') }));
        throw Error('pending_fixture_timeout');
      }
      await Bun.sleep(5);
      directory = await client.listInteractions('s', { storeId, state: 'pending', limit: 20 });
      tail = directory.nextAfterId
        ? await client.listInteractions('s', {
            storeId,
            state: 'pending',
            limit: 20,
            afterId: directory.nextAfterId,
          })
        : undefined;
    }
    expect(directory.interactions).toHaveLength(20);
    expect(tail.interactions).toHaveLength(20);
    const waiting = await observeCommand('s', intent, {
      client,
      write() {},
      pollIntervalMs: 5,
      timeoutMs: 15000,
    });
    expect(waiting.status).toBe('waiting_interaction');
    expect(waiting.interactions).toHaveLength(40);
    expect(effects).toBe(0);
    const desktop = createDesktopController({
      admittedClient: client,
      onSnapshot() {},
      readContextOnSelect: false,
    });
    const first = await desktop.selectSession('s');
    expect(first!.interactions).toHaveLength(20);
    const next = await desktop.nextInteractionPage(first!.generation, first!.interactionsAfterId!);
    expect(next!.interactions).toHaveLength(20);
    expect(next!.interactionsAfterId).toBeNull();
    const last = next!.interactions[0]!;
    const cliTarget = next!.interactions[19]!;
    expect(cliTarget.id).toBe(waiting.interactions!.at(-1)!.id);
    const answer = await desktop.answerInteraction(last, { kind: 'approval', decision: 'approve' });
    expect(answer.sessionId).toBe('s');
    expect(answer.originStoreId).toBe(storeId);
    await desktop.selectSession('other');
    expect(desktop.snapshot!.interactions).toEqual([]);
    await Promise.all(
      waiting
        .interactions!.filter((card) => card.id !== last.id && card.id !== cliTarget.id)
        .map((card) =>
          client.answerInteraction('s', card.id, {
            expectedStoreId: storeId,
            commandId: crypto.randomUUID(),
            expectedRevision: card.revision,
            answer: { kind: 'approval', decision: 'approve' },
          }),
        ),
    );
    const seen = new Set<string>();
    const outcome = await observeCommand('s', intent, {
      client,
      write() {},
      pollIntervalMs: 5,
      timeoutMs: 15000,
      async answerInteraction(card) {
        expect(card.presentationSessionId).toBe('s');
        expect(card.originStoreId).toBe(storeId);
        seen.add(card.id);
        return { kind: 'approval', decision: 'approve' };
      },
    });
    if (outcome.status !== 'succeeded')
      console.error(
        JSON.stringify({ outcome, effects, seen: [...seen], view: await client.getView('s') }),
      );
    expect(outcome.status).toBe('succeeded');
    expect(seen.size).toBe(1);
    expect(seen.has(cliTarget.id)).toBe(true);
    expect(seen.has(last.id)).toBe(false);
    expect(effects).toBe(40);
    const command = await client.getCommand(intent.commandId);
    expect((await client.getRun((command.receipt as { runId: string }).runId)).status).toBe(
      'completed',
    );
    expect(
      (await client.listInteractions('other', { storeId, state: 'pending' })).interactions,
    ).toEqual([]);
  } finally {
    client.disposeNetwork();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
