import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore, resolveProfile } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';
import { createClient } from '@kite-ai/client';
import { createDesktopController } from '@kite-ai/desktop';
import { startService } from '@kite-ai/service';
import { run } from '../src';

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-thin-interactions-')));
  const selected = { dataRoot: join(root, 'data'), profile: 'new' };
  const store = await openSqliteStore(selected);
  const storeId = (await store.getMetadata()).storeId;
  let effects = 0;
  let answers: unknown;
  const model = createFixedModel([
    [
      { type: 'tool_call', id: 'call', name: 'fixture.question', arguments: '{}' },
      { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
    [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
  ]);
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    permissions: {
      async authorize(request) {
        return request.kind === 'tool'
          ? {
              allowed: false,
              revision: 'policy-1',
              approval: { request: { title: 'Review exact tool' } },
            }
          : { allowed: true, revision: 'policy-1' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.question',
            version: '1',
            description: 'Local question',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              effects++;
              answers = await context.requestInput({
                title: 'Select exact answer',
                schema: {
                  type: 'object',
                  required: ['reply'],
                  properties: { reply: { type: 'string', enum: ['first', 'second'] } },
                  additionalProperties: false,
                },
              });
              return { outcome: 'succeeded', content: 'answered' };
            },
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
    buildId: 'thin-interactions',
    subjectId: 'owner',
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: { profile, apiMajor: 1, requiredCapabilities: ['interactions', 'commands'] },
    bootstrap: service.bootstrap,
  });
  await client.connect();
  await client.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'temporary',
    rootUri: pathToFileURL(root).href,
  });
  for (const sessionId of ['s', 'other'])
    await client.createSession({
      expectedStoreId: storeId,
      sessionId,
      workspaceId: 'w',
      commandId: `create-${sessionId}`,
      title: sessionId,
    });
  return {
    client,
    runtime,
    store,
    model,
    storeId,
    get effects() {
      return effects;
    },
    get answers() {
      return answers;
    },
    async close() {
      client.disposeNetwork();
      await service.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('real HTTP CLI opt-in answers approval then schema question, only actual Run terminal succeeds', async () => {
  const f = await fixture();
  try {
    const seen: string[] = [];
    const lines: string[] = [];
    const outcome = await run(
      's',
      { kind: 'run.start', commandId: 'run', expectedStoreId: f.storeId, content: 'question' },
      {
        client: f.client,
        write: (line) => lines.push(line),
        pollIntervalMs: 5,
        answerInteraction: async (interaction) => {
          seen.push(interaction.kind);
          expect(interaction.originStoreId).toBe(f.storeId);
          expect(interaction.presentationSessionId).toBe('s');
          expect(interaction.state).toBe('pending');
          return interaction.kind === 'approval'
            ? { kind: 'approval', decision: 'approve', optionId: 'once' }
            : { kind: 'question', answers: { reply: 'second' } };
        },
      },
    );
    expect(outcome.status).toBe('succeeded');
    expect(seen).toEqual(['approval', 'question']);
    expect(f.effects).toBe(1);
    expect(f.answers).toEqual({ reply: 'second' });
    expect(lines.filter((line) => line.startsWith('answer accepted'))).toHaveLength(2);
    const cards = await f.client.listInteractions('s', { storeId: f.storeId });
    expect(
      cards.interactions.every(
        (card) => card.state === 'answered' && card.acceptedDecisionRevision !== null,
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
}, 15000);

test('noninteractive waiting is known; Desktop freezes exact target and ignores duplicate submit across view switch', async () => {
  const f = await fixture();
  try {
    const lines: string[] = [];
    const outcome = await run(
      's',
      { kind: 'run.start', commandId: 'run', expectedStoreId: f.storeId, content: 'question' },
      { client: f.client, write: (line) => lines.push(line), pollIntervalMs: 5 },
    );
    expect(outcome.status).toBe('waiting_interaction');
    expect(outcome.exitCode).toBe(3);
    expect(f.effects).toBe(0);
    expect(lines.some((line) => line.startsWith('terminal'))).toBe(false);
    const desktop = createDesktopController({ admittedClient: f.client, onSnapshot() {} });
    const snapshot = await desktop.selectSession('s');
    const card = snapshot!.interactions[0]!;
    const one = desktop.answerInteraction(card, {
      kind: 'approval',
      decision: 'approve',
      optionId: 'once',
    });
    const duplicate = desktop.answerInteraction(card, { kind: 'approval', decision: 'deny' });
    expect(duplicate).toBe(one);
    await desktop.selectSession('other');
    const receipt = await one;
    expect(receipt.sessionId).toBe('s');
    expect(desktop.interactionSubmission(card)?.intent.answer).toEqual({
      kind: 'approval',
      decision: 'approve',
      optionId: 'once',
    });
    expect(desktop.interactionSubmission(card)?.phase).toBe('accepted');
    expect((await desktop.lookupInteractionAnswer(card)).id).toBe(receipt.id);
    const deadline = Date.now() + 3000;
    let question = false;
    while (Date.now() < deadline) {
      question = (
        await f.client.listInteractions('s', { storeId: f.storeId, state: 'pending' })
      ).interactions.some((value) => value.kind === 'question');
      if (question) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(question).toBe(true);
    // This test owns cleanup only. Unresolved question remains genuine; view switch did not stop work.
    await f.client.cancelCommand('s', {
      kind: 'command.cancel',
      commandId: 'stop',
      expectedStoreId: f.storeId,
      targetCommandId: 'run',
    });
    await f.runtime.waitForCommand('run');
    expect(f.effects).toBe(1);
  } finally {
    await f.close();
  }
}, 15000);

test('actual private paired Service process completes opt-in CLI approval/question and external ledger once', async () => {
  const { selectProfile } = await import('@kite-ai/agent/profile');
  const { launchPairedService } = await import('@kite-ai/service/paired');
  const { readFileSync } = await import('node:fs');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cli-paired-interaction-')));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  const handle = await launchPairedService({
    entrypoint: join(import.meta.dir, 'fixtures/interaction-child.ts'),
    profile,
    instanceId: 'thin-client',
    buildId: 'thin-client',
    apiMajor: 1,
    requiredCapabilities: ['commands', 'interactions'],
  });
  try {
    const client = handle.client;
    const storeId = handle.bootstrap.storeId!;
    await client.createWorkspace({
      expectedStoreId: storeId,
      id: 'w',
      name: 'temporary',
      rootUri: pathToFileURL(root).href,
    });
    await client.createSession({
      expectedStoreId: storeId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'paired',
    });
    const calls: string[] = [];
    const result = await run(
      's',
      { expectedStoreId: storeId, commandId: 'run', kind: 'run.start', content: 'question' },
      {
        client,
        write() {},
        pollIntervalMs: 5,
        answerInteraction: async (interaction) => {
          calls.push(interaction.kind);
          return interaction.kind === 'approval'
            ? { kind: 'approval', decision: 'approve', optionId: 'once' }
            : { kind: 'question', answers: { reply: 'second' } };
        },
      },
    );
    expect(result.status).toBe('succeeded');
    expect(calls).toEqual(['approval', 'question']);
    expect(readFileSync(join(profile.profilePath, 'effect'), 'utf8')).toBe('one');
    expect(JSON.parse(readFileSync(join(profile.profilePath, 'answer'), 'utf8'))).toEqual({
      reply: 'second',
    });
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('actual denied approval reaches the next Model without tool effects; invalid question answer stays pending', async () => {
  const denied = await fixture();
  try {
    const result = await run(
      's',
      { kind: 'run.start', commandId: 'run', expectedStoreId: denied.storeId, content: 'deny' },
      {
        client: denied.client,
        write() {},
        pollIntervalMs: 5,
        answerInteraction: async () => ({ kind: 'approval', decision: 'deny' }),
      },
    );
    expect(result.status).toBe('succeeded');
    expect(result.commandId).toBe('run');
    expect(result.exitCode).toBe(0);
    expect(denied.effects).toBe(0);
    expect(denied.answers).toBeUndefined();
    const view = await denied.store.getView('s');
    expect(view.runs).toHaveLength(1);
    expect(view.runs[0]).toMatchObject({ status: 'completed', originCommandId: 'run' });
    const executions = await denied.store.listExecutions('s');
    const tools = executions.filter((execution) => execution.kind === 'tool');
    expect(tools).toHaveLength(1);
    const original = tools[0]!;
    expect(original).toMatchObject({
      definitionId: 'fixture.question',
      runId: view.runs[0]!.id,
      originCommandId: 'run',
      status: 'failed',
      result: {
        outcome: 'failed',
        details: { code: 'approval_denied', adapterAttempted: false, dispatchCommitted: false },
      },
      authorization: { dispatched: false, human: { state: 'answered', decision: 'deny' } },
      decisionSource: {
        kind: 'model_decision',
        modelExecutionId: denied.model.requests[0]!.requestId,
      },
    });
    expect(denied.model.requests).toHaveLength(2);
    const models = executions.filter((execution) => execution.kind === 'model');
    expect(models.map((execution) => execution.id)).toEqual(
      denied.model.requests.map((request) => request.requestId),
    );
    expect(models.every((execution) => execution.runId === view.runs[0]!.id)).toBe(true);
    const feedback = denied.model.requests[1]!.messages.filter(
      (message) => message.role === 'tool' && message.sourceIds?.includes(original.id),
    );
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toMatchObject({ toolCallId: 'call', sourceIds: [original.id] });
    expect(feedback[0]!.content).toContain('The user denied this request.');
    expect(feedback[0]!.content).toContain('It was not executed.');
    expect(feedback[0]!.content).toContain('Do not resubmit it or bypass the refusal.');
  } finally {
    await denied.close();
  }
  const invalid = await fixture();
  try {
    const result = await run(
      's',
      {
        kind: 'run.start',
        commandId: 'run',
        expectedStoreId: invalid.storeId,
        content: 'invalid answer',
      },
      {
        client: invalid.client,
        write() {},
        pollIntervalMs: 5,
        answerInteraction: async (interaction) =>
          interaction.kind === 'approval'
            ? { kind: 'approval', decision: 'approve', optionId: 'once' }
            : { kind: 'question', answers: { reply: 4 } },
      },
    );
    expect(result.status).toBe('waiting_interaction');
    expect(result.interactions?.[0]?.kind).toBe('question');
    expect(invalid.effects).toBe(1);
    expect(invalid.answers).toBeUndefined();
    const card = result.interactions![0]!;
    expect(
      (await invalid.client.getInteraction('s', card.id, { storeId: invalid.storeId })).state,
    ).toBe('pending');
    expect(result.answerIntent?.request.expectedRevision).toBe(card.revision);
  } finally {
    await invalid.close();
  }
}, 15000);
