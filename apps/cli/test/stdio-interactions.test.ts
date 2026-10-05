import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService } from '@kite-ai/service/paired';
import { createStdioInteractionHandler, run } from '../src';
import { largeInteractionFixture } from './fixtures/large-interaction';

async function paired() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cli-stdio-')));
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  const host = await launchPairedService({
    entrypoint: join(import.meta.dir, 'fixtures/interaction-child.ts'),
    profile,
    instanceId: crypto.randomUUID(),
    buildId: 'fixed',
    apiMajor: 1,
    requiredCapabilities: ['commands', 'interactions'],
  });
  const client = host.client,
    storeId = host.bootstrap.storeId!;
  await client.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'temporary',
    rootUri: `file://${root}`,
  });
  await client.createSession({
    expectedStoreId: storeId,
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'stdio',
  });
  return {
    client,
    storeId,
    profile,
    intent: {
      expectedStoreId: storeId,
      commandId: 'work',
      kind: 'run.start' as const,
      content: 'question',
    },
    async close() {
      await host.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('real paired CLI stdio approves exact card then preserves question choice ID until true terminal', async () => {
  const f = await paired(),
    prompts: string[] = [],
    lines: string[] = [];
  const stdio = createStdioInteractionHandler({
    input: Readable.from(['approve\n{"reply":"second"}\n']),
    write: (text) => prompts.push(text),
  });
  try {
    const result = await run('s', f.intent, {
      client: f.client,
      write: (line) => lines.push(line),
      pollIntervalMs: 5,
      answerInteraction: stdio.answerInteraction,
    });
    expect(result.status).toBe('succeeded');
    expect(readFileSync(join(f.profile.profilePath, 'effect'), 'utf8')).toBe('one');
    expect(JSON.parse(readFileSync(join(f.profile.profilePath, 'answer'), 'utf8'))).toEqual({
      reply: 'second',
    });
    const cards = (await f.client.listInteractions('s', { storeId: f.storeId })).interactions;
    expect(cards.length).toBe(2);
    expect(cards.every((card) => card.acceptedDecisionRevision !== null)).toBe(true);
    expect(prompts.join('')).toContain(f.storeId);
    expect(prompts.join('')).toContain('"executionId"');
    expect(lines.filter((line) => line.startsWith('answer accepted')).length).toBe(2);
  } finally {
    stdio.dispose();
    await f.close();
  }
}, 15000);

test('EOF, blank and unsupported approval keep durable waiting with no answer/effect and no implicit stop', async () => {
  for (const text of ['', '\n', 'yes\n']) {
    const f = await paired(),
      stdio = createStdioInteractionHandler({ input: Readable.from([text]), write() {} });
    try {
      const result = await run('s', f.intent, {
        client: f.client,
        write() {},
        pollIntervalMs: 5,
        answerInteraction: stdio.answerInteraction,
      });
      expect(result.status).toBe('waiting_interaction');
      expect(result.exitCode).toBe(3);
      const cards = (await f.client.listInteractions('s', { storeId: f.storeId })).interactions;
      expect(cards[0]?.answer).toBeNull();
      expect(cards[0]?.state).toBe('pending');
      const command = await f.client.getCommand('work');
      expect(command.cancelRequestedAt).toBeNull();
      expect((await f.client.getRun((command.receipt as { runId: string }).runId)).isActive).toBe(
        true,
      );
    } finally {
      stdio.dispose();
      await f.close();
    }
  }
}, 15000);

test('Ctrl+C during stdio read targets original command; late approved line cannot revive stopped work', async () => {
  const f = await paired(),
    input = new PassThrough(),
    cancel = new AbortController();
  let prompted!: () => void;
  const shown = new Promise<void>((resolve) => {
    prompted = resolve;
  });
  const stdio = createStdioInteractionHandler({
    input,
    write() {
      prompted();
    },
  });
  try {
    const pending = run('s', f.intent, {
      client: f.client,
      write() {},
      signal: cancel.signal,
      pollIntervalMs: 5,
      answerInteraction: stdio.answerInteraction,
    });
    await shown;
    cancel.abort();
    input.end('approve\n');
    expect((await pending).status).toBe('cancelled');
    expect((await f.client.getCommand('work')).cancelRequestedAt).not.toBeNull();
    const cards = (await f.client.listInteractions('s', { storeId: f.storeId })).interactions;
    expect(cards[0]?.answer).toBeNull();
    expect(cards[0]?.state).toBe('cancelled');
  } finally {
    stdio.dispose();
    await f.close();
  }
}, 15000);

test('stdio receives whole verified >17MiB attachment before accepting one original effect', async () => {
  const f = await largeInteractionFixture();
  let full = false;
  const stdio = createStdioInteractionHandler({
    input: Readable.from(['approve\n']),
    write(text) {
      if (text.startsWith('Complete verified attachment: ')) {
        const value: unknown = JSON.parse(text.slice('Complete verified attachment: '.length));
        expect(typeof value).toBe('string');
        expect(JSON.parse(value as string).task).toBe(f.body);
        full = true;
      }
    },
  });
  try {
    await f.start();
    const outcome = await run(
      's',
      {
        expectedStoreId: f.storeId,
        commandId: 'work',
        kind: 'run.start',
        content: 'actual harmless request',
      },
      {
        client: f.client,
        write() {},
        pollIntervalMs: 5,
        answerInteraction: stdio.answerInteraction,
      },
    );
    expect(outcome.status).toBe('succeeded');
    expect(full).toBe(true);
    expect(f.effects()).toBe(1);
  } finally {
    stdio.dispose();
    await f.close();
  }
}, 30000);

test('Ctrl+C while an original attachment is being read still cancels original work and never prompts or answers', async () => {
  const f = await largeInteractionFixture(),
    cancel = new AbortController();
  let reading!: () => void;
  const began = new Promise<void>((resolve) => {
    reading = resolve;
  });
  let prompts = 0;
  const stdio = createStdioInteractionHandler({
    input: Readable.from(['approve\n']),
    write() {
      prompts++;
    },
  });
  f.client.readInteractionAttachment = async (_interaction, options) => {
    reading();
    return await new Promise((_resolve, reject) => {
      const aborted = () => reject(options?.signal?.reason ?? new Error('cancelled'));
      options?.signal?.addEventListener('abort', aborted, { once: true });
      if (options?.signal?.aborted) aborted();
    });
  };
  try {
    await f.start();
    const pending = run(
      's',
      {
        expectedStoreId: f.storeId,
        commandId: 'work',
        kind: 'run.start',
        content: 'actual harmless request',
      },
      {
        client: f.client,
        write() {},
        signal: cancel.signal,
        pollIntervalMs: 5,
        answerInteraction: stdio.answerInteraction,
      },
    );
    await began;
    cancel.abort();
    expect((await pending).status).toBe('cancelled');
    expect((await f.client.getCommand('work')).cancelRequestedAt).not.toBeNull();
    expect(f.effects()).toBe(0);
    expect(prompts).toBe(0);
    const cards = (await f.client.listInteractions('s', { storeId: f.storeId })).interactions;
    expect(cards.every((card) => card.answer === null && card.state === 'cancelled')).toBe(true);
  } finally {
    stdio.dispose();
    await f.close();
  }
}, 30000);

async function coreFixture(child: boolean, delay: number | Promise<void> = 0) {
  const { createRuntime } = await import('@kite-ai/agent');
  const { openSqliteStore } = await import('@kite-ai/agent/sqlite');
  const { createFixedModel } = await import('@kite-ai/ai');
  const { createClient } = await import('@kite-ai/client');
  const { startService } = await import('@kite-ai/service');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-cli-stdio-core-'))),
    selected = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  const store = await openSqliteStore({ dataRoot: selected.dataRoot, profile: selected.profile });
  const storeId = (await store.getMetadata()).storeId;
  const finish = {
    type: 'finish' as const,
    reason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
  const call = (name: string) => [
    { type: 'tool_call' as const, id: 'call', name, arguments: '{}' },
    { ...finish, reason: 'tool_calls' as const },
  ];
  let effects = 0,
    answers: unknown,
    entered!: () => void;
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const model = child
    ? createFixedModel([call('delegate'), [finish]])
    : {
        async *stream(_request: unknown, { signal }: { signal: AbortSignal }) {
          entered();
          await (typeof delay === 'number' ? Bun.sleep(delay) : delay);
          signal.throwIfAborted();
          yield finish;
        },
      };
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixed',
    modelConcurrency: 1,
    ...(child
      ? {
          childConfigurations: [
            {
              id: 'role',
              version: '1',
              modelId: 'child-fixed',
              model: createFixedModel([call('question'), [finish]]),
              toolIds: ['question'],
              snapshot: {},
            },
          ],
        }
      : {}),
    permissions: {
      async authorize(invocation) {
        return invocation.definitionId === 'question'
          ? {
              allowed: false,
              revision: '1',
              approval: { request: { title: 'Original child question tool' } },
            }
          : { allowed: true, revision: '1' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'delegate',
            version: '1',
            description: 'Wait for the actual child operation',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              const ref = await context.operations.ensure({
                key: 'child',
                request: {
                  kind: 'agent',
                  configurationId: 'role',
                  input: { content: 'actual child' },
                },
              });
              const result = await context.operations.wait(ref);
              return {
                outcome: result.status === 'succeeded' ? 'succeeded' : 'failed',
                content: 'child settled',
              };
            },
          },
          {
            id: 'question',
            version: '1',
            description: 'Ask the original scoped question',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              effects++;
              answers = await context.requestInput({
                schema: {
                  type: 'object',
                  properties: { reply: { type: 'string', enum: ['internal-id'] } },
                  required: ['reply'],
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
    dataRoot: selected.dataRoot,
    name: selected.profile,
    accessKey: selected.profileAccessKey,
  };
  const service = await startService({ runtime, profile, subjectId: 'owner', buildId: 'stdio' });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: { profile, apiMajor: 1, requiredCapabilities: ['commands', 'interactions'] },
    bootstrap: service.bootstrap,
  });
  await client.connect();
  await client.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'temporary',
    rootUri: `file://${root}`,
  });
  await client.createSession({
    expectedStoreId: storeId,
    sessionId: 's',
    workspaceId: 'w',
    commandId: 'create',
    title: 'stdio',
  });
  return {
    client,
    storeId,
    active,
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

test('same Loop child cards are printed with original child identity but answered only through root', async () => {
  const f = await coreFixture(true),
    prompts: string[] = [];
  const stdio = createStdioInteractionHandler({
    input: Readable.from(['approve\n{"reply":"internal-id"}\n']),
    write(text) {
      prompts.push(text);
    },
  });
  try {
    const result = await run(
      's',
      { kind: 'run.start', commandId: 'work', expectedStoreId: f.storeId, content: 'delegate' },
      {
        client: f.client,
        write() {},
        pollIntervalMs: 5,
        answerInteraction: stdio.answerInteraction,
      },
    );
    expect(result.status).toBe('succeeded');
    expect(f.effects).toBe(1);
    expect(f.answers).toEqual({ reply: 'internal-id' });
    const cards = (await f.client.listInteractions('s', { storeId: f.storeId })).interactions;
    expect(cards.length).toBe(2);
    expect(
      cards.every(
        (card) =>
          card.sessionId !== 's' &&
          card.presentationSessionId === 's' &&
          card.acceptedDecisionRevision !== null,
      ),
    ).toBe(true);
    expect(prompts.join('')).toContain(`"sessionId":"${cards[0]!.sessionId}"`);
    expect(prompts.join('')).toContain('"presentationSessionId":"s"');
  } finally {
    stdio.dispose();
    await f.close();
  }
}, 15000);

test('explicit timeout releases CLI waiting without cancelling accepted Service work', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await coreFixture(false, held);
  try {
    const result = await run(
      's',
      { kind: 'run.start', commandId: 'work', expectedStoreId: f.storeId, content: 'wait' },
      { client: f.client, write() {}, pollIntervalMs: 5, timeoutMs: 50 },
    );
    expect(result.status).toBe('outcome_unknown');
    expect((await f.client.getCommand('work')).cancelRequestedAt).toBeNull();
    const runId = ((await f.client.getCommand('work')).receipt as { runId: string }).runId;
    expect((await f.client.getRun(runId)).isActive).toBe(true);
    release();
    const deadline = Date.now() + 10_000;
    let observed = await f.client.getRun(runId);
    while (observed.isActive && Date.now() < deadline) {
      await Bun.sleep(10);
      observed = await f.client.getRun(runId);
    }
    expect(observed.status).toBe('completed');
    expect((await f.client.getCommand('work')).cancelRequestedAt).toBeNull();
  } finally {
    release();
    await f.close();
  }
}, 15000);

test('default foreground wait survives actual Model work beyond the former 30-second client limit', async () => {
  const f = await coreFixture(false, 30_100);
  try {
    const result = await run(
      's',
      {
        kind: 'run.start',
        commandId: 'work',
        expectedStoreId: f.storeId,
        content: 'actual bounded slow local Model',
      },
      { client: f.client, write() {}, pollIntervalMs: 100 },
    );
    expect(result.status).toBe('succeeded');
    expect(result.exitCode).toBe(0);
    expect((await f.client.getCommand('work')).cancelRequestedAt).toBeNull();
  } finally {
    await f.close();
  }
}, 40000);
