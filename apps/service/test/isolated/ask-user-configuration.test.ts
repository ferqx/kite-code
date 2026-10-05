import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createClient } from '@kite-ai/client';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import { startService } from '../../src';
import { createPermissionPolicy } from '../../src/permissions';

const questions = {
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
  ],
};
async function fixture(
  input: {
    mode?: 'ask' | 'auto' | 'full';
    planning?: boolean;
    tools?: unknown[];
    child?: boolean;
    explicitChild?: boolean;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-default-ask-user-')));
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
      let call: { name: string; input: unknown } | undefined;
      if (!results.length)
        call =
          input.child && body.model === 'parent'
            ? {
                name: 'task',
                input: {
                  key: 'child',
                  role: 'worker',
                  input: { content: 'Ask the user' },
                  cancellation: 'attached',
                },
              }
            : { name: 'ask_user', input: questions };
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
        model: input.child ? 'parent' : 'fixed',
        baseURL: `${provider.url.href}v1`,
      },
      ...(input.child
        ? [
            {
              id: 'child',
              provider: 'compatible',
              model: 'child',
              baseURL: `${provider.url.href}v1`,
            },
          ]
        : []),
    ],
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.child ? { tools: [{ id: 'task' }] } : {}),
  };
  writeFileSync(join(profile.profilePath, 'config.jsonc'), JSON.stringify(config));
  const host = createDefaultProcessConfiguration({
    profile,
    credentialBackend: createTemporaryCredentialBackend(),
    planning: { requirePlan: input.planning ?? false },
    ...(input.child
      ? {
          child: [
            {
              id: 'worker',
              version: '1',
              modelId: 'child',
              ...(input.explicitChild ? { toolIds: ['ask_user'] } : {}),
            },
          ],
        }
      : {}),
    permissionPolicy: {
      readPolicy: () => ({
        mode: input.mode ?? 'full',
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
    disableQuestions() {
      writeFileSync(
        join(profile.profilePath, 'config.jsonc'),
        JSON.stringify({ ...config, tools: [{ id: 'ask_user', enabled: false }] }),
      );
    },
    async close() {
      client.disposeNetwork();
      await service.close();
      provider.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function start(f: Awaited<ReturnType<typeof fixture>>) {
  await f.client.startRun('s', {
    expectedStoreId: f.expectedStoreId,
    commandId: 'run',
    kind: 'run.start',
    content: 'Ask exact questions',
  });
}
for (const mode of ['ask', 'auto', 'full'] as const)
  test(`default ask_user uses actual compatible schema and public answer in ${mode}`, async () => {
    const f = await fixture({ mode, planning: mode === 'ask' });
    try {
      await start(f);
      let card:
        | Awaited<ReturnType<typeof f.client.listInteractions>>['interactions'][number]
        | undefined;
      const deadline = Date.now() + 5000;
      while (!card) {
        const page = await f.client.listInteractions('s', { storeId: f.expectedStoreId });
        expect(page.interactions.some((item) => item.kind === 'approval')).toBe(false);
        card = page.interactions.find((item) => item.kind === 'question');
        if (Date.now() > deadline) throw Error(JSON.stringify(await f.client.getView('s')));
        if (!card) await Bun.sleep(10);
      }
      const tools = f.requests[0]!.tools as {
        function: { name: string; description: string; parameters: unknown };
      }[];
      const actual = tools.find((tool) => tool.function.name === 'ask_user')!;
      expect(actual.function.description.length).toBeGreaterThan(20);
      expect(actual.function.parameters).toMatchObject({
        type: 'object',
        additionalProperties: false,
        required: ['questions'],
      });
      expect(card.definitionId).toBe('ask_user');
      expect(card.definitionVersion).toBe('1');
      f.disableQuestions();
      await f.client.answerInteraction('s', card.id, {
        expectedStoreId: f.expectedStoreId,
        commandId: 'answer',
        expectedRevision: card.revision,
        answer: { kind: 'question', answers: { q1: 'q1-o1', q2: { text: 'q1-o1' } } },
      });
      await f.runtime.waitForCommand('run', { timeoutMs: 5000 });
      expect(f.requests).toHaveLength(2);
      const messages = f.requests[1]!.messages as { role: string; content: string }[];
      expect(JSON.parse(messages.find((item) => item.role === 'tool')!.content)).toMatchObject({
        answer: 'First?: q1-o2\nFree?: q1-o1',
        answers: { q1: 'q1-o2', q2: 'q1-o1' },
      });
      expect((await f.client.getExecution(card.executionId!)).status).toBe('succeeded');
      const run = (await f.client.getView('s')).runs[0]!;
      // Required planning can still reject completion; it did not block the question.
      expect(run.status).toBe(mode === 'ask' ? 'failed' : 'completed');
      expect(
        (await f.client.listPermissionGrants('s', { storeId: f.expectedStoreId })).items,
      ).toHaveLength(0);
      const saved = await f.client.getRun(run.id);
      expect(saved.configuration).toMatchObject({
        tools: [{ id: 'ask_user', version: '1' }],
        snapshot: {
          actualCapabilities: {
            tools: [{ id: 'ask_user', definitionVersion: '1', extensionId: 'builtin.ask-user' }],
          },
        },
      });
      expect((await f.client.listMessages('s')).length).toBeGreaterThanOrEqual(3);
      if (mode === 'full') {
        await f.client.startRun('s', {
          expectedStoreId: f.expectedStoreId,
          commandId: 'next',
          kind: 'run.start',
          content: 'New explicit work',
        });
        await f.runtime.waitForCommand('next', { timeoutMs: 5000 });
        const nextTools = f.requests.at(-1)!.tools as { function: { name: string } }[] | undefined;
        expect(nextTools?.some((tool) => tool.function.name === 'ask_user') ?? false).toBe(false);
        expect((await f.client.getRun(run.id)).configuration).toEqual(saved.configuration);
      }
    } finally {
      await f.close();
    }
  }, 15000);

for (const entry of [
  { id: 'ask_user', enabled: false },
  { id: 'ask_user', remove: true },
  { id: 'ask_user', definitionVersion: '99' },
  { id: 'ask_user', options: { invented: true } },
  { id: 'unknown-tool' },
])
  test(`configuration locally handles ${JSON.stringify(entry)}`, async () => {
    const f = await fixture({ tools: [entry] });
    try {
      await start(f);
      await f.runtime.waitForCommand('run', { timeoutMs: 5000 });
      expect(
        (await f.client.listInteractions('s', { storeId: f.expectedStoreId })).interactions,
      ).toHaveLength(0);
      if ('enabled' in entry || 'remove' in entry) {
        const tools = f.requests[0]!.tools as { function: { name: string } }[] | undefined;
        expect(tools?.some((tool) => tool.function.name === 'ask_user') ?? false).toBe(false);
        expect((await f.client.getView('s')).executions).toMatchObject([
          { kind: 'model', status: 'failed', result: { code: 'model_failed' } },
        ]);
      } else {
        expect(f.requests).toHaveLength(0);
        expect((await f.client.getCommand('run')).status).toBe('rejected');
      }
    } finally {
      await f.close();
    }
  }, 15000);

for (const explicitChild of [false, true])
  test(`actual child cannot ask_user; explicit role=${explicitChild}`, async () => {
    const f = await fixture({ child: true, explicitChild });
    try {
      await start(f);
      await f.runtime.waitForCommand('run', { timeoutMs: 5000 });
      const deadline = Date.now() + 5000;
      while (
        f.requests.filter((body) => body.model === 'child').length < 1 &&
        Date.now() < deadline
      )
        await Bun.sleep(10);
      const child = f.requests.filter((body) => body.model === 'child');
      expect(child).toHaveLength(1);
      const tools = child[0]!.tools as { function: { name: string } }[] | undefined;
      expect(tools?.some((tool) => tool.function.name === 'ask_user') ?? false).toBe(false);
      const rootView = await f.client.getView('s');
      const childSessionId = rootView.executions.find(
        (execution) => execution.childSessionId,
      )?.childSessionId;
      expect(childSessionId).toBeDefined();
      const view = await f.client.getView(childSessionId!);
      expect(view.executions).toMatchObject([
        { kind: 'model', status: 'failed', result: { code: 'model_failed' } },
      ]);
      expect(view.executions.some((execution) => execution.definitionId === 'ask_user')).toBe(
        false,
      );
      const configuration = view.runs[0]!.configuration as { tools: { id: string }[] };
      expect(configuration.tools.some((tool) => tool.id === 'ask_user')).toBe(false);
      expect(
        (await f.client.listInteractions('s', { storeId: f.expectedStoreId })).interactions,
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  }, 15000);

test('zero-effect host facts do not approve unknown or effectful definitions', async () => {
  for (const mode of ['ask', 'auto'] as const)
    for (const effect of [[], ['unknown'], ['workspace_write']] as const) {
      const policy = createPermissionPolicy({
        readPolicy: () => ({
          mode,
          workspaceTrust: true,
          revision: 'owned',
          allowed: [{ kind: 'tool', definitionId: 'exact', definitionVersion: '1' }],
        }),
        describeCapability: () => ({
          kind: 'tool',
          definitionId: 'exact',
          definitionVersion: '1',
          revision: 'trusted',
          effects: effect,
          safeRead: effect.length === 0,
          hardAllowed: true,
        }),
      });
      expect(
        (
          await policy.authorize({
            kind: 'tool',
            definitionId: 'exact',
            definitionVersion: '1',
            sessionId: 's',
            runId: null,
            executionId: 'e',
            input: {},
            signal: new AbortController().signal,
          })
        ).allowed,
      ).toBe(effect.length === 0);
      expect(
        (
          await policy.authorize({
            kind: 'tool',
            definitionId: 'unknown',
            definitionVersion: '1',
            sessionId: 's',
            runId: null,
            executionId: 'e',
            input: {},
            signal: new AbortController().signal,
          })
        ).allowed,
      ).toBe(false);
    }
});
