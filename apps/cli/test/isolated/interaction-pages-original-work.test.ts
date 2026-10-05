import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { observeCommand } from '../../src';

test('actual CLI answers original second-page question while 20 unrelated earlier Job cards remain pending', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-interaction-pages-')));
  const selected = { dataRoot: join(root, 'data'), profile: 'owned' };
  const store = await openSqliteStore(selected),
    storeId = (await store.getMetadata()).storeId;
  let effects = 0,
    questions = 0;
  const runtime = createRuntime({
    store,
    modelId: 'fixed',
    model: createFixedModel([
      [
        { type: 'tool_call', id: 'parent', name: 'fixture.parent', arguments: '{}' },
        { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
      [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
      [
        { type: 'tool_call', id: 'question', name: 'fixture.question', arguments: '{}' },
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
              await Promise.all(
                Array.from({ length: 20 }, (_, i) =>
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
              return { outcome: 'succeeded', content: 'detached approvals retained' };
            },
          },
          {
            id: 'fixture.question',
            version: '1',
            description: 'Original later question',
            inputSchema: { type: 'object' },
            async execute(_input, ctx) {
              await ctx.requestInteraction!({
                kind: 'question',
                request: {
                  schema: {
                    type: 'object',
                    required: ['confirm'],
                    additionalProperties: false,
                    properties: { confirm: { type: 'boolean' } },
                  },
                },
              });
              questions++;
              return { outcome: 'succeeded', content: 'question answered once' };
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
    const previous = {
      kind: 'run.start' as const,
      expectedStoreId: storeId,
      commandId: 'previous-work',
      content: 'detach 20 approvals',
    };
    await client.startRun('s', previous);
    let previousCommand = await client.getCommand(previous.commandId);
    const commandDeadline = Date.now() + 5000;
    while (!(previousCommand.receipt as { runId?: string } | null)?.runId) {
      if (Date.now() > commandDeadline) throw Error('previous_command_timeout');
      await Bun.sleep(5);
      previousCommand = await client.getCommand(previous.commandId);
    }
    const previousRunId = (previousCommand.receipt as { runId: string }).runId;
    const previousDeadline = Date.now() + 15000;
    while ((await client.getRun(previousRunId)).isActive) {
      if (Date.now() > previousDeadline) throw Error('previous_run_timeout');
      await Bun.sleep(5);
    }
    expect((await client.getRun(previousRunId)).status).toBe('completed');
    const deadline = Date.now() + 5000;
    let first = await client.listInteractions('s', { storeId, state: 'pending', limit: 20 });
    while (first.interactions.length !== 20) {
      if (Date.now() > deadline) throw Error('previous_pending_timeout');
      await Bun.sleep(5);
      first = await client.listInteractions('s', { storeId, state: 'pending', limit: 20 });
    }
    const original = {
      kind: 'run.start' as const,
      expectedStoreId: storeId,
      commandId: 'later-original-work',
      content: 'question after earlier unrelated approvals',
    };
    await client.startRun('s', original);
    const waiting = await observeCommand('s', original, {
      client,
      write() {},
      pollIntervalMs: 5,
      timeoutMs: 15000,
    });
    expect(waiting.status).toBe('waiting_interaction');
    expect(waiting.interactions).toHaveLength(1);
    const target = waiting.interactions![0]!;
    expect(target.id.startsWith('information-')).toBe(true);
    first = await client.listInteractions('s', { storeId, state: 'pending', limit: 20 });
    expect(first.interactions).toHaveLength(20);
    expect(first.interactions.every((card) => card.id.startsWith('approval-'))).toBe(true);
    expect(first.interactions.some((card) => card.id === target.id)).toBe(false);
    const tail = await client.listInteractions('s', {
      storeId,
      state: 'pending',
      limit: 20,
      afterId: first.nextAfterId!,
    });
    expect(tail.interactions.map((card) => card.id)).toEqual([target.id]);
    let answers = 0;
    const result = await observeCommand('s', original, {
      client,
      write() {},
      pollIntervalMs: 5,
      timeoutMs: 15000,
      async answerInteraction(card) {
        expect(card.id).toBe(target.id);
        const stillFirst = await client.listInteractions('s', {
          storeId,
          state: 'pending',
          limit: 20,
        });
        expect(stillFirst.interactions).toHaveLength(20);
        expect(stillFirst.interactions.some((value) => value.id === target.id)).toBe(false);
        answers++;
        return { kind: 'question', answers: { confirm: true } };
      },
    });
    expect(result.status).toBe('succeeded');
    expect(answers).toBe(1);
    expect(questions).toBe(1);
    expect(effects).toBe(0);
    const command = await client.getCommand(original.commandId);
    expect((await client.getRun((command.receipt as { runId: string }).runId)).status).toBe(
      'completed',
    );
    const retained = await client.listInteractions('s', { storeId, state: 'pending', limit: 20 });
    expect(retained.interactions.map((card) => card.id)).toEqual(
      first.interactions.map((card) => card.id),
    );
    await Promise.all(
      retained.interactions.map((card) =>
        client.answerInteraction('s', card.id, {
          expectedStoreId: storeId,
          commandId: crypto.randomUUID(),
          expectedRevision: card.revision,
          answer: { kind: 'approval', decision: 'approve' },
        }),
      ),
    );
  } finally {
    client.disposeNetwork();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
