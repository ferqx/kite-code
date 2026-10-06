import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createAskUserExtension } from '@kite-ai/agent/ask-user';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import type { Json, ToolContext } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createStdioInteractionHandler, observeCommand, run } from '@kite-ai/cli';
import type { Interaction } from '@kite-ai/client';
import { createClient } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';

const questions: Json = {
  questions: [
    {
      question: 'First?',
      options: [
        { label: 'q1-o2', description: 'Exact label', recommended: true },
        { label: 'Second', description: 'Other' },
      ],
    },
    {
      question: 'Free?',
      options: [
        { label: 'One', description: 'One' },
        { label: 'Two', description: 'Two' },
      ],
    },
    {
      question: 'Unicode?',
      options: [
        { label: 'Yes', description: 'Y' },
        { label: 'No', description: 'N' },
      ],
    },
  ],
};
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-default-ask-user-stdio-')));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'new' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  const requests: Record<string, unknown>[] = [];
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      const messages = body.messages as { role: string; content?: string }[];
      const results = messages.filter((message) => message.role === 'tool');
      const call = !results.length ? { name: 'ask_user', input: questions } : undefined;
      const chunk = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        chunk(
          call
            ? {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${requests.length}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.input) },
                  },
                ],
              }
            : { content: 'Finished' },
          null,
        ) +
          chunk({}, call ? 'tool_calls' : 'stop') +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const config = {
    modelId: 'fixed',
    models: [
      {
        id: 'fixed',
        provider: 'compatible',
        model: 'fixed',
        baseURL: `${provider.url.href}v1`,
      },
    ],
  };
  writeFileSync(join(profile.profilePath, 'config.jsonc'), JSON.stringify(config));
  const host = createDefaultProcessConfiguration({
    profile,
    credentialBackend: createTemporaryCredentialBackend(),
    planning: { requirePlan: false },
    permissionPolicy: {
      readPolicy: () => ({
        mode: 'full',
        workspaceTrust: true,
        revision: 'owned',
        allowed: [
          { kind: 'model', definitionId: 'fixed', definitionVersion: '1' },
          { kind: 'model', definitionId: 'child', definitionVersion: '1' },
          ...['ask_user', 'task'].map((id) => ({
            kind: 'tool' as const,
            definitionId: id,
            definitionVersion: '1',
          })),
          { kind: 'job', definitionId: 'agent/worker', definitionVersion: '1' },
        ],
      }),
    },
  });
  const store = await openSqliteStore({ dataRoot: profile.dataRoot, profile: profile.profile });
  const expectedStoreId = (await store.getMetadata()).storeId;
  const runtime = createRuntime({
    ...host,
    store,
    artifacts: createArtifactStore({ profile, store }),
    permissions: host.permissions!,
  });
  const permissionManagement = host.permissionManagement?.(runtime);
  const target = {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  };
  const service = await startService({
    runtime,
    profile: target,
    buildId: 'default-ask-user',
    subjectId: 'owner',
    permissionManagement,
  });
  const client = createClient({
    endpoint: service.endpoint,
    token: service.bootstrap.token,
    expected: {
      profile: target,
      apiMajor: 1,
      requiredCapabilities: ['interactions', 'commands', 'model_inputs', 'permission_grants'],
    },
  });
  await client.connect();
  await client.createWorkspace({
    expectedStoreId,
    id: 'w',
    rootUri: `file://${workspace}`,
    name: 'Owned',
  });
  await client.createSession({
    expectedStoreId,
    sessionId: 's',
    workspaceId: 'w',
    commandId: 'create',
    title: 'Questions',
  });
  return {
    root,
    runtime,
    client,
    requests,
    expectedStoreId,
    async close() {
      client.disposeNetwork();
      await service.close();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const answers = { q1: 'q1-o1', q2: { text: 'q2-o1' }, q3: { text: '  雪🪁\n第二行  ' } };
async function read(card: Interaction, text: string) {
  const stdio = createStdioInteractionHandler({ input: Readable.from([text]), write() {} });
  try {
    return await stdio.answerInteraction(card, { signal: new AbortController().signal });
  } finally {
    stdio.dispose();
  }
}
test('stdio accepts the canonical schema emitted by the public default ask_user factory', async () => {
  let card: Interaction | undefined;
  const tool = createAskUserExtension().tools![0]!;
  const execution = await tool.execute!(questions, {
    signal: new AbortController().signal,
    async requestInput(request) {
      card = { kind: 'question', request } as Interaction;
      const generated = await read(card, `${JSON.stringify(answers)}\n`);
      expect(generated).toEqual({ kind: 'question', answers });
      return generated!.kind === 'question' ? generated!.answers : null;
    },
  } as ToolContext);
  expect(card).toBeDefined();
  expect(execution.outcome).toBe('succeeded');
});
test('stdio literal null selects the original information alternative without cancelling the Run signal', async () => {
  const signal = new AbortController().signal;
  const result = await createAskUserExtension().tools![0]!.execute(questions, {
    signal,
    async requestInput(request) {
      const answer = await read({ kind: 'question', request } as Interaction, 'null\n');
      expect(answer).toEqual({ kind: 'question', answers: null });
      return answer!.kind === 'question' ? answer!.answers : null;
    },
  } as ToolContext);
  expect(result).toEqual({
    outcome: 'succeeded',
    content: '{"cancelled":true}',
    details: { cancelled: true },
  });
  expect(signal.aborted).toBe(false);
});

test('real default Service and CLI stdio retain invalid pending then deliver exact three answers to Provider and history', async () => {
  const f = await fixture();
  const intent = {
    expectedStoreId: f.expectedStoreId,
    commandId: 'work',
    kind: 'run.start' as const,
    content: 'Ask three exact questions',
  };
  let posts = 0;
  const originalAnswer = f.client.answerInteraction.bind(f.client);
  f.client.answerInteraction = async (...args) => {
    posts++;
    return originalAnswer(...args);
  };
  const stdio = createStdioInteractionHandler({
    input: Readable.from([`${JSON.stringify(answers)}\n${JSON.stringify(answers)}\n`]),
    write() {},
  });
  const invalid = createStdioInteractionHandler({
    input: Readable.from([`${JSON.stringify({ ...answers, q2: { text: ' \t\n ' } })}\n`]),
    write() {},
  });
  const lines: string[] = [];
  try {
    const waiting = await run('s', intent, {
      client: f.client,
      write: (line) => lines.push(line),
      pollIntervalMs: 5,
      timeoutMs: 5000,
      answerInteraction: invalid.answerInteraction,
    });
    expect(waiting.status).toBe('waiting_interaction');
    expect(posts).toBe(0);
    expect(f.requests).toHaveLength(1);
    const cards = (await f.client.listInteractions('s', { storeId: f.expectedStoreId }))
      .interactions;
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.kind).toBe('question');
    expect(card.definitionId).toBe('ask_user');
    expect(card.answer).toBeNull();
    expect(card.state).toBe('pending');
    expect(
      (card.request as { schema: { oneOf: { required: unknown }[] } }).schema.oneOf[0]!.required,
    ).toEqual(['q1', 'q2', 'q3']);
    expect(
      await read(
        {
          ...card,
          request: {
            schema: { oneOf: [{ const: 'original' }, { type: 'string', pattern: '^secret$' }] },
          },
        },
        '"original"\n',
      ),
    ).toBeUndefined();
    expect(await read(card, '')).toBeUndefined();
    expect(
      (await f.client.getInteraction('s', card.id, { storeId: f.expectedStoreId })).answer,
    ).toBeNull();
    expect(posts).toBe(0);
    const terminal = await observeCommand('s', intent, {
      client: f.client,
      write: (line) => lines.push(line),
      pollIntervalMs: 5,
      timeoutMs: 5000,
      answerInteraction: stdio.answerInteraction,
    });
    expect(terminal.status).toBe('succeeded');
    expect(posts).toBe(1);
    expect(f.requests).toHaveLength(2);
    const saved = await f.client.getInteraction('s', card.id, { storeId: f.expectedStoreId });
    expect(saved.answer).toEqual({ kind: 'question', answers });
    expect(saved.acceptedDecisionRevision).not.toBeNull();
    const semantic = {
      answer: 'First?: q1-o2\nFree?: q2-o1\nUnicode?:   雪🪁\n第二行  ',
      answers: { q1: 'q1-o2', q2: 'q2-o1', q3: answers.q3.text },
    };
    const messages = f.requests[1]!.messages as { role: string; content: string }[];
    expect(JSON.parse(messages.find((message) => message.role === 'tool')!.content)).toEqual(
      semantic,
    );
    const history = await f.client.listMessages('s');
    expect(JSON.parse(history.find((message) => message.role === 'tool')!.content)).toEqual(
      semantic,
    );
    expect((await f.client.getExecution(card.executionId!)).status).toBe('succeeded');
    expect(
      (await f.client.listPermissionGrants('s', { storeId: f.expectedStoreId })).items,
    ).toHaveLength(0);
    expect(
      (
        await observeCommand('s', intent, {
          client: f.client,
          write() {},
          pollIntervalMs: 5,
          timeoutMs: 5000,
          answerInteraction: stdio.answerInteraction,
        })
      ).status,
    ).toBe('succeeded');
    expect(posts).toBe(1);
    expect(f.requests).toHaveLength(2);
    expect(lines.filter((line) => line.startsWith('answer accepted'))).toHaveLength(1);
  } finally {
    invalid.dispose();
    stdio.dispose();
    await f.close();
  }
}, 15000);

for (const [schema, value, accepted] of [
  [{ oneOf: [{ const: 'id' }, { type: 'string' }] }, 'id', false],
  [{ oneOf: [{ const: 'id' }, { const: 'other' }] }, 'id', true],
  [{ anyOf: [{ const: 'id' }, { type: 'string' }] }, 'id', true],
  [{ const: { a: 1, b: 2 } }, { b: 2, a: 1 }, true],
  [
    {
      oneOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { const: { a: 'x', b: 1 } },
      ],
    },
    { a: 'x', b: 1 },
    false,
  ],
  [
    {
      oneOf: [
        {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
          additionalProperties: false,
          enum: [{ a: 1, b: 2 }],
        },
        { const: { a: 1, b: 2 } },
      ],
    },
    { b: 2, a: 1 },
    false,
  ],
  [{ type: 'object', properties: { a: { type: 'string' } } }, { a: 'x', b: 1 }, true],
  [
    {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      additionalProperties: false,
      enum: [{ a: 1, b: 2 }],
    },
    { b: 2, a: 1 },
    true,
  ],
  [{ anyOf: [{ const: 'id' }, { type: 'string', pattern: '^id$' }] }, 'id', false],
  [{ oneOf: [{ const: 'id' }, false] }, 'id', false],
  [{ oneOf: [{ const: 'id' }, { type: 'object' }] }, 'id', false],
  [{ anyOf: [] }, 'id', false],
  [{ oneOf: [{ const: 'id' }, { type: ['string'] }] }, 'id', false],
  [{ oneOf: [{ const: 'id' }, { type: 'string', minLength: '1' }] }, 'id', false],
  [{ oneOf: [{ const: 'id' }, { const: 'other', minLength: 5 }] }, 'id', false],
  [{ type: 'string', pattern: '\\S' }, ' \t\n', false],
  [{ type: 'string', minLength: 1, maxLength: 1, pattern: '\\S' }, '🪁', true],
  [
    { type: 'object', properties: {}, required: ['__proto__'], additionalProperties: false },
    {},
    false,
  ],
  [
    JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}},"additionalProperties":false}',
    ),
    JSON.parse('{"__proto__":"id"}'),
    false,
  ],
  [
    {
      type: 'object',
      properties: { optional: { type: 'string', pattern: '^id$' } },
      additionalProperties: false,
    },
    {},
    false,
  ],
] as const)
  test(`stdio finite combinations ${JSON.stringify(schema)} ${JSON.stringify(value)}`, async () => {
    const answer = await read(
      { kind: 'question', request: { schema } } as unknown as Interaction,
      `${JSON.stringify(value)}\n`,
    );
    expect(answer).toEqual(accepted ? { kind: 'question', answers: value } : undefined);
  });
